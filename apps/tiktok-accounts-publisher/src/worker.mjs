import { canonical, constantTimeEqual, opaqueToken, seal, sha256, unseal } from './crypto.mjs';
import { StateError, StateStore } from './state.mjs';

const PROVIDER = 'tiktok-business-accounts-v1.3';
const COOKIE = '__Host-hy-oauth';
const MAX_MEDIA = 20 * 1024 * 1024;
const DEFAULT_SCOPES = ['video.publish', 'video.list', 'user.info.basic'];
const AUTHORIZATION_ORIGINS = ['https://www.tiktok.com', 'https://business-api.tiktok.com'];
const COMMON_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const bad = (status, code) => { throw new StateError(status, code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function exactKeys(value, required, optional = []) {
  if (!object(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) bad(400, 'invalid_schema');
}
function validString(v, max = 256) { return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v); }
const millis = v => typeof v === 'number' ? v : Date.parse(v);
function json(value, status = 200, headers = {}) { return Response.json(value, { status, headers: { ...COMMON_HEADERS, ...headers } }); }
function html(value, status = 200) { return new Response(value, { status, headers: { ...COMMON_HEADERS, 'Referrer-Policy': 'strict-origin', 'Content-Type': 'text/html;charset=UTF-8', 'Content-Security-Policy': "default-src 'none'; form-action 'self' https://www.tiktok.com https://business-api.tiktok.com; frame-ancestors 'none'; base-uri 'none'" } }); }
function safeIds(values) { return Array.isArray(values) && values.every(v => validString(v, 200)) ? values : []; }
function publicReceipt(row) { return { requestId: row.request_id, connectionId: row.connection_id, assetSha256: row.asset_sha256, state: row.state, publishId: row.publish_id || null, providerRequestId: row.provider_request_id || null, providerStatus: row.provider_status || null, postIds: JSON.parse(row.post_ids), independentlyVerified: false, source: PROVIDER, updatedAt: new Date(row.updated_at).toISOString() }; }

function configuration(env) {
  if (env.APP_ID !== '7710890022718668807' || env.TENANT_ID !== 'huaying-self' || env.ACTOR_ID !== 'dalei-operator') throw new Error('invalid_configuration');
  if (!validString(env.APP_SECRET, 16_384) || !validString(env.OPERATOR_KEY, 4096) || env.OPERATOR_KEY.length < 32 || typeof env.VAULT_KEY !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(env.VAULT_KEY)) throw new Error('invalid_configuration');
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN || origin.username || origin.password) throw new Error('invalid_configuration');
  const redirectUri = origin.origin + '/oauth/account/callback';
  const requiredScopes = env.REQUIRED_SCOPES ? JSON.parse(env.REQUIRED_SCOPES) : DEFAULT_SCOPES;
  if (!Array.isArray(requiredScopes) || !requiredScopes.length || requiredScopes.some(s => !validString(s, 128)) || DEFAULT_SCOPES.some(s => !requiredScopes.includes(s))) throw new Error('invalid_configuration');
  const authorization = new URL(env.AUTHORIZATION_URL);
  if (authorization.protocol !== 'https:' || !AUTHORIZATION_ORIGINS.includes(authorization.origin) || authorization.username || authorization.password || authorization.hash) throw new Error('invalid_configuration');
  if ([...authorization.searchParams.keys()].some((k, i, all) => all.indexOf(k) !== i) || authorization.searchParams.has('state')) throw new Error('invalid_configuration');
  const appKeys = ['client_key', 'client_id', 'app_id'].filter(k => authorization.searchParams.has(k));
  if (appKeys.length !== 1 || authorization.searchParams.get(appKeys[0]) !== env.APP_ID || authorization.searchParams.get('redirect_uri') !== redirectUri || authorization.searchParams.get('response_type') !== 'code') throw new Error('invalid_configuration');
  const advertisedScopes = authorization.searchParams.get('scope')?.split(/[ ,]+/).filter(Boolean) || [];
  if (requiredScopes.some(s => !advertisedScopes.includes(s))) throw new Error('invalid_configuration');
  return { origin: origin.origin, redirectUri, authorization, requiredScopes, identity: { appId: env.APP_ID, tenantId: env.TENANT_ID, actorId: env.ACTOR_ID, provider: PROVIDER } };
}
async function readLimited(request, limit) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) bad(413, 'body_too_large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let total = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); bad(413, 'body_too_large'); }
    chunks.push(value);
  }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) bad(415, 'json_required');
  const bytes = await readLimited(request, 32_768);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { bad(400, 'invalid_json'); }
}
function postInfoSchema(info) {
  const booleans = ['is_brand_organic', 'is_branded_content', 'is_ai_generated', 'disable_comment', 'disable_duet', 'disable_stitch', 'upload_to_draft', 'is_ads_only'];
  exactKeys(info, ['is_brand_organic', 'is_branded_content', 'is_ai_generated'], ['caption', 'thumbnail_offset', 'location_id', 'location_name', 'tto_invite_link', ...booleans]);
  for (const k of booleans) if (Object.hasOwn(info, k) && typeof info[k] !== 'boolean') bad(400, 'invalid_post_info');
  if (info.upload_to_draft || info.is_ads_only) bad(400, 'public_post_required');
  if (info.caption !== undefined && (typeof info.caption !== 'string' || info.caption.length > 2200)) bad(400, 'invalid_caption');
  if (info.thumbnail_offset !== undefined && (!Number.isSafeInteger(info.thumbnail_offset) || info.thumbnail_offset < 0)) bad(400, 'invalid_thumbnail');
  for (const key of ['location_id', 'location_name', 'tto_invite_link']) if (info[key] !== undefined && !validString(info[key], 2048)) bad(400, 'invalid_post_info');
  if (info.location_id && !info.location_name || info.tto_invite_link && !info.is_branded_content) bad(400, 'invalid_post_info');
}

export function createService({ env, sql, transaction, api, media, now = () => Date.now() }) {
  const config = configuration(env);
  const store = new StateStore(sql, transaction, config.identity);
  media?.initMedia(sql);
  const aad = subjectId => ({ ...config.identity, subjectId });
  const hasScopes = scopes => Array.isArray(scopes) && config.requiredScopes.every(s => scopes.includes(s));
  const assertCurrent = c => { if (c.expires_at <= now()) bad(409, 'authorization_expired'); };
  const credentials = async c => { assertCurrent(c); return unseal(c.sealed, env.VAULT_KEY, aad(c.subject_id)); };
  function safeAccount(c) {
    return { connectionId: c.connection_id, appId: c.app_id, provider: c.provider, accountId: c.subject_id, authorizationStatus: c.expires_at > now() ? 'AUTHORIZED' : 'EXPIRED', providerVerification: c.verification_status, grantedScopes: JSON.parse(c.scopes), expiresAt: new Date(c.expires_at).toISOString(), refreshExpiresAt: new Date(c.refresh_expires_at).toISOString(), profile: c.profile ? JSON.parse(c.profile) : null, settings: c.settings ? JSON.parse(c.settings) : null };
  }
  function publishEligibility(input, expected, token, at) {
    const account = store.connection(input.connectionId);
    if (account.expires_at <= at) bad(409, 'authorization_expired');
    if (account.verification_status !== 'VERIFIED' || !Number.isSafeInteger(account.verified_at) || account.verified_at < at - 900_000 || account.verified_at > at || !hasScopes(JSON.parse(account.scopes))) bad(409, 'account_verification_required');
    if (expected && (account.subject_id !== expected.subject_id || account.sealed !== expected.sealed || token.subjectId !== account.subject_id || !hasScopes(token.grantedScopes) || millis(token.expiresAt) <= at)) bad(409, 'account_credentials_changed');
    if (!store.propertyVerified(config.origin + '/media/')) bad(409, 'media_prefix_unverified');
    const video = new URL(input.videoUrl);
    if (video.origin !== config.origin || !video.pathname.startsWith('/media/') || video.username || video.password || video.hash || !store.asset(input.assetSha256, video.href, at)) bad(409, 'uploaded_asset_required');
    const settings = JSON.parse(account.settings);
    if (!object(settings) || ['commentDisabled', 'duetDisabled', 'stitchDisabled'].some(k => typeof settings[k] !== 'boolean') || !Number.isFinite(settings.maxVideoPostDurationSec) || settings.maxVideoPostDurationSec <= 0) bad(409, 'account_settings_unverified');
    for (const [setting, flag] of [['commentDisabled', 'disable_comment'], ['duetDisabled', 'disable_duet'], ['stitchDisabled', 'disable_stitch']]) if (settings[setting] && input.postInfo[flag] !== true) bad(400, 'account_settings_conflict');
    return account;
  }
  async function verify(c) {
    const token = await credentials(c);
    store.verification(c.connection_id, { status: 'UNVERIFIED', scopes: JSON.parse(c.scopes), profile: null, settings: null, now: now() });
    try {
      const identity = await api.tokenInfo({ accessToken: token.accessToken });
      if (identity.appId !== env.APP_ID || identity.subjectId !== c.subject_id || !hasScopes(identity.grantedScopes)) {
        store.verification(c.connection_id, { status: 'FAILED', scopes: [], profile: null, settings: null, now: now() });
        bad(409, 'provider_identity_or_scope_mismatch');
      }
      const profile = await api.profile({ accessToken: token.accessToken, businessId: c.subject_id });
      const settings = await api.settings({ accessToken: token.accessToken, businessId: c.subject_id });
      if (profile.businessId !== c.subject_id || !validString(profile.username, 200) || typeof settings.commentDisabled !== 'boolean' || typeof settings.duetDisabled !== 'boolean' || typeof settings.stitchDisabled !== 'boolean' || !Number.isFinite(settings.maxVideoPostDurationSec) || settings.maxVideoPostDurationSec <= 0) bad(409, 'provider_account_unverified');
      const safeProfile = { businessId: c.subject_id, username: profile.username, displayName: typeof profile.displayName === 'string' ? profile.displayName.slice(0, 200) : null };
      const safeSettings = { commentDisabled: settings.commentDisabled, duetDisabled: settings.duetDisabled, stitchDisabled: settings.stitchDisabled, maxVideoPostDurationSec: settings.maxVideoPostDurationSec, privacyLevelOptions: safeIds(settings.privacyLevelOptions) };
      store.verification(c.connection_id, { status: 'VERIFIED', scopes: identity.grantedScopes, profile: safeProfile, settings: safeSettings, now: now() });
      return store.connection(c.connection_id);
    } catch (error) { if (error instanceof StateError) throw error; bad(502, 'provider_verification_unavailable'); }
  }
  async function route(request) {
    const url = new URL(request.url); if (url.origin !== config.origin) bad(400, 'invalid_request_origin');
    const path = url.pathname;
    if (path.startsWith('/oauth/advertiser')) return json({ error: 'advertiser_disabled', state: 'DISABLED' }, 503);
    if (path === '/healthz' && request.method === 'GET') return json({ service: 'huaying-accounts-publisher', buildId: env.BUILD_ID || 'unversioned', provider: PROVIDER, configured: true, appId: env.APP_ID, livePublishVerified: false });
    if (path.startsWith('/media/')) {
      if (!['GET', 'HEAD'].includes(request.method)) bad(405, 'method_not_allowed');
      return await media?.serveMedia(sql, request, { now: now() }) || json({ error: 'not_found' }, 404);
    }
    if (path.startsWith('/operator/')) {
      const authorization = request.headers.get('authorization') || '';
      if (!env.OPERATOR_KEY || env.OPERATOR_KEY.length < 32 || !authorization.startsWith('Bearer ') || !(await constantTimeEqual(authorization.slice(7), env.OPERATOR_KEY))) bad(401, 'operator_authorization_required');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.has('origin') && request.headers.get('origin') !== config.origin) bad(403, 'origin_rejected');
      if (url.search) bad(400, 'query_not_allowed');
    }
    if (path === '/operator/flows' && request.method === 'POST') {
      exactKeys(await readJson(request), []);
      const ticket = opaqueToken(); const expiresAt = now() + 300_000; store.createFlow(await sha256(ticket), expiresAt);
      return json({ connectUrl: config.origin + '/connect?t=' + ticket, expiresAt: new Date(expiresAt).toISOString() }, 201);
    }
    if (path === '/connect' && request.method === 'GET') {
      if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has('t')) bad(400, 'invalid_ticket');
      const t = url.searchParams.get('t'); if (!/^[A-Za-z0-9_-]{43}$/.test(t)) bad(400, 'invalid_ticket');
      store.getFlow(await sha256(t), now());
      return html('<!doctype html><html lang="zh"><meta charset="utf-8"><title>华赢账号授权</title><h1>连接本人 TikTok 账号</h1><p>继续将前往 TikTok 官方授权页。请核对账号与权限。</p><form method="post" action="/oauth/account/start"><input type="hidden" name="t" value="' + t + '"><button type="submit">前往官方授权</button></form></html>');
    }
    if (path === '/oauth/account/start' && request.method === 'POST') {
      if (url.search || request.headers.get('origin') !== config.origin) bad(403, 'origin_rejected');
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) bad(415, 'form_required');
      const form = new URLSearchParams(new TextDecoder().decode(await readLimited(request, 1024)));
      if ([...form.keys()].length !== 1 || !form.has('t') || !/^[A-Za-z0-9_-]{43}$/.test(form.get('t'))) bad(400, 'invalid_ticket');
      const state = opaqueToken(); const proof = opaqueToken();
      store.consumeFlow(await sha256(form.get('t')), await sha256(state), await sha256(proof), config.redirectUri, now());
      const destination = new URL(config.authorization); destination.searchParams.set('state', state);
      return new Response(null, { status: 303, headers: { ...COMMON_HEADERS, Location: destination.href, 'Set-Cookie': `${COOKIE}=${proof}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
    }
    if (path === '/oauth/account/callback' && request.method === 'GET') {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 2 || keys.filter(k => k === 'state').length !== 1 || keys.filter(k => k === 'auth_code').length !== 1) bad(400, 'invalid_callback');
      const state = url.searchParams.get('state'); const authCode = url.searchParams.get('auth_code');
      if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !validString(authCode, 4096)) bad(400, 'invalid_callback');
      const proofs = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
      if (proofs.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(proofs[0].slice(COOKIE.length + 1))) bad(403, 'browser_proof_invalid');
      const [stateHash, proofHash, codeHash] = await Promise.all([sha256(state), sha256(proofs[0].slice(COOKIE.length + 1)), sha256(authCode)]);
      store.claimState(stateHash, proofHash, config.redirectUri, codeHash, now());
      try {
        const exchanged = await api.exchange({ authCode, redirectUri: config.redirectUri });
        if (!validString(exchanged.subjectId) || !validString(exchanged.accessToken, 16_384) || !validString(exchanged.refreshToken, 16_384) || !hasScopes(exchanged.grantedScopes) || !Number.isFinite(millis(exchanged.expiresAt)) || millis(exchanged.expiresAt) <= now() || !Number.isFinite(millis(exchanged.refreshExpiresAt)) || millis(exchanged.refreshExpiresAt) <= now()) throw new Error('exchange_not_confirmed');
        const connectionId = opaqueToken(); const sealed = await seal(exchanged, env.VAULT_KEY, aad(exchanged.subjectId));
        store.saveConnection(stateHash, { ...exchanged, connectionId, sealed, expiresAt: millis(exchanged.expiresAt), refreshExpiresAt: millis(exchanged.refreshExpiresAt), authorizedAt: now() });
        return json({ state: 'CONNECTED', providerVerification: 'UNVERIFIED', message: '账号授权已保存；发布能力仍需服务端独立核验。' }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      } catch { return json({ state: 'UNKNOWN', message: '本次授权交换未能确认，请保留原记录。不会自动重试授权码。' }, 202); }
    }
    if (path === '/operator/accounts' && request.method === 'GET') return json({ accounts: store.connections().map(safeAccount) });
    const verifyMatch = /^\/operator\/accounts\/([A-Za-z0-9_-]{43})\/verify$/.exec(path);
    if (verifyMatch && request.method === 'POST') { exactKeys(await readJson(request), []); return json({ account: safeAccount(await verify(store.connection(verifyMatch[1]))) }); }
    const mediaMatch = /^\/operator\/media\/([a-f0-9]{64})$/.exec(path);
    if (mediaMatch && request.method === 'PUT') {
      if (!media) bad(503, 'media_unavailable');
      if (request.headers.get('content-type') !== 'video/mp4') bad(415, 'mp4_required');
      const bytes = await readLimited(request, MAX_MEDIA); if (bytes.length === 0 || await sha256(bytes) !== mediaMatch[1]) bad(400, 'media_sha_mismatch');
      const uploaded = await media.putMedia(sql, { sha256: mediaMatch[1], bytes, contentType: 'video/mp4', now: now() });
      const ownedUrl = new URL(uploaded.urlPath, config.origin); ownedUrl.searchParams.set('t', uploaded.downloadToken);
      if (uploaded.sha256 !== mediaMatch[1] || ownedUrl.origin !== config.origin || !ownedUrl.pathname.startsWith('/media/') || !Number.isFinite(millis(uploaded.expiresAt))) throw new Error('invalid_media_result');
      store.upload(uploaded.sha256, ownedUrl.href, millis(uploaded.expiresAt));
      return json({ sha256: uploaded.sha256, videoUrl: ownedUrl.href, size: uploaded.size, expiresAt: new Date(millis(uploaded.expiresAt)).toISOString() }, 201);
    }
    if (path === '/operator/url-property/status' && request.method === 'GET') {
      if (request.body || request.headers.has('content-length') && request.headers.get('content-length') !== '0') bad(400, 'body_not_allowed');
      const prefix = config.origin + '/media/';
      if (!store.propertyRecord(prefix)) bad(409, 'property_claim_required');
      const source = PROVIDER + '/business/property/list';
      try {
        const result = await api.listUrlProperties();
        const matches = Array.isArray(result.rows) ? result.rows.filter(row => row && row.type === 2 && row.url === prefix) : [];
        const verified = matches.length === 1 && matches[0].propertyStatus === 1;
        const propertyStatus = matches.length === 1 && [0, 1, 2].includes(matches[0].propertyStatus) ? matches[0].propertyStatus : null;
        // Preserve the original claim even when fresh readback revokes its cache.
        store.property(prefix, verified ? 1 : propertyStatus === 2 ? 2 : 0, now());
        return json({ state: verified ? 'VERIFIED' : 'UNVERIFIED', url: prefix, propertyStatus, source, providerRequestId: validString(result.providerRequestId, 200) ? result.providerRequestId : null, observedAt: new Date(now()).toISOString() }, verified ? 200 : 202);
      } catch {
        store.property(prefix, 0, now());
        return json({ state: 'UNKNOWN', url: prefix, source, observedAt: new Date(now()).toISOString() }, 202);
      }
    }
    if (path === '/operator/url-property' && request.method === 'POST') {
      const input = await readJson(request); exactKeys(input, ['url', 'type']);
      if (input.url !== config.origin + '/media/' || input.type !== 2) bad(400, 'owned_media_prefix_required');
      if (!media) bad(503, 'media_unavailable');
      const claim = store.claimProperty(input.url, now());
      if (!claim.winner) return json({ state: claim.row.property_status === 1 ? 'VERIFIED' : 'UNKNOWN', url: input.url, propertyStatus: claim.row.property_status }, claim.row.property_status === 1 ? 200 : 202);
      try {
        const added = await api.addUrlProperty(input);
        if (!validString(added.fileName, 200) || !validString(added.signature, 4096)) throw new Error('property_not_confirmed');
        media.putVerification(sql, { fileName: added.fileName, signature: added.signature, now: now() });
        const checked = await api.verifyUrlProperty(input);
        if (checked.verified !== true || checked.propertyStatus !== 1) return json({ state: 'UNVERIFIED' }, 202);
        store.property(input.url, 1, now()); return json({ state: 'VERIFIED', url: input.url, propertyStatus: 1 });
      } catch { return json({ state: 'UNKNOWN', message: '媒体前缀验证结果未确认。' }, 202); }
    }
    if (path === '/operator/publish' && request.method === 'POST') {
      const input = await readJson(request); exactKeys(input, ['connectionId', 'requestId', 'assetSha256', 'videoUrl', 'postInfo']);
      if (!validString(input.connectionId, 43) || !/^[A-Za-z0-9_-]{43}$/.test(input.connectionId) || !validString(input.requestId, 128) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId) || !validString(input.assetSha256, 64) || !/^[a-f0-9]{64}$/.test(input.assetSha256) || !validString(input.videoUrl, 4096)) bad(400, 'invalid_publish_request');
      postInfoSchema(input.postInfo);
      const intentHash = await sha256(canonical({ ...config.identity, ...input }));
      const existing = store.publish(input.requestId);
      if (existing) { if (existing.intent_hash !== intentHash) bad(409, 'request_intent_conflict'); return json(publicReceipt(existing), 202); }
      const account = publishEligibility(input, null, null, now());
      const token = await credentials(account);
      const claimAt = now();
      const claimed = store.claimPublish(input, intentHash, claimAt, () => publishEligibility(input, account, token, claimAt));
      if (!claimed.winner) return json(publicReceipt(claimed.row), 202);
      try {
        const result = await api.publish({ accessToken: token.accessToken, businessId: claimed.account.subject_id, videoUrl: input.videoUrl, postInfo: input.postInfo });
        if (!validString(result.publishId, 200)) throw new Error('publish_not_confirmed');
        const row = store.updatePublish(input.requestId, { state: 'PROCESSING', publishId: result.publishId, providerRequestId: validString(result.providerRequestId, 200) ? result.providerRequestId : null, now: now() });
        return json(publicReceipt(row), 202);
      } catch { return json(publicReceipt(store.publish(input.requestId)), 202); }
    }
    const statusMatch = /^\/operator\/publish\/([A-Za-z0-9_-]{8,128})\/status$/.exec(path);
    if (statusMatch && request.method === 'GET') {
      let row = store.publish(statusMatch[1]); if (!row) bad(404, 'request_not_found');
      if (!row.publish_id) return json(publicReceipt(row));
      const c = store.connection(row.connection_id); const token = await credentials(c);
      try {
        const result = await api.publishStatus({ accessToken: token.accessToken, businessId: c.subject_id, publishId: row.publish_id });
        const postIds = safeIds(result.postIds);
        const states = { PROCESSING: 'PROCESSING', FAILED: 'FAILED', PUBLISH_COMPLETE: postIds.length ? 'COMPLETE' : 'AWAITING_POST_IDS', SEND_TO_USER_INBOX: 'DRAFT', UNKNOWN: 'UNKNOWN' };
        row = store.updatePublish(row.request_id, { state: states[result.state] || 'UNKNOWN', providerStatus: validString(result.providerStatus, 200) ? result.providerStatus : null, providerRequestId: validString(result.providerRequestId, 200) ? result.providerRequestId : null, postIds, now: now() });
      } catch { return json({ ...publicReceipt(row), statusRead: 'UNKNOWN' }, 202); }
      return json(publicReceipt(row));
    }
    const postsMatch = /^\/operator\/publish\/([A-Za-z0-9_-]{8,128})\/posts$/.exec(path);
    if (postsMatch && request.method === 'GET') {
      const row = store.publish(postsMatch[1]); if (!row) bad(404, 'request_not_found');
      const expected = JSON.parse(row.post_ids);
      const base = { ...publicReceipt(row), source: PROVIDER + '/business/video/list', observedAt: new Date(now()).toISOString(), rows: [], readbackState: 'UNKNOWN' };
      if (row.state !== 'COMPLETE' || !expected.length || new Set(expected).size !== expected.length) return json(base, 202);
      const c = store.connection(row.connection_id); const token = await credentials(c);
      try {
        const result = await api.listVideos({ accessToken: token.accessToken, businessId: c.subject_id, videoIds: expected });
        const rows = Array.isArray(result.rows) ? result.rows : [];
        const matches = rows.length === expected.length && rows.every(r => r && validString(r.id, 200) && r.itemId === r.id && expected.includes(r.id) && r.isAd === false) && new Set(rows.map(r => r.id)).size === expected.length;
        const projected = rows.filter(object).slice(0, 100).map(r => ({
          id: validString(r.id, 200) ? r.id : null,
          itemId: validString(r.itemId, 200) ? r.itemId : null,
          caption: typeof r.caption === 'string' ? r.caption.slice(0, 2200) : null,
          shareUrl: typeof r.shareUrl === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i.test(r.shareUrl) ? r.shareUrl : null,
          createTime: Number.isSafeInteger(r.createTime) ? r.createTime : null,
          isAd: typeof r.isAd === 'boolean' ? r.isAd : null
        }));
        const receipt = { ...base, rows: projected, independentlyVerified: matches, readbackState: matches ? 'VERIFIED' : 'UNCONFIRMED', providerRequestId: validString(result.providerRequestId, 200) ? result.providerRequestId : null };
        store.saveReadback(row.request_id, receipt, now());
        return json(receipt, matches ? 200 : 202);
      } catch { return json(base, 202); }
    }
    return json({ error: 'not_found' }, 404);
  }
  return { async fetch(request) { try { return await route(request); } catch (error) { return error instanceof StateError ? json({ error: error.code }, error.status) : json({ error: 'service_unavailable', state: 'UNKNOWN' }, 503); } } };
}

export class AccountsStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.servicePromise = null; }
  async fetch(request) {
    if (!this.servicePromise) this.servicePromise = Promise.all([import('./accounts-api.mjs'), import('./media-store.mjs')]).then(([adapter, media]) => {
      const sql = { exec: (...args) => this.ctx.storage.sql.exec(...args), transactionSync: fn => this.ctx.storage.transactionSync(fn) };
      return createService({ env: this.env, sql, transaction: fn => this.ctx.storage.transactionSync(fn), api: adapter.createAccountsApi({ appId: this.env.APP_ID, appSecret: this.env.APP_SECRET }), media });
    });
    try { return await (await this.servicePromise).fetch(request); } catch { return json({ error: 'service_unavailable', state: 'UNKNOWN' }, 503); }
  }
}
export default { async fetch(request, env) { try { return await env.STATE.get(env.STATE.idFromName('huaying-accounts-publisher-v1')).fetch(request); } catch { return json({ error: 'service_unavailable', state: 'UNKNOWN' }, 503); } } };
