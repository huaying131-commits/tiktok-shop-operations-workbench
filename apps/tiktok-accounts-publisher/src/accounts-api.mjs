// TikTok API for Business / Accounts API v1.3, not Content Posting API.
// No automatic retry, account authorization, scheduling or business-policy bypass.

const ORIGIN = 'https://business-api.tiktok.com';
const ERRORS = new Set(['INVALID_INPUT', 'PROVIDER_TIMEOUT', 'PROVIDER_NETWORK_ERROR', 'PROVIDER_HTTP_ERROR', 'PROVIDER_NON_JSON', 'PROVIDER_RESPONSE_TOO_LARGE', 'PROVIDER_MALFORMED', 'PROVIDER_REJECTED']);
const POST_FIELDS = new Set(['caption', 'is_brand_organic', 'is_branded_content', 'disable_comment', 'disable_duet', 'disable_stitch', 'thumbnail_offset', 'is_ai_generated', 'upload_to_draft', 'tto_invite_link', 'location_id', 'location_name', 'is_ads_only']);
const PRIVACY_OPTIONS = new Set(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY', 'FOLLOWER_OF_CREATOR']);

export class AccountsApiError extends Error {
  constructor(code, mayHaveSucceeded = false) {
    super(code);
    this.name = 'AccountsApiError';
    this.code = code;
    this.mayHaveSucceeded = mayHaveSucceeded;
    this.retryable = false;
  }
}
const fail = (code = 'INVALID_INPUT', uncertain = false) => { throw new AccountsApiError(code, uncertain); };
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function object(value, allowed, code = 'INVALID_INPUT') {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length || (allowed && Object.keys(value).some(key => !allowed.includes(key)))) fail(code);
  return value;
}
function text(value, max = 4096, code = 'INVALID_INPUT', allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}
function opaque(value, code = 'INVALID_INPUT', max = 4096) {
  text(value, max, code);
  if (/\s/u.test(value)) fail(code);
  return value;
}
function bool(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'boolean') fail(code);
  return value;
}
function number(value, min, max, code = 'INVALID_INPUT') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function scopes(value) {
  text(value, 16384, 'PROVIDER_MALFORMED');
  const items = value.split(',').map(scope => scope.trim());
  if (!items.length || items.some(scope => !/^[a-z][a-z0-9_.]*$/u.test(scope))) fail('PROVIDER_MALFORMED');
  return [...new Set(items)];
}
function webUrl(value, code = 'INVALID_INPUT') {
  text(value, 8192, code);
  let url;
  try { url = new URL(value); } catch { fail(code); }
  if (!/^https?:\/\//iu.test(value) || value !== value.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('#') || !url.hostname || /[\r\n]/u.test(value)) fail(code);
  return url;
}
function propertyInput(value) {
  object(value, ['url', 'type']);
  const type = number(value.type, 1, 2);
  const raw = text(value.url, 8192);
  const url = type === 1 ? webUrl('https://' + raw) : webUrl(raw);
  // WHATWG URL canonicalizes alternate IPv4 spellings; IPv6 hosts contain ':'.
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')) fail();
  if (type === 1 && (url.hostname !== raw || url.pathname !== '/' || url.search)) fail();
  if (type === 2 && (url.protocol !== 'https:' || !url.pathname.endsWith('/') || url.search)) fail();
  return { property_type: type, url: raw };
}
function postInput(value) {
  object(value, [...POST_FIELDS]);
  bool(value.is_brand_organic);
  bool(value.is_branded_content);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'caption') output[key] = text(item, 2200, 'INVALID_INPUT', true);
    else if (key === 'thumbnail_offset') output[key] = number(item, 0, 600000);
    else if (key === 'location_id' || key === 'location_name') output[key] = text(item, 512);
    else if (key === 'tto_invite_link') { webUrl(item); output[key] = item; }
    else output[key] = bool(item);
  }
  if (output.location_id !== undefined && output.location_name === undefined) fail();
  if (output.tto_invite_link !== undefined && output.is_branded_content !== true) fail();
  return output;
}
function stringArray(value, { min = 0, max = 100, code = 'PROVIDER_MALFORMED' } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code);
  return value.map(item => opaque(item, code, 512));
}

export function createAccountsApi(options = {}) {
  object(options, ['appId', 'appSecret', 'fetchImpl', 'now', 'timeoutMs', 'maxResponseBytes']);
  const appId = opaque(options.appId, 'INVALID_INPUT', 256);
  const appSecret = opaque(options.appSecret);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = number(options.timeoutMs ?? 15000, 1, 60000);
  const maxResponseBytes = number(options.maxResponseBytes ?? 262144, 1024, 1048576);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail();
  function observedAt() {
    const time = now();
    if (typeof time !== 'number' || !Number.isFinite(time) || Math.abs(time) > 8640000000000000) fail('PROVIDER_MALFORMED');
    return new Date(time).toISOString();
  }
  function accountInput(value, extra = []) {
    object(value, ['accessToken', 'businessId', ...extra]);
    return { accessToken: opaque(value.accessToken), businessId: opaque(value.businessId, 'INVALID_INPUT', 512) };
  }
  async function call(endpoint, { method = 'GET', accessToken, query = {}, body, mutation = false } = {}, normalize) {
    // endpoint is always an internal literal; callers cannot supply an origin/path.
    const url = new URL('/open_api/v1.3' + endpoint, ORIGIN);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken !== undefined) headers['Access-Token'] = accessToken;
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AccountsApiError('PROVIDER_TIMEOUT', mutation));
      }, timeoutMs);
    });
    async function boundedBody(response) {
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxResponseBytes)) fail('PROVIDER_RESPONSE_TOO_LARGE', mutation);
      if (!response.body || typeof response.body.getReader !== 'function') fail('PROVIDER_MALFORMED', mutation);
      const reader = response.body.getReader();
      const onAbort = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let output = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (timedOut) fail('PROVIDER_TIMEOUT', mutation);
          if (done) break;
          if (!(value instanceof Uint8Array)) fail('PROVIDER_MALFORMED', mutation);
          size += value.byteLength;
          if (size > maxResponseBytes) fail('PROVIDER_RESPONSE_TOO_LARGE', mutation);
          output += decoder.decode(value, { stream: true });
        }
        return output + decoder.decode();
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        Promise.resolve(reader.cancel()).catch(() => {});
        reader.releaseLock();
      }
    }
    async function perform() {
      let response;
      try {
        response = await fetchImpl(url.href, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      } catch { fail(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR', mutation); }
      if (!response || !Number.isInteger(response.status) || !response.headers || typeof response.headers.get !== 'function') fail('PROVIDER_MALFORMED', mutation);
      if (response.status < 200 || response.status > 299) { Promise.resolve(response.body?.cancel()).catch(() => {}); fail('PROVIDER_HTTP_ERROR', mutation); }
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) { Promise.resolve(response.body?.cancel()).catch(() => {}); fail('PROVIDER_NON_JSON', mutation); }
      let payload;
      try { payload = JSON.parse(await boundedBody(response)); } catch (error) {
        if (error instanceof AccountsApiError) throw error;
        fail('PROVIDER_MALFORMED', mutation);
      }
      object(payload, undefined, 'PROVIDER_MALFORMED');
      if (!Number.isSafeInteger(payload.code)) fail('PROVIDER_MALFORMED', mutation);
      if (payload.code !== 0) fail('PROVIDER_REJECTED', false);
      object(payload.data, undefined, 'PROVIDER_MALFORMED');
      const providerRequestId = opaque(payload.request_id ?? response.headers.get('x-tt-logid'), 'PROVIDER_MALFORMED', 256);
      if ([appSecret, accessToken, body?.auth_code, body?.refresh_token, body?.access_token].filter(Boolean).some(secret => providerRequestId.includes(secret))) fail('PROVIDER_MALFORMED', mutation);
      return normalize(payload.data, providerRequestId);
    }
    try {
      return await Promise.race([perform(), deadline]);
    } catch (error) {
      if (error instanceof AccountsApiError && ERRORS.has(error.code)) {
        if (mutation && error.code !== 'PROVIDER_REJECTED') error.mayHaveSucceeded = true;
        throw error;
      }
      fail(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_MALFORMED', mutation);
    } finally { clearTimeout(timer); }
  }
  function normalizeToken(data, providerRequestId) {
    const subjectId = opaque(data.open_id, 'PROVIDER_MALFORMED', 512);
    const accessToken = opaque(data.access_token, 'PROVIDER_MALFORMED');
    const refreshToken = opaque(data.refresh_token, 'PROVIDER_MALFORMED');
    const grantedScopes = scopes(data.scope);
    if (data.token_type !== 'Bearer') fail('PROVIDER_MALFORMED');
    const expiresIn = number(data.expires_in, 1, 315360000, 'PROVIDER_MALFORMED');
    const refreshExpiresIn = number(data.refresh_token_expires_in, 1, 315360000, 'PROVIDER_MALFORMED');
    const time = Date.parse(observedAt());
    return { subjectId, accessToken, refreshToken, grantedScopes, expiresAt: new Date(time + expiresIn * 1000).toISOString(), refreshExpiresAt: new Date(time + refreshExpiresIn * 1000).toISOString(), providerRequestId, raw: { open_id: subjectId, scope: data.scope, token_type: data.token_type, expires_in: expiresIn, refresh_token_expires_in: refreshExpiresIn } };
  }
  function propertyResult(data, providerRequestId, expected, verifying) {
    const info = object(data.url_property_info, undefined, 'PROVIDER_MALFORMED');
    if (info.property_type !== expected.property_type || info.url !== expected.url) fail('PROVIDER_MALFORMED');
    const propertyStatus = number(info.property_status, 0, 2, 'PROVIDER_MALFORMED');
    if (!verifying && propertyStatus !== 0) fail('PROVIDER_MALFORMED');
    const signature = text(info.signature, 4096, 'PROVIDER_MALFORMED');
    const fileName = info.file_name === undefined ? null : opaque(info.file_name, 'PROVIDER_MALFORMED', 512);
    if (expected.property_type === 2 && (!fileName || /[/\\]/u.test(fileName) || fileName === '.' || fileName === '..')) fail('PROVIDER_MALFORMED');
    return { fileName, signature, propertyStatus, verified: propertyStatus === 1, providerRequestId };
  }
  return Object.freeze({
    async exchange(input) {
      object(input, ['authCode', 'redirectUri']);
      const authCode = opaque(input.authCode);
      const redirectUri = text(input.redirectUri, 8192);
      const redirect = webUrl(redirectUri);
      if (redirect.protocol !== 'https:' || /[?#]/u.test(redirectUri)) fail();
      return call('/tt_user/oauth2/token/', { method: 'POST', mutation: true, body: { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', auth_code: authCode, redirect_uri: redirectUri } }, normalizeToken);
    },
    async refresh(input) {
      object(input, ['refreshToken']);
      const refreshToken = opaque(input.refreshToken);
      return call('/tt_user/oauth2/refresh_token/', { method: 'POST', mutation: true, body: { client_id: appId, client_secret: appSecret, grant_type: 'refresh_token', refresh_token: refreshToken } }, normalizeToken);
    },
    async tokenInfo(input) {
      object(input, ['accessToken']);
      const accessToken = opaque(input.accessToken);
      return call('/tt_user/token_info/get/', { method: 'POST', body: { app_id: appId, access_token: accessToken } }, (data, providerRequestId) => {
        const actualAppId = opaque(data.app_id, 'PROVIDER_MALFORMED', 256);
        const subjectId = opaque(data.creator_id, 'PROVIDER_MALFORMED', 512);
        return { appId: actualAppId, subjectId, grantedScopes: scopes(data.scope), providerRequestId, raw: { app_id: actualAppId, creator_id: subjectId, scope: data.scope } };
      });
    },
    async settings(input) {
      const { accessToken, businessId } = accountInput(input);
      return call('/business/video/settings/', { accessToken, query: { business_id: businessId } }, (data, providerRequestId) => {
        const privacyLevelOptions = stringArray(data.privacy_level_options, { min: 1, max: 4 });
        if (privacyLevelOptions.some(option => !PRIVACY_OPTIONS.has(option))) fail('PROVIDER_MALFORMED');
        return { maxVideoPostDurationSec: number(data.max_video_post_duration_sec, 3, 600, 'PROVIDER_MALFORMED'), privacyLevelOptions, commentDisabled: bool(data.comment_disabled, 'PROVIDER_MALFORMED'), duetDisabled: bool(data.duet_disabled, 'PROVIDER_MALFORMED'), stitchDisabled: bool(data.stitch_disabled, 'PROVIDER_MALFORMED'), providerRequestId, observedAt: observedAt() };
      });
    },
    async profile(input) {
      const { accessToken, businessId } = accountInput(input);
      return call('/business/get/', { accessToken, query: { business_id: businessId, fields: ['username', 'display_name'] } }, (data, providerRequestId) => ({ businessId, username: opaque(data.username, 'PROVIDER_MALFORMED', 256), displayName: text(data.display_name, 512, 'PROVIDER_MALFORMED', true), providerRequestId, observedAt: observedAt() }));
    },
    async listVideos(input) {
      const { accessToken, businessId } = accountInput(input, ['videoIds', 'cursor', 'maxCount']);
      const videoIds = input.videoIds === undefined ? undefined : stringArray(input.videoIds, { min: 1, max: 100, code: 'INVALID_INPUT' });
      const cursor = input.cursor === undefined ? undefined : number(input.cursor, 0, Number.MAX_SAFE_INTEGER);
      const maxCount = input.maxCount === undefined ? undefined : number(input.maxCount, 1, 20);
      return call('/business/video/list/', { accessToken, query: { business_id: businessId, fields: ['item_id', 'share_url', 'caption', 'create_time', 'is_ad'], filters: videoIds === undefined ? undefined : { video_ids: videoIds }, cursor, max_count: maxCount } }, (data, providerRequestId) => {
        if (!Array.isArray(data.videos) || data.videos.length > 100) fail('PROVIDER_MALFORMED');
        const rows = data.videos.map(item => {
          object(item, undefined, 'PROVIDER_MALFORMED');
          const id = opaque(item.item_id, 'PROVIDER_MALFORMED', 512);
          const row = { id, itemId: id };
          if (item.caption !== undefined) row.caption = text(item.caption, 2200, 'PROVIDER_MALFORMED', true);
          if (item.share_url !== undefined) { webUrl(item.share_url, 'PROVIDER_MALFORMED'); row.shareUrl = item.share_url; }
          if (item.create_time !== undefined) row.createTime = number(item.create_time, 0, Number.MAX_SAFE_INTEGER, 'PROVIDER_MALFORMED');
          if (item.is_ad !== undefined) row.isAd = bool(item.is_ad, 'PROVIDER_MALFORMED');
          return row;
        });
        const hasMore = bool(data.has_more, 'PROVIDER_MALFORMED');
        const nextCursor = data.cursor === undefined ? null : number(data.cursor, 0, Number.MAX_SAFE_INTEGER, 'PROVIDER_MALFORMED');
        if (hasMore && nextCursor === null) fail('PROVIDER_MALFORMED');
        return { rows, postIds: rows.map(row => row.id), hasMore, cursor: nextCursor, providerRequestId, observedAt: observedAt() };
      });
    },
    async publish(input) {
      const { accessToken, businessId } = accountInput(input, ['videoUrl', 'postInfo']);
      webUrl(input.videoUrl);
      const postInfo = postInput(input.postInfo);
      return call('/business/video/publish/', { method: 'POST', accessToken, mutation: true, body: { business_id: businessId, video_url: input.videoUrl, post_info: postInfo } }, (data, providerRequestId) => ({ publishId: opaque(data.share_id, 'PROVIDER_MALFORMED', 512), providerRequestId }));
    },
    async publishStatus(input) {
      const { accessToken, businessId } = accountInput(input, ['publishId']);
      const publishId = opaque(input.publishId, 'INVALID_INPUT', 512);
      return call('/business/publish/status/', { accessToken, query: { business_id: businessId, publish_id: publishId } }, (data, providerRequestId) => {
        const providerStatus = opaque(data.status, 'PROVIDER_MALFORMED', 128);
        const states = new Map([['PROCESSING_DOWNLOAD', 'PROCESSING'], ['PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'], ['FAILED', 'FAILED'], ['SEND_TO_USER_INBOX', 'SEND_TO_USER_INBOX']]);
        const state = states.get(providerStatus) ?? 'UNKNOWN';
        const postIds = data.post_ids === undefined ? [] : stringArray(data.post_ids);
        if (state !== 'PUBLISH_COMPLETE' && postIds.length) fail('PROVIDER_MALFORMED');
        const reason = data.reason === undefined ? undefined : opaque(data.reason, 'PROVIDER_MALFORMED', 256);
        return { state, postIds, providerStatus, providerRequestId, ...(reason === undefined ? {} : { reason }) };
      });
    },
    async addUrlProperty(input) {
      const meta = propertyInput(input);
      return call('/business/property/add/', { method: 'POST', mutation: true, body: { app_id: appId, secret: appSecret, url_property_meta: meta } }, (data, providerRequestId) => propertyResult(data, providerRequestId, meta, false));
    },
    async verifyUrlProperty(input) {
      const meta = propertyInput(input);
      return call('/business/property/verify/', { method: 'POST', mutation: true, body: { app_id: appId, secret: appSecret, url_property_meta: meta } }, (data, providerRequestId) => propertyResult(data, providerRequestId, meta, true));
    },
    async listUrlProperties(input = {}) {
      object(input, []);
      // The official property/list contract requires secret in the GET query.
      // Never include this URL, the fetch exception, or provider body in errors.
      return call('/business/property/list/', { query: { app_id: appId, secret: appSecret } }, (data, providerRequestId) => {
        if (!Array.isArray(data.url_property_info_list) || data.url_property_info_list.length > 1000) fail('PROVIDER_MALFORMED');
        const rows = data.url_property_info_list.map(info => {
          object(info, undefined, 'PROVIDER_MALFORMED');
          let meta;
          try { meta = propertyInput({ type: info.property_type, url: info.url }); } catch { fail('PROVIDER_MALFORMED'); }
          const value = propertyResult({ url_property_info: info }, providerRequestId, meta, true);
          return { type: meta.property_type, url: meta.url, propertyStatus: value.propertyStatus, fileName: value.fileName, signature: value.signature };
        });
        return { rows, providerRequestId };
      });
    },
  });
}
