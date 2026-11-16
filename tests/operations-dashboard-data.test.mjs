import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readOperationsDashboard, refreshDashboardPayments, refreshDashboardShopSales } from '../apps/customer-service/operations-dashboard-data.mjs';

const date = '2026-11-14';
const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId: '9000000000000000096' };
const observedAt = '2026-11-14T06:00:00Z';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'operations-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, save: async (file, value) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  } };
}

test('scoped receipts preserve zero, separate source windows and reject wrong shops', async t => {
  const { root, save } = await fixture(t);
  await save('apps/customer-service/data/operations-board/days/2026-11-14.json', {
    day: date, metrics: { shop: 'example-shop-my', collectedAt: observedAt, activeProducts: 0, productsTotal: 0, orders7d: 0, trend: [] },
  });
  const ad = { schema: 'operations-gmv-max-read/v1', observedAt, shop,
    account: { currency: 'USD', advertiser_id: shop.advertiserId },
    completeDays: { start: '2026-11-07', end: '2026-11-13', accountByDay: { code: 0, request_id: 'abc', data: {
      total_metrics: { cost: '0.00', net_cost: '0.00', orders: '0', roi: '0.00', gross_revenue: '0.00' },
    } } }, inProgressDay: { day: date },
  };
  await save('outputs/ads-monitoring/2026-11-14/live-read-validation/official-gmv-max-0.json', ad);
  await save('outputs/ads-monitoring/2026-11-14/live-read-validation/official-gmv-max-1.json', {
    ...ad, observedAt: '2026-11-14T07:00:00Z', shop: { ...shop, id: '9000000000000000100' },
  });
  const result = await readOperationsDashboard({ root, day: date });
  assert.equal(result.shop.catalogue.orders7d, 0);
  assert.equal(result.shop.sales, null);
  assert.equal(result.ads.complete.currency, 'USD');
  assert.equal(result.ads.complete.spend, '0.00');
  assert.equal(result.ads.complete.skuOrders, 0);
  assert.deepEqual(result.ads.complete.window, { start: '2026-11-07', endExclusive: date });
  assert.equal(result.ads.inProgress, null);
  assert.equal(result.videos.ranking, null);
});

test('a later failed read preserves a verified same-day sales snapshot independently of historical coverage', async t => {
  const { root, save } = await fixture(t);
  const folder = 'outputs/operations-dashboard-shop-performance/2026-11-14';
  const original = {
    schema: 'operations-dashboard-shop-performance/v1', day: date, observedAt, shop, writes: 0, analytics: null,
    today: { state: 'official_same_day_snapshot', day: date, latestAvailableDate: date, requestId: 'today-1',
      gmv: '0.00', orders: 0 },
  };
  await save(folder + '/official-read-1.json', original);
  await save(folder + '/official-read-2.json', {
    ...original, observedAt: '2026-11-14T07:00:00Z', today: { state: 'day_read_unavailable' },
  });
  const { sales } = (await readOperationsDashboard({ root, day: date })).shop;
  assert.equal(sales.series.length, 0);
  assert.deepEqual(sales.today, { day: date, currency: 'MYR', gmv: '0.00', orders: 0,
    source: { path: folder + '/official-read-1.json', observedAt } });
  const { sales: following } = (await readOperationsDashboard({ root, day: '2026-11-15' })).shop;
  assert.equal(following, null);
});

test('after-sales keeps scoped queues separate, deduplicates cases and preserves original receipt dates', async t => {
  const { root, save } = await fixture(t);
  const folder = 'outputs/operations-service-fulfillment/2026-11-14';
  const request = requestId => ({ requestId, status: 200, code: 0, path: '/return_refund/202602/returns/search' });
  const receipt = {
    schema: 'operations-open-aftersales-read/v1', shop, day: date, observedAt, writes: 0,
    requests: [request('open-1'), request('arbitration-1')],
    openAfterSales: {
      lists: [{ key: 'pending_return_or_refund', requestIds: ['open-1'], count: 1, pages: 1 },
        { key: 'in_arbitration', requestIds: ['arbitration-1'], count: 1, pages: 1 }],
      distinctCases: 1, exactMatches: 1, replacementAndExchangeCoverage: 'recent_update_window_only',
      rows: [{ returnId: '9000000000000001', orderId: '9000000000000002', exact: true,
        status: 'RETURN_OR_REFUND_REQUEST_PENDING', arbitrationStatus: 'IN_PROGRESS', amount: '13.90', currency: 'MYR',
        updatedAt: Date.parse(observedAt) / 1000 }],
    },
  };
  await save(folder + '/open-aftersales-verified.json', receipt);
  await save(folder + '/open-aftersales-failed.json', {
    ...receipt, observedAt: '2026-11-14T08:00:00Z',
    requests: [request('open-1'), { ...request('arbitration-1'), status: 429, code: 36009002 }],
  });
  await save(folder + '/open-aftersales-other-shop.json', {
    ...receipt, observedAt: '2026-11-14T09:00:00Z', shop: { ...shop, name: 'other-shop' },
  });
  const { afterSales } = await readOperationsDashboard({ root, day: '2026-11-15' });
  assert.equal(afterSales.open.pendingReturnRefund, 1);
  assert.equal(afterSales.open.inArbitration, 1);
  assert.equal(afterSales.open.distinctCases, 1);
  assert.equal(afterSales.open.rows[0].orderSuffix, '7654');
  assert.equal(afterSales.open.source.observedAt, observedAt);
  assert.equal(afterSales.recent, null);
  assert.equal(afterSales.inbox, null);
  assert.equal(JSON.stringify(afterSales).includes(receipt.openAfterSales.rows[0].orderId), false);
  assert.equal(JSON.stringify(afterSales).includes(receipt.openAfterSales.rows[0].returnId), false);
});

test('today can show same-day paid order evidence and status counts while platform analytics is delayed', async t => {
  const { root, save } = await fixture(t);
  const paidActivity = { day: date, currency: 'MYR', paidOrders: 2, buyerPayment: '43.80',
    paymentCoverage: 'complete_for_order_window', observedAt, requestIds: ['order-1'],
    window: { startInclusive: Date.parse('2026-11-07T06:00:00Z') / 1000, endExclusive: Date.parse(observedAt) / 1000 } };
  await save(`apps/customer-service/data/operations-board/days/${date}.json`, { day: date,
    metrics: { shop: 'example-shop-my', collectedAt: observedAt, awaitingShipment: 3, awaitingCollection: 2, orderActivity: paidActivity } });
  await save(`outputs/operations-dashboard-shop-performance/${date}/official-read-1.json`, {
    schema: 'operations-dashboard-shop-performance/v1', day: date, observedAt, shop, writes: 0,
    today: { state: 'day_not_verified', latestAvailableDate: '2026-11-13', requestId: 'analytics-check' },
  });
  const { shop: salesShop, fulfillment } = await readOperationsDashboard({ root, day: date });
  assert.equal(salesShop.sales.today, null);
  assert.equal(salesShop.sales.todayCoverage.state, 'report_pending');
  assert.equal(salesShop.sales.todayCoverage.latestAvailableDate, '2026-11-13');
  assert.equal(salesShop.sales.todayCoverage.source.observedAt, observedAt);
  assert.equal(salesShop.sales.orderActivity.buyerPayment, '43.80');
  assert.equal(salesShop.sales.orderActivity.paidOrders, 2);
  assert.equal(fulfillment.pendingShipment, 3);
  assert.equal(fulfillment.awaitingCollection, 2);
  assert.equal(fulfillment.isCurrentDay, true);
  assert.ok(fulfillment.warehouses.every(row => row.pendingShipment === null || row.warehouseId === 'unassigned'));
});

test('recent order status totals keep their own source while warehouse details remain tied to routing', async t => {
  const { root, save } = await fixture(t);
  const newer = '2026-11-14T07:00:00Z';
  const endExclusive = Date.parse(newer) / 1000;
  const window = { startInclusive: endExclusive - 604_800, endExclusive };
  const orderFile = `outputs/operations-dashboard-shop-performance/${date}/official-read-2.json`;
  await save(orderFile, { schema: 'operations-dashboard-shop-performance/v1', day: date, observedAt: newer, shop, writes: 0,
    orderActivity: { day: date, currency: 'MYR', paidOrders: 1, buyerPayment: '33.33', paymentCoverage: 'complete_for_order_window',
      observedAt: newer, requestIds: ['order-2'], window },
    orderStatus: { observedAt: newer, pendingShipment: 4, awaitingCollection: 2 },
  });
  const routeDir = `outputs/operations-fulfillment-routing-replay/${date}`;
  await save(`${routeDir}/official-read-1.json`, {
    schema: 'operations-fulfillment-routing-replay/v1', shop, observedAt, day: date,
    orderSource: 'live_order_list', summary: { pendingShipment: 3, pendingCollection: 3, writes: 0 }, rows: [],
    trace: [{ path: '/order/202507/orders', status: 200, code: 0, requestId: 'route-1' }],
  });
  const result = await readOperationsDashboard({ root, day: date });
  assert.equal(result.fulfillment.pendingShipment, 3);
  assert.equal(result.fulfillment.source.observedAt, observedAt);
  assert.deepEqual(result.fulfillment.liveTotals, { pendingShipment: 4, awaitingCollection: 2,
    source: { observedAt: newer, path: orderFile } });
  assert.equal(result.shop.sales.orderActivity.buyerPayment, '33.33');
  assert.deepEqual(await refreshDashboardPayments({ root, now: new Date('2026-11-14T07:01:00Z') }),
    { state: 'fresh', day: date, observedAt: newer });

  await save(`outputs/operations-dashboard-shop-performance/${date}/official-read-3.json`, {
    schema: 'operations-dashboard-shop-performance/v1', day: date, observedAt: newer, shop, writes: 0,
    today: { state: 'report_pending', latestAvailableDate: '2026-11-13', requestId: 'analytics-check' },
  });
  assert.deepEqual(await refreshDashboardShopSales({ root, now: new Date('2026-11-14T07:15:00Z') }),
    { state: 'fresh', day: date, observedAt: newer });
});

test('routing picks the latest validated timed receipt and refreshes changed or newly arrived files', async t => {
  const { root, save } = await fixture(t);
  const prefix = `outputs/operations-fulfillment-routing-replay/${date}/official-read-`;
  const saveRoute = (hour, pendingShipment, identity = shop) => save(`${prefix}${date}T${hour}-00-00-000Z.json`, {
    schema: 'operations-fulfillment-routing-replay/v1', shop: identity, day: date,
    observedAt: `${date}T${hour}:00:00.000Z`, orderSource: 'live_order_list', rows: [],
    summary: { pendingShipment, pendingCollection: 2, writes: 0 },
    trace: [{ path: '/order/202507/orders', status: 200, code: 0, requestId: 'route-request' }],
  });
  const pending = async () => (await readOperationsDashboard({ root, day: date })).fulfillment.pendingShipment;
  await saveRoute('06', 3);
  await saveRoute('07', 9, { ...shop, region: 'US' });
  assert.equal(await pending(), 3);
  await saveRoute('06', 4);
  assert.equal(await pending(), 4);
  await saveRoute('08', 5);
  assert.equal(await pending(), 5);
});

test('fulfillment exposes masked order references and attaches stock only to the same package and SKU', async t => {
  const { root, save } = await fixture(t);
  const orderId = '900000000000000029';
  const packageId = '9000000000000000010';
  const skuId = '9000000000000000033';
  const directory = 'outputs/operations-fulfillment-routing-replay/2026-11-14';
  const route = { orderId, packages: [packageId], status: 'AWAITING_SHIPMENT', route: 'china_direct', identityVerified: true,
    serviceMatches: true, packageLineIdentityVerified: true, skus: [{ skuId, quantity: 1 }], address: 'private-address' };
  const routeFile = `${directory}/official-read-1.json`;
  const collectionOrder = { ...route, status: 'AWAITING_COLLECTION', orderId: '900000000000000030',
    packages: ['9000000000000000011'], nextAction: 'check_existing_package_and_carrier' };
  const overseasCollectionOrder = { ...collectionOrder, orderId: '900000000000000031',
    packages: ['9000000000000000012'], route: 'malaysia_overseas' };
  await save(routeFile, { schema: 'operations-fulfillment-routing-replay/v1', observedAt, shop, orderSource: 'live_order_list',
    summary: { pendingShipment: 1, pendingCollection: 2, pendingShipmentByRoute: { china_direct: 1, malaysia_overseas: 0 },
      writes: 0 }, rows: [route, collectionOrder, overseasCollectionOrder],
    trace: [{ path: '/order/202507/orders', status: 200, code: 0, requestId: 'abc' }] });
  await save(`${directory}/domestic-packing-1.json`, { schema: 'operations-domestic-packing/v1', observedAt, shop,
    routingSource: join(root, routeFile), writes: 0,
    platform: { order: { id: orderId, lines: [{ skuId, packageId }] }, package: { id: packageId } },
    packing: { orderId, packageId, state: 'stock_or_card_unverified' },
    history: [{ skuId, goodsSkuOuterId: 'TEST-SKU' }],
    inventory: [{ warehouseId: '879', goodsSkuOuterId: 'TEST-SKU', exactRows: 1, available: 0, locked: 1 }],
  });
  await save(`${directory}/shadow-run-1.json`, { schema: 'operations-fulfillment-shadow-run/v1', observedAt, shop,
    routingSource: join(root, routeFile), summary: { writes: 0 }, rows: [{ orderId: collectionOrder.orderId,
      packageId: collectionOrder.packages[0], route: 'china_direct', currentStatus: 'AWAITING_COLLECTION',
      comparison: { originalPackageMatch: true, platformRouteMatch: true, observedWarehouse: '879',
        warehouseReadComplete: true, expectedRouteRecords: 1, otherRouteRecords: 0,
        crossRouteDuplicate: false, duplicateAcrossWarehouses: false, warehouseOnWrongRoute: false } }],
  });
  const result = await readOperationsDashboard({ root, day: date });
  assert.equal(result.fulfillment.pendingShipment, 1);
  assert.equal(result.fulfillment.snapshotDay, date);
  assert.equal(result.fulfillment.isCurrentDay, true);
  assert.equal(result.fulfillment.rows[0].orderSuffix, '4980');
  assert.equal(result.fulfillment.rows[0].state, 'stock_or_card_unverified');
  assert.equal(result.fulfillment.rows[0].inventory[0].available, 0);
  const domestic = result.fulfillment.warehouses.find(row => row.warehouseId === '879');
  assert.equal(domestic.awaitingCollection, 1);
  assert.equal(domestic.collectionCoverage, 'verified');
  assert.equal(domestic.pendingCoverage, 'partial');
  const overseas = result.fulfillment.warehouses.find(row => row.warehouseId === '80');
  assert.equal(overseas.pendingShipment, 0);
  assert.equal(overseas.pendingCoverage, 'verified');
  assert.equal(overseas.collectionCoverage, 'partial');
  assert.equal(result.fulfillment.pendingRouteUnknown, 0);
  assert.equal(result.fulfillment.collectionRouteUnknown, 0);
  const chinaDirect = result.fulfillment.byRoute.find(row => row.route === 'china_direct');
  assert.equal(chinaDirect.pendingShipment, 1);
  assert.equal(chinaDirect.unassignedPendingShipment, 1);
  assert.equal(chinaDirect.unassignedAwaitingCollection, 0);
  assert.equal(result.fulfillment.warehouses.find(row => row.warehouseId === 'unassigned').awaitingCollection, 1);
  assert.equal(result.fulfillment.warehouses.find(row => row.warehouseId === 'unassigned').pendingShipment, 1);
  assert.equal(JSON.stringify(result).includes(orderId), false);
  assert.equal(JSON.stringify(result).includes('private-address'), false);
  const tomorrow = await readOperationsDashboard({ root, day: '2026-11-15' });
  assert.equal(tomorrow.fulfillment.snapshotDay, date);
  assert.equal(tomorrow.fulfillment.isCurrentDay, false);
  assert.equal(tomorrow.fulfillment.pendingShipment, 1);
  assert.deepEqual(tomorrow.fulfillment.source, result.fulfillment.source);
  assert.deepEqual(tomorrow.fulfillment.rows, result.fulfillment.rows);
  assert.equal(tomorrow.suggestions.some(item => item.kind === 'fulfillment'), false);
});

test('product performance keeps analytics orders, order details, and unobserved cart steps separate', async t => {
  const { root, save } = await fixture(t);
  const productId = '9000000000000000016';
  await save('outputs/operations-product-finance-review/2026-11-13/official-read-1.json', {
    schema: 'operations-product-finance-review/v1', observedAt: '2026-11-13T10:00:00Z', day: '2026-11-13', shop,
    window: { startDate: '2026-11-07', endDateExclusive: '2026-11-13' }, analyticsCoverage: 'LIVE', analyticsPages: 1,
    summary: { activeProductsInAnalytics: 1, impressions: 100, clicks: 10, analyticsProductOrders: 3, exactPlatformOrders: 2 },
    rows: [{ productId, title: '飞机', impressions: 100, clicks: 10, analyticsOrders: 3, orderDetailOrders: 2, itemsSold: 4 }],
  });
  const result = await readOperationsDashboard({ root, day: date });
  assert.equal(result.funnel.orders, 3);
  assert.equal(result.funnel.exactOrders, 2);
  assert.equal(result.funnel.cartAdds, null);
  assert.equal(result.productRank.rows[0].orders, 2);
  assert.equal(result.productRank.rows[0].skuId, null);
  assert.equal(result.productRank.rows[0].imageUrl, null);
});
