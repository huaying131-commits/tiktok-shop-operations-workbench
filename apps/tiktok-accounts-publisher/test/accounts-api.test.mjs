import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAccountsApi } from '../src/accounts-api.mjs';

const APP_ID = '7710890022718668807';
const SECRET = 'secret-SENTINEL-never-public';
const TOKEN = 'token-SENTINEL-never-public';
const CODE = 'code-SENTINEL-never-public';
const REFRESH = 'refresh-SENTINEL-never-public';
const SUBJECT = 'account-owned-1';
const TIME = Date.parse('2026-11-22T16:00:00Z');
const ORIGIN = 'https://business-api.tiktok.com';
const POST_INFO = { caption: 'Original product video', is_brand_organic: true, is_branded_content: false, is_ai_generated: true };
const success = (data, extra = {}) => new Response(JSON.stringify({ code: 0, message: 'OK', request_id: 'request-1', data }), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } });
const tokenData = () => ({ open_id: SUBJECT, access_token: TOKEN, refresh_token: REFRESH, scope: 'video.publish,video.list,video.publish,user.info.basic', token_type: 'Bearer', expires_in: 86400, refresh_token_expires_in: 31536000 });
function fixture(responses, options = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const value = queue.shift();
    if (typeof value === 'function') return value(url, init);
    if (value instanceof Error) throw value;
    assert.ok(value, 'Unexpected additional request');
    return value;
  };
  return { api: createAccountsApi({ appId: APP_ID, appSecret: SECRET, fetchImpl, now: () => TIME, ...options }), calls };
}
const account = { accessToken: TOKEN, businessId: SUBJECT };
const publishInput = () => ({ ...account, videoUrl: 'https://media.example.com/original.mp4?signature=opaque', postInfo: { ...POST_INFO } });
function safeError(expectedCode, mayHaveSucceeded) {
  return error => {
    assert.equal(error.code, expectedCode);
    if (mayHaveSucceeded !== undefined) assert.equal(error.mayHaveSucceeded, mayHaveSucceeded);
    const publicText = [String(error), JSON.stringify(error), error.stack].join('\n');
    for (const secret of [SECRET, TOKEN, CODE, REFRESH]) assert.ok(!publicText.includes(secret), 'Public error leaked a credential');
    assert.equal(error.cause, undefined);
    return true;
  };
}
function assertTransport(call, pathname, method) {
  assert.equal(call.url.origin, ORIGIN);
  assert.equal(call.url.pathname, '/open_api/v1.3' + pathname);
  assert.equal(call.init.method, method);
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.url.searchParams.has('access_token'), false);
  assert.equal(call.url.searchParams.has('client_secret'), false);
  assert.equal(call.url.searchParams.has('auth_code'), false);
}

test('exports the complete Accounts adapter contract', () => {
  const { api } = fixture([]);
  for (const method of ['exchange', 'refresh', 'tokenInfo', 'settings', 'profile', 'listVideos', 'publish', 'publishStatus', 'addUrlProperty', 'verifyUrlProperty', 'listUrlProperties']) assert.equal(typeof api[method], 'function', method + ' is missing');
});

test('exchange sends exact official JSON and normalizes token lifetimes and granted scopes', async () => {
  const { api, calls } = fixture([success(tokenData())]);
  const value = await api.exchange({ authCode: CODE, redirectUri: 'https://app.example.com/callback/' });
  assertTransport(calls[0], '/tt_user/oauth2/token/', 'POST');
  assert.deepEqual(calls[0].body, { client_id: APP_ID, client_secret: SECRET, grant_type: 'authorization_code', auth_code: CODE, redirect_uri: 'https://app.example.com/callback/' });
  assert.equal(new Headers(calls[0].init.headers).get('access-token'), null);
  assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json');
  assert.equal(value.subjectId, SUBJECT);
  assert.equal(value.accessToken, TOKEN);
  assert.equal(value.refreshToken, REFRESH);
  assert.deepEqual(value.grantedScopes, ['video.publish', 'video.list', 'user.info.basic']);
  assert.equal(value.expiresAt, '2026-11-23T16:00:00.000Z');
  assert.equal(value.refreshExpiresAt, '2027-11-22T16:00:00.000Z');
  assert.equal(value.providerRequestId, 'request-1');
  assert.ok(!JSON.stringify(value.raw).includes(TOKEN));
  assert.ok(!JSON.stringify(value.raw).includes(REFRESH));
});

test('refresh is a single explicit JSON request using refresh_token grant', async () => {
  const { api, calls } = fixture([success(tokenData())]);
  const value = await api.refresh({ refreshToken: REFRESH });
  assertTransport(calls[0], '/tt_user/oauth2/refresh_token/', 'POST');
  assert.deepEqual(calls[0].body, { client_id: APP_ID, client_secret: SECRET, grant_type: 'refresh_token', refresh_token: REFRESH });
  assert.equal(value.subjectId, SUBJECT);
  assert.equal(calls.length, 1);
});

test('exchange preserves an officially registered callback without a trailing slash', async () => {
  const redirectUri = 'https://huaying-business-auth-registration.huaying131.workers.dev/oauth/account/callback';
  const { api, calls } = fixture([success(tokenData())]);
  await api.exchange({ authCode: CODE, redirectUri });
  assert.equal(calls[0].body.redirect_uri, redirectUri);
  assert.equal(calls.length, 1);
});

test('callback slash compatibility preserves HTTPS and rejects query, fragment and userinfo', async () => {
  const { api, calls } = fixture([]);
  for (const redirectUri of ['http://app.example.com/callback', 'https://app.example.com/callback?code=x', 'https://app.example.com/callback?', 'https://app.example.com/callback#state', 'https://app.example.com/callback#', 'https://user:password@app.example.com/callback', ' https://app.example.com/callback']) {
    await assert.rejects(api.exchange({ authCode: CODE, redirectUri }), safeError('INVALID_INPUT', false));
  }
  assert.equal(calls.length, 0);
});

test('the adapter uses Web platform APIs without Node runtime imports', async () => {
  const source = await readFile(new URL('../src/accounts-api.mjs', import.meta.url), 'utf8');
  assert.equal(/(?:from\s*|import\s*\()\s*['"]node:/u.test(source), false, 'Adapter must not import Node builtins');
});

test('tokenInfo independently normalizes app_id, creator_id, and scopes using the body token', async () => {
  const { api, calls } = fixture([success({ app_id: APP_ID, creator_id: SUBJECT, scope: 'video.publish,video.list' })]);
  const value = await api.tokenInfo({ accessToken: TOKEN });
  assertTransport(calls[0], '/tt_user/token_info/get/', 'POST');
  assert.deepEqual(calls[0].body, { app_id: APP_ID, access_token: TOKEN });
  assert.equal(new Headers(calls[0].init.headers).get('access-token'), null);
  assert.deepEqual(value, { appId: APP_ID, subjectId: SUBJECT, grantedScopes: ['video.publish', 'video.list'], providerRequestId: 'request-1', raw: { app_id: APP_ID, creator_id: SUBJECT, scope: 'video.publish,video.list' } });
});

test('settings preserves disabled flags and returns a fresh observation', async () => {
  const { api, calls } = fixture([success({ max_video_post_duration_sec: 600, privacy_level_options: ['PUBLIC_TO_EVERYONE'], comment_disabled: true, duet_disabled: false, stitch_disabled: true })]);
  const value = await api.settings(account);
  assertTransport(calls[0], '/business/video/settings/', 'GET');
  assert.equal(calls[0].url.searchParams.get('business_id'), SUBJECT);
  assert.equal(new Headers(calls[0].init.headers).get('access-token'), TOKEN);
  assert.deepEqual(value, { maxVideoPostDurationSec: 600, privacyLevelOptions: ['PUBLIC_TO_EVERYONE'], commentDisabled: true, duetDisabled: false, stitchDisabled: true, providerRequestId: 'request-1', observedAt: '2026-11-22T16:00:00.000Z' });
});

test('profile requests only identity fields and projects safe metadata', async () => {
  const { api, calls } = fixture([success({ username: 'owned_account', display_name: 'Owned account', unexpected: SECRET })]);
  const value = await api.profile(account);
  assertTransport(calls[0], '/business/get/', 'GET');
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('fields')), ['username', 'display_name']);
  assert.equal(value.businessId, SUBJECT);
  assert.equal(value.username, 'owned_account');
  assert.equal(value.displayName, 'Owned account');
  assert.ok(!JSON.stringify(value).includes(SECRET));
});

test('listVideos serializes exact JSON filters and returns IDs, public URLs and pagination', async () => {
  const { api, calls } = fixture([success({ videos: [{ item_id: '90071992547409939', caption: 'Reviewed caption', share_url: 'https://www.tiktok.com/@owned_account/video/90071992547409939', create_time: 123, is_ad: false, unexpected: SECRET }], has_more: true, cursor: 1760000000000 })]);
  const value = await api.listVideos({ ...account, videoIds: ['90071992547409939'], maxCount: 20, cursor: 1760000000100 });
  assertTransport(calls[0], '/business/video/list/', 'GET');
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('filters')), { video_ids: ['90071992547409939'] });
  assert.ok(JSON.parse(calls[0].url.searchParams.get('fields')).includes('item_id'));
  assert.equal(value.rows[0].id, '90071992547409939');
  assert.deepEqual(value.postIds, ['90071992547409939']);
  assert.equal(value.hasMore, true);
  assert.equal(value.cursor, 1760000000000);
  assert.ok(!JSON.stringify(value).includes(SECRET));
});

test('publish uses Access-Token, required disclosure flags and returns only the original share_id', async () => {
  const { api, calls } = fixture([success({ share_id: 'v_pub_url~v1.100' })]);
  const value = await api.publish(publishInput());
  assertTransport(calls[0], '/business/video/publish/', 'POST');
  assert.deepEqual(calls[0].body, { business_id: SUBJECT, video_url: publishInput().videoUrl, post_info: POST_INFO });
  assert.equal(new Headers(calls[0].init.headers).get('access-token'), TOKEN);
  assert.deepEqual(value, { publishId: 'v_pub_url~v1.100', providerRequestId: 'request-1' });
  assert.equal(calls.length, 1);
});

for (const [providerStatus, state] of [['PROCESSING_DOWNLOAD', 'PROCESSING'], ['PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'], ['FAILED', 'FAILED'], ['SEND_TO_USER_INBOX', 'SEND_TO_USER_INBOX'], ['NEW_UNKNOWN_STATUS', 'UNKNOWN']]) {
  test('publishStatus handles ' + providerStatus + ' without converting it to public success', async () => {
    const { api, calls } = fixture([success({ status: providerStatus, ...(providerStatus === 'FAILED' ? { reason: 'frame_rate_check_failed' } : {}) })]);
    const value = await api.publishStatus({ ...account, publishId: 'v_pub_url~v1.100' });
    assertTransport(calls[0], '/business/publish/status/', 'GET');
    assert.equal(calls[0].url.searchParams.get('publish_id'), 'v_pub_url~v1.100');
    assert.equal(value.state, state);
    assert.equal(value.providerStatus, providerStatus);
    assert.deepEqual(value.postIds, []);
    assert.equal(calls.length, 1);
    if (state === 'FAILED') assert.equal(value.reason, 'frame_rate_check_failed');
  });
}

test('publishStatus returns post IDs for complete tasks without fabricating a public URL', async () => {
  const { api } = fixture([success({ status: 'PUBLISH_COMPLETE', post_ids: ['90071992547409939'] })]);
  const value = await api.publishStatus({ ...account, publishId: 'task-1' });
  assert.deepEqual(value.postIds, ['90071992547409939']);
  assert.equal(value.publicUrl, undefined);
});

test('provider status matching an Object prototype key remains UNKNOWN', async () => {
  const { api } = fixture([success({ status: 'constructor' })]);
  const value = await api.publishStatus({ ...account, publishId: 'task-1' });
  assert.equal(value.state, 'UNKNOWN');
});

test('URL property methods use app_id and secret rather than OAuth field names', async () => {
  const info = { property_type: 2, url: 'https://media.example.com/videos/', file_name: 'verify.txt', signature: 'public-signature', property_status: 0 };
  const { api, calls } = fixture([success({ url_property_info: info }), success({ url_property_info: { ...info, property_status: 1 } })]);
  const added = await api.addUrlProperty({ url: info.url, type: 2 });
  const verified = await api.verifyUrlProperty({ url: info.url, type: 2 });
  for (let i = 0; i < 2; i++) {
    assertTransport(calls[i], i ? '/business/property/verify/' : '/business/property/add/', 'POST');
    assert.deepEqual(calls[i].body, { app_id: APP_ID, secret: SECRET, url_property_meta: { property_type: 2, url: info.url } });
    assert.equal(new Headers(calls[i].init.headers).get('access-token'), null);
  }
  assert.equal(added.verified, false);
  assert.equal(verified.verified, true);
  assert.equal(verified.fileName, 'verify.txt');
  assert.equal(verified.signature, 'public-signature');
});

test('listUrlProperties reads the official GET with app_id and encoded secret query only', async () => {
  const appSecret = SECRET + '/+=?&query';
  const row = { property_type: 2, url: 'https://media.example.com/videos/', property_status: 1, file_name: 'verify.txt', signature: 'public-signature', ignored: 'not-returned' };
  const { api, calls } = fixture([success({ url_property_info_list: [row] })], { appSecret });
  assert.equal(typeof api.listUrlProperties, 'function', 'URL property list method is missing');
  const value = await api.listUrlProperties();
  assertTransport(calls[0], '/business/property/list/', 'GET');
  assert.equal(calls[0].url.searchParams.get('app_id'), APP_ID);
  assert.equal(calls[0].url.searchParams.get('secret'), appSecret);
  assert.deepEqual([...calls[0].url.searchParams.keys()].sort(), ['app_id', 'secret']);
  assert.equal(new Headers(calls[0].init.headers).get('access-token'), null);
  assert.equal(new Headers(calls[0].init.headers).get('secret'), null);
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(value, { rows: [{ type: 2, url: row.url, propertyStatus: 1, fileName: 'verify.txt', signature: 'public-signature' }], providerRequestId: 'request-1' });
  assert.equal(calls.length, 1);
});

test('listUrlProperties preserves pending and failed status without calling any mutation', async () => {
  const rows = [0, 2].map(property_status => ({ property_type: 1, url: 'media.example.com', property_status, signature: 'public-proof' }));
  const { api, calls } = fixture([success({ url_property_info_list: rows }), success({ url_property_info_list: [] })]);
  const result = await api.listUrlProperties();
  assert.deepEqual(result.rows.map(row => row.propertyStatus), [0, 2]);
  assert.ok(result.rows.every(row => row.propertyStatus !== 1));
  assert.ok(result.rows.every(row => row.fileName === null));
  assert.deepEqual((await api.listUrlProperties()).rows, []);
  assert.ok(calls.every(call => call.init.method === 'GET' && call.url.pathname.endsWith('/business/property/list/')));
});

test('listUrlProperties does not expose query credentials through errors or retries', async () => {
  const { api, calls } = fixture([(url) => { throw new Error('Transport failed for ' + url); }]);
  await assert.rejects(api.listUrlProperties(), safeError('PROVIDER_NETWORK_ERROR', false));
  assert.equal(calls.length, 1);
});

test('listUrlProperties validates response list shape and property metadata strictly', async () => {
  const base = { property_type: 2, url: 'https://media.example.com/videos/', property_status: 1, signature: 'public-proof', file_name: 'verify.txt' };
  const badRows = [null, { ...base, property_type: '2' }, { ...base, property_type: 3 }, { ...base, property_status: '1' }, { ...base, property_status: -1 }, { ...base, property_status: 3 }, { ...base, url: 42 }, { ...base, url: 'https://127.0.0.1/videos/' }, { ...base, url: 'https://media.example.com/videos/?token=private' }, { ...base, signature: undefined }, { ...base, file_name: undefined }, { ...base, file_name: '../verify.txt' }];
  for (const data of [{}, { url_property_info_list: {} }, ...badRows.map(row => ({ url_property_info_list: [row] }))]) {
    const { api, calls } = fixture([success(data)]);
    await assert.rejects(api.listUrlProperties(), safeError('PROVIDER_MALFORMED', false));
    assert.equal(calls.length, 1);
  }
});

test('listUrlProperties forbids app or endpoint override arguments before HTTP', async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(api.listUrlProperties({ appId: 'another-app' }), safeError('INVALID_INPUT', false));
  assert.equal(calls.length, 0);
});

for (const [name, mutate] of [
  ['missing required disclosure', input => { delete input.postInfo.is_brand_organic; }],
  ['wrong boolean type', input => { input.postInfo.is_ai_generated = 'true'; }],
  ['unreviewed unknown post field', input => { input.postInfo.product_id = 'product-1'; }],
  ['other API privacy_level field', input => { input.postInfo.privacy_level = 'PUBLIC_TO_EVERYONE'; }],
  ['unsupported music schema', input => { input.postInfo.music_sound_info = { music_sound_id: 'sound-1' }; }],
  ['caption exceeds UTF-16 limit', input => { input.postInfo.caption = '😀'.repeat(1101); }],
  ['non-HTTP video URL', input => { input.videoUrl = 'file:///tmp/private.mp4'; }],
  ['credentialed video URL', input => { input.videoUrl = 'https://user:password@media.example.com/video.mp4'; }],
  ['header injection', input => { input.accessToken = TOKEN + '\r\nInjected: true'; }],
  ['unrecognized method argument', input => { input.endpoint = 'https://attacker.example/'; }],
]) test('rejects ' + name + ' before any HTTP call', async () => {
  const { api, calls } = fixture([]);
  const input = publishInput();
  mutate(input);
  await assert.rejects(api.publish(input), safeError('INVALID_INPUT', false));
  assert.equal(calls.length, 0);
});

for (const field of ['open_id', 'access_token', 'refresh_token', 'scope', 'expires_in', 'refresh_token_expires_in', 'token_type']) test('rejects exchange response missing ' + field, async () => {
  const data = tokenData(); delete data[field];
  const { api, calls } = fixture([success(data)]);
  await assert.rejects(api.exchange({ authCode: CODE, redirectUri: 'https://app.example.com/callback/' }), safeError('PROVIDER_MALFORMED', true));
  assert.equal(calls.length, 1);
});

for (const field of ['app_id', 'creator_id', 'scope']) test('rejects independent token identity missing ' + field, async () => {
  const data = { app_id: APP_ID, creator_id: SUBJECT, scope: 'video.publish' }; delete data[field];
  const { api } = fixture([success(data)]);
  await assert.rejects(api.tokenInfo({ accessToken: TOKEN }), safeError('PROVIDER_MALFORMED', false));
});

test('rejects a negative token expiry rather than manufacturing an unexpired session', async () => {
  const { api } = fixture([success({ ...tokenData(), expires_in: -1 })]);
  await assert.rejects(api.exchange({ authCode: CODE, redirectUri: 'https://app.example.com/callback/' }), safeError('PROVIDER_MALFORMED', true));
});

test('malformed required settings and missing profile identity fail closed', async () => {
  const { api } = fixture([success({ max_video_post_duration_sec: 600 }), success({ display_name: 'Unknown owner' })]);
  await assert.rejects(api.settings(account), safeError('PROVIDER_MALFORMED', false));
  await assert.rejects(api.profile(account), safeError('PROVIDER_MALFORMED', false));
});

test('a successful publish envelope missing share_id stays uncertain', async () => {
  const { api, calls } = fixture([success({})]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_MALFORMED', true));
  assert.equal(calls.length, 1);
});

test('nonzero provider code never exposes message/body and is never retried', async () => {
  const { api, calls } = fixture([new Response(JSON.stringify({ code: 40105, message: [SECRET, TOKEN, CODE, REFRESH].join(' '), data: null, request_id: SECRET }), { headers: { 'Content-Type': 'application/json' } })]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_REJECTED', false));
  assert.equal(calls.length, 1);
});

test('non-JSON response stays uncertain for mutating operations', async () => {
  const { api } = fixture([new Response('<html>' + SECRET, { headers: { 'Content-Type': 'text/html' } })]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_NON_JSON', true));
});

test('invalid JSON and invalid success envelopes stay uncertain without retry', async () => {
  for (const text of ['{"code":', JSON.stringify({ code: '0', data: {} }), JSON.stringify({ code: 0, data: [] })]) {
    const { api, calls } = fixture([new Response(text, { headers: { 'Content-Type': 'application/json' } })]);
    await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_MALFORMED', true));
    assert.equal(calls.length, 1);
  }
});

test('HTTP failure cannot echo provider body or create an automatic retry', async () => {
  const { api, calls } = fixture([new Response(SECRET + TOKEN, { status: 503 })]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_HTTP_ERROR', true));
  assert.equal(calls.length, 1);
});

test('302 is handled manually without following Location or retrying a publish', async () => {
  const { api, calls } = fixture([(url, init) => {
    // Match Workerd's supported redirect modes rather than Node's extra mode.
    if (init.redirect !== 'manual') throw new TypeError('Unsupported redirect mode');
    return new Response(SECRET, { status: 302, headers: { Location: 'https://redirect.invalid/?token=' + TOKEN } });
  }]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_HTTP_ERROR', true));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, ORIGIN);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('network errors are replaced with a fixed public error without cause', async () => {
  const { api, calls } = fixture([new Error('Network error ' + [TOKEN, CODE, SECRET, REFRESH].join(' '))]);
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_NETWORK_ERROR', true));
  assert.equal(calls.length, 1);
});

test('response Content-Length and streamed byte limits are enforced', async () => {
  for (const headers of [{ 'Content-Length': '9999999' }, {}]) {
    const { api } = fixture([new Response(JSON.stringify({ code: 0, data: { huge: 'x'.repeat(3000) } }), { headers: { 'Content-Type': 'application/json', ...headers } })], { maxResponseBytes: 1024 });
    await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_RESPONSE_TOO_LARGE', true));
  }
});

test('request timeout aborts once even when a custom fetch ignores cancellation', async () => {
  let receivedSignal;
  const { api, calls } = fixture([(url, init) => { receivedSignal = init.signal; return new Promise(() => {}); }], { timeoutMs: 20 });
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_TIMEOUT', true));
  assert.equal(receivedSignal.aborted, true);
  assert.equal(calls.length, 1);
});

test('the same timeout also bounds an unending response body', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"code":0')); } });
  const { api, calls } = fixture([new Response(stream, { headers: { 'Content-Type': 'application/json' } })], { timeoutMs: 20 });
  await assert.rejects(api.publish(publishInput()), safeError('PROVIDER_TIMEOUT', true));
  assert.equal(calls.length, 1);
});

test('post IDs in status and video rows must stay exact strings', async () => {
  const { api } = fixture([success({ status: 'PUBLISH_COMPLETE', post_ids: [9007199254740992] }), success({ videos: [{ caption: 'Unidentified post' }], has_more: false })]);
  await assert.rejects(api.publishStatus({ ...account, publishId: 'task-1' }), safeError('PROVIDER_MALFORMED', false));
  await assert.rejects(api.listVideos(account), safeError('PROVIDER_MALFORMED', false));
});

test('URL prefix validation forbids query strings, missing trailing slash and IP hosts', async () => {
  const { api, calls } = fixture([]);
  for (const url of ['https://media.example.com/videos', 'https://media.example.com/videos/?key=value', 'http://media.example.com/videos/', 'https://127.0.0.1/videos/', 'https://[::ffff:127.0.0.1]/videos/', 'https://2130706433/videos/', 'https://0x7f000001/videos/']) await assert.rejects(api.addUrlProperty({ url, type: 2 }), safeError('INVALID_INPUT', false));
  assert.equal(calls.length, 0);
});

test('URL verify pending and failed states do not become verified', async () => {
  const { api } = fixture([success({ url_property_info: { property_status: 2, property_type: 1, url: 'media.example.com', signature: 'public-proof' } })]);
  const value = await api.verifyUrlProperty({ url: 'media.example.com', type: 1 });
  assert.equal(value.verified, false);
  assert.equal(value.propertyStatus, 2);
});
