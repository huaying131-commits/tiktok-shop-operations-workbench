import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const snapshots = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
const isCross1 = shop => shop?.id === shopId && shop.region === 'MY' && shop.name === 'example-shop-my';

function cents(value) {
  const parsed = typeof value === 'string' && /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!parsed || /[1-9]/u.test(parsed[3]?.slice(2) ?? '')) return null;
  const amount = Number(parsed[2]) * 100 + Number((parsed[3] ?? '').slice(0, 2).padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? (parsed[1] ? -amount : amount) : null;
}

function sum(values) {
  if (values.some(value => !Number.isSafeInteger(value))) return null;
  const result = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(result) ? result : null;
}

const amountText = value => value === null ? null : (value / 100).toFixed(2);

export function comparePaidOrderWindows(previous, current, previousCatalog, currentCatalog) {
  const inside = (createdAt, { startInclusive, endExclusive }) => createdAt >= startInclusive && createdAt < endExclusive;
  function index(receipt, catalog) {
    const window = receipt.orderWindow;
    if (!isCross1(receipt.shop) || !isCross1(catalog.shop) || receipt.settlement.currency !== 'MYR' ||
        !Number.isSafeInteger(window?.startInclusive) || !Number.isSafeInteger(window?.endExclusive) ||
        window.startInclusive >= window.endExclusive || catalog.orderWindow?.startInclusive !== window.startInclusive ||
        catalog.orderWindow?.endExclusive !== window.endExclusive) throw new Error('Paid comparison requires matching official order windows');
    const orders = new Map(catalog.orders.rows.map(row => [row.id, row.createdAt]));
    if (orders.size !== catalog.orders.rows.length || catalog.orders.rows.length !== receipt.settlement.orderCount ||
        catalog.orders.rows.some(row => !isPlatformId(row.id) || !Number.isSafeInteger(row.createdAt) || !inside(row.createdAt, window))) {
      throw new Error('Paid comparison requires the full order catalog');
    }
    const paid = new Map();
    for (const row of receipt.settlement.paid.orders) {
      const createdAt = orders.get(row.orderId);
      const net = cents(row.net);
      if (paid.has(row.orderId) || net === null || createdAt === undefined) throw new Error('Invalid paid order or order creation time');
      paid.set(row.orderId, { orderId: row.orderId, createdAt, net });
    }
    return { window, orders, paid };
  }
  const before = index(previous, previousCatalog);
  const after = index(current, currentCatalog);
  const outside = (source, other) => [...source.paid.values()].filter(row =>
    !other.orders.has(row.orderId) && !inside(row.createdAt, other.window));
  const agedOut = outside(before, after);
  const entered = outside(after, before);
  const total = rows => amountText(sum(rows.map(row => row.net)));
  const report = rows => ({ count: rows.length, net: total(rows),
    orders: rows.map(row => ({ ...row, net: amountText(row.net) })) });
  const beforeOverlap = [...before.paid.values()].filter(row => inside(row.createdAt, after.window));
  const afterOverlap = [...after.paid.values()].filter(row => inside(row.createdAt, before.window));
  for (const row of beforeOverlap) {
    const createdAt = after.orders.get(row.orderId);
    if (createdAt !== row.createdAt) throw new Error('Paid order identity missing or changed in the overlapping catalog');
  }
  for (const row of afterOverlap) {
    if (before.orders.get(row.orderId) !== row.createdAt) throw new Error('Paid order identity missing or changed in the overlapping catalog');
  }
  return { agedOut: report(agedOut), entered: report(entered), overlap: {
    beforeCount: beforeOverlap.length, afterCount: afterOverlap.length,
    beforeNet: total(beforeOverlap), afterNet: total(afterOverlap),
    changes: beforeOverlap.filter(row => after.paid.get(row.orderId)?.net !== row.net).length +
      afterOverlap.filter(row => !before.paid.has(row.orderId)).length,
  } };
}

export function compareEstimatedSettlements(estimated, settled) {
  const estimates = new Map(estimated.map(row => [row.orderId, cents(row.amount)]));
  if (estimates.size !== estimated.length || new Set(settled.map(row => row.orderId)).size !== settled.length) {
    throw new Error('Duplicate order in settlement comparison');
  }
  const matched = settled.filter(row => estimates.has(row.orderId)).map(row => {
    const estimate = estimates.get(row.orderId);
    const net = cents(row.net);
    const statementIds = row.statementIds ?? row.statements?.map(statement => statement.id);
    if (!isPlatformId(row.orderId) || estimate === null || net === null || !statementIds?.length ||
        !statementIds.every(isPlatformId) || new Set(statementIds).size !== statementIds.length) {
      throw new Error('Invalid estimated or actual settlement row');
    }
    return { orderId: row.orderId, statementIds, estimate, net, variance: net - estimate };
  });
  const total = field => amountText(sum(matched.map(row => row[field])));
  return { count: matched.length, previousEstimated: total('estimate'), actualNet: total('net'), totalVariance: total('variance'),
    sameAmountOrders: matched.filter(row => row.variance === 0).length,
    rows: matched.map(({ orderId, statementIds, estimate, net, variance }) => ({ orderId, statementIds,
      estimated: amountText(estimate), net: amountText(net), variance: amountText(variance) })) };
}

export function compareUnsettledRevisions(previous, current) {
  const index = rows => {
    const orders = new Map();
    const transactions = new Set();
    for (const row of rows) {
      const amount = cents(row.amount);
      if (!isPlatformId(row.orderId) || !isPlatformId(row.transactionId) || row.status !== 'UNSETTLED' ||
          amount === null || orders.has(row.orderId) || transactions.has(row.transactionId)) {
        throw new Error('Invalid or duplicated unsettled order transaction');
      }
      transactions.add(row.transactionId);
      orders.set(row.orderId, { transactionId: row.transactionId, amount });
    }
    return orders;
  };
  const before = index(previous);
  const after = index(current);
  const changes = [];
  let matched = 0;
  let transactionChanged = 0;
  for (const [orderId, fresh] of after) {
    const old = before.get(orderId);
    if (!old) continue;
    if (old.transactionId !== fresh.transactionId) {
      transactionChanged++;
      continue;
    }
    matched++;
    if (fresh.amount !== old.amount) changes.push({ orderId, transactionId: fresh.transactionId,
      previous: old.amount, current: fresh.amount, difference: fresh.amount - old.amount });
  }
  return { matched, changed: changes.length, transactionChanged, netChange: amountText(sum(changes.map(row => row.difference))),
    rows: changes.map(row => ({ orderId: row.orderId, transactionId: row.transactionId,
      previous: amountText(row.previous), current: amountText(row.current), difference: amountText(row.difference) })) };
}

export function matchStatementPayment(statement, rows) {
  const matches = rows.filter(row => row.id === statement.id);
  const [match] = matches;
  return matches.length === 1 && match.currency === statement.currency && match.createdAt === statement.createdAt
    ? match : null;
}

export async function readPaidStatementCoverage(client, token, shop, transition, orderWindow, now = Date.now()) {
  const { statement, cohort } = transition;
  const endExclusive = Math.floor(now / 1000);
  if (!isCross1(shop) || !isPlatformId(statement.id) || !isPlatformId(statement.paymentId) || statement.currency !== 'MYR' ||
      !Number.isSafeInteger(statement.createdAt) || !Number.isSafeInteger(statement.paymentTime) || statement.paymentTime >= endExclusive ||
      !Number.isSafeInteger(orderWindow.startInclusive) || orderWindow.endExclusive - orderWindow.startInclusive !== 604_800) {
    throw new Error('Exact paid MY statement and order window required');
  }
  const indexStart = statement.createdAt - 604_800;
  const index = await collectPages(cursor => client.statementsPage(token, shop, indexStart, endExclusive, cursor), Date.now() + 60_000);
  const matched = matchStatementPayment(statement, index.rows);
  if (matched?.paymentStatus !== 'PAID' || matched.paymentId !== statement.paymentId || matched.paymentTime !== statement.paymentTime) {
    throw new Error('Statement payment identity changed');
  }
  let header;
  const seen = new Set();
  const detail = await collectPages(async cursor => {
    const page = await client.statementTransactionsPage(token, shop, statement.id, cursor);
    const current = page.statement;
    if (current?.id !== statement.id || current.currency !== statement.currency || current.createdAt !== statement.createdAt ||
        (header && JSON.stringify(header) !== JSON.stringify(current)) || page.rows.some(row => {
          if (!isPlatformId(row.id) || seen.has(row.id)) return true;
          seen.add(row.id);
          return false;
        })) throw new Error('Statement transaction pagination changed');
    header = current;
    return page;
  }, Date.now() + 60_000);
  const orderRows = detail.rows.filter(row => row.type === 'ORDER');
  const orderIds = new Set(orderRows.map(row => row.orderId));
  const inWindow = new Map(cohort.orders.map(row => [row.orderId, cents(row.net)]));
  const byId = new Map(orderRows.map(row => [row.orderId, cents(row.amount)]));
  const settled = sum(detail.rows.map(row => cents(row.amount)));
  if (detail.totalCount !== detail.rows.length || orderIds.size !== orderRows.length || ![...orderIds].every(isPlatformId) ||
      inWindow.size !== cohort.orderCount || !inWindow.size || [...inWindow].some(([id, net]) => net === null || byId.get(id) !== net) ||
      sum([...inWindow.values()]) !== cents(cohort.net) || settled === null || settled !== cents(header.settlement) ||
      cents(header.payable) !== cents(statement.payable)) throw new Error('Statement order or amount reconciliation failed');
  const outside = orderRows.filter(row => !inWindow.has(row.orderId));
  const outsideDetails = new Map();
  for (let offset = 0; offset < outside.length; offset += 50) {
    const ids = outside.slice(offset, offset + 50).map(row => row.orderId);
    for (const order of await client.operationalOrders(token, shop, ids)) {
      if (!ids.includes(order.id) || outsideDetails.has(order.id)) throw new Error('Unexpected statement order detail');
      outsideDetails.set(order.id, order);
    }
  }
  const otherOrders = outside.map(row => {
    const order = outsideDetails.get(row.orderId);
    if (!Number.isSafeInteger(order?.createdAt) || (order.createdAt >= orderWindow.startInclusive && order.createdAt < orderWindow.endExclusive)) {
      throw new Error('Unmatched statement order could not be proved outside the review window');
    }
    return { orderId: row.orderId, status: order.status, createdAt: order.createdAt, net: row.amount };
  });
  return { statement: { ...header, paymentId: matched.paymentId, paymentStatus: matched.paymentStatus, paymentTime: matched.paymentTime },
    orderWindow, indexWindow: { startInclusive: indexStart, endExclusive }, indexPages: index.pages,
    samePaymentStatementIds: index.rows.filter(row => row.paymentId === matched.paymentId).map(row => row.id),
    transactionPages: detail.pages, transactionCount: detail.rows.length, statementOrderCount: orderRows.length,
    statementOrderNet: amountText(sum([...byId.values()])), otherTransactionCount: detail.rows.length - orderRows.length,
    windowOrderCount: inWindow.size, windowOrderNet: amountText(sum([...inWindow.values()])),
    outsideOrderCount: otherOrders.length, outsideOrderNet: amountText(sum(otherOrders.map(row => cents(row.net)))),
    otherOrders, bankReceiptVerified: false };
}

export function summarizeSettlementPayments(originalPaid, settledOrders, laterStatuses = new Map()) {
  if (!Array.isArray(originalPaid.orders) || !Array.isArray(settledOrders)) return null;
  const paid = originalPaid.orders.slice();
  const awaitingProof = [];
  const ids = [...paid, ...settledOrders].map(row => row.orderId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate orders in payment reconciliation');
  for (const row of settledOrders) {
    const confirmed = row.statements?.length > 0 &&
      row.statements.every(statement => (laterStatuses.get(statement.id) ?? statement.paymentStatus) === 'PAID');
    (confirmed ? paid : awaitingProof).push(row);
  }
  const total = rows => ({ orderCount: rows.length, net: amountText(sum(rows.map(row => cents(row.net)))) });
  return { platformPaid: total(paid), settledAwaitingPaymentProof: total(awaitingProof), bankReceiptVerified: false };
}

function byOrder(rows) {
  const groups = new Map();
  for (const row of rows) {
    const records = groups.get(row.orderId) ?? [];
    records.push(row);
    groups.set(row.orderId, records);
  }
  return groups;
}

export function reconcileSettlement({ catalog, finance, financeReview, unsettled }) {
  if (![catalog.shop, finance.shop, financeReview.shop].every(isCross1)) throw new Error('Expected the same MY shop');
  const cohort = new Map(catalog.orders.rows.map(order => [order.id, order]));
  const ledger = byOrder(financeReview.rows);
  const paid = [];
  const paidIssues = [];
  for (const row of finance.orders) {
    const { transactions, detail } = row.settlement ?? {};
    if (!transactions?.length || !transactions.every(tx => tx.paymentStatus === 'PAID')) continue;
    const orderSkus = ledger.get(row.orderId) ?? [];
    const statements = new Set(transactions.map(tx => tx.statementId));
    const net = cents(detail?.settlementAmount);
    const confirmed = net !== null && detail.currency === 'MYR' && cohort.has(row.orderId) && orderSkus.length > 0 &&
      orderSkus.length === detail.skuTransactions?.length &&
      transactions.every(tx => tx.currency === 'MYR' && isPlatformId(tx.id) && isPlatformId(tx.statementId)) &&
      new Set(transactions.map(tx => tx.id)).size === transactions.length &&
      orderSkus.every(sku => sku.settlement.state === 'paid_statement' && statements.has(sku.settlement.statementId)) &&
      sum(orderSkus.map(sku => cents(sku.settlement.amount))) === net && sum(transactions.map(tx => cents(tx.amount))) === net;
    if (!confirmed) {
      paidIssues.push(row.orderId);
      continue;
    }
    const revenue = cents(detail.revenueAmount);
    const feesAndTax = cents(detail.feeAndTaxAmount);
    const shipping = cents(detail.shippingCostAmount);
    paid.push({ orderId: row.orderId, orderStatus: cohort.get(row.orderId).status, statementIds: [...statements],
      net, revenue, feesAndTax, shipping, componentsAgree: sum([revenue, feesAndTax, shipping]) === net });
  }
  const paidIds = new Set(paid.map(row => row.orderId));
  const ambiguousPaidIds = new Set(paidIssues);
  const estimated = [];
  const estimateIssues = [];
  const relatedEstimates = byOrder(unsettled.filter(row => row.type === 'ORDER' && cohort.has(row.orderId)));
  for (const [orderId, rows] of relatedEstimates) {
    const [row] = rows;
    const value = cents(row.amount);
    if (paidIds.has(orderId) || ambiguousPaidIds.has(orderId) || rows.length !== 1 ||
        row.currency !== 'MYR' || row.status !== 'UNSETTLED' || value === null) {
      estimateIssues.push(orderId);
      continue;
    }
    estimated.push({ orderId, transactionId: row.id, amount: row.amount, status: row.status });
  }
  const known = new Set([...paidIds, ...estimated.map(row => row.orderId)]);
  const remainingByStatus = {};
  for (const [id, row] of cohort) {
    if (!known.has(id)) {
      const status = row.status ?? 'UNKNOWN';
      remainingByStatus[status] = (remainingByStatus[status] ?? 0) + 1;
    }
  }
  const components = Object.fromEntries(['revenue', 'feesAndTax', 'shipping'].map(field =>
    [field, amountText(sum(paid.map(row => row[field])))]));
  return { orderCount: cohort.size, currency: 'MYR',
    paid: { orderCount: paid.length, net: amountText(sum(paid.map(row => row.net))), ...components,
      componentMatches: paid.filter(row => row.componentsAgree).length, zeroNet: paid.filter(row => row.net === 0).length,
      issues: paidIssues, orders: paid.map(row => ({ ...row, net: amountText(row.net),
        revenue: amountText(row.revenue), feesAndTax: amountText(row.feesAndTax), shipping: amountText(row.shipping) })) },
    estimated: { orderCount: estimated.length, netEstimate: amountText(sum(estimated.map(row => cents(row.amount)))),
      issues: estimateIssues, orders: estimated },
    remainingOrderCount: cohort.size - known.size, remainingByStatus,
    excludedUnsettledRecords: unsettled.length - [...relatedEstimates.values()].reduce((count, rows) => count + rows.length, 0) };
}

async function reconcileDeliveredDetails(client, token, shop, catalog, settlement) {
  const accounted = new Set([...settlement.paid.orders, ...settlement.estimated.orders].map(row => row.orderId));
  const candidates = catalog.orders.rows.filter(row => row.status === 'DELIVERED' && !accounted.has(row.id));
  const linked = [];
  const issues = [];
  for (const order of candidates) {
    try {
      const detail = await client.orderSettlement(token, shop, order.id);
      const expected = new Set((order.skus ?? []).map(sku => sku.id));
      const skus = detail.skuTransactions;
      const net = cents(detail.settlementAmount);
      if (detail.currency !== 'MYR' || net === null || skus.length !== expected.size ||
          new Set(skus.map(row => row.skuId)).size !== skus.length ||
          skus.some(row => !expected.has(row.skuId) || !isPlatformId(row.statementId)) ||
          sum(skus.map(row => cents(row.settlementAmount))) !== net) throw new Error('Order detail and SKU amounts do not reconcile');
      linked.push({ orderId: order.id, net, statementIds: [...new Set(skus.map(row => row.statementId))],
        skuTransactions: skus.map(row => ({ skuId: row.skuId, statementId: row.statementId,
          quantity: row.quantity, net: row.settlementAmount })) });
    } catch (error) {
      issues.push({ orderId: order.id, error: publicPlatformError(error, error.message) });
    }
  }
  if (!linked.length) return { attemptedOrders: candidates.length, orderCount: 0, net: '0.00', orders: [], statements: [],
    indexedPaidOrderCount: 0, indexedPaidNet: '0.00', paymentStatusUnknownCount: 0, issues };

  const deadline = Date.now() + 60_000;
  const index = await collectPages(cursor => client.statementsPage(token, shop, catalog.orderWindow.startInclusive,
    Math.floor(Date.now() / 1000), cursor), deadline);
  const statementTransactions = new Map();
  const statements = [];
  for (const id of new Set(linked.flatMap(row => row.statementIds))) {
    try {
      let header;
      const transactions = await collectPages(async cursor => {
        const page = await client.statementTransactionsPage(token, shop, id, cursor);
        const detail = page.statement;
        if (detail.id !== id || detail.currency !== 'MYR' || detail.status !== 'SETTLED' ||
            detail.createdAt === null || (header && JSON.stringify(header) !== JSON.stringify(detail))) {
          throw new Error('Statement identity, state, or amounts changed during read');
        }
        header = detail;
        return page;
      }, deadline);
      statementTransactions.set(id, byOrder(transactions.rows.filter(row => row.type === 'ORDER')));
      const indexed = matchStatementPayment(header, index.rows);
      statements.push({ ...header, indexed: Boolean(indexed), paymentStatus: indexed?.paymentStatus ?? null,
        paymentId: indexed?.paymentId ?? null, paymentTime: indexed?.paymentTime ?? null,
        transactionCount: transactions.rows.length });
    } catch (error) {
      issues.push({ statementId: id, error: publicPlatformError(error, error.message) });
    }
  }
  const confirmed = linked.filter(row => {
    const transactions = row.statementIds.map(id => statementTransactions.get(id)?.get(row.orderId));
    const matched = transactions.every(entries => entries?.length) &&
      sum(transactions.flat().map(entry => cents(entry.amount))) === row.net;
    if (!matched) issues.push({ orderId: row.orderId, error: 'Statement transactions did not match order amount' });
    return matched;
  });
  const paymentStatuses = new Map(statements.map(row => [row.id, row.paymentStatus]));
  const indexedPaid = confirmed.filter(row => row.statementIds.every(id => paymentStatuses.get(id) === 'PAID'));
  const paymentUnknown = confirmed.filter(row => row.statementIds.some(id => !paymentStatuses.get(id)));
  return { attemptedOrders: candidates.length, orderCount: confirmed.length, net: amountText(sum(confirmed.map(row => row.net))),
    indexedPaidOrderCount: indexedPaid.length, indexedPaidNet: amountText(sum(indexedPaid.map(row => row.net))),
    paymentStatusUnknownCount: paymentUnknown.length,
    orders: confirmed.map(row => ({ orderId: row.orderId, net: amountText(row.net), skuTransactions: row.skuTransactions,
      statements: row.statementIds.map(id => ({ id, paymentStatus: paymentStatuses.get(id) ?? null })) })),
    statements, issues };
}

export async function reconcileSellerFunds(client, token, shop, delivered, endExclusive) {
  if (!delivered.statements.length) return { state: 'no_statements', matches: [] };
  const startInclusive = Math.min(...delivered.statements.map(row => row.createdAt));
  try {
    const ledger = await collectPages(cursor => client.sellerFundsTransactionsPage(token, shop, startInclusive, endExclusive, cursor),
      Date.now() + 60_000);
    const matches = delivered.statements.map(statement => {
      const wallet = ledger.rows.filter(row => row.currency === statement.currency);
      const exact = wallet.filter(row => (row.type === 'SETTLE' && row.id === statement.id) ||
        (row.type === 'WITHDRAW' && row.id === statement.paymentId));
      const payable = cents(statement.payable);
      const statementDay = dayKey(new Date(statement.createdAt * 1000));
      const sameDayAmountCandidates = wallet.filter(row => !exact.includes(row) && payable !== null &&
        cents(row.amount) === payable && Number.isSafeInteger(row.createdAt) && row.createdAt >= statement.createdAt &&
        dayKey(new Date(row.createdAt * 1000)) === statementDay);
      return { statementId: statement.id, exact, sameDayAmountCandidates };
    });
    return { state: 'read', window: { startInclusive, endExclusive }, rows: ledger.rows.length, pages: ledger.pages,
      bankReceiptVerified: false, matches };
  } catch (error) {
    return { state: 'unavailable', bankReceiptVerified: false, matches: [], error: publicPlatformError(error, error.message) };
  }
}

async function main() {
  const review = reviewFinanceSnapshot(process.argv[2]);
  const [credentials, authorization, catalog, finance, registryText] = await Promise.all([
    loadLocalAppCredentials(), loadLocalAuthorization(),
    ...[join(snapshots, review.catalogFile), join(snapshots, 'finance', review.financeFile)].map(async file =>
      JSON.parse(await readFile(file, 'utf8'))),
    readFile(join(root, 'pricing/price-registry.json'), 'utf8'),
  ]);
  if (createHash('sha256').update(registryText).digest('hex') !== review.registrySha256) throw new Error('Pricing ledger changed during review');
  const token = authorization.tokens?.access_token;
  if (credentials.serviceId !== authorization.serviceId || authorization.tokens?.user_type !== 0 || !token) {
    throw new Error('Matching TikTok seller authorization is required');
  }
  const requests = [];
  const client = createTikTokClient({ ...credentials, async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ method: options.method, path: url.pathname, status: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const shop = (await client.authorizedShops(token)).find(isCross1);
  if (!shop) throw new Error('Exact MY Cross1 shop is required');
  const { startInclusive, endExclusive } = review.orderWindow;
  const open = await collectPages(cursor => client.unsettledTransactionsPage(token, shop, startInclusive, endExclusive, cursor),
    Date.now() + 60_000);
  const settlement = reconcileSettlement({ catalog, finance, financeReview: review, unsettled: open.rows });
  const deliveredDetails = await reconcileDeliveredDetails(client, token, shop, catalog, settlement);
  const sellerFunds = await reconcileSellerFunds(client, token, shop, deliveredDetails, Math.floor(Date.now() / 1000));
  settlement.remainingOrderCount -= deliveredDetails.orderCount;
  if (deliveredDetails.orderCount) settlement.remainingByStatus.DELIVERED -= deliveredDetails.orderCount;
  if (settlement.remainingByStatus.DELIVERED === 0) delete settlement.remainingByStatus.DELIVERED;
  const registry = JSON.parse(registryText);
  const costFollowups = review.costReviewQueue.filter(row => row.paidCount > 0).map(row => {
    const ids = new Set(registry.shop_matches.filter(entry => entry.market === 'MY' && entry.shop === '跨境1' &&
      entry.product_id === row.productId && entry.sku_id === row.skuId).map(entry => entry.price_id));
    const versions = registry.confirmed_records.filter(entry => ids.has(entry.price_id)).map(entry =>
      ({ priceId: entry.price_id, name: entry.name, unitCny: entry.cost_cny, handlingCny: entry.handling_cny,
        confirmedDate: entry.confirmed_date, basis: entry.cost_basis }));
    return { ...row, versions };
  });
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const receipt = { schema: 'operations-settlement-reconciliation/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, orderWindow: review.orderWindow,
    catalogFile: review.catalogFile, financeFile: review.financeFile, registrySha256: review.registrySha256,
    unsettledPages: open.pages, settlement, deliveredDetails, sellerFunds, costFollowups, costQueueSize: review.costReviewQueue.length, requests };
  const directory = join(root, 'outputs/operations-settlement-reconciliation', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const { orders: paidOrders, ...paid } = settlement.paid;
  const { orders: estimates, ...estimated } = settlement.estimated;
  const { orders: delivered, ...deliveredSummary } = deliveredDetails;
  const deliveredPaymentStates = [...new Set(delivered.flatMap(row => row.statements.map(statement => statement.paymentStatus)))];
  console.log(JSON.stringify({ file, observedAt, orderCount: settlement.orderCount, currency: settlement.currency,
    paid, estimated, deliveredDetails: { ...deliveredSummary, paymentStates: deliveredPaymentStates },
    sellerFunds: { state: sellerFunds.state, statementsWithExactId: sellerFunds.matches.filter(row => row.exact.length > 0).length,
      amountDateCandidates: sellerFunds.matches.reduce((count, row) => count + row.sameDayAmountCandidates.length, 0) },
    remainingOrderCount: settlement.remainingOrderCount,
    remainingByStatus: settlement.remainingByStatus, costFollowups }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  });
}
