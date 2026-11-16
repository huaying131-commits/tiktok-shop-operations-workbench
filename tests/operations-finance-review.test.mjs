import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFinanceReviews, reviewFinance } from '../scripts/operations/finance-review.mjs';
import { compareEstimatedSettlements, comparePaidOrderWindows, matchStatementPayment, readPaidStatementCoverage, reconcileSellerFunds, summarizeSettlementPayments } from '../scripts/operations/run-settlement-reconciliation.mjs';
import { summarizeSkuSettlementBreakdowns } from '../scripts/operations/run-order-unit-economics.mjs';

test('distinguishes paid orders aging out from changes within the same order window', () => {
  const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' };
  const first = { id: '900000000000000008', createdAt: 12 };
  const retained = { id: '900000000000000016', createdAt: 15 };
  const incoming = { id: '900000000000000017', createdAt: 25 };
  function snapshot(startInclusive, endExclusive, rows, paid) {
    const orderWindow = { startInclusive, endExclusive };
    return [{ shop, orderWindow, settlement: { currency: 'MYR', orderCount: rows.length, paid: { orders: paid } } },
      { shop, orderWindow, orders: { rows } }];
  }
  const [previous, previousCatalog] = snapshot(10, 20, [first, retained],
    [{ orderId: first.id, net: '5.20' }, { orderId: retained.id, net: '8.30' }]);
  const [current, currentCatalog] = snapshot(15, 25, [retained], [{ orderId: retained.id, net: '8.30' }]);
  const unchanged = comparePaidOrderWindows(previous, current, previousCatalog, currentCatalog);
  assert.deepEqual(unchanged.agedOut, { count: 1, net: '5.20', orders: [{ orderId: first.id, createdAt: 12, net: '5.20' }] });
  assert.deepEqual(unchanged.overlap, { beforeCount: 1, afterCount: 1, beforeNet: '8.30', afterNet: '8.30', changes: 0 });
  const [next, nextCatalog] = snapshot(15, 26, [retained, incoming],
    [{ orderId: retained.id, net: '8.00' }, { orderId: incoming.id, net: '3.10' }]);
  const changed = comparePaidOrderWindows(previous, next, previousCatalog, nextCatalog);
  assert.equal(changed.overlap.changes, 1);
  assert.equal(changed.entered.net, '3.10');
  assert.throws(() => comparePaidOrderWindows(previous, next, previousCatalog,
    { ...nextCatalog, orders: { rows: [incoming] } }), /full order catalog/u);
});

test('compares only exact prior estimates entering statement settlement and preserves signed variance', () => {
  const orderId = '900000000000000008';
  const otherId = '900000000000000016';
  const statementId = '9000000000000000136';
  const before = [{ orderId, amount: '10.2' }, { orderId: otherId, amount: '22.00' }];
  const after = [{ orderId, net: '10.18', statements: [{ id: statementId }] },
    { orderId: '900000000000000017', net: '10.19', statements: [{ id: statementId }] }];
  const result = compareEstimatedSettlements(before, after);
  assert.deepEqual(result, { count: 1, previousEstimated: '10.20', actualNet: '10.18', totalVariance: '-0.02', sameAmountOrders: 0,
    rows: [{ orderId, statementIds: [statementId], estimated: '10.20', net: '10.18', variance: '-0.02' }] });
  assert.throws(() => compareEstimatedSettlements([...before, before[0]], after), /Duplicate/u);
  assert.equal(compareEstimatedSettlements(before, after.slice(1)).count, 0);
});

test('SKU economics totals the platform line items and preserves unknown components', () => {
  const row = (orderId, net, fees, shipping) => ({ orderId, settlement: {
    revenue: '14.50', net, feeBreakdown: fees, taxBreakdown: { sst_amount: '0' }, shippingBreakdown: shipping,
  } });
  const fees = { platform_commission_amount: '-1.96', affiliate_ads_commission_amount: '-0.14' };
  const shipping = { actual_shipping_fee_amount: '-2.12', customer_paid_shipping_fee_amount: '2' };
  const exact = summarizeSkuSettlementBreakdowns([row('a', '12.28', fees, shipping), row('b', '12.28', fees, shipping)]);
  assert.deepEqual(exact.componentsMyr, { revenue: '29.00', fees: '-4.20', tax: '0.00', shipping: '-0.24', net: '24.56' });
  assert.equal(exact.feesByFieldMyr.affiliate_ads_commission_amount, '-0.28');
  assert.equal(exact.reconciledOrderCount, 2);
  const incomplete = summarizeSkuSettlementBreakdowns([row('a', '12.28', fees, shipping), row('b', '12.29', {}, shipping)]);
  assert.equal(incomplete.componentsMyr.fees, null);
  assert.equal(incomplete.feesByFieldMyr.affiliate_ads_commission_amount, null);
  assert.deepEqual(incomplete.unreconciledOrderIds, ['b']);
  const mismatch = summarizeSkuSettlementBreakdowns([row('c', '12.29', fees, shipping)]);
  assert.deepEqual(mismatch.unreconciledOrderIds, ['c']);
});

test('full paid statement covers additional orders only when their creation time is proved outside the review window', async () => {
  const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' };
  const window = { startInclusive: 1793923732, endExclusive: 1794528532 };
  const statement = { id: '9000000000000000133', paymentId: '9000000000000000080', paymentStatus: 'PAID',
    paymentTime: 1794454201, createdAt: 1794441600, currency: 'MYR', payable: '12.00' };
  const inWindow = '900000000000000007';
  const outside = '900000000000000009';
  const transition = { statement, cohort: { orderCount: 1, net: '10.00', orders: [{ orderId: inWindow, net: '10.00' }] } };
  let outsideCreatedAt = window.startInclusive - 1;
  const client = {
    async statementsPage() { return { rows: [statement], totalCount: 1, nextToken: '' }; },
    async statementTransactionsPage(_token, _shop, id, cursor) {
      assert.equal(id, statement.id);
      const rows = cursor ? [{ id: '11111112', orderId: outside, type: 'ORDER', amount: '2.00' }]
        : [{ id: '11111111', orderId: inWindow, type: 'ORDER', amount: '10.00' }];
      return { statement: { ...statement, settlement: '12.00' }, rows, totalCount: 2, nextToken: cursor ? '' : 'next' };
    },
    async operationalOrders(_token, _shop, ids) {
      assert.deepEqual(ids, [outside]);
      return [{ id: outside, status: 'DELIVERED', createdAt: outsideCreatedAt }];
    },
  };
  const now = (window.endExclusive + 60) * 1000;
  const checked = await readPaidStatementCoverage(client, 'token', shop, transition, window, now);
  assert.equal(checked.transactionPages, 2);
  assert.equal(checked.statementOrderNet, '12.00');
  assert.equal(checked.outsideOrderNet, '2.00');
  assert.equal(checked.bankReceiptVerified, false);
  outsideCreatedAt = window.startInclusive;
  await assert.rejects(readPaidStatementCoverage(client, 'token', shop, transition, window, now), /outside the review window/u);
});

function fixture() {
  const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' };
  const orderWindow = { startInclusive: 10, endExclusive: 20 };
  const catalogFile = '20261112T130832233Z-cae88581-fbbb-4e18-bac3-6e4336aa2422.json';
  return {
    catalogFile,
    catalog: {
      shop, orderWindow,
      orders: { rows: [
        { id: 'o1', status: 'COMPLETED', skus: [
          { lineId: 'a1', productId: 'p1', id: 's1' },
          { lineId: 'a2', productId: 'p1', id: 's1' },
        ] },
        { id: 'o2', status: 'AWAITING_SHIPMENT', skus: [{ lineId: 'a3', productId: 'p2', id: 's2' }] },
        { id: 'o3', status: 'COMPLETED', skus: [{ lineId: 'a4', productId: 'p3', id: 's3' }] },
      ] },
    },
    finance: {
      kind: 'order-finance', basis: catalogFile, shop, orderWindow,
      returns: { status: 'available' }, statements: { status: 'available' },
      orders: [
        { orderId: 'o1', orderStatus: 'COMPLETED', returnRecords: [], settlementStatus: 'statement_found',
          settlement: { transactions: [{ paymentStatus: 'PAID' }], adjustments: [{ id: 'adj' }],
            detailStatus: 'available', detail: { currency: 'MYR', skuTransactions: [
              { skuId: 's1', settlementAmount: '15.20', matchesOrderSku: true },
              { skuId: 'other', settlementAmount: '18.00', matchesOrderSku: false },
            ] } } },
        { orderId: 'o2', orderStatus: 'AWAITING_SHIPMENT', returnRecords: [], settlementStatus: 'not_found_in_scanned_statements' },
        { orderId: 'o3', orderStatus: 'COMPLETED', returnRecords: [], settlementStatus: 'statement_found',
          settlement: { detailStatus: 'unavailable' } },
      ],
    },
    registry: {
      shop_matches: [
        { market: 'MY', shop: '跨境1', product_id: 'p1', sku_id: 's1', price_id: 'cost-1' },
        { market: 'MY', shop: '跨境10', product_id: 'p1', sku_id: 's1', price_id: 'other-shop' },
      ],
      confirmed_records: [{ market: 'MY', price_id: 'cost-1', cost_cny: 8.5, handling_cny: 1.5 }],
    },
  };
}

test('reconciles an order SKU once even when it appears on multiple order lines', () => {
  const input = fixture();
  const result = reviewFinance(input);
  assert.deepEqual(reviewFinance(input), result);
  assert.equal(result.summary.orderLines, 4);
  assert.equal(result.summary.orderSkus, 3);
  assert.equal(result.summary.costMatchedOrderLines, 2);
  assert.equal(result.summary.paidSettlementOrderSkus, 1);
  assert.equal(result.summary.adjustmentRows, 1);
  assert.deepEqual(result.rows[0].orderLineIds, ['a1', 'a2']);
  assert.equal(result.rows[0].settlement.amount, '15.20');
  assert.equal(result.rows[0].cost.priceId, 'cost-1');
  assert.equal(result.rows[0].actualNetProfit, null);
  assert.equal(result.summary.unmatchedFinanceRows, 1);
  assert.equal(result.rows[1].settlement.state, 'not_found_in_scanned_statements');
  assert.equal(result.rows[2].settlement.state, 'sku_detail_unavailable');
  assert.deepEqual(result.costReviewQueue, [
    { productId: 'p2', skuId: 's2', state: 'no_binding', orderSkuCount: 1, paidCount: 0 },
    { productId: 'p3', skuId: 's3', state: 'no_binding', orderSkuCount: 1, paidCount: 0 },
  ]);
});

test('flags conflicting cost IDs, duplicate SKU settlement rows and unavailable refunds', () => {
  const input = fixture();
  input.registry.shop_matches.push({ ...input.registry.shop_matches[0], price_id: 'cost-2' });
  input.finance.returns.status = 'unavailable';
  input.finance.orders[0].settlement.detail.skuTransactions.push({ skuId: 's1', settlementAmount: '12.00' });
  const result = reviewFinance(input);
  assert.equal(result.rows[0].cost.state, 'ambiguous');
  assert.equal(result.rows[0].settlement.state, 'ambiguous_sku_detail');
  assert.equal(result.rows[0].settlement.amount, null);
  assert.equal(result.summary.ordersWithReturnRecords, null);
});

test('rejects a mixed shop, wrong catalog snapshot and incomplete finance order cohort', () => {
  for (const change of [
    input => { input.finance.shop = { ...input.finance.shop, id: 'other' }; },
    input => { input.finance.basis = 'another-file.json'; },
    input => { input.finance.orderWindow = { startInclusive: 11, endExclusive: 20 }; },
    input => { input.finance.orders.pop(); },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => reviewFinance(input), /cohort|snapshot|shop/iu);
  }
});

test('keeps paid rows that leave a rolling window separate from retained rows that lose payment evidence', () => {
  const previous = reviewFinance(fixture());
  const current = { ...previous, rows: previous.rows.slice(1).map(row => ({ ...row,
    settlement: { state: 'paid_statement', amount: '15.20', currency: 'MYR' } })) };
  const first = compareFinanceReviews(previous, current);
  assert.equal(first.paidLeftWindow, 1);
  assert.equal(first.retainedPaidNoLongerVerified, 0);
  assert.equal(first.retainedNewlyPaid, 2);

  const second = compareFinanceReviews(current, previous);
  assert.equal(second.paidLeftWindow, 0);
  assert.equal(second.retainedPaidNoLongerVerified, 2);
  assert.equal(second.paidEnteredWindow, 1);
});

test('keeps a same-day withdrawal at the same amount separate from an exact payment-ID match', async () => {
  const createdAt = Date.parse('2026-11-12T00:00:00Z') / 1000;
  const statement = { id: '9000000000000000133', paymentId: 'PAY-001', payable: '227.78', currency: 'MYR', createdAt };
  const payment = { id: 'PAY-001', currency: 'MYR', type: 'WITHDRAW', status: 'PROCESSING',
    amount: '227.78', createdAt: createdAt + 600 };
  const other = { ...payment, id: 'PAY-002', status: 'SUCCESS' };
  const unrelated = { ...payment, id: 'PAY-003', currency: 'USD' };
  const client = { async sellerFundsTransactionsPage(_token, _shop, start, end) {
    assert.equal(start, createdAt);
    assert.equal(end, createdAt + 3600);
    return { totalCount: 3, nextToken: '', rows: [payment, other, unrelated] };
  } };
  const evidence = await reconcileSellerFunds(client, 'token', {}, { statements: [statement] }, createdAt + 3600);
  assert.equal(evidence.state, 'read');
  assert.equal(evidence.bankReceiptVerified, false);
  assert.deepEqual(evidence.matches, [{ statementId: statement.id, exact: [payment], sameDayAmountCandidates: [other] }]);
});

test('later exact payment proof moves the matching order amount without double-counting or inferring a bank deposit', () => {
  const statement = { id: '9000000000000000133', currency: 'MYR', createdAt: 1794441600 };
  const paid = { ...statement, paymentStatus: 'PAID', paymentId: 'payment-a' };
  const other = { ...statement, id: '9000000000000000134', paymentStatus: 'PAID' };
  assert.equal(matchStatementPayment(statement, [other]), null);
  assert.equal(matchStatementPayment(statement, [{ ...paid, currency: 'USD' }]), null);
  assert.equal(matchStatementPayment(statement, [paid, { ...paid, paymentStatus: 'FAILED' }]), null);
  const exact = matchStatementPayment(statement, [other, paid]);
  assert.deepEqual(exact, paid);
  const baseline = { orders: [{ orderId: '10000001', net: '9.99' }] };
  const original = { id: statement.id, paymentStatus: null };
  const rows = [
    { orderId: '10000002', net: '1.11', statements: [original] },
    { orderId: '10000003', net: '-4.98', statements: [{ id: other.id, paymentStatus: null }] },
    { orderId: '10000004', net: '7.77', statements: [original, { id: other.id, paymentStatus: 'PROCESSING' }] },
  ];
  const summary = summarizeSettlementPayments(baseline, rows, new Map([[statement.id, exact.paymentStatus]]));
  assert.deepEqual(summary, {
    platformPaid: { orderCount: 2, net: '11.10' },
    settledAwaitingPaymentProof: { orderCount: 2, net: '2.79' },
    bankReceiptVerified: false,
  });
  assert.throws(() => summarizeSettlementPayments(baseline, [{ ...rows[0], orderId: '10000001' }]), /duplicate/i);
});
