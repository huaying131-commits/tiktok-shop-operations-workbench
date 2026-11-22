import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../src/worker.mjs';
import * as realMedia from '../src/media-store.mjs';
import { seal, unseal } from '../src/crypto.mjs';

const origin = 'https://publisher.example.workers.dev';
const secret = 'operator-test-key-with-more-than-32-bytes';
const sentinel = 'SECRET_SENTINEL_never_expose';
const scopes = ['video.publish', 'video.list', 'user.info.basic'];
const env = {
  APP_ID: '7710890022718668807', APP_SECRET: sentinel,
  VAULT_KEY: btoa('12345678901234567890123456789012'), OPERATOR_KEY: secret,
  PUBLIC_ORIGIN: origin, TENANT_ID: 'huaying-self', ACTOR_ID: 'dalei-operator', BUILD_ID: 'test',
  REQUIRED_SCOPES: JSON.stringify(scopes),
  AUTHORIZATION_URL: `https://www.tiktok.com/v2/auth/authorize/?client_key=7710890022718668807&response_type=code&scope=${encodeURIComponent(scopes.join(','))}&redirect_uri=${encodeURIComponent(origin + '/oauth/account/callback')}`
};
function sqlite() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...bindings) {
    bindings = bindings.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    const statement = db.prepare(query);
    const result = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    result.toArray = () => [...result];
    return result;
  } };
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  sql.transactionSync = transaction;
  return { db, sql, transaction };
}
function fakeApi(overrides = {}) {
  const calls = { exchange: 0, publish: 0, status: 0 };
  return { calls,
    async exchange() { calls.exchange++; return { subjectId: 'account-A', accessToken: sentinel, refreshToken: sentinel + '-refresh', grantedScopes: scopes, expiresAt: 2_000_000, refreshExpiresAt: 9_000_000, raw: { access_token: sentinel } }; },
    async tokenInfo() { return { appId: env.APP_ID, subjectId: 'account-A', grantedScopes: scopes }; },
    async profile() { return { businessId: 'account-A', username: 'safe-name', displayName: 'Safe' }; },
    async settings() { return { commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 60, privacyLevelOptions: ['PUBLIC_TO_EVERYONE'] }; },
    async publish() { calls.publish++; return { publishId: 'share-1', providerRequestId: 'provider-1' }; },
    async publishStatus() { calls.status++; return { state: 'PUBLISH_COMPLETE', postIds: ['post-1'], providerStatus: 'PUBLISH_COMPLETE', providerRequestId: 'provider-2' }; },
    ...overrides
  };
}
function fixture(api = fakeApi(), options = {}) {
  const storage = options.storage || sqlite();
  let time = 1_000_000;
  const service = createService({ env: { ...env, ...options.env }, sql: storage.sql, transaction: storage.transaction, api, now: () => time, media: options.media });
  function req(path, { method = 'GET', body, cookie, operator = true, headers = {} } = {}) {
    const h = { ...headers };
    if (operator) h.Authorization = `Bearer ${secret}`;
    if (body !== undefined && typeof body !== 'string' && !ArrayBuffer.isView(body)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (cookie) h.Cookie = cookie;
    return service.fetch(new Request(origin + path, { method, headers: h, body }));
  }
  return { ...storage, api, req, service, setTime(v) { time = v; } };
}
async function oauthStart(f) {
  const issued = await f.req('/operator/flows', { method: 'POST', body: {} });
  assert.equal(issued.status, 201, await issued.clone().text());
  const { connectUrl } = await issued.json();
  const t = new URL(connectUrl).searchParams.get('t');
  const started = await f.req('/oauth/account/start', { method: 'POST', body: new URLSearchParams({ t }).toString(), operator: false, headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(started.status, 303, await started.clone().text());
  return { state: new URL(started.headers.get('location')).searchParams.get('state'), cookie: started.headers.get('set-cookie').split(';')[0], t };
}
async function connect(f) {
  const started = await oauthStart(f);
  const response = await f.req(`/oauth/account/callback?state=${started.state}&auth_code=once-code`, { cookie: started.cookie, operator: false });
  assert.equal(response.status, 200, await response.clone().text());
  const accounts = await (await f.req('/operator/accounts')).json();
  return { ...started, connectionId: accounts.accounts[0].connectionId };
}
async function verified(f) {
  const connected = await connect(f);
  const r = await f.req(`/operator/accounts/${connected.connectionId}/verify`, { method: 'POST', body: {} });
  assert.equal(r.status, 200, await r.clone().text());
  return connected;
}
const mediaBytes = new Uint8Array([0, 0, 0, 24]);
const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', mediaBytes))].map(v => v.toString(16).padStart(2, '0')).join('');
const publishBody = connectionId => ({ connectionId, requestId: 'request-1', assetSha256: sha, videoUrl: origin + '/media/' + sha + '?t=download', postInfo: { caption: 'Reviewed test', is_brand_organic: true, is_branded_content: false, is_ai_generated: true } });
async function preparePublish(f, connectionId) {
  const upload = await f.req('/operator/media/' + sha, { method: 'PUT', body: mediaBytes, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(upload.status, 201, await upload.clone().text());
  // URL property registration uses the same real state ledger as deployment.
  f.api.addUrlProperty = async () => ({ fileName: 'proof.txt', signature: 'proof', propertyStatus: 0 });
  f.api.verifyUrlProperty = async () => ({ verified: true, propertyStatus: 1 });
  const r = await f.req('/operator/url-property', { method: 'POST', body: { url: origin + '/media/', type: 2 } });
  assert.equal(r.status, 200, await r.clone().text());
  return publishBody(connectionId);
}
const mediaStub = { initMedia() {}, putVerification() {}, async serveMedia() { return null; }, async putMedia() { return { sha256: sha, urlPath: '/media/' + sha, downloadToken: 'download', size: 4, expiresAt: 8_000_000 }; } };

test('operator routes reject missing/Shop credentials and forged identities; advertiser route remains disabled', async () => {
  const f = fixture();
  assert.equal((await f.req('/operator/accounts', { operator: false })).status, 401);
  assert.equal((await f.req('/operator/flows', { method: 'POST', body: { tenantId: 'other', actorId: 'other' } })).status, 400);
  assert.equal((await f.req('/operator/flows', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.req('/oauth/advertiser/callback', { operator: false })).status, 503);
  assert.equal((await (await f.req('/healthz', { operator: false })).json()).livePublishVerified, false);
});

test('connect GET never consumes ticket; exact Origin POST consumes once and sets protected cookie', async () => {
  const f = fixture();
  const issued = await (await f.req('/operator/flows', { method: 'POST', body: {} })).json();
  const u = new URL(issued.connectUrl);
  assert.equal((await f.req(u.pathname + u.search, { operator: false })).status, 200);
  assert.equal((await f.req(u.pathname + u.search, { operator: false })).status, 200);
  const t = u.searchParams.get('t');
  const start = () => f.req('/oauth/account/start', { method: 'POST', body: 't=' + t, operator: false, headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const first = await start();
  assert.equal(first.status, 303);
  assert.match(first.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await start()).status, 409);
});

test('connect HTML preserves browser form Origin while missing, null and foreign Origin cannot consume its ticket', async () => {
  const f = fixture();
  const issuedResponse = await f.req('/operator/flows', { method: 'POST', body: {} });
  assert.equal(issuedResponse.headers.get('referrer-policy'), 'no-referrer');
  const u = new URL((await issuedResponse.json()).connectUrl);
  const page = await f.req(u.pathname + u.search, { operator: false });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
  const t = u.searchParams.get('t');
  const start = requestOrigin => f.req('/oauth/account/start', {
    method: 'POST', operator: false, body: 't=' + t,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(requestOrigin === undefined ? {} : { Origin: requestOrigin }) }
  });
  for (const rejected of [undefined, 'null', 'https://foreign.example']) {
    const response = await start(rejected);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'origin_rejected');
    assert.equal(f.db.prepare('SELECT status FROM flows').get().status, 'READY');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
  }
  const accepted = await start(origin);
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(f.db.prepare('SELECT status FROM flows').get().status, 'CONSUMED');
  assert.equal((await start(origin)).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 1);
  assert.equal(f.api.calls.exchange, 0);
  assert.equal(f.api.calls.publish, 0);
});

test('authorization form CSP allows only self and the two exact official redirect origins', async () => {
  for (const authorizationOrigin of ['https://www.tiktok.com', 'https://business-api.tiktok.com']) {
    const f = fixture(fakeApi(), { env: { AUTHORIZATION_URL: env.AUTHORIZATION_URL.replace('https://www.tiktok.com', authorizationOrigin) } });
    const issued = await (await f.req('/operator/flows', { method: 'POST', body: {} })).json();
    const u = new URL(issued.connectUrl);
    const page = await f.req(u.pathname + u.search, { operator: false });
    const directives = page.headers.get('content-security-policy').split(';').map(s => s.trim());
    assert.deepEqual(directives, ["default-src 'none'", "form-action 'self' https://www.tiktok.com https://business-api.tiktok.com", "frame-ancestors 'none'", "base-uri 'none'"]);
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  }
  for (const foreign of ['https://www.tiktok.com:444', 'https://other.example', 'https://www.tiktok.com.attacker.example']) {
    assert.throws(() => fixture(fakeApi(), { env: { AUTHORIZATION_URL: env.AUTHORIZATION_URL.replace('https://www.tiktok.com', foreign) } }), /invalid_configuration/);
  }
});

test('concurrent callback claims exchange exactly once, encrypts tokens and rejects replay', async () => {
  const f = fixture();
  const { state, cookie } = await oauthStart(f);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.req(`/oauth/account/callback?auth_code=once-code&state=${state}`, { cookie, operator: false })));
  assert.equal(f.api.calls.exchange, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  const dump = JSON.stringify(f.db.prepare('SELECT * FROM connections').all());
  assert.ok(!dump.includes(sentinel));
  assert.equal((await f.req('/operator/accounts')).status, 200);
  assert.ok(!(await (await f.req('/operator/accounts')).text()).includes(sentinel));
});

test('callback rejects absent browser proof, duplicate query, wrong alias and expired state before exchange', async () => {
  const f = fixture();
  const { state, cookie } = await oauthStart(f);
  assert.equal((await f.req(`/oauth/account/callback?auth_code=x&state=${state}`, { operator: false })).status, 403);
  assert.equal((await f.req(`/oauth/account/callback?auth_code=x&state=${state}&state=${state}`, { cookie, operator: false })).status, 400);
  assert.equal((await f.req(`/oauth/account/callback?code=x&state=${state}`, { cookie, operator: false })).status, 400);
  f.setTime(2_000_001);
  assert.equal((await f.req(`/oauth/account/callback?auth_code=x&state=${state}`, { cookie, operator: false })).status, 410);
  assert.equal(f.api.calls.exchange, 0);
});

test('uncertain exchange remains UNKNOWN across restart and never exposes exception text', async () => {
  const api = fakeApi({ async exchange() { api.calls.exchange++; throw new Error(sentinel); } });
  const f = fixture(api);
  const { state, cookie } = await oauthStart(f);
  const path = `/oauth/account/callback?auth_code=x&state=${state}`;
  const r = await f.req(path, { cookie, operator: false });
  assert.equal(r.status, 202);
  assert.ok(!(await r.text()).includes(sentinel));
  const restarted = fixture(api, { storage: f });
  assert.equal((await restarted.req(path, { cookie, operator: false })).status, 409);
  assert.equal(api.calls.exchange, 1);
  assert.equal(f.db.prepare('SELECT status FROM oauth_states').get().status, 'UNKNOWN');
});

test('scope and identity verification fail closed and cannot authorize a publish', async () => {
  const f = fixture(fakeApi({ async tokenInfo() { return { appId: 'other-app', subjectId: 'account-A', grantedScopes: scopes }; } }));
  const { connectionId } = await connect(f);
  assert.equal((await f.req(`/operator/accounts/${connectionId}/verify`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await f.req('/operator/publish', { method: 'POST', body: publishBody(connectionId) })).status, 409);
  assert.equal(f.api.calls.publish, 0);
});

test('concurrent identical requests publish once; changed intent and global asset reuse conflict', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  const body = await preparePublish(f, connectionId);
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.req('/operator/publish', { method: 'POST', body })));
  assert.ok(responses.every(r => r.status === 202));
  assert.equal(f.api.calls.publish, 1);
  assert.equal((await f.req('/operator/publish', { method: 'POST', body: { ...body, postInfo: { ...body.postInfo, caption: 'changed' } } })).status, 409);
  assert.equal((await f.req('/operator/publish', { method: 'POST', body: { ...body, requestId: 'another-request' } })).status, 409);
});

test('uncertain publish persists UNKNOWN on restart and status never starts a new publish', async () => {
  const api = fakeApi({ async publish() { api.calls.publish++; throw new Error(sentinel); } });
  const f = fixture(api, { media: mediaStub });
  const { connectionId } = await verified(f);
  const body = await preparePublish(f, connectionId);
  const r = await f.req('/operator/publish', { method: 'POST', body });
  assert.equal(r.status, 202);
  assert.ok(!(await r.text()).includes(sentinel));
  const restarted = fixture(api, { storage: f, media: mediaStub });
  assert.equal((await restarted.req('/operator/publish', { method: 'POST', body })).status, 202);
  const status = await (await restarted.req('/operator/publish/request-1/status')).json();
  assert.equal(status.state, 'UNKNOWN');
  assert.equal(api.calls.publish, 1);
  assert.equal(api.calls.status, 0);
});

test('complete without post IDs stays pending; exact original ID status query records safe receipt', async () => {
  const api = fakeApi({ async publishStatus({ publishId }) { api.calls.status++; assert.equal(publishId, 'share-1'); return { state: 'PUBLISH_COMPLETE', postIds: [], providerStatus: 'PUBLISH_COMPLETE' }; } });
  const f = fixture(api, { media: mediaStub });
  const { connectionId } = await verified(f);
  await f.req('/operator/publish', { method: 'POST', body: await preparePublish(f, connectionId) });
  let state = await (await f.req('/operator/publish/request-1/status')).json();
  assert.equal(state.state, 'AWAITING_POST_IDS');
  api.publishStatus = async () => ({ state: 'PUBLISH_COMPLETE', postIds: ['post-1'], providerStatus: 'PUBLISH_COMPLETE' });
  state = await (await f.req('/operator/publish/request-1/status')).json();
  assert.equal(state.state, 'COMPLETE');
  assert.deepEqual(state.postIds, ['post-1']);
  assert.equal(state.independentlyVerified, false);
  assert.equal(api.calls.publish, 1);
});

test('URL property accepts only exact owned media prefix and media uploads require operator', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  assert.equal((await f.req('/operator/url-property', { method: 'POST', body: { url: 'https://attacker.example/media/', type: 2 } })).status, 400);
  assert.equal((await f.req('/operator/media/' + sha, { method: 'PUT', operator: false, body: 'fake', headers: { 'Content-Type': 'video/mp4' } })).status, 401);
});

test('real media integration uploads exact bytes, serves tokenized Range and never exposes operator secret', async () => {
  const f = fixture(fakeApi(), { media: realMedia });
  const r = await f.req('/operator/media/' + sha, { method: 'PUT', body: mediaBytes, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(r.status, 201, await r.clone().text());
  const uploaded = await r.json();
  const url = new URL(uploaded.videoUrl);
  assert.match(url.searchParams.get('t'), /^[a-f0-9]{64}$/);
  assert.equal((await f.req(url.pathname, { operator: false })).status, 404);
  const partial = await f.req(url.pathname + url.search, { operator: false, headers: { Range: 'bytes=1-2' } });
  assert.equal(partial.status, 206);
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), mediaBytes.slice(1, 3));
});

test('provider re-verification failures invalidate previously verified account', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  f.api.profile = async () => { throw new Error(sentinel); };
  const r = await f.req(`/operator/accounts/${connectionId}/verify`, { method: 'POST', body: {} });
  assert.equal(r.status, 502);
  const account = (await (await f.req('/operator/accounts')).json()).accounts[0];
  assert.equal(account.providerVerification, 'UNVERIFIED');
  assert.ok(!(await r.text()).includes(sentinel));
  assert.equal((await f.req('/operator/publish', { method: 'POST', body: await preparePublish(f, connectionId) })).status, 409);
});

test('property add is claimed once, including uncertain calls and restart', async () => {
  let count = 0;
  const api = fakeApi({ async addUrlProperty() { count++; throw new Error(sentinel); } });
  const f = fixture(api, { media: mediaStub });
  const input = { url: origin + '/media/', type: 2 };
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.req('/operator/url-property', { method: 'POST', body: input })));
  assert.ok(responses.every(r => r.status === 202));
  const restarted = fixture(api, { storage: f, media: mediaStub });
  assert.equal((await restarted.req('/operator/url-property', { method: 'POST', body: input })).status, 202);
  assert.equal(count, 1);
});

test('owner property status reconciles an existing UNKNOWN claim only through the exact official read-only list', async () => {
  const calls = { add: 0, verify: 0, list: 0 };
  const api = fakeApi({
    async addUrlProperty() { calls.add++; throw new Error(sentinel); },
    async verifyUrlProperty() { calls.verify++; assert.fail('read-only reconciliation must never call verify'); },
    async listUrlProperties() { calls.list++; return { rows: [{ type: 2, url: origin + '/media/', propertyStatus: 1, fileName: 'proof.txt', signature: 'proof' }], providerRequestId: 'property-list-original' }; }
  });
  const f = fixture(api, { media: mediaStub });
  assert.equal((await f.req('/operator/url-property/status', { operator: false })).status, 401);
  assert.equal((await f.req('/operator/url-property/status')).status, 409);
  assert.equal(calls.list, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM url_properties').get().n, 0);
  const claim = await f.req('/operator/url-property', { method: 'POST', body: { url: origin + '/media/', type: 2 } });
  assert.equal((await claim.json()).state, 'UNKNOWN');
  assert.equal((await f.req('/operator/url-property/status?url=https://other.example/media/')).status, 400);
  assert.equal((await f.req('/operator/url-property/status', { headers: { 'Content-Length': '1' } })).status, 400);
  assert.equal(calls.list, 0);
  const response = await f.req('/operator/url-property/status');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.url, origin + '/media/');
  assert.equal(result.providerRequestId, 'property-list-original');
  assert.equal(f.db.prepare('SELECT property_status FROM url_properties').get().property_status, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM url_properties').get().n, 1);
  const original = await f.req('/operator/url-property', { method: 'POST', body: { url: origin + '/media/', type: 2 } });
  assert.equal((await original.json()).state, 'VERIFIED');
  assert.deepEqual(calls, { add: 1, verify: 0, list: 1 });
  assert.equal(f.api.calls.publish, 0);
});

test('pending, failed, absent, wrong or duplicate URL properties cannot verify or recreate the existing owner claim', async () => {
  const row = { type: 2, url: origin + '/media/', propertyStatus: 1, fileName: 'proof.txt', signature: 'proof' };
  const candidates = [[], [{ ...row, propertyStatus: 0 }], [{ ...row, propertyStatus: 2 }], [{ ...row, url: 'https://other.example/media/' }], [{ ...row, type: 1 }], [row, row]];
  for (const rows of candidates) {
    let add = 0; let verify = 0; let list = 0;
    const f = fixture(fakeApi({
      async addUrlProperty() { add++; return { fileName: 'proof.txt', signature: 'proof' }; },
      async verifyUrlProperty() { verify++; return { verified: true, propertyStatus: 1 }; },
      async listUrlProperties() { list++; return { rows, providerRequestId: 'negative-list' }; }
    }), { media: mediaStub });
    await f.req('/operator/url-property', { method: 'POST', body: { url: origin + '/media/', type: 2 } });
    const r = await f.req('/operator/url-property/status');
    assert.equal(r.status, 202);
    const response = await r.json();
    assert.equal(response.state, 'UNVERIFIED');
    const exact = rows.filter(r => r.type === 2 && r.url === origin + '/media/');
    assert.equal(response.propertyStatus, exact.length === 1 ? exact[0].propertyStatus : null);
    assert.notEqual(f.db.prepare('SELECT property_status FROM url_properties').get().property_status, 1);
    await f.req('/operator/url-property', { method: 'POST', body: { url: origin + '/media/', type: 2 } });
    assert.deepEqual({ add, verify, list }, { add: 1, verify: 1, list: 1 });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM url_properties').get().n, 1);
    assert.equal(f.api.calls.publish, 0);
  }
});

test('property list exceptions revoke positive cache while preserving the claim and never retrying mutations', async () => {
  for (const code of ['PROVIDER_NETWORK_ERROR', 'PROVIDER_MALFORMED']) {
    const calls = { add: 0, verify: 0, list: 0 };
    const f = fixture(fakeApi({
      async addUrlProperty() { calls.add++; return { fileName: 'proof.txt', signature: 'proof' }; },
      async verifyUrlProperty() { calls.verify++; return { verified: true, propertyStatus: 1 }; },
      async listUrlProperties() { calls.list++; throw Object.assign(new Error(sentinel), { code }); }
    }), { media: mediaStub });
    const property = { url: origin + '/media/', type: 2 };
    await f.req('/operator/url-property', { method: 'POST', body: property });
    assert.equal(f.db.prepare('SELECT property_status FROM url_properties').get().property_status, 1);
    const response = await f.req('/operator/url-property/status');
    assert.equal(response.status, 202);
    assert.equal((await response.clone().json()).state, 'UNKNOWN');
    assert.ok(!(await response.text()).includes(sentinel));
    assert.notEqual(f.db.prepare('SELECT property_status FROM url_properties').get().property_status, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM url_properties').get().n, 1);
    await f.req('/operator/url-property', { method: 'POST', body: property });
    assert.deepEqual(calls, { add: 1, verify: 1, list: 1 });
    assert.equal(f.api.calls.publish, 0);
    const exec = f.sql.exec;
    f.sql.exec = (query, ...args) => { if (query.startsWith('INSERT OR REPLACE INTO url_properties')) throw new Error(sentinel); return exec(query, ...args); };
    const failedStorage = await f.req('/operator/url-property/status');
    assert.equal(failedStorage.status, 503);
    assert.equal((await failedStorage.json()).error, 'service_unavailable');
  }
});

test('insufficient granted scope cannot create a connection or publish', async () => {
  const api = fakeApi();
  const exchange = api.exchange;
  api.exchange = async () => ({ ...await exchange(), grantedScopes: ['video.list'] });
  const f = fixture(api);
  const { state, cookie } = await oauthStart(f);
  assert.equal((await f.req(`/oauth/account/callback?state=${state}&auth_code=x`, { cookie, operator: false })).status, 202);
  assert.deepEqual((await (await f.req('/operator/accounts')).json()).accounts, []);
  assert.equal(api.calls.publish, 0);
});

test('AES vault authenticates app, tenant, provider, account and key', async () => {
  const identity = { appId: env.APP_ID, tenantId: 'huaying-self', provider: 'accounts', subjectId: 'account-A' };
  const value = await seal({ accessToken: sentinel }, env.VAULT_KEY, identity);
  assert.ok(!value.includes(sentinel));
  assert.equal((await unseal(value, env.VAULT_KEY, identity)).accessToken, sentinel);
  for (const key of ['appId', 'tenantId', 'provider', 'subjectId']) await assert.rejects(unseal(value, env.VAULT_KEY, { ...identity, [key]: 'other' }));
  await assert.rejects(unseal(value, btoa('X'.repeat(32)), identity));
});

test('storage failure before publish claim makes zero calls; failure after send retains UNKNOWN', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  const body = await preparePublish(f, connectionId);
  const exec = f.sql.exec;
  f.sql.exec = (query, ...args) => { if (query.startsWith('INSERT INTO publish_requests')) throw new Error(sentinel); return exec(query, ...args); };
  const r = await f.req('/operator/publish', { method: 'POST', body });
  assert.equal(r.status, 503);
  assert.ok(!(await r.text()).includes(sentinel));
  assert.equal(f.api.calls.publish, 0);
  f.sql.exec = (query, ...args) => { if (query.startsWith('UPDATE publish_requests')) throw new Error(sentinel); return exec(query, ...args); };
  const sent = await f.req('/operator/publish', { method: 'POST', body });
  assert.equal(sent.status, 202);
  assert.equal((await sent.json()).state, 'UNKNOWN');
  f.sql.exec = exec;
  await f.req('/operator/publish', { method: 'POST', body });
  assert.equal(f.api.calls.publish, 1);
});

test('FAILED and DRAFT receipts never count as a complete public post', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  await f.req('/operator/publish', { method: 'POST', body: await preparePublish(f, connectionId) });
  for (const [providerState, expected] of [['FAILED', 'FAILED'], ['SEND_TO_USER_INBOX', 'DRAFT'], ['UNKNOWN', 'UNKNOWN']]) {
    f.api.publishStatus = async () => ({ state: providerState, postIds: [], providerStatus: providerState });
    const response = await (await f.req('/operator/publish/request-1/status')).json();
    assert.equal(response.state, expected);
    assert.equal(response.independentlyVerified, false);
  }
  assert.equal(f.api.calls.publish, 1);
});

test('independent posts readback uses only original account and IDs; exact full unique match is required', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  await f.req('/operator/publish', { method: 'POST', body: await preparePublish(f, connectionId) });
  await f.req('/operator/publish/request-1/status');
  let calls = 0;
  f.api.listVideos = async input => {
    calls++;
    assert.equal(input.businessId, 'account-A');
    assert.deepEqual(input.videoIds, ['post-1']);
    assert.equal(input.accessToken, sentinel);
    return { rows: [{ id: 'post-1', itemId: 'post-1', caption: 'Reviewed test', shareUrl: 'https://www.tiktok.com/@safe-name/video/post-1', isAd: false, ignoredToken: sentinel }], providerRequestId: 'list-original', observedAt: '1970-01-01T00:16:40.000Z' };
  };
  const r = await f.req('/operator/publish/request-1/posts');
  assert.equal(r.status, 200, await r.clone().text());
  const readback = await r.json();
  assert.equal(readback.independentlyVerified, true);
  assert.equal(readback.source, 'tiktok-business-accounts-v1.3/business/video/list');
  assert.equal(readback.rows[0].ignoredToken, undefined);
  assert.ok(!JSON.stringify(readback).includes(sentinel));
  assert.equal((await f.req('/operator/publish/request-1/posts?accountId=other')).status, 400);
  assert.equal(calls, 1);
  for (const rows of [[], [{ id: 'wrong', itemId: 'wrong' }], [{ id: 'post-1', itemId: 'post-1' }, { id: 'post-1', itemId: 'post-1' }], [{ id: 'post-1', itemId: 'wrong' }]]) {
    f.api.listVideos = async () => ({ rows });
    const invalid = await (await f.req('/operator/publish/request-1/posts')).json();
    assert.equal(invalid.independentlyVerified, false);
  }
  f.api.listVideos = async () => { throw new Error(sentinel); };
  const unavailable = await f.req('/operator/publish/request-1/posts');
  assert.equal(unavailable.status, 202);
  assert.ok(!(await unavailable.text()).includes(sentinel));
  assert.equal(f.api.calls.publish, 1);
});

test('independent readback does not query arbitrary latest videos when original post IDs are absent', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  await f.req('/operator/publish', { method: 'POST', body: await preparePublish(f, connectionId) });
  f.api.listVideos = () => { assert.fail('must not list without exact original post IDs'); };
  const r = await f.req('/operator/publish/request-1/posts');
  assert.equal(r.status, 202);
  assert.equal((await r.json()).independentlyVerified, false);
});

test('configuration rejects missing secrets and any authorization app, redirect, scope or identity mismatch', () => {
  for (const changed of [
    { APP_SECRET: '' }, { OPERATOR_KEY: 'short' }, { VAULT_KEY: btoa('short') },
    { TENANT_ID: 'forged' }, { ACTOR_ID: 'forged' },
    { AUTHORIZATION_URL: env.AUTHORIZATION_URL.replace(env.APP_ID, 'other-app') },
    { AUTHORIZATION_URL: env.AUTHORIZATION_URL.replace(encodeURIComponent(origin + '/oauth/account/callback'), encodeURIComponent('https://evil.example/callback')) },
    { AUTHORIZATION_URL: env.AUTHORIZATION_URL.replace(encodeURIComponent(scopes.join(',')), 'video.list') }
  ]) assert.throws(() => fixture(fakeApi(), { env: changed }), /invalid_configuration/);
});

test('publish schema rejects coercible numeric and array identity fields before creating a claim', async () => {
  const f = fixture(fakeApi(), { media: mediaStub });
  const { connectionId } = await verified(f);
  const body = await preparePublish(f, connectionId);
  for (const changed of [{ requestId: 12345678 }, { requestId: ['request-1'] }, { connectionId: [connectionId] }, { assetSha256: [sha] }]) {
    assert.equal((await f.req('/operator/publish', { method: 'POST', body: { ...body, ...changed } })).status, 400);
  }
  assert.equal(f.api.calls.publish, 0);
});

test('one authorization code is claimed globally across distinct valid states and survives UNKNOWN restart', async () => {
  for (const uncertain of [false, true]) {
    const api = fakeApi();
    if (uncertain) api.exchange = async () => { api.calls.exchange++; throw new Error(sentinel); };
    const f = fixture(api);
    const first = await oauthStart(f); const second = await oauthStart(f);
    const authCode = 'one-global-code-never-persist-plain';
    const callback = (service, flow) => service.req(`/oauth/account/callback?state=${flow.state}&auth_code=${authCode}`, { cookie: flow.cookie, operator: false });
    const responses = await Promise.all([callback(f, first), callback(f, second)]);
    assert.equal(api.calls.exchange, 1);
    assert.equal(responses.filter(r => r.status === 409).length, 1);
    const restarted = fixture(api, { storage: f });
    assert.equal((await callback(restarted, await oauthStart(restarted))).status, 409);
    assert.equal(api.calls.exchange, 1);
    const claims = f.db.prepare('SELECT * FROM oauth_code_claims').all();
    assert.equal(claims.length, 1);
    assert.match(claims[0].code_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(claims).includes(authCode));
  }
});

test('latest account identity, verification, scope, expiry, settings, property and asset gates share the publish claim transaction', async () => {
  const mutations = [
    f => f.db.prepare("UPDATE connections SET verification_status='FAILED'").run(),
    f => f.db.prepare("UPDATE connections SET app_id='other-app'").run(),
    f => f.db.prepare("UPDATE connections SET subject_id='other-subject'").run(),
    f => f.db.prepare('UPDATE connections SET scopes=?').run(JSON.stringify(['video.list'])),
    f => f.db.prepare('UPDATE connections SET expires_at=1000000').run(),
    f => f.db.prepare('UPDATE connections SET verified_at=0').run(),
    f => f.db.prepare('UPDATE connections SET settings=?').run(JSON.stringify({ commentDisabled: true })),
    f => f.db.prepare('UPDATE url_properties SET property_status=0').run(),
    f => f.db.prepare('UPDATE uploaded_assets SET expires_at=2800000').run(),
    f => f.db.prepare('UPDATE uploaded_assets SET sha256=?').run('0'.repeat(64))
  ];
  for (const mutate of mutations) {
    const f = fixture(fakeApi(), { media: mediaStub });
    const { connectionId } = await verified(f); const body = await preparePublish(f, connectionId);
    const originalDecrypt = crypto.subtle.decrypt;
    let resume; let entered; let paused = false;
    const continueDecrypt = new Promise(resolve => { resume = resolve; });
    const decryptEntered = new Promise(resolve => { entered = resolve; });
    crypto.subtle.decrypt = async function (...args) {
      const result = await originalDecrypt.apply(this, args);
      if (!paused) { paused = true; entered(); await continueDecrypt; }
      return result;
    };
    try {
      const pending = f.req('/operator/publish', { method: 'POST', body });
      await decryptEntered; mutate(f); resume();
      const response = await pending;
      assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
      assert.equal(f.api.calls.publish, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM publish_requests').get().n, 0);
    } finally { resume(); crypto.subtle.decrypt = originalDecrypt; }
  }
});
