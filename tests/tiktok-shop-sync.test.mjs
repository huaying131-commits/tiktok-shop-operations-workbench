import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { createAuthorizationAccess, syncSkuSnapshot } from '../apps/customer-service/tiktok-shop-sync.mjs';

const now = () => 1_800_000_000_000;
const serviceId = '9000000000000000013';
const shop = { id: '9000000000000000079', name: 'fixture shop', region: 'MY', cipher: 'fixture-cipher' };
const saved = { serviceId, tokens: { access_token: 'initial-access', refresh_token: 'initial-refresh' } };
const nextTokens = { access_token: 'renewed-access', refresh_token: 'renewed-refresh',
  access_token_expire_in: now() / 1000 + 3600, refresh_token_expire_in: now() / 1000 + 7200 };
const api = (data, code = 0) => Response.json({ code, data });

test('reactive refresh is serialized, persists the rotated pair, and retries each read once', async () => {
  let refreshes = 0;
  let rejectedReads = 0;
  const persisted = [];
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, init) => {
      if (url.pathname === '/api/v2/token/refresh') {
        refreshes += 1;
        assert.equal(url.hostname, 'auth.tiktok-shops.com');
        assert.equal(url.searchParams.get('refresh_token'), saved.tokens.refresh_token);
        assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
        return api(nextTokens);
      }
      if (init.headers['x-tts-access-token'] === saved.tokens.access_token) {
        rejectedReads += 1;
        return api(null, 105002);
      }
      assert.equal(init.headers['x-tts-access-token'], nextTokens.access_token);
      return api({ shops: [shop] });
    } });
  const access = createAuthorizationAccess({ serviceId, client, now, loadAuthorization: async () => saved,
    saveAuthorization: async value => persisted.push(value) });
  const credential = await access.restore();
  const results = await Promise.all([access.read(credential, client.authorizedShops), access.read(credential, client.authorizedShops)]);
  assert.deepEqual(results, [[shop], [shop]]);
  assert.equal(rejectedReads, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(persisted, [{ serviceId, tokens: nextTokens }]);
});

test('a failed save retries the rotated pair before using it and reauthorization invalidates old sessions', async () => {
  let refreshes = 0;
  let writes = 0;
  const access = createAuthorizationAccess({ serviceId, now,
    client: { refresh: async () => { refreshes += 1; return nextTokens; } },
    loadAuthorization: async () => ({ ...saved, tokens: { ...saved.tokens, access_token_expire_in: now() / 1000 + 10 } }),
    saveAuthorization: async () => { if (++writes === 1) throw new Error('fixture disk failure'); } });
  const credential = await access.restore();
  await assert.rejects(access.read(credential, () => assert.fail('unsaved token used')), /disk failure/);
  assert.equal(await access.read(credential, token => token), nextTokens.access_token);
  assert.equal(refreshes, 1);
  assert.equal(writes, 2);
  await access.install(nextTokens);
  await assert.rejects(access.read(credential, () => assert.fail('old session used')), /Authorization has changed/);
});

test('follows opaque cursors, fixes the order window, and links exact SKU IDs without buyer fields', async () => {
  const cursor = 'opaque+/=token';
  const orderBodies = [];
  const client = createTikTokClient({ appKey: 'fixture-key', appSecret: 'fixture-secret', now,
    fetchApi: async (url, init) => {
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.get('shop_cipher'), shop.cipher);
      const next = url.searchParams.get('page_token');
      assert.ok(next === null || next === cursor);
      if (url.pathname.startsWith('/product/')) {
        const id = next ? 'product-2' : 'product-1';
        return api({ total_count: 2, next_page_token: next ? '' : cursor,
          products: [{ id, skus: [{ id: 'sku-' + id }] }] });
      }
      orderBodies.push(JSON.parse(init.body));
      return Response.json({ code: 0, request_id: next ? 'orders-2' : 'orders-1', data: {
        total_count: 2, next_page_token: next ? '' : cursor, orders: [{ id: next ? 'order-2' : 'order-1',
        create_time: now() / 1000 - 300, paid_time: now() / 1000 - 60, is_sample_order: Boolean(next),
        payment: { currency: 'MYR', total_amount: '39.95' },
        recipient_address: { name: 'private fixture' }, line_items: [{ id: 'line', product_id: 'product-1',
          sku_id: next ? 'sku-product-2' : 'sku-product-1' }] }] } });
    } });
  const snapshot = await syncSkuSnapshot({ client, shop, read: action => action('access'), now });
  const end = now() / 1000;
  const expected = { create_time_ge: end - 604_800, create_time_lt: end };
  assert.deepEqual(orderBodies, [expected, expected]);
  assert.equal(snapshot.products.pages, 2);
  assert.equal(snapshot.orders.pages, 2);
  assert.deepEqual(snapshot.skuCoverage, { matchedOrderLines: 1, unmatchedOrderLines: 1, ordersWithoutLines: 0 });
  assert.equal(snapshot.orderActivity.paidOrders, 1);
  assert.equal(snapshot.orderActivity.buyerPayment, '39.95');
  assert.doesNotMatch(JSON.stringify(snapshot.orders), /buyerPayment|paidAt/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private fixture|fixture-cipher|opaque/);
});

test('rejects incomplete data without treating duplicate IDs as additional rows', async () => {
  const client = { productsPage: async (_token, _shop, _size, cursor) => ({ totalCount: 2,
    rows: [{ id: 'repeated-id' }], nextToken: cursor ? '' : 'next' }) };
  await assert.rejects(syncSkuSnapshot({ client, shop, read: action => action('access'), now }), /总数不一致/);
});
