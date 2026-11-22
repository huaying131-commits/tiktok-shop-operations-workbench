import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const digest = text => createHash('sha256').update(text).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const validState = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const equalDigest = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const invalid = () => Object.assign(new Error('Invalid authorization flow'), { status: 400 });

export class FileStateStore {
  constructor(directory, { now = () => Date.now(), ttlMs = 300_000 } = {}) {
    if (!(ttlMs > 0 && ttlMs <= 600_000)) throw new Error('State TTL must be at most ten minutes');
    this.directory = directory;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  async issue({ provider, tenantId, actorId, requestedScopes, callbackUri }) {
    if (!['advertiser', 'account'].includes(provider) || !textId(tenantId) || !textId(actorId)) throw invalid();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const state = opaque();
    const browserBinding = opaque();
    const record = { flowId: randomUUID(), provider, tenantId, actorId, requestedScopes, callbackUri, bindingHash: digest(browserBinding), createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
    await writeFile(join(this.directory, `${digest(state)}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return { state, browserBinding, flowId: record.flowId };
  }

  async consume({ state, browserBinding, provider, callbackUri }) {
    if (!validState(state) || !validState(browserBinding)) throw invalid();
    const key = digest(state);
    let record;
    try { record = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')); } catch { throw invalid(); }
    if (record.provider !== provider || record.callbackUri !== callbackUri || record.expiresAt <= this.now() || !equalDigest(record.bindingHash, digest(browserBinding))) throw invalid();
    try {
      // Atomic, durable, cross-process claim. Never delete a claim to retry an uncertain exchange.
      await writeFile(join(this.directory, `${key}.consumed`), JSON.stringify({ flowId: record.flowId, consumedAt: this.now() }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('Authorization flow already consumed'), { status: 409 });
      throw error;
    }
    return record;
  }
}

export class EncryptedFileVault {
  constructor(directory, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A dedicated 32-byte encryption key is required');
    this.directory = directory;
    this.key = Buffer.from(key);
  }

  async save(record) {
    if (!textId(record.tenantId) || !textId(record.actorId) || !['advertiser', 'account'].includes(record.provider) || !Array.isArray(record.subjectIds) || !record.subjectIds.length || record.subjectIds.some(id => !textId(id)) || !record.credentials?.access_token) throw new Error('Invalid token record');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const connectionId = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(connectionId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    await writeFile(join(this.directory, `${connectionId}.json`), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }), { flag: 'wx', mode: 0o600 });
    return connectionId;
  }

  async read(connectionId, { tenantId, provider }) {
    if (!/^[a-f0-9-]{36}$/.test(connectionId)) throw invalid();
    const envelope = JSON.parse(await readFile(join(this.directory, `${connectionId}.json`), 'utf8'));
    if (envelope.version !== 1) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(connectionId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (record.tenantId !== tenantId || record.provider !== provider) throw invalid();
    return record;
  }
}

function validateProvider(provider, id, origin) {
  if (!provider?.enabled || typeof provider.exchange !== 'function' || provider.codeParameter !== 'auth_code') return false;
  try {
    const authorization = new URL(provider.authorizationUrlFromPortal);
    const callback = new URL(provider.callbackUri);
    return authorization.protocol === 'https:' && ['business-api.tiktok.com', 'www.tiktok.com'].includes(authorization.hostname) && !authorization.username && !authorization.password && !authorization.hash && callback.href === `${origin}/oauth/${id}/callback` && Array.isArray(provider.requestedScopes) && provider.requestedScopes.every(textId);
  } catch { return false; }
}

function cookieValue(req, name) {
  const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function send(res, status, message, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", ...extraHeaders });
  res.end(message);
}

export function createOAuthHandler({ publicOrigin, stateStore, vault, providers = {}, authenticate = async () => null, audit = () => {} }) {
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('An exact HTTPS public origin is required');
  const origin = parsed.origin;
  // Audit receives only this explicit whitelist. Never send req.url, codes, token bodies, error.message, or portal URLs.
  const emit = ({ event, provider, outcome, flowId }) => { try { audit({ event, provider, outcome, ...(flowId ? { flowId } : {}) }); } catch { /* Audit must not replay OAuth operations. */ } };
  return async function handle(req, res) {
    let providerId;
    let flowId;
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(res, 400, 'Invalid request.');
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, JSON.stringify({ service: 'huaying-business-oauth', configuredProviders: Object.keys(providers).filter(id => validateProvider(providers[id], id, origin)), liveIntegrationVerified: false }));
      const match = /^\/oauth\/(advertiser|account)\/(start|callback)$/.exec(url.pathname);
      if (!match) return send(res, 404, 'Not found.');
      providerId = match[1];
      const operation = match[2];
      const provider = providers[providerId];
      if (!validateProvider(provider, providerId, origin)) return send(res, 503, 'This authorization integration is not configured. No authorization has been processed.');
      const cookieName = `__Secure-huaying_oauth_${providerId}`;
      const cookieOptions = `Path=/oauth/${providerId}/callback; HttpOnly; Secure; SameSite=Lax`;
      if (operation === 'start') {
        if (req.method !== 'POST') return send(res, 405, 'POST required.', { Allow: 'POST' });
        if (req.headers.origin !== origin) return send(res, 403, 'A same-origin merchant action is required.');
        const identity = await authenticate(req);
        if (!identity || !textId(identity.tenantId) || !textId(identity.actorId)) return send(res, 401, 'Merchant sign-in required.');
        const flow = await stateStore.issue({ provider: providerId, ...identity, requestedScopes: [...provider.requestedScopes], callbackUri: provider.callbackUri });
        const authorization = new URL(provider.authorizationUrlFromPortal);
        authorization.searchParams.set('state', flow.state);
        emit({ event: 'authorization_start', provider: providerId, outcome: 'redirected', flowId: flow.flowId });
        return send(res, 303, 'Continue with TikTok authorization.', { Location: authorization.href, 'Set-Cookie': `${cookieName}=${flow.browserBinding}; ${cookieOptions}; Max-Age=600` });
      }
      if (req.method !== 'GET') return send(res, 405, 'GET required.', { Allow: 'GET' });
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll(provider.codeParameter).length > 1 || url.searchParams.getAll('error').length > 1) throw invalid();
      const code = url.searchParams.get(provider.codeParameter);
      const denied = url.searchParams.has('error');
      if (!denied && (!code || code.length > 4096)) throw invalid();
      const record = await stateStore.consume({ state: url.searchParams.get('state'), browserBinding: cookieValue(req, cookieName), provider: providerId, callbackUri: provider.callbackUri });
      flowId = record.flowId;
      res.setHeader('Set-Cookie', `${cookieName}=; ${cookieOptions}; Max-Age=0`);
      if (denied) {
        emit({ event: 'authorization_callback', provider: providerId, outcome: 'owner_declined', flowId });
        return send(res, 400, 'Authorization was not completed. Return to your merchant workspace.');
      }
      let result;
      try { result = await provider.exchange({ code, callbackUri: record.callbackUri, requestedScopes: record.requestedScopes }); }
      catch {
        emit({ event: 'token_exchange', provider: providerId, outcome: 'unknown_or_failed_do_not_replay', flowId });
        return send(res, 502, 'The token exchange could not be confirmed. This authorization attempt will not be retried. Contact the operator with the time of this attempt.');
      }
      try { await vault.save({ tenantId: record.tenantId, actorId: record.actorId, provider: providerId, subjectIds: result.subjectIds, requestedScopes: record.requestedScopes, grantedScopes: result.grantedScopes, credentials: result.credentials, connectedAt: new Date().toISOString(), flowId }); }
      catch {
        emit({ event: 'token_persistence', provider: providerId, outcome: 'failed_do_not_replay', flowId });
        return send(res, 500, 'Authorization storage could not be confirmed. This attempt will not be replayed. Contact the operator.');
      }
      emit({ event: 'authorization_callback', provider: providerId, outcome: 'stored', flowId });
      return send(res, 200, 'Authorization has been stored on the server. Return to your merchant workspace. No video or advertisement was published.');
    } catch (error) {
      const status = [400, 409].includes(error.status) ? error.status : 500;
      emit({ event: 'authorization_request', provider: providerId || 'unknown', outcome: status === 409 ? 'replay_blocked' : 'rejected', flowId });
      return send(res, status, status === 409 ? 'This authorization attempt has already been consumed. It will not be replayed.' : 'The authorization request could not be validated. Return to your merchant workspace.');
    }
  };
}

// Only the documented advertiser exchange is implemented live. Accounts API exchange is deliberately not guessed.
export function createAdvertiserProvider({ appId, appSecret, fetchImpl = fetch }) {
  if (!textId(appId) || !textId(appSecret)) throw new Error('Advertiser application credentials are required');
  return {
    codeParameter: 'auth_code',
    async exchange({ code }) {
      if (!textId(code)) throw invalid();
      const response = await fetchImpl('https://business-api.tiktok.com/open_api/v2.0/oauth2/access_token/', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: code, return_advertiser_ids: true, is_long_term: true }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Advertiser token endpoint rejected the request');
      const bytes = await response.text();
      if (bytes.length > 1_000_000) throw new Error('Advertiser token response is too large');
      const result = JSON.parse(bytes);
      if (result.code !== 0 || typeof result.data?.access_token !== 'string' || !result.data.access_token || !Array.isArray(result.data.advertiser_ids) || !result.data.advertiser_ids.length || result.data.advertiser_ids.some(id => typeof id !== 'string' || !/^\d{5,30}$/.test(id))) throw new Error('Advertiser token response did not confirm account identity');
      return { subjectIds: result.data.advertiser_ids, grantedScopes: Array.isArray(result.data.scope) ? result.data.scope.map(String) : [], credentials: result.data };
    }
  };
}
