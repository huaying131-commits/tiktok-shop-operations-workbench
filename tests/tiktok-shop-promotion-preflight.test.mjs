import assert from 'node:assert/strict';
import test from 'node:test';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';

test('promotion preflight uses only documented search and detail reads', async () => {
  const requests = [];
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture',
    fetchApi: async (url, args) => {
      requests.push({ path: url.pathname, method: args.method, query: url.searchParams,
        body: args.body === undefined ? null : JSON.parse(args.body) });
      return new Response(JSON.stringify({ code: 0, data: { accepted: true } }));
    } });
  const shop = { region: 'MY', cipher: 'fixture' };
  await client.productDetail('token', shop, '9000000000000000041');
  await client.promotionActivities('token', shop, undefined, 'NOT_START');
  await client.promotionCoupons('token', shop, 'next');
  await client.promotionCoupon('token', shop, '9000000000000000124');
  await client.openAffiliateProducts('token', shop, '9000000000000000041');
  assert.deepEqual(requests.map(({ path, method }) => [path, method]), [
    ['/product/202309/products/9000000000000000041', 'GET'],
    ['/promotion/202309/activities/search', 'POST'],
    ['/promotion/202406/coupons/search', 'POST'],
    ['/promotion/202406/coupons/9000000000000000124', 'GET'],
    ['/affiliate_seller/202412/open_collaborations/search', 'POST'],
  ]);
  assert.equal(requests[1].body.status, 'NOT_START');
  assert.deepEqual(requests[2].body.status, ['ONGOING', 'NOT_START']);
  assert.equal(requests[2].query.get('page_token'), 'next');
  assert.deepEqual(requests[4].body, { keyword_type: 'PRODUCT_ID', keyword: '9000000000000000041' });
  await assert.rejects(() => client.promotionCoupon('token', shop, 'unknown/id'), /invalid/i);
  await assert.rejects(() => client.promotionActivities('token', shop, undefined, 'UNKNOWN'), /invalid/i);
  assert.equal(requests.length, 5);
});

test('keeps native sample tags and restricts sample application reads to the exact order and product', async () => {
  const orderId = '900000000000000015', productId = '9000000000000000016', applicationId = '9000000000000000133';
  const calls = [];
  const client = createTikTokClient({ appKey: 'fixture', appSecret: 'fixture', fetchApi: async (url, args) => {
    calls.push({ path: url.pathname, method: args.method, body: args.body === undefined ? null : JSON.parse(args.body) });
    return Response.json({ code: 0, data: { total_count: 1,
      orders: [{ id: orderId, create_time: 1794000000, is_sample_order: true, order_type: 'SELLER_FUND_FREE_SAMPLE' }],
    } });
  } });
  const shop = { region: 'MY', cipher: 'fixture' };
  const list = await client.ordersPage('token', shop, 50, undefined, 1793980800, 1794499200);
  const details = await client.operationalOrders('token', shop, [orderId]);
  for (const order of [list.rows[0], details[0]]) {
    assert.equal(order.sampleOrder, true);
    assert.equal(order.orderType, 'SELLER_FUND_FREE_SAMPLE');
  }
  await client.sampleApplicationsByOrder('token', shop, orderId, productId);
  await client.sampleApplicationFulfillments('token', shop, applicationId);
  assert.deepEqual(calls.slice(2), [
    { path: '/affiliate_seller/202508/sample_applications/search', method: 'POST', body: { order_id: orderId, product_id: productId } },
    { path: `/affiliate_seller/202409/sample_applications/${applicationId}/fulfillments/search`, method: 'POST', body: {} },
  ]);
  await assert.rejects(() => client.sampleApplicationsByOrder('token', shop, 'unknown', productId), /invalid/i);
  assert.equal(calls.length, 4);
});
