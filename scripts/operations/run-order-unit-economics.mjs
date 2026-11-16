import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const registryFile = join(root, 'pricing/price-registry.json');
const feeFile = join(root, 'pricing/fee-profiles/MY-20261030-reviewed-policy-v1.json');
const myr = value => typeof value === 'string' && /^-?\d+(\.\d{1,2})?$/u.test(value);
const minor = value => Math.round(Number(value) * 100);
const amount = value => (value / 100).toFixed(2);

function sumMyr(values) {
  if (!values.length || !values.every(myr)) return null;
  const cents = values.reduce((sum, value) => sum + minor(value), 0);
  return Number.isSafeInteger(cents) ? amount(cents) : null;
}

export function summarizeSkuSettlementBreakdowns(rows) {
  const entries = rows.map(row => row.settlement);
  const groups = { fees: 'feeBreakdown', tax: 'taxBreakdown', shipping: 'shippingBreakdown' };
  const subtotals = entries.map(row => Object.fromEntries(Object.entries(groups).map(([name, property]) =>
    [name, sumMyr(Object.values(row[property] ?? {}))])));
  const componentsMyr = { revenue: sumMyr(entries.map(row => row.revenue)),
    ...Object.fromEntries(Object.keys(groups).map(name => [name, sumMyr(subtotals.map(row => row[name]))])),
    net: sumMyr(entries.map(row => row.net)) };
  const unreconciledOrderIds = rows.filter(({ settlement }, index) => {
    const reconstructed = sumMyr([settlement.revenue, ...Object.values(subtotals[index])]);
    return reconstructed === null || !myr(settlement.net) || minor(reconstructed) !== minor(settlement.net);
  }).map(row => row.orderId);
  const feeFields = new Set(entries.flatMap(row => Object.keys(row.feeBreakdown ?? {})));
  const feesByFieldMyr = Object.fromEntries([...feeFields].sort().map(field =>
    [field, sumMyr(entries.map(row => row.feeBreakdown?.[field]))]));
  return { componentsMyr, feesByFieldMyr, reconciledOrderCount: rows.length - unreconciledOrderIds.length, unreconciledOrderIds };
}

async function readCostReference(review, productId, skuId) {
  const [bytes, fee] = await Promise.all([readFile(registryFile), readFile(feeFile, 'utf8').then(JSON.parse)]);
  if (createHash('sha256').update(bytes).digest('hex') !== review.registrySha256) throw new Error('Pricing ledger changed during review');
  const registry = JSON.parse(bytes);
  const priceIds = new Set(registry.shop_matches.filter(row => row.market === 'MY' && row.shop === '跨境1' &&
    row.product_id === productId && row.sku_id === skuId).map(row => row.price_id));
  const records = registry.confirmed_records.filter(row => row.market === 'MY' && priceIds.has(row.price_id))
    .map(row => ({ id: row.price_id, goodsCny: row.cost_cny, handlingCny: row.handling_cny, weightGrams: row.gross_grams,
      regularTargetMyr: row.original, priceFloorReferenceMyr: row.minimum_8pct, date: row.confirmed_date }));
  const commonCost = records[0]?.goodsCny;
  const unitCny = records.length === priceIds.size && new Set(records.map(row => row.id)).size === priceIds.size &&
    Number.isFinite(commonCost) && commonCost > 0 &&
    records.every(row => row.goodsCny === commonCost) ? commonCost : null;
  const fx = Number(fee.historical_FX_input);
  return { source: registryFile, versions: records, commonGoodsQuoteCny: unitCny,
    referenceFxCnyPerMyr: Number.isFinite(fx) && fx > 0 ? fx : null, fxSource: feeFile,
    actualLandedCost: null };
}

async function readOrder(client, token, shop, row, order, warehouses, productId, skuId) {
  const lines = order?.lines?.filter(line => line.productId === productId && line.skuId === skuId) ?? [];
  if (lines.length !== row.orderLineIds.length || new Set(lines.map(line => line.id)).size !== lines.length ||
      !lines.length || lines.some(line => !row.orderLineIds.includes(line.id))) {
    throw new Error('Order lines do not match the selected product and SKU');
  }
  const [price, settlement] = await Promise.all([
    client.orderPriceDetails(token, shop, row.orderId), client.orderSettlement(token, shop, row.orderId),
  ]);
  const exactPrices = price.lines.filter(line => row.orderLineIds.includes(line.id));
  const details = settlement.skuTransactions.filter(detail => detail.skuId === skuId);
  const [detail] = details;
  if (price.currency !== 'MYR' || exactPrices.length !== lines.length ||
      new Set(exactPrices.map(line => line.id)).size !== lines.length ||
      exactPrices.some(line => line.currency !== 'MYR' || !myr(line.buyerProduct)) ||
      settlement.currency !== 'MYR' || details.length !== 1 || detail.statementId !== row.settlement.statementId ||
      detail.quantity !== row.settlement.quantity || !myr(detail.settlementAmount) ||
      !myr(row.settlement.amount) || minor(detail.settlementAmount) !== minor(row.settlement.amount)) {
    throw new Error('Price or settlement does not match the exact ledger SKU');
  }
  const warehouse = warehouses.get(order.warehouseId);
  return { orderId: row.orderId, status: order.status, warehouseId: order.warehouseId,
    warehouseType: warehouse?.sub_type ?? null, warehouseRegion: warehouse?.address?.region ?? null,
    orderLineIds: row.orderLineIds, packageIds: [...new Set(lines.map(line => line.packageId).filter(isPlatformId))],
    buyerOrderPayment: price.payment, lines: exactPrices,
    settlement: { statementId: detail.statementId, quantity: detail.quantity, revenue: detail.revenueAmount,
      net: detail.settlementAmount, refundBeforeDiscount: detail.refundSubtotalBeforeDiscount,
      feeBreakdown: detail.feeBreakdown, taxBreakdown: detail.taxBreakdown, shippingBreakdown: detail.shippingBreakdown },
    actualNetProfit: null };
}

async function main() {
  const { values } = parseArgs({ options: {
    'product-id': { type: 'string' }, 'sku-id': { type: 'string' }, 'activity-id': { type: 'string' },
  } });
  const { 'product-id': productId, 'sku-id': skuId, 'activity-id': activityId } = values;
  if (![productId, skuId].every(isPlatformId) || (activityId && !isPlatformId(activityId))) {
    throw new Error('Expected an exact product ID, SKU ID, and optional activity ID');
  }
  const review = reviewFinanceSnapshot();
  const [credentials, authorization, cost] = await Promise.all([
    loadLocalAppCredentials(), loadLocalAuthorization(), readCostReference(review, productId, skuId),
  ]);
  const token = authorization.tokens?.access_token;
  if (authorization.serviceId !== credentials.serviceId || authorization.tokens?.user_type !== 0 || !token) {
    throw new Error('Matching TikTok Shop seller authorization is required');
  }
  const requests = [];
  const client = createTikTokClient({ ...credentials, async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ method: options.method, path: url.pathname, code: envelope?.code ?? null,
      status: response.status, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const shop = (await client.authorizedShops(token)).find(row => row.id === shopId && row.region === 'MY' && row.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia Cross1 shop is required');
  const cohort = review.rows.filter(row => row.productId === productId && row.skuId === skuId);
  const paid = cohort.filter(row => row.settlement.state === 'paid_statement');
  if (!paid.length || paid.length > 50) throw new Error('Expected 1 to 50 exact SKU rows in paid statements');
  const [orders, warehouseData, product, activity] = await Promise.all([
    client.operationalOrders(token, shop, paid.map(row => row.orderId)),
    client.listingWarehouses(token, shop), client.productDetail(token, shop, productId),
    activityId ? client.promotionActivity(token, shop, activityId) : null,
  ]);
  const sku = product.skus?.find(row => row.id === skuId);
  if (product.id !== productId || !sku || !Array.isArray(warehouseData.warehouses)) throw new Error('Exact SKU or warehouses not found');
  const warehouses = new Map(warehouseData.warehouses.map(row => [row.id, row]));
  const currentOrders = new Map(orders.map(row => [row.id, row]));
  if (orders.length !== paid.length || currentOrders.size !== paid.length) throw new Error('Unexpected order detail cohort');
  const rows = [];
  for (const row of paid) {
    rows.push(await readOrder(client, token, shop, row, currentOrders.get(row.orderId), warehouses, productId, skuId));
  }
  const activitySku = activity?.products?.find(row => row.id === productId)?.skus?.find(row => row.id === skuId);
  const offer = activitySku ? { id: activityId, title: activity.title, status: activity.status, type: activity.activity_type,
    from: activity.begin_time, to: activity.end_time, price: activitySku.activity_price ?? null,
    quantityLimit: activitySku.quantity_limit, usedQuantity: activitySku.used_quantity,
    quantityPerBuyer: activitySku.quantity_per_user } : null;
  if (activityId && !offer) throw new Error('Exact SKU not returned in requested activity');
  const delivered = rows.filter(row => ['DELIVERED', 'COMPLETED'].includes(row.status));
  const netMinor = delivered.reduce((total, row) => total + minor(row.settlement.net), 0);
  const quantity = delivered.reduce((total, row) => total + Number(row.settlement.quantity), 0);
  const goodsQuote = cost.commonGoodsQuoteCny !== null && cost.referenceFxCnyPerMyr !== null &&
    Number.isSafeInteger(quantity) && quantity > 0 ? cost.commonGoodsQuoteCny * quantity / cost.referenceFxCnyPerMyr : null;
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const receipt = { schema: 'operations-order-unit-economics/v1', day, observedAt,
    shop: { id: shop.id, region: shop.region, name: shop.name }, productId, skuId, financeFile: review.financeFile,
    catalogFile: review.catalogFile, orderWindow: review.orderWindow, product: { status: product.status, listPrice: sku.price },
    offer, summary: { cohortSkuRows: cohort.length, checkedPaidStatementRows: rows.length, deliveredOrders: delivered.length,
      cancelledOrders: rows.filter(row => row.status === 'CANCELLED').length, deliveredNetMyr: amount(netMinor),
      deliveredUnits: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null,
      goodsQuoteTotalMyr: goodsQuote === null ? null : goodsQuote.toFixed(2),
      balanceAfterGoodsQuoteMyr: goodsQuote === null ? null : (netMinor / 100 - goodsQuote).toFixed(2),
      actualNetProfit: null }, deliveredSettlementBreakdown: summarizeSkuSettlementBreakdowns(delivered), cost, rows, requests };
  const dir = join(root, 'outputs/operations-order-unit-economics', day, skuId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, skuId, offer, summary: receipt.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
