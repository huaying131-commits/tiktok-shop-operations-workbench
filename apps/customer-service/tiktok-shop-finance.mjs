import { isPlatformId, publicPlatformError } from './tiktok-shop-read.mjs';
import { collectPages, SnapshotError } from './tiktok-shop-sync.mjs';

export const snapshotFilename = /^\d{8}T\d{9}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;

export function verifyCohort(snapshot, shop, end) {
  const start = snapshot.orderWindow?.startInclusive;
  const cutoff = snapshot.orderWindow?.endExclusive;
  const rows = snapshot.orders?.rows;
  if (snapshot.schemaVersion !== 1 || snapshot.source !== 'TikTok Shop Open API' ||
      snapshot.shop?.id !== shop.id || snapshot.shop.region !== 'MY' || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(cutoff) || cutoff - start !== 604800 || cutoff > end || !Array.isArray(rows) ||
      (snapshot.orders.totalCount !== null && snapshot.orders.totalCount !== rows.length) ||
      rows.some(order => !isPlatformId(order?.id)) || new Set(rows.map(order => order.id)).size !== rows.length) {
    throw new SnapshotError('订单快照、时间窗口或店铺校验失败。');
  }
  return rows;
}

function errorMessage(error, fallback) {
  return error instanceof SnapshotError ? error.message : publicPlatformError(error, fallback);
}

async function scanReturns({ client, shop, read, orderIds, deadline }) {
  const byOrder = new Map();
  for (let offset = 0; offset < orderIds.length; offset += 20) {
    const batch = orderIds.slice(offset, offset + 20);
    const allowed = new Set(batch);
    const page = await collectPages(cursor => read(token => client.returnsPage(token, shop, batch, cursor)), deadline);
    for (const record of page.rows) {
      if (!allowed.has(record.orderId)) throw new SnapshotError('退款接口返回了本次查询范围外的订单。');
      if (!byOrder.has(record.orderId)) byOrder.set(record.orderId, []);
      byOrder.get(record.orderId).push(record);
    }
  }
  return byOrder;
}

async function scanStatements({ client, shop, read, orderIds, start, end, deadline }) {
  if (!orderIds.length) return { statementCount: 0, byOrder: new Map() };
  const byOrder = new Map();
  const allowed = new Set(orderIds);
  const statements = await collectPages(cursor => read(token => client.statementsPage(token, shop, start, end, cursor)), deadline);
  for (const statement of statements.rows) {
    const page = await collectPages(cursor => read(token => client.statementTransactionsPage(token, shop, statement.id, cursor)), deadline);
    for (const row of page.rows) {
      const orderId = row.type === 'ORDER' ? row.orderId : row.adjustmentOrderId;
      if (!allowed.has(orderId)) continue;
      if (!byOrder.has(orderId)) byOrder.set(orderId, { transactions: [], adjustments: [], detail: null, detailStatus: 'not_applicable' });
      const order = byOrder.get(orderId);
      const entry = { id: row.id, statementId: statement.id, currency: statement.currency, paymentStatus: statement.paymentStatus,
        amount: row.type === 'ORDER' ? row.amount : row.adjustmentAmount, type: row.type };
      (row.type === 'ORDER' ? order.transactions : order.adjustments).push(entry);
    }
  }
  for (const [orderId, order] of byOrder) {
    if (!order.transactions.length) continue;
    if (Date.now() >= deadline) {
      order.detailStatus = 'not_checked';
      continue;
    }
    try {
      order.detail = await read(token => client.orderSettlement(token, shop, orderId));
      order.detailStatus = order.detail.skuTransactions.length ? 'available' : 'no_sku_details';
    } catch (error) {
      order.detailStatus = 'unavailable';
      order.detailError = errorMessage(error, '暂未读到此订单的结算明细。');
    }
  }
  return { statementCount: statements.rows.length, byOrder };
}

export async function reconcileOrderFinance({ client, shop, read, snapshot, basis, now }) {
  const end = Math.floor(now() / 1000);
  const cohort = verifyCohort(snapshot, shop, end);
  const orderIds = cohort.map(order => order.id);
  const deadline = Date.now() + 145_000;
  const params = { client, shop, read, orderIds, deadline };
  const [returnsResult, statementsResult] = await Promise.allSettled([
    scanReturns(params), scanStatements({ ...params, start: snapshot.orderWindow.startInclusive, end }),
  ]);
  const returns = returnsResult.status === 'fulfilled' ? returnsResult.value : null;
  const statements = statementsResult.status === 'fulfilled' ? statementsResult.value : null;
  const counts = { orders: orderIds.length, ordersWithReturnRecords: returns ? returns.size : null,
    ordersWithCompletedRefund: returns ? 0 : null, ordersWithStatementSettlement: statements ? 0 : null,
    ordersWithSkuSettlementDetail: statements ? 0 : null, statementsScanned: statements?.statementCount ?? null,
    refundLinesMatched: returns ? 0 : null, refundLinesUnmatched: returns ? 0 : null,
    settlementSkusMatched: statements ? 0 : null, settlementSkusUnmatched: statements ? 0 : null };
  const orders = cohort.map(order => {
    const records = returns ? returns.get(order.id) ?? [] : null;
    const completed = records?.filter(record => record.status === 'RETURN_OR_REFUND_REQUEST_COMPLETE' &&
      (record.type === 'REFUND' || record.type === 'RETURN_AND_REFUND')) ?? [];
    if (completed.length) counts.ordersWithCompletedRefund += 1;
    const finance = statements?.byOrder.get(order.id);
    const settled = Boolean(finance?.transactions.length);
    if (settled) counts.ordersWithStatementSettlement += 1;
    if (finance?.detailStatus === 'available') counts.ordersWithSkuSettlementDetail += 1;
    const skus = new Set((order.skus ?? []).map(line => line.id).filter(Boolean));
    const linesById = new Map((order.skus ?? []).filter(line => line.lineId && line.id).map(line => [line.lineId, line.id]));
    for (const record of records ?? []) {
      for (const line of record.lines ?? []) {
        line.matchesOrderLine = Boolean(line.orderLineId && line.skuId && linesById.get(line.orderLineId) === line.skuId);
        counts[line.matchesOrderLine ? 'refundLinesMatched' : 'refundLinesUnmatched'] += 1;
      }
    }
    for (const line of finance?.detail?.skuTransactions ?? []) {
      line.matchesOrderSku = skus.has(line.skuId);
      counts[line.matchesOrderSku ? 'settlementSkusMatched' : 'settlementSkusUnmatched'] += 1;
    }
    return { orderId: order.id, orderStatus: order.status, returnRecords: records,
      completedRefundIds: returns ? completed.map(record => record.id) : null,
      settlementStatus: statements ? settled ? 'statement_found' : 'not_found_in_scanned_statements' : 'unavailable',
      settlement: finance ?? null };
  });
  return { schemaVersion: 1, source: 'TikTok Shop Open API', kind: 'order-finance', basis,
    collectedAt: new Date(now()).toISOString(), shop: { id: shop.id, name: shop.name ?? null, region: shop.region },
    orderWindow: snapshot.orderWindow, statementWindow: { startInclusive: snapshot.orderWindow.startInclusive, endExclusive: end },
    returns: returns ? { status: 'available' } : { status: 'unavailable', error: errorMessage(returnsResult.reason, '退款读取失败。') },
    statements: statements ? { status: 'available' } : { status: 'unavailable', error: errorMessage(statementsResult.reason, '结算读取失败。') },
    counts, orders };
}
