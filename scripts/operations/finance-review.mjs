import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { snapshotFilename } from '../../apps/customer-service/tiktok-shop-finance.mjs';

const shopId = '9000000000000000099';
const root = fileURLToPath(new URL('../../', import.meta.url));
const snapshots = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
const money = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value);
const isCross1 = shop => shop?.id === shopId && shop?.name === 'example-shop-my' && shop?.region === 'MY';

function group(rows, key) {
  const byKey = new Map();
  for (const row of rows) {
    const id = key(row);
    if (!id) continue;
    const entries = byKey.get(id) ?? [];
    entries.push(row);
    byKey.set(id, entries);
  }
  return byKey;
}

function catalogKey(productId, skuId) {
  return productId && skuId ? productId + ':' + skuId : null;
}

function costFor(productId, skuId, bindings, records) {
  const ids = new Set((bindings.get(catalogKey(productId, skuId)) ?? []).map(row => row.price_id).filter(Boolean));
  if (ids.size !== 1) return { state: ids.size ? 'ambiguous' : 'no_binding' };
  const priceId = ids.values().next().value;
  const versions = records.get(priceId) ?? [];
  if (versions.length > 1) return { state: 'ambiguous', priceId };
  const entry = versions[0];
  const amount = Number(entry?.cost_cny);
  if (!Number.isFinite(amount) || amount <= 0) return { state: 'no_confirmed_cost', priceId };
  const handling = entry.handling_cny;
  return { state: 'pricing_estimate', priceId, unitCny: amount,
    handlingCny: handling != null && handling !== '' && Number.isFinite(Number(handling)) && Number(handling) >= 0
      ? Number(handling) : null,
    confirmedDate: entry.confirmed_date ?? null };
}

function settlementFor(order, detailRows) {
  const unavailable = state => ({ state, amount: null });
  if (order.settlementStatus !== 'statement_found') return unavailable(order.settlementStatus);
  const settlement = order.settlement;
  if (settlement?.detailStatus !== 'available') return unavailable('sku_detail_unavailable');
  if (detailRows.length > 1) return unavailable('ambiguous_sku_detail');
  const detail = detailRows[0];
  if (detail?.matchesOrderSku !== true || !money(detail.settlementAmount)) return unavailable('no_exact_sku_detail');
  if (settlement.detail.currency !== 'MYR') return unavailable('currency_unverified');
  const transactions = settlement.transactions ?? [];
  const isPaid = transactions.length > 0 && transactions.every(row => row.paymentStatus === 'PAID');
  return { state: isPaid ? 'paid_statement' : 'statement_payment_pending_or_unknown',
    amount: detail.settlementAmount, currency: 'MYR', quantity: detail.quantity ?? null,
    statementId: detail.statementId ?? null };
}

export function reviewFinance({ catalog, catalogFile, finance, registry }) {
  if (!isCross1(catalog?.shop) || !isCross1(finance?.shop)) throw new Error('Unexpected shop for MY Cross1 review');
  if (finance.kind !== 'order-finance' || !snapshotFilename.test(catalogFile) || finance.basis !== catalogFile) {
    throw new Error('Finance snapshot does not identify this order snapshot');
  }
  const window = catalog.orderWindow;
  if (!Number.isSafeInteger(window?.startInclusive) || !Number.isSafeInteger(window?.endExclusive) ||
      window.startInclusive >= window.endExclusive || window.startInclusive !== finance.orderWindow?.startInclusive ||
      window.endExclusive !== finance.orderWindow?.endExclusive) throw new Error('Order cohort window mismatch');
  const catalogOrders = catalog.orders?.rows;
  const financeOrders = finance.orders;
  if (!Array.isArray(catalogOrders) || !Array.isArray(financeOrders)) throw new Error('Missing order cohort');
  const byOrder = group(financeOrders, order => order.orderId);
  const orderIds = new Set(catalogOrders.map(order => order.id));
  if (orderIds.has(null) || orderIds.has(undefined) || orderIds.size !== catalogOrders.length ||
      byOrder.size !== orderIds.size || financeOrders.length !== orderIds.size ||
      [...orderIds].some(id => byOrder.get(id)?.length !== 1)) throw new Error('Order cohort is missing or duplicated');

  const bindings = group(registry.shop_matches.filter(row => row.market === 'MY' && row.shop === '跨境1'),
    row => catalogKey(row.product_id, row.sku_id));
  const records = group(registry.confirmed_records.filter(row => row.market === 'MY'), row => row.price_id);
  const summary = { orders: orderIds.size, orderLines: 0, orderSkus: 0, incompleteOrderLines: 0,
    costMatchedOrderLines: 0, costMatchedOrderSkus: 0, paidSettlementOrderSkus: 0, paidSettlementWithCost: 0,
    unmatchedFinanceRows: 0, adjustmentRows: 0,
    ordersWithReturnRecords: finance.returns?.status === 'available' ? 0 : null, settlementStates: {}, costStates: {} };
  const rows = [];
  const costReview = new Map();
  for (const order of catalogOrders) {
    const f = byOrder.get(order.id)[0];
    const orderLines = order.skus ?? [];
    const bySku = group(orderLines, row => row.id);
    const details = f.settlement?.detail?.skuTransactions ?? [];
    const byDetailSku = group(details, row => row.skuId);
    summary.orderLines += orderLines.length;
    summary.incompleteOrderLines += orderLines.filter(line => !line.id || !line.lineId || !line.productId).length;
    summary.unmatchedFinanceRows += details.filter(line => !bySku.has(line.skuId) || line.matchesOrderSku !== true).length;
    summary.adjustmentRows += f.settlement?.adjustments?.length ?? 0;
    if (summary.ordersWithReturnRecords !== null && f.returnRecords?.length) summary.ordersWithReturnRecords += 1;
    for (const [skuId, lines] of bySku) {
      const productIds = new Set(lines.map(line => line.productId));
      const productId = productIds.size === 1 ? lines[0].productId ?? null : null;
      const orderLineIds = [...new Set(lines.map(line => line.lineId).filter(Boolean))].sort();
      const cost = costFor(productId, skuId, bindings, records);
      const settlement = productId ? settlementFor(f, byDetailSku.get(skuId) ?? []) :
        { state: 'product_identity_unverified', amount: null };
      summary.costStates[cost.state] = (summary.costStates[cost.state] ?? 0) + 1;
      summary.settlementStates[settlement.state] = (summary.settlementStates[settlement.state] ?? 0) + 1;
      summary.orderSkus += 1;
      if (cost.state === 'pricing_estimate') {
        summary.costMatchedOrderSkus += 1;
        summary.costMatchedOrderLines += orderLineIds.length;
      }
      if (settlement.state === 'paid_statement') {
        summary.paidSettlementOrderSkus += 1;
        if (cost.state === 'pricing_estimate') summary.paidSettlementWithCost += 1;
      }
      const key = catalogKey(productId, skuId);
      if (key && cost.state !== 'pricing_estimate') {
        const item = costReview.get(key) ?? { productId, skuId, state: cost.state, orderSkuCount: 0, paidCount: 0 };
        item.orderSkuCount += 1;
        if (settlement.state === 'paid_statement') item.paidCount += 1;
        costReview.set(key, item);
      }
      rows.push({ orderId: order.id, skuId, productId, orderLineIds, orderStatus: order.status,
        settlement, cost, actualNetProfit: null });
    }
  }
  const costReviewQueue = [...costReview.values()].sort((a, b) =>
    b.paidCount - a.paidCount || b.orderSkuCount - a.orderSkuCount || a.skuId.localeCompare(b.skuId));
  return { schema: 'operations-finance-review/v1', shop: finance.shop, catalogFile,
    catalogCollectedAt: catalog.collectedAt ?? null, financeCollectedAt: finance.collectedAt ?? null,
    orderWindow: window, statementsStatus: finance.statements?.status ?? null,
    refundsStatus: finance.returns?.status ?? null, summary, costReviewQueue, rows };
}

export function reviewFinanceSnapshot(filename) {
  const folder = join(snapshots, 'finance');
  const latest = filename ? null : readdirSync(folder).filter(name => snapshotFilename.test(name)).sort().at(-1);
  if (!filename && !latest) throw new Error('No finance snapshot for MY Cross1');
  const financeFile = filename ? resolve(filename) : join(folder, latest);
  const finance = JSON.parse(readFileSync(financeFile, 'utf8'));
  if (!snapshotFilename.test(finance.basis ?? '')) throw new Error('Invalid finance snapshot basis');
  const catalog = JSON.parse(readFileSync(join(dirname(dirname(financeFile)), finance.basis), 'utf8'));
  const registryBytes = readFileSync(join(root, 'pricing', 'price-registry.json'));
  const result = reviewFinance({ catalog, catalogFile: finance.basis, finance, registry: JSON.parse(registryBytes) });
  return { ...result, financeFile: basename(financeFile),
    registrySha256: createHash('sha256').update(registryBytes).digest('hex') };
}

export function compareFinanceReviews(previous, current) {
  if (!isCross1(previous.shop) || !isCross1(current.shop)) throw new Error('Unexpected shop for MY Cross1 comparison');
  const key = row => row.orderId + ':' + row.skuId;
  const paid = row => row.settlement.state === 'paid_statement';
  const before = new Map(previous.rows.map(row => [key(row), row]));
  const after = new Map(current.rows.map(row => [key(row), row]));
  const left = previous.rows.filter(row => !after.has(key(row)));
  const entered = current.rows.filter(row => !before.has(key(row)));
  const retained = current.rows.filter(row => before.has(key(row)));
  const source = review => ({ financeFile: review.financeFile ?? null, orderWindow: review.orderWindow,
    statementsStatus: review.statementsStatus, orders: review.summary.orders,
    paidOrderSkus: review.summary.paidSettlementOrderSkus });
  return { schema: 'operations-finance-delta/v1', shop: current.shop,
    previous: source(previous), current: source(current),
    orderSkusLeftWindow: left.length, orderSkusEnteredWindow: entered.length,
    paidLeftWindow: left.filter(paid).length, paidEnteredWindow: entered.filter(paid).length,
    retainedPaidNoLongerVerified: retained.filter(row => paid(before.get(key(row))) && !paid(row)).length,
    retainedNewlyPaid: retained.filter(row => !paid(before.get(key(row))) && paid(row)).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args.length === 3 && args[0] === '--compare') {
      result = compareFinanceReviews(reviewFinanceSnapshot(args[1]), reviewFinanceSnapshot(args[2]));
    } else if (args.length <= 1 && args[0] !== '--compare') {
      result = reviewFinanceSnapshot(args[0]);
    } else {
      throw new Error('Usage: node scripts/operations/finance-review.mjs [snapshot path | --compare previous current]');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
