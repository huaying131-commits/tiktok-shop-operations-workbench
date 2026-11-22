import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { ShadowError, fail, requireValue } from './errors.mjs';
import { IDENTITY_KEYS, canonicalJson, deepFreeze, exactKeys, fixtureId, fixtureRef, normalizeIntent, requestId, sha256 } from './intents.mjs';
import { readFixtureProof } from './reconcile-shadow.mjs';

const MARKER = 'shop-write-control-shadow:fixture-only:v1';
const HASH = /^[a-f0-9]{64}$/;
const scopeKeys = IDENTITY_KEYS.filter((key) => key !== 'principal_id');

export class WriteStore {
  #db; #authority; #clock; #readFixture; #closed = false;

  constructor({ file, authority, clock = () => new Date(), readFixture = async () => null }) {
    requireValue(typeof file === 'string' && isAbsolute(file) && /\.sqlite$/.test(file));
    requireValue(authority && typeof authority.authorize === 'function' && typeof clock === 'function' && typeof readFixture === 'function');
    this.#authority = authority; this.#clock = clock; this.#readFixture = readFixture;
    const existed = existsSync(file);
    try {
      mkdirSync(dirname(file), { recursive: true });
      this.#db = new DatabaseSync(file);
      if (existed) {
        const marker = this.#db.prepare("SELECT value FROM shadow_meta WHERE key='package'").get();
        requireValue(marker?.value === MARKER, 'DATABASE_OWNERSHIP', 409);
      }
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS shadow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS writes (
          request_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL, tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL,
          service_id TEXT NOT NULL, shop_id TEXT NOT NULL, region TEXT NOT NULL, action TEXT NOT NULL,
          intent_json TEXT NOT NULL, intent_hash TEXT NOT NULL,
          approval_state TEXT NOT NULL CHECK(approval_state IN ('PENDING','FIXTURE_APPROVED')),
          execution_state TEXT NOT NULL CHECK(execution_state IN ('NOT_CLAIMED','UNKNOWN','FIXTURE_VERIFIED')),
          approved_intent_hash TEXT, approval_actor TEXT, approval_authority_ref TEXT, approved_at TEXT,
          claim_token_hash TEXT, provider_id TEXT, provider_request_id TEXT, object_id TEXT, claimed_at TEXT,
          evidence_ref TEXT, evidence_sha256 TEXT, observed_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          CHECK(execution_state='NOT_CLAIMED' OR (approval_state='FIXTURE_APPROVED' AND claim_token_hash IS NOT NULL)),
          CHECK(execution_state!='FIXTURE_VERIFIED' OR (evidence_ref IS NOT NULL AND evidence_sha256 IS NOT NULL))
        );
        CREATE TRIGGER IF NOT EXISTS immutable_shadow_intent BEFORE UPDATE ON writes
        WHEN NEW.request_id != OLD.request_id OR NEW.intent_json != OLD.intent_json OR NEW.intent_hash != OLD.intent_hash
          OR NEW.principal_id != OLD.principal_id OR NEW.tenant_id != OLD.tenant_id OR NEW.grant_id != OLD.grant_id
          OR NEW.service_id != OLD.service_id OR NEW.shop_id != OLD.shop_id OR NEW.region != OLD.region OR NEW.action != OLD.action
        BEGIN SELECT RAISE(ABORT, 'immutable intent'); END;
        CREATE TRIGGER IF NOT EXISTS no_shadow_requeue BEFORE UPDATE ON writes
        WHEN (OLD.execution_state='UNKNOWN' AND NEW.execution_state='NOT_CLAIMED')
          OR (OLD.execution_state='FIXTURE_VERIFIED' AND NEW.execution_state!='FIXTURE_VERIFIED')
          OR (OLD.claim_token_hash IS NOT NULL AND (NEW.claim_token_hash IS NOT OLD.claim_token_hash
            OR NEW.provider_id IS NOT OLD.provider_id OR NEW.provider_request_id IS NOT OLD.provider_request_id OR NEW.object_id IS NOT OLD.object_id))
        BEGIN SELECT RAISE(ABORT, 'no replay'); END;
      `);
      this.#db.prepare('INSERT OR IGNORE INTO shadow_meta(key,value) VALUES(?,?)').run('package', MARKER);
    } catch (error) {
      this.#db?.close(); this.#closed = true;
      if (error instanceof ShadowError) throw error;
      fail(503, existed ? 'DATABASE_OWNERSHIP' : 'STORE_UNCERTAIN');
    }
  }

  #now() {
    const value = this.#clock();
    requireValue(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_CLOCK', 500);
    return value.toISOString();
  }
  #transaction(operation) {
    requireValue(!this.#closed, 'STORE_CLOSED', 503);
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Never retry a possibly committed action. */ }
      if (error instanceof ShadowError) throw error;
      fail(503, 'STORE_UNCERTAIN');
    }
  }
  #row(id) { return this.#db.prepare('SELECT * FROM writes WHERE request_id=?').get(id); }
  #project(row) {
    const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, row[key]]));
    const { claim_token_hash: _tokenHash, intent_json, ...fields } = row;
    for (const key of IDENTITY_KEYS) delete fields[key];
    return deepFreeze({ ...fields, identity, intent: JSON.parse(intent_json), fixture_only: true });
  }
  #input(principal, capability, input, keys, own = true) {
    const identity = this.#authority.authorize(principal, capability);
    canonicalJson(input); exactKeys(input, keys);
    this.#authority.authorize(principal, capability, { shop_id: input.shop_id });
    requireValue(requestId(input.request_id));
    if (own) requireValue(input.request_id.startsWith(identity.principal_id + ':'), 'ACCESS_DENIED', 403);
    return identity;
  }
  #owned(principal, capability, identity, id) {
    const row = this.#row(id);
    requireValue(row && IDENTITY_KEYS.every((key) => row[key] === identity[key]), 'REQUEST_NOT_FOUND', 404);
    this.#authority.authorize(principal, capability, { shop_id: row.shop_id, action: row.action });
    return row;
  }
  propose(principal, input) {
    const normalized = normalizeIntent(this.#authority, principal, input);
    const { identity } = normalized.intent;
    return this.#transaction(() => {
      const existing = this.#row(input.request_id);
      if (existing) {
        requireValue(IDENTITY_KEYS.every((key) => existing[key] === identity[key]), 'ACCESS_DENIED', 403);
        requireValue(existing.intent_hash === normalized.intent_hash && existing.intent_json === normalized.intent_json, 'INTENT_CONFLICT', 409);
        return this.#project(existing);
      }
      const now = this.#now();
      this.#db.prepare(`INSERT INTO writes(request_id,principal_id,tenant_id,grant_id,service_id,shop_id,region,action,
        intent_json,intent_hash,approval_state,execution_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING','NOT_CLAIMED',?,?)`)
        .run(input.request_id, ...IDENTITY_KEYS.map((key) => identity[key]), input.action, normalized.intent_json, normalized.intent_hash, now, now);
      return this.#project(this.#row(input.request_id));
    });
  }
  get(principal, input) {
    const identity = this.#input(principal, 'read', input, ['request_id', 'shop_id']);
    requireValue(!this.#closed, 'STORE_CLOSED', 503);
    try { return this.#project(this.#owned(principal, 'read', identity, input.request_id)); }
    catch (error) { if (error instanceof ShadowError) throw error; fail(503, 'STORE_UNCERTAIN'); }
  }
  list(principal) {
    const identity = this.#authority.authorize(principal, 'read');
    requireValue(!this.#closed, 'STORE_CLOSED', 503);
    try {
      return this.#db.prepare(`SELECT * FROM writes WHERE ${IDENTITY_KEYS.map((key) => key + '=?').join(' AND ')} ORDER BY request_id`)
        .all(...IDENTITY_KEYS.map((key) => identity[key])).map((row) => {
          this.#authority.authorize(principal, 'read', { shop_id: row.shop_id, action: row.action });
          return this.#project(row);
        });
    } catch (error) { if (error instanceof ShadowError) throw error; fail(503, 'STORE_UNCERTAIN'); }
  }
  approveFixture(principal, input) {
    const identity = this.#input(principal, 'approve_fixture', input, ['request_id', 'shop_id', 'intent_hash', 'intent', 'authority_ref', 'fixture_only'], false);
    requireValue(input.fixture_only === true && HASH.test(input.intent_hash) && fixtureRef(input.authority_ref));
    return this.#transaction(() => {
      const row = this.#row(input.request_id);
      // Until exact intent/hash is known, absence/scope/mismatch have one public
      // error. A different principal cannot use approval as an existence oracle.
      requireValue(row && scopeKeys.every((key) => row[key] === identity[key])
        && row.intent_hash === input.intent_hash && row.intent_json === canonicalJson(input.intent), 'ACCESS_DENIED', 403);
      this.#authority.authorize(principal, 'approve_fixture', { shop_id: row.shop_id, action: row.action });
      if (row.approval_state === 'FIXTURE_APPROVED') {
        requireValue(row.approval_actor === identity.principal_id && row.approval_authority_ref === input.authority_ref, 'APPROVAL_MISMATCH', 409);
        return this.#project(row);
      }
      const now = this.#now();
      this.#db.prepare("UPDATE writes SET approval_state='FIXTURE_APPROVED', approved_intent_hash=?, approval_actor=?, approval_authority_ref=?, approved_at=?, updated_at=? WHERE request_id=?")
        .run(row.intent_hash, identity.principal_id, input.authority_ref, now, now, row.request_id);
      return this.#project(this.#row(row.request_id));
    });
  }
  claimFixture(principal, input) {
    const identity = this.#input(principal, 'claim_fixture', input, ['request_id', 'shop_id', 'provider_id', 'provider_request_id', 'object_id']);
    requireValue(['provider_id', 'provider_request_id', 'object_id'].every((key) => fixtureId(input[key])));
    return this.#transaction(() => {
      const row = this.#owned(principal, 'claim_fixture', identity, input.request_id);
      requireValue(row.approval_state === 'FIXTURE_APPROVED' && row.approved_intent_hash === row.intent_hash, 'APPROVAL_REQUIRED', 409);
      if (row.execution_state !== 'NOT_CLAIMED') {
        requireValue(['provider_id', 'provider_request_id', 'object_id'].every((key) => input[key] === row[key]), 'CLAIM_MISMATCH', 409);
        return deepFreeze({ fixture_only: true, claimed: false, request_id: row.request_id, execution_state: row.execution_state });
      }
      const token = randomBytes(32).toString('hex');
      const now = this.#now();
      this.#db.prepare("UPDATE writes SET execution_state='UNKNOWN', claim_token_hash=?, provider_id=?, provider_request_id=?, object_id=?, claimed_at=?, updated_at=? WHERE request_id=?")
        .run(sha256(token), input.provider_id, input.provider_request_id, input.object_id, now, now, row.request_id);
      // #transaction commits before the caller receives this opaque once token.
      return deepFreeze({ fixture_only: true, claimed: true, request_id: row.request_id, intent_hash: row.intent_hash, claim_token: token, execution_state: 'UNKNOWN' });
    });
  }
  async reconcileFixture(principal, input) {
    const identity = this.#input(principal, 'claim_fixture', input, ['request_id', 'shop_id', 'claim_token']);
    requireValue(typeof input.claim_token === 'string' && HASH.test(input.claim_token));
    requireValue(!this.#closed, 'STORE_CLOSED', 503);
    let row;
    try { row = this.#owned(principal, 'claim_fixture', identity, input.request_id); }
    catch (error) { if (error instanceof ShadowError) throw error; fail(503, 'STORE_UNCERTAIN'); }
    requireValue(row.execution_state !== 'NOT_CLAIMED', 'CLAIM_REQUIRED', 409);
    requireValue(row.claim_token_hash === sha256(input.claim_token), 'CLAIM_MISMATCH', 403);
    if (row.execution_state === 'FIXTURE_VERIFIED') return this.#project(row);
    const query = deepFreeze({
      request_id: row.request_id, identity: Object.fromEntries(IDENTITY_KEYS.map((key) => [key, row[key]])), action: row.action,
      intent_hash: row.intent_hash, intent: JSON.parse(row.intent_json), claim_token_hash: row.claim_token_hash,
      provider_id: row.provider_id, provider_request_id: row.provider_request_id, object_id: row.object_id
    });
    const proof = await readFixtureProof(this.#readFixture, query, { now: () => new Date(this.#now()), claimedAt: row.claimed_at });
    return this.#transaction(() => {
      const current = this.#owned(principal, 'claim_fixture', identity, input.request_id);
      requireValue(current.intent_hash === row.intent_hash && current.claim_token_hash === row.claim_token_hash, 'CLAIM_MISMATCH', 403);
      if (proof && current.execution_state === 'UNKNOWN') {
        const persistedAt = this.#now();
        const observed = Date.parse(proof.observed_at);
        const persisted = Date.parse(persistedAt);
        if (observed >= Date.parse(current.claimed_at) && observed >= persisted - 60000 && observed <= persisted) {
          this.#db.prepare("UPDATE writes SET execution_state='FIXTURE_VERIFIED', evidence_ref=?, evidence_sha256=?, observed_at=?, updated_at=? WHERE request_id=?")
            .run(proof.evidence_ref, proof.evidence_sha256, proof.observed_at, persistedAt, row.request_id);
        }
      }
      return this.#project(this.#row(row.request_id));
    });
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
