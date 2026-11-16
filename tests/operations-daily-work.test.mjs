import assert from 'node:assert/strict';
import test from 'node:test';
import { matchDomesticFulfillmentControl, matchDomesticShipping, matchesPaidWarehouseCohort, productFollowups, publicationCounts, readShopChannelOrders, readShopChannelPerformance, readTodayVideoOverview, retainDomesticPacking } from '../scripts/operations/run-daily-work.mjs';
import { readCustomerInbox, readOpenAfterSales } from '../scripts/operations/run-service-fulfillment-read.mjs';
import { readHistoricalVideoProduct } from '../scripts/operations/run-shop-video-reconciliation.mjs';
import { previousCollectionCandidates, readLiveRoutingOrders, readPendingPackages, replayFulfillmentRouting, reviewPendingWms } from '../scripts/operations/run-fulfillment-routing-replay.mjs';
import { matchDomesticCollection, reviewDomesticPacking } from '../scripts/operations/read-domestic-packing.mjs';
import { compareProductFinance, completeMalaysiaDays } from '../scripts/operations/run-product-finance-review.mjs';
import { proposeCreativeReviews, refreshAffiliateCreativeMatches, reviewAffiliateCreativeMatches, reviewAircraftCreativeDecisions, reviewGmvMaxProducts } from '../scripts/operations/gmv-max-review.mjs';
import { reviewSupportTriage } from '../scripts/operations/support-triage.mjs';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { readNewArrivalSalesHistory } from '../scripts/operations/read-promotion-preflight.mjs';
import { compareUnsettledRevisions } from '../scripts/operations/run-settlement-reconciliation.mjs';

test('rechecks original collection orders that advance or leave the rolling list', () => {
  const queued = orderId => ({ orderId, nextAction: 'check_existing_package_and_carrier' });
  const retained = queued('900000000000000023');
  const advanced = queued('900000000000000019');
  const missing = queued('900000000000000020');
  const old = [retained, advanced, missing, { orderId: '900000000000000021', nextAction: 'historical_or_ineligible_for_new_dispatch' }];
  const fresh = [retained, { orderId: advanced.orderId, status: 'IN_TRANSIT' }, queued('900000000000000022')];
  assert.deepEqual(previousCollectionCandidates(old, fresh), [advanced, missing]);
});

test('explains unsettled estimate revisions only for identical order and transaction IDs', () => {
  const first = { orderId: '900000000000000011', transactionId: '9000000000000000126', amount: '22.23', status: 'UNSETTLED' };
  const second = { orderId: '900000000000000012', transactionId: '9000000000000000127', amount: '21.92', status: 'UNSETTLED' };
  const result = compareUnsettledRevisions([first, second],
    [{ ...first, amount: '18.84' }, { ...second, transactionId: '9000000000000000128', amount: '1.00' }]);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.transactionChanged, 1);
  assert.equal(result.netChange, '-3.39');
  assert.throws(() => compareUnsettledRevisions([first, first], [second]), /duplicated/u);
});

test('reads open aftersales without an update cutoff and deduplicates the same return across filters', async () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
  const returnId = '9000000000000000081';
  const orderId = '900000000000000023';
  const lineId = '900000000000000024';
  const skuId = '9000000000000000036';
  const row = { id: returnId, orderId, updatedAt: 1760000000, status: 'RETURN_OR_REFUND_REQUEST_PENDING',
    arbitrationStatus: 'IN_PROGRESS', lines: [{ orderLineId: lineId, skuId }] };
  const client = {
    openReturnsPage: async (_token, _shop, key) => ({ rows: [row], totalCount: 1, nextToken: '', requestId: key }),
    operationalOrders: async () => [{ id: orderId, lines: [{ id: lineId, skuId }] }],
    returnDecisionEligibility: async (_token, _shop, id) => ({ requestId: id, decisions: [] }),
  };
  const result = await readOpenAfterSales(client, 'test', shop);
  assert.deepEqual(result.lists.map(list => list.count), [1, 1]);
  assert.equal(result.distinctCases, 1);
  assert.equal(result.exactMatches, 1);
  assert.equal(result.rows[0].decisionEligibility.data.requestId, returnId);
  const changed = { ...client, openReturnsPage: async (_token, _shop, key) =>
    ({ rows: [{ ...row, updatedAt: key === 'in_arbitration' ? row.updatedAt + 1 : row.updatedAt }],
      totalCount: 1, nextToken: '', requestId: key }) };
  await assert.rejects(readOpenAfterSales(changed, 'test', shop), /changed during the read/u);
});

test('checks the full product lifetime in contiguous order windows and includes other variants', async () => {
  const item = { productId: '9000000000000000041', skuId: '9000000000000000042', sellerSku: 'MY-OCT17-PLA-BLUE' };
  const createdAt = 1793002361;
  const cutoff = createdAt + 604_810;
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
  const requests = [];
  const client = {
    productDetail: async () => ({ requestId: 'product-read', data: { id: item.productId, create_time: createdAt,
      skus: [{ id: item.skuId, seller_sku: item.sellerSku }] } }),
    ordersPage: async (_token, _shop, _size, _cursor, start, end) => {
      requests.push({ start, end });
      const rows = start === createdAt ? [{ id: '900000000000000023', createdAt: start, status: 'DELIVERED',
        skus: [{ lineId: '1234567890123', productId: item.productId, id: '9000000000000000043' }] }] : [];
      return { rows, nextToken: '', totalCount: rows.length, requestId: 'orders-' + start };
    },
  };
  const result = await readNewArrivalSalesHistory(item, { client, token: 'test', shop }, cutoff * 1000);
  assert.deepEqual(requests, [{ start: createdAt, end: createdAt + 604_800 }, { start: createdAt + 604_800, end: cutoff }]);
  assert.equal(result.matchingProductOrders, 1);
  assert.equal(result.matchingSkuOrders, 0);
  assert.equal(result.shopOrders, 1);
  await assert.rejects(readNewArrivalSalesHistory(item, { client: { ...client, ordersPage: async () =>
    ({ rows: [], nextToken: '', totalCount: 1, requestId: 'incomplete' }) }, token: 'test', shop }, cutoff * 1000), /总数不一致/u);
});

test('matches domestic collection to the exact original order, package and SKU quantities', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
  const pkg = { packageId: '9000000000000000006' };
  const order = { orderId: '900000000000000026', packages: [pkg.packageId],
    skus: [{ productId: '9000000000000000016', skuId: '9000000000000000024', quantity: 1 }] };
  const warehouse = { platformShopId: shop.id, shopName: shop.name, site: shop.region, platformOrderSn: order.orderId,
    platformPackageId: pkg.packageId, orderId: '900000000000000002', warehouseId: '879', stage: 'wait_pack',
    trackingNo: 'present', items: [{ platformItemId: order.skus[0].productId, platformSkuId: order.skus[0].skuId,
      quantity: '1', goodsSkuList: [{ goodsSkuId: '9000000000000000065', quantity: 1 }] }],
    giftList: [{ goodsSkuOuterId: 'SKU20251211113951022', quantity: '1' }] };
  const result = matchDomesticCollection(order, pkg, shop, warehouse);
  assert.equal(result.stage, 'wait_pack');
  assert.equal(result.cardVerified, true);
  assert.equal(matchDomesticCollection(order, pkg, shop, { ...warehouse, stage: 'has_pack', giftList: [] }).cardVerified, false);
  for (const changed of [{ hasProblem: true }, { site: 'SG' }, { platformPackageId: '9000000000000000007' },
    { items: [{ ...warehouse.items[0], goodsSkuList: [{ ...warehouse.items[0].goodsSkuList[0], quantity: 2 }] }] }]) {
    assert.equal(matchDomesticCollection(order, pkg, shop, { ...warehouse, ...changed }), null);
  }
});

test('counts historical domestic packing only when the original package, warehouse item and card match', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
  const row = { orderId: '900000000000000018', packageId: '9000000000000000004', warehouseOrderId: '900000000000000001',
    warehouseId: '879', productId: '9000000000000000016', skuId: '9000000000000000025', skuUnits: 1,
    platformOrderStatus: 'IN_TRANSIT', platformPackageStatus: 'FULFILLING', platformTrackingPresent: true,
    wmsStage: 'has_pack', wmsStatus: 'wait_receiver_confirm', wmsTrackingPresent: true, wmsCardQuantity: 1,
    pickupSuccessSeen: false, trackingEvents: 12, wmsSource: 'warehouse-receipt.json' };
  const trace = ['/authorization/202309/shops', '/order/202507/orders', `/fulfillment/202309/packages/${row.packageId}`,
    `/fulfillment/202309/orders/${row.orderId}/tracking`].map((path, index) => ({ path, method: 'GET', status: 200, code: 0,
    requestId: `request-${index}` }));
  const binding = { orderId: row.orderId, packageId: row.packageId, warehouseId: row.warehouseId, productId: row.productId,
    skuId: row.skuId, goodsSkuId: '9000000000000000065', goodsSkuOuterId: 'SKU20250610173937100', source: row.wmsSource };
  const order = { orderId: row.warehouseOrderId, platformOrderSn: row.orderId, platformPackageId: row.packageId,
    platformShopId: shop.id, shopName: shop.name, site: shop.region, warehouseId: row.warehouseId,
    stage: row.wmsStage, orderStatus: row.wmsStatus, trackingNo: 'omitted-after-validation',
    items: [{ platformItemId: row.productId, platformSkuId: row.skuId, quantity: 1,
      goodsSkuList: [{ goodsSkuId: binding.goodsSkuId, goodsSkuOuterId: binding.goodsSkuOuterId, quantity: 1 }] }],
    giftList: [{ goodsSkuOuterId: 'SKU20251211113951022', quantity: 1 }] };
  const wms = orders => ({ operation: 'orders', code: 'success', data: { total: 1, orderList: orders } });
  assert.equal(matchDomesticFulfillmentControl(row, { shop, trace, history: [binding], warehouse: wms([order]) }), true);
  assert.equal(matchDomesticFulfillmentControl(row, { shop, trace: trace.slice(0, -1), history: [binding], warehouse: wms([order]) }), false);
  for (const changed of [{ platformPackageId: '9000000000000000005' }, { giftList: [] }, { platformShopId: '123' },
    { items: [{ ...order.items[0], quantity: 2 }] }]) {
    assert.equal(matchDomesticFulfillmentControl(row, { shop, trace, history: [binding], warehouse: wms([{ ...order, ...changed }]) }), false);
  }
});

test('joins later shipping evidence to the original pending package and keeps another package separate', () => {
  const orderId = '900000000000000026', packageId = '9000000000000000006';
  const pending = { orderId, packageId, state: 'packing_inputs_verified', observedAt: '2026-11-13T03:46:01Z' };
  const prefix = `/fulfillment/202309/packages/${packageId}`;
  const row = { orderId, packageId, kind: 'pending', orderStatus: 'AWAITING_SHIPMENT', packageStatus: 'TO_FULFILL',
    hasTrackingNumber: false, handover: { path: prefix + '/handover_time_slots', status: 200, code: 0, requestId: 'handover',
      data: { canDropOff: true } }, documents: { path: prefix + '/shipping_documents', status: 200, code: 21042104, requestId: 'label' } };
  assert.deepEqual(matchDomesticShipping(pending, row), { canDropOff: true, labelAvailable: false, hasTrackingNumber: false });
  assert.equal(matchDomesticShipping(pending, { ...row, packageId: '9000000000000000007' }), null);
  assert.equal(matchDomesticShipping(pending, { ...row, orderStatus: 'AWAITING_COLLECTION' }), null);
});

test('retains earlier same-day warehouse evidence only when a newer platform read verifies the original pending package', () => {
  const orderId = '900000000000000026', packageId = '9000000000000000006';
  const plan = { orderId, packageId, observedAt: '2026-11-13T03:46:01Z' };
  const route = '2026-11-13T04:28:26Z';
  const verified = { orderId, packageId, observedAt: '2026-11-13T04:32:39Z', stillPending: true };
  assert.equal(retainDomesticPacking(plan, route, verified), true);
  assert.equal(retainDomesticPacking(plan, route, { ...verified, packageId: '9000000000000000007' }), false);
  assert.equal(retainDomesticPacking(plan, route, { ...verified, observedAt: '2026-11-13T04:25:39Z' }), false);
  assert.equal(retainDomesticPacking(plan, route, null), false);
  assert.equal(retainDomesticPacking({ ...plan, observedAt: '2026-11-13T04:29:01Z' }, route, null), true);
  assert.equal(retainDomesticPacking({ ...plan, observedAt: '2026-11-13T04:29:01Z' }, route, { ...verified, stillPending: false }), false);
});

test('reads same-day video traffic by account type without deriving a publication count', async () => {
  const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my', cipher: 'fixture' };
  const day = '2026-11-13';
  let latestDay = day;
  const accounts = new Set();
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, options) => {
    assert.equal(url.pathname, '/analytics/202609/shop_videos/overview_performance');
    assert.equal(options.method, 'GET');
    const account = url.searchParams.get('account_type');
    accounts.add(account);
    assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
    assert.equal(url.searchParams.get('start_date_ge'), day);
    assert.equal(url.searchParams.get('end_date_lt'), '2026-11-14');
    assert.equal(url.searchParams.get('today'), 'true');
    return Response.json({ code: 0, request_id: 'fixture-' + account, data: { latest_available_date: '2026-11-11',
      performance: { intervals: [{ start_date: latestDay, end_date: '2026-11-14', today: true,
        product_impressions: 100, product_clicks: 10, video_attributed_sku_orders: 2,
        video_attributed_gmv: { amount: '14.20', currency: 'MYR' } }] } } });
  } });
  const get = () => readTodayVideoOverview(client, 'fixture', shop, day);
  const overview = await get();
  assert.deepEqual([...accounts].sort(), ['AFFILIATE_ACCOUNTS', 'ALL', 'MARKETING_ACCOUNTS', 'OFFICIAL_ACCOUNTS']);
  assert.equal(overview.rows.find(row => row.accountType === 'ALL').attributedSkuOrders, 2);
  assert.equal(overview.rows.find(row => row.accountType === 'ALL').attributedGmv, '14.20');
  assert.equal(overview.confirmedPublications, undefined);
  latestDay = '2026-11-12';
  await assert.rejects(get(), /Current video overview window/);
});

test('pairs the original China-direct package with an exact historical SKU and a separate in-stock service card', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
  const orderId = '900000000000000027', packageId = '9000000000000000008';
  const productId = '9000000000000000016', skuId = '9000000000000000025';
  const order = { orderId, packages: [packageId], skus: [{ productId, skuId, quantity: 1 }] };
  const item = { platformItemId: productId, platformSkuId: skuId, quantity: 1, goodsSkuList: [] };
  const current = { platformOrderSn: orderId, platformShopId: shop.id, site: 'MY', shopName: shop.name,
    orderStatus: 'AWAITING_SHIPMENT', warehouseId: null, packages: [{ platformPackageId: packageId,
      platformOrderPackageId: '9000000000000000078', platformPackageStatus: 'TO_FULFILL', items: [item] }] };
  const statuses = ['wait_submit', 'part_submit', 'wait_process', 'has_process', 'has_problem', 'has_closed']
    .map(tab => ({ tab, rows: tab === 'wait_submit' ? [current] : [] }));
  const goods = { goodsSkuId: '9000000000000000065', goodsSkuOuterId: 'SKU20250610173937100', quantity: 1 };
  const card = { goodsSkuOuterId: 'SKU20251211113951022', available: 4, exactRows: 1, warehouseId: '879' };
  const history = [{ productId, skuId, goodsSkuId: goods.goodsSkuId, goodsSkuOuterId: goods.goodsSkuOuterId,
    warehouseId: '879', orderId: '900000000000000018', packageId: '9000000000000000004' }];
  const stock = { goodsSkuOuterId: goods.goodsSkuOuterId, available: 2, exactRows: 1, warehouseId: '879' };
  const ready = reviewDomesticPacking({ shop, order, statuses, history, inventory: [stock, card] });
  assert.equal(ready.state, 'packing_inputs_verified');
  assert.equal(ready.warehouseId, '879');
  assert.deepEqual(ready.items, [{ productId, skuId, ...goods, available: 2 }]);
  assert.equal(ready.card.quantity, 1);
  assert.equal(ready.writes, 0);
  assert.equal(reviewDomesticPacking({ shop, order, statuses: statuses.slice(0, -1), history,
    inventory: [stock, card] }).state, 'warehouse_status_unverified');
  assert.equal(reviewDomesticPacking({ shop, order, statuses, history,
    inventory: [stock, { ...card, available: 0 }] }).state, 'stock_or_card_unverified');
  assert.equal(reviewDomesticPacking({ shop, order, statuses, history: [...history, { ...history[0], goodsSkuOuterId: 'OTHER' }],
    inventory: [stock, card] }).state, 'warehouse_sku_unverified');
  statuses[1].rows.push(current);
  assert.equal(reviewDomesticPacking({ shop, order, statuses, history, inventory: [stock, card] }).state, 'warehouse_status_unverified');
});

test('cross-checks affiliate content against finance and creative evidence without inferring order attribution', () => {
  const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my', advertiserId: '9000000000000000096' };
  const productId = '9000000000000000016';
  const skuId = '9000000000000000027';
  const campaignId = '9000000000000004';
  const videoId = '9000000000000000125';
  const orderId = '900000000000000006';
  const statementId = '9000000000000000131';
  const orderWindow = { startInclusive: 1793923732, endExclusive: 1794528532 };
  const metrics = { cost: '2.22', gross_revenue: '39.40', roi: '17.77', orders: '7', shop_content_type: 'VIDEO' };
  const ads = { shop, schema: 'operations-gmv-max-read/v1', reportContract: { orderIdDimensionAvailable: false },
    campaignDetails: [{ id: campaignId, status: 'ENABLE', type: 'PRODUCT', productIds: [productId] }],
    completeDays: { start: '2026-11-06', end: '2026-11-12', productReports: [{ campaignId, creatives: [{ productId,
      result: { requestIds: ['ad-request'], rows: [{ dimensions: { item_id: videoId }, metrics }] } }] }] } };
  const finance = { shop, productId, skuId, orderWindow, schema: 'exact-sku-fee-reconciliation/v1',
    affiliate: { complete: true, reportedSkuCount: 68 }, rows: [{ orderId, statementId, orderStatus: 'DELIVERED',
      feeBreakdown: { affiliate_ads_commission_amount: '-0.14' }, affiliate: { status: 'SETTLED', contentType: 'VIDEO',
        actualShopAdsCommission: { amount: '0.14', currency: 'MYR' } } }] };
  const receipt = { shop, campaignId, productId, skuId, platformWrites: 0, matchedOrders: 1, matchedCreativeOrders: 1,
    observedAt: '2026-11-13T02:13:29Z', schema: 'operations-gmv-max-affiliate-content-join/v1',
    affiliateWindow: orderWindow, adsWindow: { start: '2026-11-06', end: '2026-11-12' }, affiliateRows: 68,
    affiliateRequests: ['affiliate-request'], adsRequests: ['ad-request'], exactGmvMaxOrderAttribution: null,
    rows: [{ orderId, skuId, creationDay: '2026-11-06', videoId, commissionMyr: '0.14', statementId,
      insideAdsWindow: true, matchedCreative: true, creativeReport: { costUsd: '2.22', roi: '17.77', orders: '7', grossRevenueUsd: '39.40' } }] };
  const result = reviewAffiliateCreativeMatches(receipt, ads, finance);
  assert.equal(result.matchedOrders, 1);
  assert.equal(result.distinctMatchedVideos, 1);
  assert.equal(result.matchedCommissionMyr, '0.14');
  assert.equal(result.exactGmvMaxOrderAttribution, null);
  assert.equal(reviewAffiliateCreativeMatches({ ...receipt, rows: [{ ...receipt.rows[0], commissionMyr: '0.40' }] }, ads, finance), null);
  assert.equal(reviewAffiliateCreativeMatches({ ...receipt, rows: [{ ...receipt.rows[0], videoId: orderId }] }, ads, finance), null);
  const fresh = structuredClone(ads);
  fresh.observedAt = '2026-11-13T06:26:16Z';
  const freshResult = fresh.completeDays.productReports[0].creatives[0].result;
  freshResult.requestIds = ['fresh-ad-request'];
  freshResult.rows[0].metrics.orders = '8';
  const replay = refreshAffiliateCreativeMatches(receipt, ads, fresh, finance);
  assert.equal(replay.matchedOrders, 1);
  assert.equal(replay.matchedCommissionMyr, '0.14');
  assert.equal(replay.observedAt, receipt.observedAt);
  assert.equal(replay.creativeObservedAt, fresh.observedAt);
  assert.equal(replay.exactGmvMaxOrderAttribution, null);
  assert.equal(refreshAffiliateCreativeMatches(receipt, ads, { ...fresh, completeDays: { ...fresh.completeDays, start: '2026-11-07' } }, finance), null);
  freshResult.rows.push(freshResult.rows[0]);
  assert.equal(refreshAffiliateCreativeMatches(receipt, ads, fresh, finance), null);
});

test('new SKU fee receipts preserve prior warehouse proof only for the identical paid cohort', () => {
  const warehouseRows = [{ orderId: 'order-a', packageId: 'package-a', itemQuantity: 1, platformSettlementNetMyr: '10.42' }];
  const order = { orderId: 'order-a', status: 'DELIVERED', packageIds: ['package-a'],
    settlement: { statementId: 'statement-a', quantity: '1', net: '10.42' } };
  const original = { rows: [order], summary: { deliveredOrders: 1 } };
  const current = { ...original, rows: [{ ...order, settlement: { ...order.settlement, feeBreakdown: {} } }] };
  assert.equal(matchesPaidWarehouseCohort(warehouseRows, original, current), true);
  assert.equal(matchesPaidWarehouseCohort(warehouseRows, original, { ...current,
    rows: [{ ...order, settlement: { ...order.settlement, statementId: 'statement-b' } }] }), false);
  assert.equal(matchesPaidWarehouseCohort(warehouseRows, original, { ...current,
    rows: [{ ...order, packageIds: ['package-b'] }] }), false);
  assert.equal(matchesPaidWarehouseCohort(warehouseRows, original, { ...current,
    rows: [{ ...order, settlement: { ...order.settlement, quantity: '2' } }] }), false);
});

test('diagnoses at distinct funnel stages without substituting zero for missing data', () => {
  const rows = [
    { productId: 'a', impressions: 100, clicks: 0, orders: 0 },
    { productId: 'b', impressions: 20, clicks: 4, orders: 0 },
    { productId: 'c', impressions: 300, clicks: null, orders: 0 },
    { productId: 'd', impressions: 40, clicks: 2, orders: 1, refunds: 1 },
  ];
  assert.deepEqual(productFollowups(rows).map(x => [x.productId, x.reason]), [
    ['d', 'review_refunds'], ['a', 'review_click_rate'], ['b', 'review_checkout'],
  ]);
});

test('shop channel analytics aggregates only days at or before the official availability date', async () => {
  const calls = [];
  const dates = ['06', '07', '08', '09', '10', '11', '12', '13'].map(date => `2026-11-${date}`);
  const daily = dates.slice(0, -1).map((date, i) => ({ start_date: date, end_date: dates[i + 1] }));
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(url.pathname, '/analytics/202609/shop/performance');
    assert.equal(url.searchParams.get('currency'), 'LOCAL');
    const granularity = url.searchParams.get('granularity');
    calls.push([granularity, url.searchParams.get('start_date_ge'), url.searchParams.get('end_date_lt')]);
    const intervals = granularity === '1D' ? daily : [{ start_date: dates[0], end_date: dates[6],
      sales: { gmv: { amount: '95.30', currency: 'MYR' }, orders_count: 4,
        video_attributed_gmv: { amount: '31.00', currency: 'MYR' }, live_attributed_gmv: { amount: '0.00', currency: 'MYR' } } }];
    return Response.json({ code: 0, request_id: granularity, data: {
      latest_available_date: dates[5], performance: { intervals },
    } });
  } });
  const session = { client, token: 'fixture', shop: { region: 'MY', cipher: 'fixture' } };
  const result = await readShopChannelPerformance(session, dates[7]);
  assert.deepEqual(calls, [['1D', dates[0], dates[7]], ['ALL', dates[0], dates[6]]]);
  assert.deepEqual(result.provisionalDays, [dates[6]]);
  assert.equal(result.daily.length, 6);
  assert.equal(result.summary.videoAttributedMyr, '31.00');
  assert.equal(result.summary.liveAttributedMyr, '0.00');
  assert.equal(result.summary.productCardAttributedMyr, null);
  daily.pop();
  daily.pop();
  await assert.rejects(() => readShopChannelPerformance(session, dates[7]), /omitted a complete day/u);
});

test('same-day publication counts keep unconfirmed identifiers separate and deduplicate real IDs', () => {
  const at = '2026-11-12T13:00:00Z';
  const result = publicationCounts([
    { published: true, published_at: at, platform_video_id: 'video' },
    { published: true, published_at: at, platform_video_id: 'video' },
    { published: true, published_at: at, job_id: 'proof-without-id' },
    { published: true, published_at: '2026-11-11T13:00:00Z', platform_video_id: 'yesterday' },
    { published: false, published_at: at, platform_video_id: 'not-posted' },
  ], '2026-11-12');
  assert.deepEqual(result, { confirmedVideoIds: 1, localSuccessWithoutPlatformId: 1 });
});

test('shop order reconciliation keeps cancelled, cash-on-delivery and later payment evidence distinct', async () => {
  const start = Date.parse('2026-11-06T00:00:00+08:00') / 1000;
  const end = start + 86400;
  const data = [
    { id: '9000000000000000121', create_time: start, status: 'IN_TRANSIT', is_sample_order: false, is_cod: true },
    { id: '9000000000000000122', create_time: start, status: 'CANCELLED', is_sample_order: false, is_cod: false, paid_time: end },
  ];
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, options) => {
    assert.equal(url.pathname, '/order/202309/orders/search');
    assert.deepEqual(JSON.parse(options.body), { create_time_ge: start, create_time_lt: end });
    return Response.json({ code: 0, request_id: 'exact-order-list', data: { orders: data, total_count: 2 } });
  } });
  const session = { client, token: 'fixture', shop: { region: 'MY', cipher: 'fixture' } };
  const window = { startDate: '2026-11-06', endDateExclusive: '2026-11-07' };
  const channels = { window, summary: { orders: 1 }, daily: [{ start_date: window.startDate, end_date: window.endDateExclusive }] };
  const result = await readShopChannelOrders(session, channels);
  assert.deepEqual(result.requestIds, ['exact-order-list']);
  assert.equal(result.summary.createdOrders, 2);
  assert.equal(result.summary.cancelledPaid, 1);
  assert.equal(result.summary.cashOnDeliveryWithoutPaidTimestamp, 1);
  assert.equal(result.summary.paidOutsideWindow, 1);
  assert.equal(result.daily[0].reportMinusCreated, null);
  data[1].id = data[0].id;
  await assert.rejects(() => readShopChannelOrders(session, channels), /cohort is inconsistent/u);
});

test('a seller video product analytics match uses the exact video and keeps an empty report unconfirmed', async () => {
  const video = { platformVideoId: '9000000000000000135', productId: '9000000000000000038' };
  let products = [{ id: video.productId }];
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(url.pathname, `/analytics/202509/shop_videos/${video.platformVideoId}/products/performance`);
    assert.equal(url.searchParams.get('currency'), 'LOCAL');
    return Response.json({ code: 0, request_id: 'fixture-request', data: {
      latest_available_date: '2026-11-11', total_count: products?.length ?? 0, products,
    } });
  } });
  const check = () => readHistoricalVideoProduct(client, 'fixture', { region: 'MY', cipher: 'fixture' }, '2026-11-06', '2026-11-13', video);
  assert.equal((await check()).state, 'product_analytics_confirmed');
  products = undefined;
  assert.equal((await check()).state, 'expected_product_not_returned');
});

test('warehouse review matches the original TikTok package and flags simultaneous processing in two warehouses', () => {
  const orderId = '900000000000000005', packageId = '9000000000000000002';
  const rows = [{ orderId, exact: true, route: 'malaysia_overseas', orderStatus: 'AWAITING_COLLECTION', packages: [{ packageId, itemQuantity: 1 }] }];
  const original = { orderId: '9000000000000000076', warehouseId: '80', shopName: 'example-shop-my', platform: 'tiktok',
    platformOrderSn: orderId, platformPackageId: packageId, stage: 'has_out_storage', gmtOutStorage: '2026-11-06 15:13:42',
    items: [{ quantity: 1 }] };
  const zhanma = { available: true, system: 'zhanma', warehouseId: '80', records: [original] };
  const shenniu = { available: true, system: 'shenniu', warehouseId: '148', records: [
    { ...original, warehouseId: '148', orderId: '9000000000000000077', stage: 'has_pack', gmtOutStorage: '' },
  ] };
  const one = reviewPendingWms(rows, [zhanma, { ...shenniu, available: false }]);
  assert.equal(one.completedWarehouses, 1);
  assert.equal(one.outboundPackages, 1);
  const conflict = reviewPendingWms(rows, [zhanma, shenniu]);
  assert.equal(conflict.outboundPackages, 0);
  assert.equal(conflict.conflictedPackages, 1);
  assert.equal(conflict.packedWarehousePackages, 0);
  const picking = { ...original, stage: 'has_pick', gmtOutStorage: '' };
  assert.equal(reviewPendingWms(rows, [{ ...zhanma, records: [picking] }]).pickingWarehousePackages, 1);
  assert.equal(reviewPendingWms(rows, [{ ...zhanma, records: [{ ...picking, items: [{ quantity: 2 }] }] }]).pickingWarehousePackages, 0);
  const packed = reviewPendingWms(rows, [{ ...zhanma, records: [{ ...picking, stage: 'has_pack' }] }]);
  assert.equal(packed.packedWarehousePackages, 1);
  assert.equal(packed.outboundPackages, 0);
  const mismatch = reviewPendingWms(rows, [{ ...zhanma, records: [{ ...original, platformPackageId: '9000000000000000003' }] }]);
  assert.equal(mismatch.exactMatchedPackages, 0);
  assert.equal(mismatch.unresolvedRecords, 1);
  const quantityMismatch = reviewPendingWms(rows, [{ ...zhanma, records: [{ ...original, items: [{ quantity: 2 }] }] }]);
  assert.equal(quantityMismatch.quantityUnverifiedPackages, 1);
  assert.equal(quantityMismatch.outboundPackages, 0);
  const awaiting = reviewPendingWms([{ ...rows[0], orderStatus: 'AWAITING_SHIPMENT' }],
    [{ ...zhanma, records: [] }, { ...shenniu, records: [] }]);
  assert.equal(awaiting.checkedOrders, 1);
  assert.equal(awaiting.packagesWithoutExactWarehouseRecord, 1);
});

test('live routing discovers new orders on later pages and rejects rows outside its fixed window', async () => {
  const end = 1794530574;
  const one = { id: '900000000000000025', createdAt: end - 30, status: 'ON_HOLD' };
  const two = { id: '900000000000000026', createdAt: end - 5, status: 'AWAITING_SHIPMENT' };
  const client = { async ordersPage(_token, _shop, size, cursor, start, cutoff) {
    assert.equal(size, 100);
    assert.equal(start, end - 604_800);
    assert.equal(cutoff, end);
    return cursor ? { rows: [two], totalCount: 2, nextToken: null } : { rows: [one], totalCount: 2, nextToken: 'p2' };
  } };
  const { orders } = await readLiveRoutingOrders(client, 'token', {}, end);
  assert.deepEqual(orders.rows, [one, two]);
  assert.equal(orders.pages, 2);
  two.createdAt = end;
  await assert.rejects(readLiveRoutingOrders(client, 'token', {}, end), /outside the live routing scope/u);
});

test('reads seller aftersales decisions by request ID and keeps the response read-only', async () => {
  const returnId = '9000000000000000082';
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(url.pathname, '/return_refund/202601/decision_eligibility');
    assert.equal(url.searchParams.get('return_or_cancel_id'), returnId);
    assert.equal(options.method, 'GET');
    return Response.json({ code: 0, request_id: 'return-readback', data: { decisions: [
      { decision: 'APPROVE_RECEIVED_PACKAGE', eligible: false, ineligible_code: 25001001, ineligible_reason: 'Untrusted text' },
    ] } });
  } });
  const result = await client.returnDecisionEligibility('fixture-token', { region: 'MY', cipher: 'fixture-cipher' }, returnId);
  assert.deepEqual(result, { requestId: 'return-readback', decisions: [
    { decision: 'APPROVE_RECEIVED_PACKAGE', eligible: false, code: 25001001 },
  ] });
});

test('includes unread conversations on later pages and checks that the first page stayed stable', async () => {
  const first = { conversations: [{ id: '10000001', unread_count: 0, can_send_message: true }], next_page_token: 'opaque' };
  const second = { conversations: [{ id: '10000002', unread_count: 2, can_send_message: false }] };
  const calls = [];
  const client = { async customerServiceConversations(_token, _shop, cursor) {
    calls.push(cursor);
    return cursor ? second : first;
  } };
  const result = await readCustomerInbox(client, 'token', {});
  assert.deepEqual(calls, [undefined, 'opaque', undefined]);
  assert.deepEqual(result.summary, { coverage: 'all_cursor_pages', count: 2, pages: 2, morePages: false,
    unreadConversations: 1, unreadMessages: 2, unreadReplyable: 0, replyableConversations: 1 });
  second.conversations[0].id = first.conversations[0].id;
  await assert.rejects(readCustomerInbox(client, 'token', {}), /changed during paging/u);
});

test('warehouse replay keeps package confirmation and WMS evidence bound to the exact order lines', () => {
  const orderId = '10000001';
  const line = { id: '10000002', skuId: '10000003', productId: '10000004', packageId: '10000005' };
  const warehouseId = '10000006';
  const catalog = [{ id: orderId, status: 'AWAITING_COLLECTION', skus: [{ lineId: line.id, id: line.skuId, productId: line.productId }] }];
  const warehouse = [{ id: warehouseId, sub_type: 'CB_OVERSEA_WAREHOUSE' }];
  const exactWms = [{ orderId, packageId: line.packageId, productId: line.productId, skuId: line.skuId,
    platformWarehouseId: warehouseId, system: 'fixture WMS', warehouseId: 80, stage: 'has_out_storage' }];
  const detail = { id: orderId, status: 'AWAITING_COLLECTION', warehouseId, deliveryOptionName: 'Self-collection',
    lines: [line], packageIds: [line.packageId] };
  const [matched] = replayFulfillmentRouting(catalog, [detail], warehouse, exactWms);
  assert.equal(matched.nextAction, 'check_existing_package_and_carrier');
  assert.equal(matched.serviceMatches, null);
  assert.equal(matched.wms.warehouseId, 80);
  const [wrongService] = replayFulfillmentRouting(catalog, [{ ...detail, status: 'AWAITING_SHIPMENT' }], warehouse, exactWms);
  assert.equal(wrongService.nextAction, 'verify_shipping_service_before_assignment');
  const [platformPickup] = replayFulfillmentRouting(catalog, [{ ...detail, shippingType: 'TIKTOK' }], warehouse, exactWms);
  assert.equal(platformPickup.serviceMatches, true);
  assert.equal(platformPickup.buyerCollectionPoint, true);
  assert.equal(platformPickup.nextAction, 'check_existing_package_and_carrier');
  const [routeMismatch] = replayFulfillmentRouting(catalog, [{ ...detail, shippingType: 'TIKTOK', status: 'AWAITING_SHIPMENT' }],
    [{ ...warehouse[0], sub_type: 'CB_DIRECT_SHIPPING_WAREHOUSE' }], exactWms);
  assert.equal(routeMismatch.buyerCollectionPoint, false);
  assert.equal(routeMismatch.nextAction, 'verify_shipping_service_before_assignment');
  const [wrongSku] = replayFulfillmentRouting(catalog, [{ ...detail, lines: [{ ...line, skuId: '10000009' }] }], warehouse, exactWms);
  assert.equal(wrongSku.route, null);
  assert.equal(wrongSku.wms, null);
});

test('only exact original orders and packages count toward collection progress and pickup scans', async () => {
  const [a, b, ap, bp, al, bl, sku, product, warehouse] =
    ['10000001', '10000002', '10000003', '10000004', '10000005', '10000006', '10000007', '10000008', '10000009'];
  const cutoff = Date.parse('2026-11-13T07:00:00+08:00') / 1000;
  const basis = [[a, ap, al], [b, bp, bl]].map(([orderId, packageId, lineId]) => ({
    orderId, packages: [packageId], status: 'AWAITING_COLLECTION', warehouseId: warehouse,
    skus: [{ skuId: sku, productId: product, lineIds: [lineId] }], nextAction: 'check_existing_package_and_carrier',
  }));
  const tracking = [];
  const client = {
    async operationalOrders(_token, _shop, ids) {
      assert.deepEqual(ids, [a, b]);
      return [[a, ap, al, 'IN_TRANSIT'], [b, bp, bl, 'AWAITING_COLLECTION']].map(([id, packageId, lineId, status]) => ({
        id, status, warehouseId: warehouse, collectionDueAt: cutoff - 1, packageIds: [packageId],
        fulfillmentDeadlines: { collectionSlaAt: cutoff - 1, collectionDueAt: cutoff + 60 },
        lines: [{ id: lineId, skuId: sku, productId: product, packageId }],
      }));
    },
    async packageDetail(_token, _shop, id) {
      return { id, orderIds: [a], lineIds: [al], status: id === ap ? 'IN_TRANSIT' : 'PROCESSING', hasTrackingNumber: true,
        warehouseId: '10000010' };
    },
    async orderTracking(_token, _shop, orderId) {
      tracking.push(orderId);
      return [{ code: 30901, updatedAtMillis: (cutoff - 20) * 1000 }];
    },
  };
  const { rows, summary } = await readPendingPackages(client, 'fixture', {}, basis, cutoff);
  assert.deepEqual(tracking, [a]);
  assert.equal(summary.exactCurrent, 1);
  assert.equal(summary.movedToTransitOrLater, 1);
  assert.equal(summary.pickupScansVerified, 1);
  assert.equal(summary.packageWarehouseConflicts, 1);
  assert.equal(rows[0].packageWarehouseConflict, true);
  assert.deepEqual(rows[0].fulfillmentDeadlines, { collectionSlaAt: cutoff - 1, collectionDueAt: cutoff + 60 });
  assert.equal(summary.unverified, 1);
  assert.equal(summary.passedCollectionDeadline, 0);
  assert.equal(rows[1].packages[0].belongsToOriginalOrder, false);
  assert.equal(rows[1].exact, false);
});

test('checks label and drop-off only on exact original domestic packages still awaiting shipment', async () => {
  const cutoff = Date.parse('2026-11-13T12:00:00+08:00') / 1000;
  const [productId, skuId, warehouseId] = ['10000101', '10000102', '10000103'];
  const rows = ['10000201', '10000202', '10000203'].map((orderId, index) => ({ orderId, status: 'AWAITING_SHIPMENT', warehouseId,
    route: 'china_direct', packages: [`1000030${index}`], skus: [{ productId, skuId, lineIds: [`1000040${index}`] }],
    nextAction: 'check_existing_package_and_carrier' }));
  const [pending, otherPackage, alreadyMoved] = rows;
  const calls = [];
  const client = {
    async operationalOrders() {
      return rows.map(({ orderId: id, packages: packageIds, skus: [sku] }) => ({ id, packageIds, warehouseId,
        status: id === alreadyMoved.orderId ? 'AWAITING_COLLECTION' : 'AWAITING_SHIPMENT',
        lines: [{ id: sku.lineIds[0], skuId, productId, packageId: packageIds[0] }] }));
    },
    async packageDetail(_token, _shop, id) {
      const row = rows.find(order => order.packages.includes(id));
      return { id, orderIds: [row === otherPackage ? pending.orderId : row.orderId], lineIds: row.skus[0].lineIds,
        status: row === alreadyMoved ? 'PROCESSING' : 'TO_FULFILL', hasTrackingNumber: false, warehouseId };
    },
    async packageHandover(_token, _shop, id) {
      calls.push(['handover', id]);
      return { requestId: 'handover-ok', canDropOff: true };
    },
    async packageLabelAvailability(_token, _shop, id) {
      calls.push(['label', id]);
      throw Object.assign(new Error('no label'), { platformCode: 21042104, httpStatus: 200, requestId: 'label-pending' });
    },
  };
  const result = await readPendingPackages(client, 'fixture', {}, rows, cutoff, { readShippingDocuments: true });
  assert.deepEqual(calls, [['handover', pending.packages[0]], ['label', pending.packages[0]]]);
  assert.deepEqual(result.rows[0].packages[0].shipping, { canDropOff: true, handoverRequestId: 'handover-ok', labelAvailable: false,
    labelRequestId: 'label-pending', labelCode: 21042104 });
  assert.equal(result.rows[1].packages[0].shipping, undefined);
  assert.equal(result.rows[2].packages[0].shipping, undefined);
});

test('product finance review separates complete MY days, cancelled orders and exact SKU settlement', () => {
  const window = completeMalaysiaDays({ startInclusive: Date.parse('2026-11-06T02:00:00+08:00') / 1000,
    endExclusive: Date.parse('2026-11-13T02:00:00+08:00') / 1000 });
  assert.equal(window.startDate, '2026-11-07');
  assert.equal(window.endDateExclusive, '2026-11-13');
  const [productId, skuId, orderId, lineId, statementId] = ['10000001', '10000002', '10000003', '10000004', '10000005'];
  const lines = [{ productId, id: skuId, lineId }];
  const product = { productId, impressions: 12, clicks: 2, analyticsOrders: 2, refundedItems: 0 };
  const orders = [{ id: orderId, status: 'DELIVERED', createdAt: window.startInclusive, skus: lines },
    { id: '10000006', status: 'CANCELLED', createdAt: window.startInclusive, skus: lines },
    { id: '10000007', status: 'DELIVERED', createdAt: window.endExclusive, skus: lines }];
  assert.equal(compareProductFinance([product], orders, [], window).summary.directSettlementSkuRows, null);
  const evidence = [{ orderId, statements: [{ id: statementId, paymentStatus: null }],
    skuTransactions: [{ skuId, statementId, quantity: '1', net: '4.2000' },
      { skuId: '10000009', statementId, quantity: '1', net: '0.80' }] }];
  const result = compareProductFinance([product], orders, [], window, evidence);
  assert.equal(result.summary.exactPlatformOrders, 1);
  assert.equal(result.summary.cancelledPlatformOrders, 1);
  assert.equal(result.summary.orderCountDisagreementProducts, 1);
  assert.equal(result.summary.directSettlementSkuRows, 1);
  assert.equal(result.summary.directSettlementNetMyr, '4.20');
  assert.equal(result.summary.directSettlementPaymentUnverified, 1);
  assert.equal(result.summary.actualProfitMyr, null);
  assert.equal(result.rows[0].orderTypes.unknownSampleFlag, 1);
  assert.deepEqual(result.rows[0].orderDays, [{ day: '2026-11-07', exactOrders: 1, orderSkuPairs: 1, exactLineItems: 1 }]);
  assert.equal(result.rows[0].orderTypes.sampleSettlementNetMyr, null);
  const taggedOrders = [{ ...orders[0], sampleOrder: true }, ...orders.slice(1)];
  const sample = compareProductFinance([product], taggedOrders, [], window, evidence);
  assert.equal(sample.rows[0].orderDetailOrders, 1);
  assert.equal(sample.rows[0].orderTypes.sampleOrders, 1);
  assert.equal(sample.rows[0].orderTypes.unknownSampleFlag, 0);
  assert.equal(sample.rows[0].orderTypes.sampleSettlementNetMyr, '4.20');
  assert.equal(sample.rows[0].orderTypes.nonSampleSettlementNetMyr, null);
  assert.equal(sample.summary.directSettlementNetMyr, result.summary.directSettlementNetMyr);
});

test('GMV Max review keeps product cards, verified video IDs and shop settlement in their own measures', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId: '9000000000000000096' };
  const productId = '9000000000000000016', campaignId = '9000000000000004', videoId = '9000000000000000129';
  const window = { startDate: '2026-11-12', endDateExclusive: '2026-11-13', days: 1 };
  const item = (id, type, cost, revenue, orders) => ({ dimensions: { item_id: id },
    metrics: { shop_content_type: type, cost, gross_revenue: revenue, orders } });
  const byDay = { result: { rows: [{ dimensions: { item_group_id: productId, stat_time_day: '2026-11-12 00:00:00' },
    metrics: { cost: '1.50', gross_revenue: '15.00', orders: '3' } }] } };
  const creatives = [{ productId, available: true, result: { rows: [item('-1', 'PRODUCT_CARD', '1.50', '8.00', '2'),
    item(videoId, 'VIDEO', '0', '7.00', '1')] } }];
  const ads = { schema: 'operations-gmv-max-read/v1', shop, account: { advertiser_id: shop.advertiserId,
    timezone: 'Asia/Kuala_Lumpur', currency: 'USD' }, campaignDetails: [{ id: campaignId, type: 'PRODUCT', status: 'ENABLE', productIds: [productId] }],
    completeDays: { start: window.startDate, end: window.startDate, productReports: [{ campaignId, byDay, creatives }] } };
  const finance = { schema: 'operations-product-finance-review/v1', shop, window,
    rows: [{ productId, orderDetailOrders: 2, analyticsOrders: 2, directSettlementSkuRows: 1, directSettlementNetMyr: '6.40',
      orderDays: [{ day: window.startDate, exactOrders: 2, orderSkuPairs: 3, exactLineItems: 4 }] }] };
  const video = { schema: 'operations-shop-video-reconciliation/v1', shop,
    linkedHistoricalVideos: [{ platformVideoId: videoId, productId, account: 'example-creator-3', jobId: 'original', originalSuccess: { source: 'receipt' } }] };
  const [row] = reviewGmvMaxProducts(ads, finance, video).rows;
  assert.equal(row.creative.byContent.PRODUCT_CARD.skuOrders, 2);
  assert.equal(row.creative.byContent.VIDEO.roiFromDisplayedAmounts, null);
  assert.equal(row.creative.mostOrderedOriginalVideos[0].platformVideoId, videoId);
  assert.equal(row.sameWindow.ads.skuOrders, 3);
  assert.equal(row.sameWindow.shop.exactOrders, 2);
  assert.equal(row.sameWindow.shop.exactLineItems, 4);
  assert.equal(row.sameWindow.shop.settledNetMyr, '6.40');
  assert.deepEqual(row.sameWindow.daily.map(entry => [entry.day, entry.ads.skuOrders, entry.shop.exactOrders, entry.shop.orderSkuPairs]),
    [['2026-11-12', 3, 2, 3]]);
  assert.equal(row.sameWindow.attributedOrderLink, null);
  assert.equal(row.sameWindow.actualNetProfitMyr, null);
  Object.assign(finance.rows[0], { paidSkuRows: 1, paidNetMyr: '-1.20', directSettlementPaymentUnverified: 1 });
  const paid = reviewGmvMaxProducts(ads, finance, video).rows[0].sameWindow.shop;
  assert.equal(paid.settledSkuRows, 2);
  assert.equal(paid.settledNetMyr, '5.20');
  assert.equal(paid.platformPaidNetMyr, '-1.20');
  assert.equal(paid.paymentUnverifiedSkuRows, 1);
  finance.rows[0].orderDays[0].exactOrders = 1;
  assert.throws(() => reviewGmvMaxProducts(ads, finance, video), /order day totals/u);
});

test('creative review requires same-window product evidence and skips product cards, exclusions and account mismatches', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId: '9000000000000000096' };
  const campaignId = '9000000000000004';
  const productId = '9000000000000000016';
  const videoId = '9000000000000000129';
  const metrics = { shop_content_type: 'VIDEO', orders: '7', cost: '0.33', gross_revenue: '41.05', roi: '124.39', tt_account_name: '0' };
  const report = { dimensions: ['item_id'], requestIds: ['ad-request'], rows: [
    { dimensions: { item_id: '-1' }, metrics: { ...metrics, shop_content_type: 'PRODUCT_CARD' } },
    { dimensions: { item_id: videoId }, metrics },
  ] };
  const ads = { schema: 'operations-gmv-max-read/v1', shop, requestIds: { account: 'a', shop: 's' },
    account: { advertiser_id: shop.advertiserId, timezone: 'Asia/Kuala_Lumpur', currency: 'USD' },
    campaignDetails: [{ id: campaignId, status: 'ENABLE', type: 'PRODUCT', productIds: [productId] }],
    completeDays: { start: '2026-11-06', end: '2026-11-12', productReports: [{ campaignId, creatives: [{ productId, result: report }] }] } };
  const stats = { platformVideoId: videoId, expectedProductId: productId, productIds: [productId], requestIds: ['shop-request'],
    state: 'product_analytics_confirmed', latestAvailableDate: '2026-11-12',
    engagement: { startInclusive: '2026-11-06', endExclusive: '2026-11-13', clicks: 9, unitsSold: 7 } };
  const videos = { schema: 'operations-shop-video-reconciliation/v1', shop, coverage: { completeForPerformanceList: true },
    linkedHistoricalVideos: [{ platformVideoId: videoId, productId, account: 'example-creator-3', originalSuccess: { source: 'receipt', sha256: 'a'.repeat(64) } }],
    productPerformance: [stats] };
  assert.deepEqual(proposeCreativeReviews(ads, videos).map(row => row.id), [videoId]);
  metrics.tt_account_name = 'other';
  assert.deepEqual(proposeCreativeReviews(ads, videos), []);
  metrics.tt_account_name = '@example-creator-3';
  metrics.creative_delivery_status = 'EXCLUDED';
  assert.deepEqual(proposeCreativeReviews(ads, videos), []);
  metrics.creative_delivery_status = 'LEARNING';
  stats.engagement.endExclusive = '2026-11-12';
  assert.deepEqual(proposeCreativeReviews(ads, videos), []);
});

test('Claude aircraft decisions require an exact creative report and leave exclusion impact pending', () => {
  const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId: '9000000000000000096' };
  const campaignId = '9000000000000004';
  const productId = '9000000000000000016';
  const videoId = '9000000000000000123';
  const card = { dimensions: { item_id: '-1' }, metrics: { shop_content_type: 'PRODUCT_CARD', orders: '23',
    cost: '10.13', gross_revenue: '157.35', roi: '15.53' } };
  const video = { dimensions: { item_id: videoId }, metrics: { shop_content_type: 'VIDEO', orders: '2',
    cost: '7.04', gross_revenue: '12.24', roi: '1.74', creative_delivery_status: 'EXCLUDED' } };
  const report = { dimensions: ['item_id'], requestIds: ['creative-page'], rows: [card, video] };
  const receipt = { schema: 'operations-gmv-max-read/v1', observedAt: '2026-11-13T08:52:42Z', shop,
    account: { advertiser_id: shop.advertiserId, timezone: 'Asia/Kuala_Lumpur', currency: 'USD' },
    requestIds: { account: 'advertiser-read', shop: 'shop-read' }, inProgressDay: { day: '2026-11-13' },
    campaignDetails: [{ id: campaignId, type: 'PRODUCT', status: 'ENABLE', productIds: [productId] }],
    completeDays: { start: '2026-11-06', end: '2026-11-12',
      productReports: [{ campaignId, creatives: [{ productId, result: report }] }] } };
  const result = reviewAircraftCreativeDecisions(receipt);
  assert.equal(result.productCard.state, 'classification_verified');
  assert.equal(result.productCard.skuOrders, 23);
  assert.equal(result.productCard.videoComparison.skuOrders, 2);
  assert.equal(result.video.deliveryStatus, 'EXCLUDED');
  assert.equal(result.video.outcome.exclusionAt, null);
  assert.equal(result.video.outcome.changePercent, null);
  assert.equal(reviewAircraftCreativeDecisions({ ...receipt, shop: { ...shop, id: productId } }), null);
  assert.equal(reviewAircraftCreativeDecisions({ ...receipt, inProgressDay: { day: '2026-11-12' } }), null);
  card.metrics.shop_content_type = 'UNCLASSIFIED';
  assert.equal(reviewAircraftCreativeDecisions(receipt).productCard, null);
  report.rows.push(card);
  assert.throws(() => reviewAircraftCreativeDecisions(receipt), /Duplicate or invalid creative ID/u);
});

test('support triage retains the need to confirm buyer context and uses exact return identity', () => {
  const base = { unread: true, canSend: true, available: true, latestRole: 'ROBOT' };
  const order = { id: '1000000100', status: 'IN_TRANSIT' };
  const conversations = [
    { ...base, conversationId: '1000000001', orders: [order] },
    { ...base, conversationId: '1000000002', canSend: false, orders: [order] },
    { ...base, conversationId: '1000000003', latestRole: 'SHOP', orders: [order] },
    { ...base, conversationId: '1000000004', orders: [order, { id: '1000000101', status: 'COMPLETED' }] },
  ];
  const receipt = { schema: 'operations-service-fulfillment-read/v1', shop: { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' },
    conversations: { available: true, data: { unreadConversations: 4 } },
    caseLinkage: { available: true, data: { cases: conversations } },
    returns: { available: true, data: { rows: [{ returnId: '1000000020', orderId: order.id,
      status: 'RETURN_OR_REFUND_REQUEST_PENDING', matchedLines: false }] } } };
  const result = reviewSupportTriage(receipt);
  assert.deepEqual(result.routes, { check_logistics_context: 1, platform_reply_disabled: 1, recheck_latest_shop_reply: 1, choose_exact_order: 1 });
  assert.equal(result.conversations.every(row => !row.buyerIntentVerified), true);
  assert.equal(result.refundCases[0].route, 'verify_return_order_and_sku');
  assert.equal(result.refundCases[0].sellerDeadline, null);
  assert.equal(result.customerMessagesSent, 0);
  assert.equal(result.pendingCancellationOrders, null);
  receipt.caseLinkage.data.afterSales = { available: true, data: { cancellationRecords: [
    { id: '1000000030', orderId: order.id, status: 'CANCELLATION_REQUEST_PENDING' },
    { id: '1000000031', orderId: '1000000101', status: 'CANCELLATION_REQUEST_COMPLETE' },
  ] } };
  const updated = reviewSupportTriage(receipt);
  assert.equal(updated.routes.check_pending_cancellation, 1);
  assert.equal(updated.routes.choose_exact_order, 1);
  assert.equal(updated.ordersWithCancellationRecords, 2);
  assert.equal(updated.pendingCancellationOrders, 1);
  receipt.caseLinkage.data.afterSales.data.cancellationRecords[0].status = 'CANCELLATION_REQUEST_SUCCESS';
  assert.equal(reviewSupportTriage(receipt).routes.check_cancellation_status, 1);
  receipt.caseLinkage.data.afterSales.data.cancellationRecords[0].status = 'CANCELLATION_REQUEST_CANCEL';
  assert.equal(reviewSupportTriage(receipt).routes.check_logistics_context, 1);
});
