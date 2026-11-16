import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { reconcileOrderFinance, verifyCohort } from '../apps/customer-service/tiktok-shop-finance.mjs';

const shop = { id: '100000000001', name: 'fixture shop', region: 'MY', cipher: 'fixture-cipher' };
const ids = ['200000000001', '200000000002', '200000000003'];
const end = 1_800_000_000;
const now = () => end * 1000;
const snapshot = { schemaVersion: 1, source: 'TikTok Shop Open API', shop: { id: shop.id, region: 'MY' },
  orderWindow: { startInclusive: end - 604800, endExclusive: end },
  orders: { totalCount: 3, rows: ids.map(id => ({ id, status: 'DELIVERED', skus: [{ id: 'sku-1', lineId: 'line-1' }] })) } };
const page = (rows, nextToken = '') => ({ rows, totalCount: null, nextToken });
const base = { shop, snapshot, basis: 'fixture-basis', now, read: action => action('fixture-token') };

test('reads handover and existing label availability for the exact package without retaining label data', async () => {
  const packageId = '9000000000000000006';
  const path = `/fulfillment/202309/packages/${packageId}`;
  let documentAvailable = false;
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
      if (url.pathname === path + '/handover_time_slots') {
        return Response.json({ code: 0, request_id: 'handover-fixture', data: { can_drop_off: true,
          drop_off_point_url: 'private-dropoff-fixture' } });
      }
      assert.equal(url.pathname, path + '/shipping_documents');
      assert.equal(url.searchParams.get('document_type'), 'SHIPPING_LABEL');
      return Response.json(documentAvailable ? { code: 0, request_id: 'label-fixture', data: {
        doc_url: 'https://example.test/private-label-fixture', tracking_number: 'private-tracking-fixture' } } :
        { code: 21042104, request_id: 'unavailable-fixture' });
    } });
  assert.deepEqual(await client.packageHandover('fixture-token', shop, packageId),
    { requestId: 'handover-fixture', canDropOff: true, canPickup: null, canVanCollection: null, pickupSlotCount: null });
  await assert.rejects(client.packageLabelAvailability('fixture-token', shop, packageId), error =>
    error.platformCode === 21042104 && error.requestId === 'unavailable-fixture');
  documentAvailable = true;
  assert.deepEqual(await client.packageLabelAvailability('fixture-token', shop, packageId),
    { requestId: 'label-fixture', labelUrlReturned: true, hasTrackingNumber: true });
});

test('reads the payment register with exact IDs and omits bank details', async () => {
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', now, fetchApi: async (url, options) => {
    assert.equal(url.pathname, '/finance/202605/payments');
    assert.equal(options.method, 'GET');
    assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
    assert.equal(url.searchParams.get('create_time_ge'), String(end - 604800));
    assert.equal(url.searchParams.get('create_time_lt'), String(end));
    assert.equal(url.searchParams.get('page_token'), 'fixture-cursor');
    return Response.json({ code: 0, data: { payments: [{ id: '9000000000000000080', status: 'PAID',
      create_time: end - 60, paid_time: end - 50, bank_account: { account_number: 'fixture-private' } }], next_page_token: '' } });
  } });
  assert.deepEqual(await client.paymentsPage('fixture-token', shop, end - 604800, end, 'fixture-cursor'), {
    rows: [{ id: '9000000000000000080', status: 'PAID', createdAt: end - 60, paidAt: end - 50 }], totalCount: null, nextToken: '',
  });
});

test('preserves each financial status, joins exact IDs and keeps adjustments distinct', async () => {
  const client = {
    returnsPage: async (_token, _shop, orderIds) => {
      assert.deepEqual(orderIds, ids);
      return page([{ id: 'return-1', orderId: ids[0], type: 'REFUND', status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', amount: '2.10',
        lines: [{ orderLineId: 'line-1', skuId: 'sku-1' }] },
      { id: 'return-2', orderId: ids[1], type: 'REFUND', status: 'RETURN_OR_REFUND_REQUEST_SUCCESS', amount: '6.00',
        lines: [{ orderLineId: 'line-1', skuId: 'sku-wrong' }] }]);
    },
    statementsPage: async (_token, _shop, start, cutoff) => {
      assert.deepEqual([start, cutoff], [snapshot.orderWindow.startInclusive, end]);
      return page([{ id: '300000000001', currency: 'MYR', paymentStatus: 'SETTLED' }]);
    },
    statementTransactionsPage: async (_token, _shop, _id, cursor) => cursor
      ? page([{ id: 'adjustment-1', type: 'REBATE', adjustmentOrderId: ids[0], adjustmentAmount: '0.10' }])
      : page([{ id: 'statement-line-1', orderId: ids[0], type: 'ORDER', amount: '4.10' },
        { id: 'out-of-cohort', type: 'ORDER', orderId: '200000000009', amount: '90.00' }], 'next'),
    orderSettlement: async (_token, _shop, id) => {
      assert.equal(id, ids[0]);
      return { currency: 'MYR', settlementAmount: '4.10', skuTransactions: [{ skuId: 'sku-1' }, { skuId: 'unknown' }] };
    },
  };
  const result = await reconcileOrderFinance({ ...base, client });
  assert.equal(result.orders[0].settlementStatus, 'statement_found');
  assert.equal(result.orders[0].settlement.transactions[0].paymentStatus, 'SETTLED');
  assert.equal(result.orders[0].settlement.adjustments[0].amount, '0.10');
  assert.deepEqual(result.orders[0].completedRefundIds, ['return-1']);
  assert.deepEqual(result.orders[1].completedRefundIds, []);
  assert.equal(result.orders[2].settlementStatus, 'not_found_in_scanned_statements');
  assert.deepEqual(result.counts, { orders: 3, ordersWithReturnRecords: 2, ordersWithCompletedRefund: 1,
    ordersWithStatementSettlement: 1, ordersWithSkuSettlementDetail: 1, statementsScanned: 1,
    refundLinesMatched: 1, refundLinesUnmatched: 1, settlementSkusMatched: 1, settlementSkusUnmatched: 1 });
  assert.doesNotMatch(JSON.stringify(result), /out-of-cohort|fixture-cipher|fixture-token/);
});

test('retains refund evidence when settlement is unavailable and fails mixed-shop cohorts', async () => {
  const client = { returnsPage: async () => page([]), statementsPage: async () => { throw new Error('internal-fixture'); } };
  const result = await reconcileOrderFinance({ ...base, client });
  assert.equal(result.returns.status, 'available');
  assert.equal(result.statements.status, 'unavailable');
  assert.equal(result.counts.ordersWithReturnRecords, 0);
  assert.equal(result.counts.ordersWithStatementSettlement, null);
  assert.equal(result.orders[0].settlementStatus, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /internal-fixture/);
  assert.throws(() => verifyCohort({ ...snapshot, shop: { ...snapshot.shop, id: '100000000002' } }, shop, end), /校验失败/);
});

test('uses fixed signed endpoints and projects refund and settlement data without private fields', async () => {
  const statementId = '300000000001';
  const responses = new Map([
    ['/return_refund/202602/returns/search', { return_orders: [{ return_id: '400000000001', order_id: ids[0],
      refund_amount: { currency: 'MYR', refund_total: '0.01' }, return_warehouse_address: 'private-fixture' }] }],
    ['/finance/202309/statements', { statements: [{ id: statementId, currency: 'MYR', payment_status: 'PAID' }] }],
    ['/finance/202501/statements/' + statementId + '/statement_transactions', { transactions: [{ id: '500000000001',
      order_id: ids[0], type: 'ORDER', settlement_amount: '4.01' }] }],
    ['/finance/202501/orders/' + ids[0] + '/statement_transactions', { order_id: ids[0], currency: 'MYR', settlement_amount: '4.01',
      sku_transactions: [{ sku_id: 'sku-1', statement_id: statementId, settlement_amount: '4.01' }] }],
  ]);
  let callCount = 0;
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now, fetchApi: async (url, options) => {
    callCount += 1;
    assert.equal(url.hostname, 'open-api.tiktokglobalshop.com');
    assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
    assert.match(url.searchParams.get('sign'), /^[a-f0-9]{64}$/);
    if (url.pathname.startsWith('/return_refund/')) assert.deepEqual(JSON.parse(options.body), { order_ids: ids });
    else assert.equal(options.method, 'GET');
    if (url.pathname === '/finance/202309/statements') assert.equal(url.searchParams.get('sort_field'), 'statement_time');
    if (url.pathname.startsWith('/finance/202501/statements/')) assert.equal(url.searchParams.get('sort_field'), 'order_create_time');
    return Response.json({ code: 0, data: responses.get(url.pathname) });
  } });
  const result = await reconcileOrderFinance({ ...base, client });
  assert.equal(callCount, 4);
  assert.equal(result.orders[0].returnRecords[0].amount, '0.01');
  assert.equal(result.orders[0].settlement.detail.settlementAmount, '4.01');
  assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
});

test('read-only requests honor rate-limit delay and recompute the signature before retrying', async () => {
  let timestamp = end * 1000;
  const queries = [];
  const waits = [];
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now: () => timestamp,
    wait: async delay => { waits.push(delay); timestamp += delay; },
    fetchApi: async url => {
      queries.push(url.searchParams);
      if (queries.length === 1) return Response.json({ code: 36009002 }, { status: 429, headers: { 'Retry-After': '3' } });
      return Response.json({ code: 0, data: { return_orders: [], total_count: 0 } });
    } });
  assert.deepEqual(await client.returnsPage('fixture-token', shop, ids), { rows: [], totalCount: 0, nextToken: '' });
  assert.deepEqual(waits, [3000]);
  assert.equal(queries[1].get('timestamp'), String(end + 3));
  assert.notEqual(queries[0].get('sign'), queries[1].get('sign'));
});

test('cancellation search is read-only and rejects an unexpected order', async () => {
  const cancellationId = '400000000001';
  let orderId = ids[0];
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, options) => {
      assert.equal(url.pathname, '/return_refund/202309/cancellations/search');
      assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
      assert.equal(url.searchParams.get('page_token'), 'page-2');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { order_ids: ids });
      return Response.json({ code: 0, data: { total_count: 1, cancellations: [{ cancel_id: cancellationId,
        order_id: orderId, cancel_status: 'CANCELLATION_REQUEST_COMPLETE', buyer_message: 'private-fixture' }] } });
    } });
  assert.deepEqual(await client.cancellationsPage('fixture-token', shop, ids, 'page-2'), {
    rows: [{ id: cancellationId, orderId, status: 'CANCELLATION_REQUEST_COMPLETE' }], totalCount: 1, nextToken: '',
  });
  orderId = '200000000099';
  await assert.rejects(client.cancellationsPage('fixture-token', shop, ids, 'page-2'), /scope or status/);
});

test('order price details keep buyer payment and exact line discount fields separate', async () => {
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, options) => {
      assert.equal(url.pathname, '/order/202407/orders/' + ids[0] + '/price_detail');
      assert.equal(options.method, 'GET');
      return Response.json({ code: 0, data: { currency: 'MYR', payment: '17.78', line_items: [
        { id: '500000000001', currency: 'MYR', sku_list_price: '64.46', sku_sale_price: '13.78',
          subtotal_deduction_seller: '49.96', subtotal_deduction_platform: '0.72',
          voucher_deduction_platform: '0.72', voucher_deduction_seller: '0', shipping_sale_price: '4',
          payment: '17.78', subtotal_tax_amount: '0', shipping_list_price: '9',
          shipping_fee_deduction_platform: '5', shipping_fee_deduction_platform_voucher: '5' },
      ] } });
    } });
  const result = await client.orderPriceDetails('fixture-token', shop, ids[0]);
  assert.deepEqual(result, { currency: 'MYR', payment: '17.78', lines: [
    { id: '500000000001', currency: 'MYR', list: '64.46', buyerProduct: '13.78', sellerDiscount: '49.96',
      platformDiscount: '0.72', sellerVoucher: '0', platformVoucher: '0.72', buyerShipping: '4',
      linePayment: '17.78', productTax: '0', shippingList: '9', sellerShippingDiscount: null,
      platformShippingDiscount: '5', platformShippingVoucher: '5', sellerProductPromotions: null },
  ] });
});

test('opportunity reads keep nested pagination and validate the exact detail ID', async () => {
  const opportunity = { id: '9000000000000000092', opportunity_type: 'PRODUCT', title: 'Paper puzzle' };
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, options) => {
      if (url.pathname.endsWith('/query')) {
        assert.deepEqual(JSON.parse(options.body), { opportunity_type: 'PRODUCT', category_ids: ['868360'] });
        assert.equal(url.searchParams.get('page_token'), 'page-2');
        return Response.json({ code: 0, data: { data: { opportunities: [opportunity], total_count: 100, next_page_token: 'page-3' } } });
      }
      return Response.json({ code: 0, data: { opportunity: { id: '9000000000000000093', basic_info: {} } } });
    } });
  assert.deepEqual(await client.productOpportunityPage('fixture-token', shop, {
    type: 'PRODUCT', categoryIds: ['868360'], cursor: 'page-2',
  }), { rows: [opportunity], totalCount: 100, nextToken: 'page-3' });
  await assert.rejects(client.productOpportunityDetail('fixture-token', shop, opportunity.id), /identity mismatch/u);
});

test('return update pagination accepts an empty terminal cursor response after the reported total', async () => {
  const cursor = 'next-opaque-page';
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, options) => {
      assert.equal(url.pathname, '/return_refund/202602/returns/search');
      assert.equal(url.searchParams.get('sort_field'), 'update_time');
      assert.deepEqual(JSON.parse(options.body), { update_time_ge: 1, update_time_lt: 3 });
      const terminal = url.searchParams.get('page_token') === cursor;
      return Response.json({ code: 0, data: terminal ? { total_count: 1 } : {
        total_count: 1, next_page_token: cursor, return_orders: [
          { return_id: '500000000001', order_id: ids[0], update_time: 2, return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE' },
        ],
      } });
    } });
  const first = await client.returnsUpdatedPage('fixture-token', shop, 1, 3);
  assert.equal(first.rows[0].updatedAt, 2);
  assert.equal(first.nextToken, cursor);
  assert.deepEqual(await client.returnsUpdatedPage('fixture-token', shop, 1, 3, cursor),
    { rows: [], totalCount: 1, nextToken: '' });
});

test('exact return lookup keeps carrier status fields and omits the tracking number', async () => {
  const returnId = '500000000001';
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now, fetchApi: async (url, options) => {
    assert.equal(url.pathname, '/return_refund/202602/returns/search');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { return_ids: [returnId], order_ids: [ids[0]] });
    return Response.json({ code: 0, data: { total_count: 1, return_orders: [{
      return_id: returnId, order_id: ids[0], shipment_type: 'PLATFORM', handover_method: 'PICKUP',
      return_provider_name: 'J&T Express', return_tracking_number: 'fixture-tracking',
    }] } });
  } });
  const { rows: [row] } = await client.exactReturnPage('fixture-token', shop, returnId, ids[0]);
  assert.equal(row.hasTrackingNumber, true);
  assert.equal(row.shipmentType, 'PLATFORM');
  assert.equal(row.providerName, 'J&T Express');
  assert.doesNotMatch(JSON.stringify(row), /fixture-tracking/u);
});
