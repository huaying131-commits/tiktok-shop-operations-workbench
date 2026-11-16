import assert from 'node:assert/strict';
import test from 'node:test';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { readMerchantPromotionPreflight } from '../scripts/operations/read-promotion-preflight.mjs';
import { canCloseEmptyPilot, comparePilotMarketPrice, linkPilotStatementPayments, planFixedPriceActivity, planPilotRepricing, readLivePilotOutcome, readPilotOrderEconomics, readPilotOrderWindow, readPromotionInventory, reviewActivity, reviewPilotOrders } from '../scripts/operations/verify-promotion-outcome.mjs';

test('uses priced local components as a near-spec comparison without treating them as an exact bundle or approved price', () => {
  const benchmark = { currency: 'MYR', scope: 'near_spec_components', components: [
    { type: 'sticks', count: 5, amount: '15.00', listedInStock: true },
    { type: 'rings', count: 4, amount: '15.00', listedInStock: true },
  ] };
  const models = [{ id: 'original', regularPrice: '62.58', firstStagePrice: '35.67', secondStagePrice: '31.29' },
    { id: 'updated', regularPrice: '53.10', firstStagePrice: '30.27', secondStagePrice: '26.55' }];
  const result = comparePilotMarketPrice(benchmark, models, '34.90');
  assert.equal(result.combinedPrice, '30.00');
  assert.equal(result.currentRegularAboveComparison, '4.90');
  assert.deepEqual(result.models[0], { id: 'original', regularDifference: '32.58', firstStageDifference: '5.67', secondStageDifference: '1.29' });
  assert.equal(result.models[1].secondStageDifference, '-3.45');
  assert.equal(result.exactMarketBundlePrice, null);
  const withoutLivePrice = comparePilotMarketPrice(benchmark, models, null);
  assert.equal(withoutLivePrice.combinedPrice, '30.00');
  assert.equal(withoutLivePrice.currentRegularAboveComparison, null);
  assert.deepEqual(withoutLivePrice.models, result.models);
  assert.throws(() => comparePilotMarketPrice({ ...benchmark, components: [benchmark.components[0]] }, models, '34.90'), /comparison/u);
});

test('promotion inventory verifies the product and exact SKU and keeps omitted allocations unknown', async () => {
  const shop = { id: '9000000000000000099', region: 'MY', cipher: 'fixture' };
  const pool = { productId: '9000000000000000057', skuId: '9000000000000000056', sellerSku: 'pool' };
  const octopus = { productId: '9000000000000000041', skuId: '9000000000000000042', sellerSku: 'octopus' };
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, args) => {
    assert.equal(url.pathname, '/product/202309/inventory/search');
    assert.equal(args.method, 'POST');
    assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
    assert.deepEqual(JSON.parse(args.body), { sku_ids: [pool.skuId, octopus.skuId] });
    return Response.json({ code: 0, request_id: 'fixture-request', data: { inventory: [
      { product_id: pool.productId, skus: [{ id: pool.skuId, seller_sku: pool.sellerSku,
        total_available_quantity: 100, total_committed_quantity: 0,
        total_available_inventory_distribution: { in_shop_inventory: { quantity: 100 } } }] },
      { product_id: pool.productId, skus: [{ id: octopus.skuId, seller_sku: octopus.sellerSku, total_available_quantity: 500 }] },
    ] } });
  } });
  const receipt = await readPromotionInventory([pool, octopus], { client, token: 'token', shop });
  assert.equal(receipt.requestId, 'fixture-request');
  assert.deepEqual(receipt.rows, [
    { ...pool, state: 'sku_verified', platformAvailable: 100, platformCommitted: 0, inShop: 100,
      campaignAllocations: null, creatorAllocations: null, warehouses: null },
    { ...octopus, state: 'sku_identity_mismatch' },
  ]);
});

const pilot = { productId: '9000000000000000041', skuId: '9000000000000000042',
  proposal: { activityType: 'FIXED_PRICE', activityPriceMYR: '32.90', totalQuantityLimit: 5, buyerQuantityLimit: 1,
    proposedStart: '2026-11-14T00:00:00+08:00', proposedEnd: '2026-11-17T00:00:00+08:00' } };
const start = Date.parse(pilot.proposal.proposedStart) / 1000;
const end = Date.parse(pilot.proposal.proposedEnd) / 1000;
const activity = { activity_id: '9000000000000000124', activity_type: 'FIXED_PRICE', product_level: 'VARIATION',
  status: 'ONGOING', begin_time: start, end_time: end, products: [{ id: pilot.productId, skus: [
    { id: pilot.skuId, activity_price: { amount: '32.9', currency: 'MYR' }, quantity_limit: 5, quantity_per_user: 1 },
  ] }] };

test('live pilot uses the official product detail link only for the exact active SKU', async () => {
  let link = 'https://www.tiktok.com/shop/open_homepage?redirect_link=fixture';
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async url => {
    const reply = data => Response.json({ code: 0, request_id: 'fixture-request', data });
    if (url.pathname === `/promotion/202309/activities/${activity.activity_id}`) return reply(activity);
    if (url.pathname === '/order/202309/orders/search') return reply({ orders: [], total_count: 0 });
    assert.equal(url.pathname, `/product/202309/products/${pilot.productId}`);
    assert.deepEqual(JSON.parse(url.searchParams.get('query_options')), ['GET_PRODUCT_DETAIL_URL']);
    return reply({ id: pilot.productId, status: 'ACTIVATE', audit: { status: 'APPROVED' }, is_not_for_sale: false,
      product_detail_url: link, skus: [{ id: pilot.skuId, price: { currency: 'MYR', sale_price: '49.30' } }] });
  } });
  const session = { client, token: 'fixture', shop: { region: 'MY', cipher: 'fixture' } };
  const get = () => readLivePilotOutcome(pilot, activity.activity_id, session, { includeBuyerUrl: true });
  const outcome = await get();
  assert.equal(outcome.listing.buyerUrl, link);
  assert.equal(outcome.activity.requestId, 'fixture-request');
  assert.equal(outcome.listing.requestId, 'fixture-request');
  link = 'https://tiktok.com.example.org/shop/';
  assert.equal((await get()).listing.buyerUrl, null);
});

test('merchant preflight shares complete indexes and rejects inconsistent platform totals', async () => {
  const other = { productId: '9000000000000000057', skuId: '9000000000000000056' };
  const items = [pilot, other];
  const couponId = '9000000000000000114';
  let total = 1;
  let couponReads = 0;
  const response = data => ({ data, requestId: 'fixture-request' });
  const client = {
    promotionCoupons: async () => { couponReads += 1; return response({ coupons: [{ id: couponId }], total_count: total }); },
    promotionCoupon: async () => response({ coupon: { id: couponId, status: 'ONGOING',
      product_scope: 'SPECIFIC_PRODUCTS', product_ids: [other.productId] } }),
    promotionActivities: async (_, __, ___, status) => response(status === 'ONGOING'
      ? { activities: [{ id: activity.activity_id }], total_count: 1 } : { activities: [], total_count: 0 }),
    promotionActivity: async () => response(activity),
    productDetail: async (_, __, id) => response({ id, skus: [{ id: items.find(item => item.productId === id).skuId }] }),
    openAffiliateProducts: async () => response({ open_collaborations: [], total_count: 0 }),
  };
  const session = { client, shop: { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' }, token: 'fixture' };
  const [first, second] = await readMerchantPromotionPreflight(items, session);
  assert.equal(couponReads, 1);
  assert.equal(first.activities.ONGOING.result[0].applies, true);
  assert.equal(second.activities.ONGOING.result[0].applies, false);
  assert.equal(first.couponCheck.result[0].productIncluded, false);
  assert.equal(second.couponCheck.result[0].productIncluded, true);
  assert.equal(second.couponCheck.requestIds.length, 2);
  total = 2;
  const [incomplete] = await readMerchantPromotionPreflight(items, session);
  assert.equal(incomplete.couponCheck.complete, false);
  assert.equal(incomplete.couponCheck.result, undefined);
  assert.equal(incomplete.activities.ONGOING.complete, true);
});

test('repricing keeps fixed-price stages tied to the exact SKU and respects the current activity lock', () => {
  const scoped = { ...pilot, market: 'MY', shopId: '9000000000000000099', sellerSku: 'MY-OCT17-PLA-BLUE' };
  const pricing = { ...scoped, currency: 'MYR', decision: 'awaiting_user_review', models: [{ id: 'test',
    regularPrice: '53.10', firstStagePrice: '30.27', secondStagePrice: '26.55' }] };
  const outcome = { listing: { ...scoped, currency: 'MYR', regularPrice: '34.90', status: 'ACTIVATE', auditStatus: 'APPROVED', isNotForSale: false },
    activity: reviewActivity(scoped, activity.activity_id, activity) };
  const plan = planPilotRepricing(pricing, scoped, outcome);
  assert.equal(plan.currentActivityBlocksRegularPrice, true);
  assert.equal(plan.platformWrites, 0);
  assert.equal(plan.followupActivity.schedule, null);
  assert.deepEqual(plan.planned[0].regularPriceRequest.body.skus, [{ id: scoped.skuId, price: { currency: 'MYR', sale_price: '53.10' } }]);
  assert.equal(plan.planned[0].firstStage.sku.activity_price_amount, '30.27');
  assert.equal(plan.planned[0].secondStage.afterVolumeReview, true);
  assert.throws(() => planPilotRepricing({ ...pricing, skuId: '9000000000000000056' }, scoped, outcome), /verified live pricing/i);
  assert.throws(() => planPilotRepricing({ ...pricing, models: [{ ...pricing.models[0], firstStagePrice: '30.26' }] }, scoped, outcome), /original calculation/i);
});

test('plans the exact merchant variation and rejects a platform campaign or invalid buyer limit', () => {
  const proposal = { ...pilot, market: 'MY', shopId: '9000000000000000099', sellerSku: 'MY-OCT17-PLA-BLUE' };
  const plan = planFixedPriceActivity(proposal, 'MY Oct17 trial', activity.activity_id);
  assert.deepEqual(plan.create.body, { title: 'MY Oct17 trial', activity_type: 'FIXED_PRICE',
    product_level: 'VARIATION', duration_type: 'NORMAL', begin_time: start, end_time: end });
  assert.deepEqual(plan.bind.body, { activity_id: activity.activity_id, products: [{ id: pilot.productId,
    quantity_limit: -1, quantity_per_user: -1, skus: [{ id: pilot.skuId,
      activity_price_amount: '32.90', quantity_limit: 5, quantity_per_user: 1 }] }] });
  assert.equal(plan.type, 'merchant_fixed_price_discount');
  assert.equal(planFixedPriceActivity(proposal, 'MY Oct17 trial').bind.body.activity_id, '<activity_id>');
  assert.throws(() => planFixedPriceActivity({ ...proposal, proposal: { ...pilot.proposal, activityType: 'NEW_ARRIVAL' } }, 'invalid'),
    /merchant fixed-price/i);
  assert.throws(() => planFixedPriceActivity({ ...proposal, proposal: { ...pilot.proposal, buyerQuantityLimit: 6 } }, 'invalid'),
    /purchase limits/i);
});

test('validates exact activity object, price, limits and dates, including other SKUs', () => {
  const original = reviewActivity(pilot, activity.activity_id, activity);
  assert.equal(original.state, 'active_configuration_verified');
  assert.deepEqual(original.limitUsage, { total: 5, perBuyer: 1, used: null });
  const modified = structuredClone(activity);
  modified.products[0].skus[0].used_quantity = 0;
  const unused = reviewActivity(pilot, activity.activity_id, modified);
  assert.equal(unused.limitUsage.used, 0);
  assert.equal(unused.buyerCheckoutPrice, null);
  modified.products[0].skus.push({ id: 'unexpected' });
  const mismatch = reviewActivity(pilot, activity.activity_id, modified);
  assert.equal(mismatch.state, 'configuration_mismatch');
  assert.equal(mismatch.limitUsage, null);
  assert.equal(reviewActivity(pilot, 'another', activity).state, 'configuration_mismatch');
});

test('reconciles only matching order SKU in the exact half-open activity window', () => {
  const catalog = { orderWindow: { startInclusive: start, endExclusive: end },
    orders: { rows: [{ id: 'o1', createdAt: start }, { id: 'o2', createdAt: end }, { id: 'o3', createdAt: start }] } };
  const rows = ['o1', 'o2', 'o3'].map((orderId, index) => ({ orderId,
    skuId: index === 2 ? 'different' : pilot.skuId, productId: pilot.productId, settlement: { state: 'paid_statement' } }));
  const report = reviewPilotOrders(pilot, catalog, { rows, statementsStatus: 'available', refundsStatus: 'available' });
  assert.equal(report.windowCovered, true);
  assert.equal(report.orders.length, 1);
  assert.equal(report.orders[0].orderId, 'o1');
  assert.equal(report.orders[0].promotionAttribution, null);
});

test('live order reads stop at expiry, page exactly, and distinguish absent SKU data from zero matches', async () => {
  const line = { productId: pilot.productId, id: pilot.skuId, lineId: 'line-1' };
  const order = { id: 'order-1', createdAt: start, status: 'AWAITING_SHIPMENT', skus: [line] };
  const calls = [];
  const result = await readPilotOrderWindow(pilot, async (...args) => {
    calls.push(args);
    return calls.length === 1 ? { rows: [order], nextToken: 'page-2', totalCount: 2, requestId: 'page-1-request' } :
      { rows: [{ ...order, id: 'order-2', skus: [{ ...line, id: 'other-sku' }] }], nextToken: null,
        totalCount: 2, requestId: 'page-2-request' };
  }, (end + 300) * 1000);
  assert.deepEqual(calls, [[undefined, start, end], ['page-2', start, end]]);
  assert.equal(result.wholePilotCovered, true);
  assert.equal(result.checkedOrderCount, 2);
  assert.deepEqual(result.requestIds, ['page-1-request', 'page-2-request']);
  assert.deepEqual(result.exactOrderRows, [{ orderId: 'order-1', orderLineId: 'line-1', orderStatus: 'AWAITING_SHIPMENT' }]);
  assert.equal(await readPilotOrderWindow(pilot, async () => assert.fail('queried future pilot'), (start - 1) * 1000), null);
  await assert.rejects(readPilotOrderWindow(pilot, async () => ({ rows: [{ ...order, skus: null }], totalCount: 1 }),
    (start + 300) * 1000), /missing product or SKU data/);
  await assert.rejects(readPilotOrderWindow(pilot, async () => ({ rows: [{ ...order,
    skus: [{ ...line, productId: 'different-product' }] }], totalCount: 1 }), (start + 300) * 1000), /product and SKU identity/);
});

test('an expired empty activity only closes on a complete order window and matching zero platform usage', () => {
  const expired = { state: 'expired_configuration_verified', windowCovered: true, orderLines: 0,
    limitUsage: { used: 0 }, ordersCountVerified: true };
  assert.equal(canCloseEmptyPilot(expired), true);
  for (const patch of [{ limitUsage: { used: 1 } }, { limitUsage: null }, { ordersCountVerified: false },
    { ordersCountVerified: undefined }, { orderLines: 1 }, { windowCovered: false }, { state: 'active_configuration_verified' }]) {
    assert.equal(canCloseEmptyPilot({ ...expired, ...patch }), false);
  }
});

test('first-sale readback ties checkout and statement reference to the exact product and order line', async () => {
  const orderId = '9876543210001';
  const orderLineId = '9876543210002';
  const statementId = '9876543210003';
  const line = { id: orderLineId, productId: pilot.productId, skuId: pilot.skuId };
  const order = { id: orderId, status: 'DELIVERED', lines: [line] };
  const price = { id: orderLineId, currency: 'MYR', list: '49.3', buyerProduct: '28.6', sellerDiscount: '16.4', platformDiscount: '4.3' };
  const sellerTransaction = { skuId: pilot.skuId, statementId, quantity: '1', settlementAmount: '24.2' };
  const client = {
    operationalOrders: async (token, shop, ids) => { assert.deepEqual(ids, [orderId]); return [order]; },
    orderPriceDetails: async () => ({ currency: 'MYR', payment: '60.60', lines: [price, { id: 'other' }] }),
    orderSettlement: async () => ({ currency: 'MYR', skuTransactions: [sellerTransaction, { skuId: 'other' }] }),
  };
  const input = [{ orderId, orderLineId }];
  const [observed] = await readPilotOrderEconomics(pilot, input, { client });
  assert.deepEqual(observed.checkout, { currency: 'MYR', orderPayment: '60.60', lines: [price] });
  assert.equal(observed.settlement.settlementAmount, '24.2');
  assert.equal(observed.settlementState, 'statement_reference');
  assert.equal(observed.promotionAttribution, null);
  assert.equal(observed.actualNetProfit, null);
  const ledger = { orderId, skuId: pilot.skuId, orderLineIds: [orderLineId], settlement: {
    statementId, currency: 'MYR', amount: '24.20', quantity: '1', state: 'paid_statement',
  } };
  assert.equal(linkPilotStatementPayments([observed], { orders: [ledger] })[0].paidStatementVerified, true);
  assert.equal(linkPilotStatementPayments([observed], { orders: [{ ...ledger, orderLineIds: ['other'] }] })[0].paidStatementVerified, null);
  const activityId = '9876543210004';
  price.sellerProductPromotions = [{ activityId, type: 'ACTIVITY', amount: '16.40' }];
  const [attributed] = await readPilotOrderEconomics(pilot, input, { client }, activityId);
  assert.deepEqual(attributed.promotionAttribution, { activityId, source: 'seller_funded_product_promotions',
    lines: [{ orderLineId, amount: '16.40' }] });
  sellerTransaction.quantity = '2';
  const [quantityMismatch] = await readPilotOrderEconomics(pilot, input, { client }, activityId);
  assert.equal(quantityMismatch.settlementState, 'exact_sku_settlement_unverified');
  client.orderSettlement = async () => { throw new Error('Settlement not available'); };
  const [waiting] = await readPilotOrderEconomics(pilot, input, { client });
  assert.equal(waiting.checkoutState, 'exact_buyer_price');
  assert.equal(waiting.settlementState, 'unavailable');
  assert.equal(waiting.settlement, null);
  order.lines = [{ ...line, productId: 'other' }];
  client.orderPriceDetails = async () => assert.fail('wrong order was used for price');
  const [mismatch] = await readPilotOrderEconomics(pilot, input, { client });
  assert.equal(mismatch.state, 'order_identity_unverified');
});
