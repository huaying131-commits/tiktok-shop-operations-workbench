import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creatorAuthorizationUrl, verifyCreatorTrial } from '../apps/customer-service/tiktok-creator-auth.mjs';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { createAuthorizationAccess } from '../apps/customer-service/tiktok-shop-sync.mjs';

const account = 'fixture.creator';
const productId = '9000000000000000047';
const profile = { username: account, selection_region: 'MY', creator_user_open_id: 'fixture-open-id',
  user_type: 'TIKTOK_SHOP_OFFICIAL_ACCOUNT' };
const tokens = { user_type: 1, access_token: 'fixture-creator-token', granted_scopes: ['creator.video.write'] };

test('creator consent and signed readback use the fixed official endpoints and exact product', async () => {
  const authorize = creatorAuthorizationUrl('fixture-app', 'fixture-state');
  assert.equal(authorize.origin + authorize.pathname, 'https://shop.tiktok.com/alliance/creator/auth');
  assert.deepEqual(Object.fromEntries(authorize.searchParams), { app_key: 'fixture-app', state: 'fixture-state' });
  const requests = [];
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['x-tts-access-token'], tokens.access_token);
    assert.equal(url.origin, 'https://open-api.tiktokglobalshop.com');
    assert.match(url.searchParams.get('sign'), /^[a-f0-9]{64}$/u);
    requests.push(url.pathname);
    if (requests.length === 1) return Response.json({ code: 0, data: profile });
    assert.equal(url.searchParams.get('page_size'), '20');
    const data = requests.length === 2 ? { products: [], next_page_token: 'opaque+/=' } :
      { products: [{ id: productId, added_status: 'ADDED' }] };
    assert.equal(url.searchParams.get('page_token'), requests.length === 2 ? null : 'opaque+/=');
    return Response.json({ code: 0, data });
  } });
  assert.deepEqual(await verifyCreatorTrial({ tokens, client, account, productId }), {
    account, productId, market: 'MY', accountType: profile.user_type,
  });
  assert.deepEqual(requests, ['/affiliate_creator/202508/profiles', '/affiliate_creator/202509/shop_products',
    '/affiliate_creator/202509/shop_products']);
});

test('creator verification stops on the wrong grant, identity, product status, or cursor', async () => {
  const trial = { account, productId, tokens };
  for (const badGrant of [{ ...tokens, user_type: 0 }, { ...tokens, granted_scopes: [] }]) {
    await assert.rejects(verifyCreatorTrial({ ...trial, tokens: badGrant, client: {} }), /挂车发布权限/);
  }
  for (const badProfile of [{ ...profile, username: 'other.creator' }, { ...profile, selection_region: 'SG' }]) {
    await assert.rejects(verifyCreatorTrial({ ...trial, client: { creatorProfile: async () => badProfile } }), /与原发布任务不符/);
  }
  await assert.rejects(verifyCreatorTrial({ ...trial, client: {
    creatorProfile: async () => profile,
    creatorShopProducts: async () => ({ products: [{ id: productId, added_status: 'NOT_ADDED' }] }),
  } }), /未返回可挂车状态/);
  await assert.rejects(verifyCreatorTrial({ ...trial, client: {
    creatorProfile: async () => profile,
    creatorShopProducts: async () => ({ products: [{ id: '9000000000000000048' }], next_page_token: 'duplicate' }),
  } }), /分页异常/);
});

test('seller authorization never installs, restores, or persists a creator token', async () => {
  const serviceId = '9000000000000000013';
  const saved = [];
  let disk = { serviceId, tokens };
  const sellerAccess = createAuthorizationAccess({ serviceId, expectedUserType: 0, now: () => 1_800_000_000_000,
    client: { refresh: async () => tokens }, loadAuthorization: async () => disk,
    saveAuthorization: async value => saved.push(value) });
  await assert.rejects(sellerAccess.install(tokens), /token type/);
  await assert.rejects(sellerAccess.restore(), /token type/);
  disk = { serviceId, tokens: { user_type: 0, access_token: 'fixture-seller-token', refresh_token: 'fixture-refresh-token',
    access_token_expire_in: 1_800_000_010 } };
  const authorization = await sellerAccess.restore();
  await assert.rejects(sellerAccess.read(authorization, () => assert.fail('wrong token used')), /token type/);
  assert.equal(saved.length, 0);
  assert.deepEqual(authorization.record, disk);
});

test('affiliate accounts verify the exact visible and approved in-stock showcase product', async () => {
  let status = { added_status: 'ADDED', inventory_status: 'IN_STOCK', review_status: 'APPROVED', is_hidden: false };
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    if (url.pathname.endsWith('/profiles')) {
      return Response.json({ code: 0, data: { ...profile, user_type: 'TIKTOK_SHOP_CREATOR' } });
    }
    assert.equal(url.pathname, '/affiliate_creator/202405/showcases/products');
    assert.equal(url.searchParams.get('origin'), 'SHOWCASE');
    return Response.json({ code: 0, data: { products: [{ id: productId, status }] } });
  } });
  const args = { account, productId, client, tokens };
  assert.equal((await verifyCreatorTrial(args)).accountType, 'TIKTOK_SHOP_CREATOR');
  for (const invalidStatus of [{ is_hidden: true }, { inventory_status: 'SOLD_OUT' }, { review_status: 'UNAVAILABLE' }]) {
    const original = status;
    status = { ...original, ...invalidStatus };
    await assert.rejects(verifyCreatorTrial(args), /未返回可挂车状态/);
    status = original;
  }
});
