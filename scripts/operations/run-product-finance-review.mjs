import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const snapshots = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
const commerceStatuses = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
const daySeconds = 86_400;
const midnight = date => Date.parse(date + 'T00:00:00+08:00') / 1000;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function completeMalaysiaDays({ startInclusive, endExclusive }) {
  if (!Number.isSafeInteger(startInclusive) || !Number.isSafeInteger(endExclusive) || startInclusive >= endExclusive) {
    throw new Error('Invalid source order window');
  }
  const startDay = dayKey(new Date(startInclusive * 1000));
  const endDateExclusive = dayKey(new Date(endExclusive * 1000));
  const start = midnight(startDay) + (midnight(startDay) < startInclusive ? daySeconds : 0);
  const end = midnight(endDateExclusive);
  if (start >= end) throw new Error('No complete MY calendar day in the order snapshot');
  return { startDate: dayKey(new Date(start * 1000)), endDateExclusive, startInclusive: start, endExclusive: end,
    days: (end - start) / daySeconds };
}

function netCents(value) {
  const match = typeof value === 'string' && /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/u.exec(value);
  if (!match) return null;
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
}

function centsText(value) {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function sumAvailable(rows, key) {
  return rows.length && rows.every(row => row[key] !== null) ? rows.reduce((total, row) => total + row[key], 0) : null;
}

async function verifyLegacyOrderTypes(client, token, shop, orders, window) {
  const candidates = orders.filter(row => row.createdAt >= window.startInclusive && row.createdAt < window.endExclusive &&
    commerceStatuses.has(row.status) && typeof row.sampleOrder !== 'boolean');
  const resolved = new Map();
  for (let offset = 0; offset < candidates.length; offset += 50) {
    const batch = candidates.slice(offset, offset + 50);
    const expected = new Map(batch.map(order => [order.id, order]));
    for (const order of await client.operationalOrders(token, shop, batch.map(row => row.id))) {
      const prior = expected.get(order.id);
      if (!prior || resolved.has(order.id)) throw new Error('Unexpected order ID while verifying sample status');
      const lines = new Map(prior.skus?.map(line => [line.lineId, line]));
      const exact = Array.isArray(order.lines) && order.lines.length === lines.size &&
        new Set(order.lines.map(line => line.id)).size === lines.size && order.lines.every(line =>
          lines.get(line.id)?.id === line.skuId && lines.get(line.id)?.productId === line.productId);
      if (exact && typeof order.sampleOrder === 'boolean') resolved.set(order.id, order.sampleOrder);
    }
  }
  return { candidates: candidates.length, verified: resolved.size,
    orders: orders.map(row => resolved.has(row.id) ? { ...row, sampleOrder: resolved.get(row.id) } : row) };
}

export function compareProductFinance(performanceRows, orders, financeRows, window, confirmedStatements = null) {
  const windowOrders = orders.filter(order => order.createdAt >= window.startInclusive && order.createdAt < window.endExclusive);
  const catalogOrders = new Map(windowOrders.filter(order => commerceStatuses.has(order.status)).map(order => [order.id, order]));
  const ordersByProduct = new Map();
  const ordersByProductDay = new Map();
  const cancellationsByProduct = new Map();
  for (const order of windowOrders) {
    const destination = order.status === 'CANCELLED' ? cancellationsByProduct : catalogOrders.has(order.id) ? ordersByProduct : null;
    if (!destination) continue;
    for (const productId of new Set((order.skus ?? []).map(line => line.productId).filter(isPlatformId))) {
      const ids = destination.get(productId) ?? new Set();
      ids.add(order.id);
      destination.set(productId, ids);
      if (destination === ordersByProduct) {
        const day = dayKey(new Date(order.createdAt * 1000));
        const byDay = ordersByProductDay.get(productId) ?? new Map();
        const group = byDay.get(day) ?? new Map();
        const skuIds = new Set((order.skus ?? []).filter(line => line.productId === productId && isPlatformId(line.id)).map(line => line.id));
        group.set(order.id, skuIds.size);
        byDay.set(day, group);
        ordersByProductDay.set(productId, byDay);
      }
    }
  }
  const financeByProduct = new Map();
  for (const row of financeRows) {
    const order = catalogOrders.get(row.orderId);
    const exact = order?.skus?.filter(line => line.productId === row.productId && line.id === row.skuId) ?? [];
    if (!exact.length || !Array.isArray(row.orderLineIds) || exact.length !== row.orderLineIds.length ||
        new Set(row.orderLineIds).size !== exact.length || !exact.every(line => row.orderLineIds.includes(line.lineId))) continue;
    const items = financeByProduct.get(row.productId) ?? [];
    items.push(row);
    financeByProduct.set(row.productId, items);
  }
  const statementsByProduct = new Map();
  const confirmedKeys = new Set();
  for (const entry of confirmedStatements ?? []) {
    const order = catalogOrders.get(entry.orderId);
    if (!order || !Array.isArray(entry.skuTransactions)) continue;
    const payment = new Map((entry.statements ?? []).map(row => [row.id, row.paymentStatus]));
    for (const transaction of entry.skuTransactions) {
      const matching = order.skus?.filter(line => line.id === transaction.skuId) ?? [];
      const productId = matching[0]?.productId;
      const net = netCents(transaction.net);
      if (!isPlatformId(productId) || !isPlatformId(transaction.statementId) || net === null || !payment.has(transaction.statementId) ||
          matching.length !== Number(transaction.quantity) || matching.some(line => line.productId !== productId)) continue;
      const key = entry.orderId + ':' + transaction.skuId;
      if (confirmedKeys.has(key)) throw new Error('Duplicated confirmed order SKU in statement reconciliation');
      confirmedKeys.add(key);
      const items = statementsByProduct.get(productId) ?? [];
      items.push({ orderId: entry.orderId, skuId: transaction.skuId, net, paymentStatus: payment.get(transaction.statementId) });
      statementsByProduct.set(productId, items);
    }
  }
  const performanceIds = new Set(performanceRows.map(row => row.productId));
  const matchedOrderIds = new Set();
  const rows = performanceRows.map(row => {
    const ids = ordersByProduct.get(row.productId) ?? new Set();
    for (const id of ids) matchedOrderIds.add(id);
    const ledger = financeByProduct.get(row.productId) ?? [];
    const paid = ledger.filter(item => item.settlement.state === 'paid_statement' && item.settlement.currency === 'MYR' &&
      isPlatformId(item.settlement.statementId)).map(item => ({ item, net: netCents(item.settlement.amount) })).filter(item => item.net !== null);
    const financialNet = paid.length ? centsText(paid.reduce((total, item) => total + item.net, 0n)) : null;
    const direct = (statementsByProduct.get(row.productId) ?? [])
      .filter(item => !paid.some(p => p.item.orderId === item.orderId && p.item.skuId === item.skuId));
    const sampleFlags = [...ids].map(id => catalogOrders.get(id).sampleOrder);
    const settled = [...paid.map(({ item, net }) => ({ orderId: item.orderId, net })), ...direct];
    const sampleRows = settled.filter(item => catalogOrders.get(item.orderId).sampleOrder === true);
    const nonSampleRows = settled.filter(item => catalogOrders.get(item.orderId).sampleOrder === false);
    const orderTypes = {
      sampleOrders: sampleFlags.filter(flag => flag === true).length,
      nonSampleOrders: sampleFlags.filter(flag => flag === false).length,
      unknownSampleFlag: sampleFlags.filter(flag => typeof flag !== 'boolean').length,
      sampleSettlementSkuRows: sampleRows.length,
      sampleSettlementNetMyr: sampleRows.length ? centsText(sampleRows.reduce((sum, item) => sum + item.net, 0n)) : null,
      nonSampleSettlementSkuRows: nonSampleRows.length,
      nonSampleSettlementNetMyr: nonSampleRows.length ? centsText(nonSampleRows.reduce((sum, item) => sum + item.net, 0n)) : null,
      unknownSettlementSampleFlag: settled.length - sampleRows.length - nonSampleRows.length,
    };
    const orderDays = [...(ordersByProductDay.get(row.productId) ?? [])].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, group]) => ({ day, exactOrders: group.size,
        orderSkuPairs: [...group.values()].reduce((total, count) => total + count, 0),
        exactLineItems: [...group.keys()].reduce((total, id) => total +
          catalogOrders.get(id).skus.filter(line => line.productId === row.productId && isPlatformId(line.id)).length, 0) }));
    return { ...row, orderDetailOrders: ids.size, analyticsOrderDifference: row.analyticsOrders === null ? null : row.analyticsOrders - ids.size,
      orderDays,
      cancelledOrders: cancellationsByProduct.get(row.productId)?.size ?? 0,
      linkedFinanceSkuRows: ledger.length, paidSkuRows: paid.length, paidNetMyr: financialNet,
      pendingPaymentSkuRows: ledger.filter(item => item.settlement.state === 'statement_payment_pending_or_unknown').length,
      directSettlementSkuRows: confirmedStatements ? direct.length : null,
      directSettlementNetMyr: direct.length ? centsText(direct.reduce((sum, row) => sum + row.net, 0n)) : null,
      directSettlementPaymentUnverified: confirmedStatements ? direct.filter(item => item.paymentStatus !== 'PAID').length : null,
      orderTypes,
      estimatedCostSkuRows: ledger.filter(item => item.cost.state === 'pricing_estimate').length, actualProfitMyr: null };
  });
  const gaps = rows.filter(row => row.analyticsOrderDifference !== null && row.analyticsOrderDifference !== 0);
  const checkouts = rows.filter(row => row.clicks > 0 && row.analyticsOrders === 0 && row.orderDetailOrders === 0)
    .sort((left, right) => right.clicks - left.clicks);
  const paidRows = rows.filter(row => row.paidNetMyr !== null);
  const directRows = rows.filter(row => row.directSettlementNetMyr !== null);
  const byOrders = rows.toSorted((left, right) => right.orderDetailOrders - left.orderDetailOrders);
  return { summary: { activeProductsInAnalytics: rows.length, impressions: sumAvailable(rows, 'impressions'), clicks: sumAvailable(rows, 'clicks'),
    analyticsProductOrders: sumAvailable(rows, 'analyticsOrders'), liveProductOrderPairs: rows.reduce((sum, row) => sum + row.orderDetailOrders, 0),
    exactPlatformOrders: catalogOrders.size, ordersMatchingLiveProducts: matchedOrderIds.size,
    cancelledPlatformOrders: windowOrders.filter(order => order.status === 'CANCELLED').length,
    productsWithOrdersOutsideLiveAnalytics: [...ordersByProduct.keys()].filter(id => !performanceIds.has(id)).length,
    orderCountDisagreementProducts: gaps.length, refundedItemsInAnalytics: sumAvailable(rows, 'refundedItems'),
    productsWithObservedClicksAndNoOrders: checkouts.length,
    paidSkuRows: rows.reduce((sum, row) => sum + row.paidSkuRows, 0),
    paidNetMyr: paidRows.length ? centsText(paidRows.reduce((sum, row) => sum + netCents(row.paidNetMyr), 0n)) : null,
    directSettlementSkuRows: sumAvailable(rows, 'directSettlementSkuRows'),
    directSettlementNetMyr: directRows.length ? centsText(directRows.reduce((sum, row) => sum + netCents(row.directSettlementNetMyr), 0n)) : null,
    directSettlementPaymentUnverified: sumAvailable(rows, 'directSettlementPaymentUnverified'),
    actualProfitMyr: null },
  mostOrdered: byOrders.filter(row => row.orderDetailOrders > 0).slice(0, 5),
  reviewQueue: { refundProducts: rows.filter(row => row.refundedItems > 0).sort((left, right) => right.refundedItems - left.refundedItems),
    clickedWithoutOrders: checkouts, orderCountDifferences: gaps }, rows };
}

async function latestDirectSettlement(day, finance) {
  const folder = join(root, 'outputs/operations-settlement-reconciliation', day);
  const files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const filename of files.filter(name => /^official-read-.*\.json$/u.test(name)).sort().reverse()) {
    const source = join(folder, filename);
    const receipt = JSON.parse(await readFile(source, 'utf8'));
    const rows = receipt.deliveredDetails?.orders;
    if (receipt.schema === 'operations-settlement-reconciliation/v1' && receipt.shop?.id === shopId &&
        receipt.shop.region === 'MY' && receipt.financeFile === finance.financeFile && receipt.catalogFile === finance.catalogFile &&
        receipt.orderWindow?.startInclusive === finance.orderWindow.startInclusive &&
        receipt.orderWindow.endExclusive === finance.orderWindow.endExclusive &&
        Array.isArray(rows) && rows.every(row => Array.isArray(row.skuTransactions))) return { source, rows };
  }
  return null;
}

async function main() {
  const supplied = process.argv[2];
  if (process.argv.length > 3) throw new Error('Usage: node scripts/operations/run-product-finance-review.mjs [finance-snapshot.json]');
  const finance = reviewFinanceSnapshot(supplied);
  const directory = supplied ? dirname(dirname(resolve(supplied))) : snapshots;
  const catalogFile = join(directory, finance.catalogFile);
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const window = completeMalaysiaDays(finance.orderWindow);
  const titles = new Map(catalog.products.rows.map(row => [row.id, row.title]));
  const { client, token, shop } = await openMyShopSession(shopId);
  const seen = new Set();
  const pages = await collectPages(async cursor => {
    const page = await client.productPerformancePage(token, shop, window.startDate, window.endDateExclusive, cursor);
    if (!Array.isArray(page.products)) throw new Error('Invalid product performance page');
    const rows = page.products.map(item => {
      const productId = item.id ?? item.product_id;
      if (!isPlatformId(productId) || seen.has(productId)) throw new Error('Missing or duplicated product performance ID');
      seen.add(productId);
      const metric = item.total_performance;
      return { id: productId, productId, title: item.title ?? item.product_name ?? titles.get(productId) ?? null,
        impressions: count(metric?.product_impressions), clicks: count(metric?.product_clicks), analyticsOrders: count(metric?.orders),
        itemsSold: count(metric?.items_sold), refundedItems: count(metric?.refunded_items) };
    });
    return { rows, nextToken: page.next_page_token ?? '', totalCount: count(page.total_count) };
  }, Date.now() + 120_000);
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const [direct, typed] = await Promise.all([
    latestDirectSettlement(day, finance),
    verifyLegacyOrderTypes(client, token, shop, catalog.orders.rows, window).catch(error => ({
      orders: catalog.orders.rows, candidates: null, verified: null,
      error: publicPlatformError(error, '原订单样品标记回查失败。'),
    })),
  ]);
  const result = compareProductFinance(pages.rows, typed.orders, finance.rows, window, direct?.rows);
  const output = join(root, 'outputs/operations-product-finance-review', day);
  await mkdir(output, { recursive: true });
  const file = join(output, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify({ schema: 'operations-product-finance-review/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, window, catalogFile: finance.catalogFile, financeFile: finance.financeFile,
    financeObservedAt: finance.financeCollectedAt, directSettlementSource: direct?.source ?? null,
    analyticsCoverage: 'LIVE', analyticsPages: pages.pages,
    orderTypeReadback: { candidates: typed.candidates, verified: typed.verified, error: typed.error ?? null },
    ...result }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, window, summary: result.summary, mostOrdered: result.mostOrdered.slice(0, 3).map(row => ({
    productId: row.productId, orders: row.orderDetailOrders, paidNetMyr: row.paidNetMyr, directSettlementNetMyr: row.directSettlementNetMyr })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
