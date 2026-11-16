import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

export async function readNewArrivalSalesHistory(item, { client, token, shop }, now = Date.now()) {
  if (!isPlatformId(item.productId) || !isPlatformId(item.skuId)) throw new Error('Exact new arrival product and SKU required');
  const { data: product, requestId: productRequestId } = await client.productDetail(token, shop, item.productId, { includeRequestId: true });
  const cutoff = Math.floor(now / 1000);
  if (!productRequestId || product.id !== item.productId ||
      product.skus?.filter(row => row.id === item.skuId && (!item.sellerSku || row.seller_sku === item.sellerSku)).length !== 1 ||
      !Number.isSafeInteger(product.create_time) || product.create_time >= cutoff || product.create_time < cutoff - 60 * 86_400) {
    throw new Error('The exact product and its creation date must match the new arrival window');
  }
  const windows = [];
  const seen = new Set();
  const matches = [];
  const deadline = Date.now() + 90_000;
  for (let from = product.create_time; from < cutoff;) {
    const to = Math.min(cutoff, from + 604_800);
    const requestIds = [];
    const page = await collectPages(async cursor => {
      const data = await client.ordersPage(token, shop, 100, cursor, from, to, { includeRequestId: true });
      if (!data.requestId) throw new Error('Missing order request ID');
      requestIds.push(data.requestId);
      return data;
    }, deadline);
    if (page.totalCount !== page.rows.length) throw new Error('Incomplete new arrival order window');
    for (const row of page.rows) {
      if (!isPlatformId(row.id) || seen.has(row.id) || !Number.isSafeInteger(row.createdAt) || row.createdAt < from || row.createdAt >= to ||
          !row.skus?.length || row.skus.some(line => !isPlatformId(line.lineId) || !isPlatformId(line.productId) || !isPlatformId(line.id) ||
            (line.id === item.skuId && line.productId !== item.productId))) throw new Error('New arrival order scope or line identity changed');
      seen.add(row.id);
      const lines = row.skus.filter(line => line.productId === item.productId);
      if (lines.length) matches.push({ orderId: row.id, status: row.status, createdAt: row.createdAt, sampleOrder: row.sampleOrder, lines });
    }
    windows.push({ startInclusive: from, endExclusive: to, orders: page.rows.length, pages: page.pages, requestIds });
    from = to;
  }
  return { schema: 'operations-new-arrival-sales-history/v1', observedAt: new Date().toISOString(),
    shop: { id: shop.id, name: shop.name, region: shop.region }, productId: item.productId, skuId: item.skuId, productRequestId,
    productCreatedAt: product.create_time, orderCutoffExclusive: cutoff, windows, shopOrders: seen.size,
    matchingProductOrders: matches.length, matchingSkuOrders: matches.filter(row => row.lines.some(line => line.id === item.skuId)).length,
    matches, writes: 0 };
}

async function scan(loadPage, key, requestIds) {
  const seen = new Set();
  const result = await collectPages(async cursor => {
    const { data, requestId } = await loadPage(cursor);
    if (!requestId) throw new Error('Missing ' + key + ' index request ID');
    requestIds.push(requestId);
    const nextToken = data.next_page_token ?? '';
    if (!Array.isArray(data[key]) || typeof nextToken !== 'string' || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
      throw new Error('Incomplete ' + key + ' index');
    }
    for (const row of data[key]) {
      if (!isPlatformId(row.id) || seen.has(row.id)) throw new Error('Missing or duplicated ' + key + ' identity');
      seen.add(row.id);
    }
    return { rows: data[key], nextToken, totalCount: data.total_count };
  }, Date.now() + 60_000);
  return result.rows;
}

function relatedProduct(activity, productId, skuId) {
  const product = activity.products?.find(entry => entry.id === productId);
  if (activity.product_level === 'SHOP') {
    return Array.isArray(activity.exclude_product_ids) ? !activity.exclude_product_ids.includes(productId) : null;
  }
  if (!Array.isArray(activity.products)) return null;
  if (activity.product_level === 'PRODUCT') return Boolean(product);
  if (activity.product_level === 'VARIATION') {
    return !product ? false : Array.isArray(product.skus) ? product.skus.some(entry => entry.id === skuId) : null;
  }
  return null;
}

export async function readMerchantActivities({ client, token, shop }, status, requestIds = []) {
  const options = { includeRequestId: true };
  const rows = await scan(cursor => client.promotionActivities(token, shop, cursor, status, options), 'activities', requestIds);
  const result = [];
  for (const row of rows) {
    const { data: activity, requestId } = await client.promotionActivity(token, shop, row.id, options);
    if (!requestId || (activity.activity_id ?? activity.id) !== row.id) throw new Error('Activity identity mismatch');
    requestIds.push(requestId);
    if (activity.status !== status) throw new Error('Activity status changed during read');
    result.push(activity);
  }
  return result;
}

function projectCoupon(coupon, productId) {
  const scope = coupon.product_scope?.type ?? coupon.product_scope ?? null;
  const productIds = coupon.product_ids ?? coupon.product_scope?.product_ids;
  return { id: coupon.id, status: coupon.status, displayType: coupon.display_type ?? null,
    channels: coupon.display_channels ?? null, targetSegment: coupon.target_buyer_segment ?? null,
    claimDuration: coupon.claim_duration ?? null, redemptionDuration: coupon.redemption_duration ?? null,
    discount: coupon.discount ?? null, threshold: coupon.threshold ?? null, productScope: scope,
    productIncluded: scope === 'ALL_PRODUCTS' ? true :
      scope === 'SPECIFIC_PRODUCTS' && Array.isArray(productIds) ? productIds.includes(productId) : null };
}

async function attempt(operation) {
  const requestIds = [];
  try {
    return { complete: true, result: await operation(requestIds), requestIds };
  } catch (error) {
    const transport = error.cause?.code ?? error.name;
    return { complete: false, error: publicPlatformError(error, 'Read failed (' + transport + ')'),
      platformCode: error.platformCode ?? null, requestIds, failedRequestId: error.requestId ?? null };
  }
}

export async function readMerchantPromotionPreflight(items, { shop, client, token }) {
  if (!items.length || items.some(({ productId, skuId }) => !isPlatformId(productId) || !isPlatformId(skuId))) {
    throw new Error('Exact promotion product and SKU required');
  }
  const project = (check, map) => check.complete ? { ...check, result: check.result.map(map) } : check;
  const withRequestId = { includeRequestId: true };
  const couponCheck = await attempt(async requestIds => {
    const rows = await scan(cursor => client.promotionCoupons(token, shop, cursor, withRequestId), 'coupons', requestIds);
    const result = [];
    for (const row of rows) {
      const { data, requestId } = await client.promotionCoupon(token, shop, row.id, withRequestId);
      const detail = data.coupon;
      if (!requestId || detail?.id !== row.id) throw new Error('Coupon identity mismatch');
      requestIds.push(requestId);
      if (!['ONGOING', 'NOT_START'].includes(detail.status)) throw new Error('Coupon status changed during read');
      result.push(detail);
    }
    return result;
  });
  const activities = {};
  for (const status of ['ONGOING', 'NOT_START']) {
    activities[status] = await attempt(requestIds => readMerchantActivities({ client, token, shop }, status, requestIds));
  }
  return Promise.all(items.map(async ({ productId, skuId, sellerSku }) => {
    const [{ data: product, requestId: productRequestId }, openAffiliate] = await Promise.all([
      client.productDetail(token, shop, productId, withRequestId),
      attempt(async requestIds => {
        const rows = await scan(cursor => client.openAffiliateProducts(token, shop, productId, cursor, withRequestId), 'open_collaborations', requestIds);
        if (rows.some(row => row.product?.id !== productId)) throw new Error('Open collaboration product mismatch');
        return rows.map(row => ({ status: row.status, commission: row.current_commission ?? null }));
      }),
    ]);
    const matches = product.skus?.filter(entry => entry.id === skuId) ?? [];
    const [sku] = matches;
    if (!productRequestId || product.id !== productId || matches.length !== 1 || (sellerSku && sku.seller_sku !== sellerSku)) {
      throw new Error('Exact product/SKU not returned');
    }
    return { schema: 'operations-promotion-preflight/v1', checkedAt: new Date().toISOString(),
      shop: { id: shop.id, region: shop.region, name: shop.name }, productId, skuId, productRequestId,
      product: { status: product.status, sellerSku: sku.seller_sku, price: sku.price,
        createdAt: product.create_time ?? null, sellingFormat: product.selling_format ?? null,
        inventory: sku.inventory?.map(row => ({ warehouseId: row.warehouse_id, quantity: row.quantity,
          availableQuantity: row.available_quantity ?? null })) ?? null },
      couponCheck: project(couponCheck, row => projectCoupon(row, productId)),
      activities: Object.fromEntries(Object.entries(activities).map(([status, check]) => [status, project(check, row => ({
        id: row.activity_id ?? row.id, type: row.activity_type, level: row.product_level, from: row.begin_time, to: row.end_time,
        applies: relatedProduct(row, productId, skuId),
      }))])), openAffiliate };
  }));
}

async function main() {
  const [productId, skuId, output, ...extra] = process.argv.slice(2);
  if (extra.length || !/^\d{8,30}$/u.test(productId ?? '') || !/^\d{8,30}$/u.test(skuId ?? '') || !output) {
    throw new Error('Usage: node scripts/operations/read-promotion-preflight.mjs <product-id> <sku-id> <output-dir>');
  }
  const [receipt] = await readMerchantPromotionPreflight([{ productId, skuId }], await openMyShopSession('9000000000000000099'));
  const dir = resolve(output);
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, 'promotion-preflight-' + receipt.checkedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...receipt, file }, null, 2));
  if (!receipt.couponCheck.complete || Object.values(receipt.activities).some(check => !check.complete) ||
      !receipt.openAffiliate.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
