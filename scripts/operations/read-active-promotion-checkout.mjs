import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { readMerchantActivities } from './read-promotion-preflight.mjs';
import { openMyShopSession, readPilotOrderEconomics, readPilotStatementPayments } from './verify-promotion-outcome.mjs';

const shopId = '9000000000000000099';
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short' });
const root = fileURLToPath(new URL('../../', import.meta.url));
const discountTypes = new Set(['FIXED_PRICE', 'DIRECT_DISCOUNT', 'FLASHSALE']);
const eligibleStatuses = ['DELIVERED', 'COMPLETED', 'IN_TRANSIT', 'AWAITING_COLLECTION', 'AWAITING_SHIPMENT'];

function activityOrders(activity, orders) {
  if (!Array.isArray(activity.products) || !['PRODUCT', 'VARIATION'].includes(activity.product_level) ||
      !Number.isSafeInteger(activity.begin_time) || !Number.isSafeInteger(activity.end_time) || activity.end_time <= activity.begin_time) {
    throw new Error('Incomplete merchant activity terms');
  }
  const products = new Map(activity.products.map(product => [product.id, product]));
  if (products.size !== activity.products.length || activity.products.some(product => !isPlatformId(product.id) ||
      (activity.product_level === 'VARIATION' && (!Array.isArray(product.skus) || product.skus.some(sku => !isPlatformId(sku.id)))))) {
    throw new Error('Incomplete merchant activity SKU coverage');
  }
  return orders.flatMap(order => {
    if (order.sampleOrder !== false || !eligibleStatuses.includes(order.status) ||
        order.createdAt < activity.begin_time || order.createdAt >= activity.end_time) return [];
    const matches = order.skus.filter(line => {
      const product = products.get(line.productId);
      return product && (activity.product_level === 'PRODUCT' || product.skus.some(sku => sku.id === line.id));
    });
    return matches.length ? [{ order, matches }] : [];
  });
}

export async function refreshActivePromotionCheckout() {
  const trace = [];
  const session = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    trace.push({ method: options.method, path: url.pathname, status: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const { client, token, shop } = session;
  const end = Math.floor(Date.now() / 1000);
  const start = end - 604800;
  const orderRequestIds = [];
  const activityRequestIds = [];
  const seen = new Set();
  const [orders, activities] = await Promise.all([
    collectPages(async cursor => {
      const page = await client.ordersPage(token, shop, 100, cursor, start, end, { includeRequestId: true });
      if (!page.requestId || !Number.isSafeInteger(page.totalCount)) throw new Error('Incomplete order pagination evidence');
      orderRequestIds.push(page.requestId);
      for (const order of page.rows) {
        if (!isPlatformId(order.id) || seen.has(order.id) || !Number.isSafeInteger(order.createdAt) ||
            order.createdAt < start || order.createdAt >= end || !order.skus?.length ||
            order.skus.some(line => ![line.id, line.lineId, line.productId].every(isPlatformId)) ||
            new Set(order.skus.map(line => line.lineId)).size !== order.skus.length) throw new Error('Order scope or SKU identity changed');
        seen.add(order.id);
      }
      return page;
    }, Date.now() + 60_000),
    readMerchantActivities(session, 'ONGOING', activityRequestIds),
  ]);
  const summary = [];
  const results = [];
  const maximumOrdersPerActivity = 4;
  for (const item of activities.filter(row => discountTypes.has(row.activity_type))) {
    const activity = { id: item.activity_id ?? item.id, type: item.activity_type, level: item.product_level,
      from: item.begin_time, to: item.end_time, applies: true };
    const covered = activityOrders(item, orders.rows);
    // Prefer completed orders for settlement and take one covered SKU per order for this sample.
    const sorted = covered.sort((a, b) => eligibleStatuses.indexOf(a.order.status) - eligibleStatuses.indexOf(b.order.status) ||
      a.order.createdAt - b.order.createdAt || a.order.id.localeCompare(b.order.id));
    const sample = sorted.slice(0, maximumOrdersPerActivity);
    summary.push({ activity, coveredOrders: covered.length, coveredLines: covered.reduce((sum, row) => sum + row.matches.length, 0),
      sampledOrders: sample.length });
    for (const { order, matches } of sample) {
      const { productId, id: skuId, sellerSku } = matches[0];
      const orderRows = matches.filter(line => line.productId === productId && line.id === skuId)
        .map(line => ({ orderId: order.id, orderLineId: line.lineId }));
      const { data: product, requestId } = await client.productDetail(token, shop, productId, { includeRequestId: true });
      const matchedSkus = product.skus?.filter(row => row.id === skuId);
      if (!requestId || product.id !== productId || matchedSkus?.length !== 1) throw new Error('Current product SKU identity unavailable');
      const details = await readPilotOrderEconomics({ productId, skuId }, orderRows, session, activity.id);
      results.push({ productId, skuId, sellerSku, activity, productRequestId: requestId, details });
    }
  }
  const statementPayments = await readPilotStatementPayments(results.flatMap(row => row.details), session, start);
  const observedAt = new Date().toISOString();
  const directory = join(root, 'outputs/operations-promotion-outcome', dayFormat.format(new Date(observedAt)));
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'active-promotion-checkout-controls-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  const receipt = { schema: 'operations-active-promotion-checkout-controls/v1', observedAt,
    shop: { id: shop.id, name: shop.name, region: shop.region }, start, end, orderCount: orders.rows.length,
    orderRequestIds, activityRequestIds, maximumOrdersPerActivity, summary, results, statementPayments, trace, writes: 0 };
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { file, observedAt, orderCount: receipt.orderCount, summary, sampled: results.length,
    exactCheckout: results.filter(row => row.details[0]?.checkout).length,
    exactSettlement: results.filter(row => row.details[0]?.settlement).length,
    exactActivityAttribution: results.filter(row => row.details[0]?.promotionAttribution).length, writes: 0 };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  refreshActivePromotionCheckout().then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  });
}
