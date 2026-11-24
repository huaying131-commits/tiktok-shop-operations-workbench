export class StateError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
export class StateStore {
  constructor(sql, transaction, identity) {
    this.sql = sql; this.transaction = transaction; this.identity = identity;
    for (const query of [
      `CREATE TABLE IF NOT EXISTS flows (ticket_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, provider TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, proof_hash TEXT NOT NULL, app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, provider TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, connection_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS oauth_code_claims (app_id TEXT NOT NULL, provider TEXT NOT NULL, code_hash TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY (app_id, provider, code_hash))`,
      `CREATE TABLE IF NOT EXISTS connections (connection_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, provider TEXT NOT NULL, subject_id TEXT NOT NULL, sealed TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, authorized_at INTEGER NOT NULL, verification_status TEXT NOT NULL, verified_at INTEGER, profile TEXT, settings TEXT)`,
      `CREATE TABLE IF NOT EXISTS publish_requests (request_id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL, asset_sha256 TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL, app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, publish_id TEXT, provider_request_id TEXT, provider_status TEXT, post_ids TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS url_properties (url TEXT PRIMARY KEY, property_status INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS uploaded_assets (sha256 TEXT NOT NULL, url TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS post_readbacks (request_id TEXT PRIMARY KEY, receipt TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS publish_status_observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, state TEXT NOT NULL, provider_status TEXT, provider_request_id TEXT, post_ids TEXT NOT NULL, disposition TEXT NOT NULL, observed_at INTEGER NOT NULL)`
    ]) sql.exec(query);
  }
  rows(query, ...values) { return [...this.sql.exec(query, ...values)]; }
  one(query, ...values) { return this.rows(query, ...values)[0]; }
  owned(row) { const i = this.identity; return row && row.app_id === i.appId && row.tenant_id === i.tenantId && row.actor_id === i.actorId && row.provider === i.provider; }
  identityValues() { const i = this.identity; return [i.appId, i.tenantId, i.actorId, i.provider]; }
  createFlow(hash, expiresAt) { this.sql.exec('INSERT INTO flows VALUES (?, ?, ?, ?, ?, ?, ?)', hash, ...this.identityValues(), expiresAt, 'READY'); }
  getFlow(hash, now) {
    const row = this.one('SELECT * FROM flows WHERE ticket_hash = ?', hash);
    if (!this.owned(row)) throw new StateError(404, 'flow_not_found');
    if (row.expires_at <= now) throw new StateError(410, 'flow_expired');
    if (row.status !== 'READY') throw new StateError(409, 'flow_consumed');
    return row;
  }
  consumeFlow(ticketHash, stateHash, proofHash, redirectUri, now) {
    this.transaction(() => {
      this.getFlow(ticketHash, now);
      this.sql.exec("UPDATE flows SET status = 'CONSUMED' WHERE ticket_hash = ?", ticketHash);
      this.sql.exec('INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)', stateHash, ticketHash, proofHash, ...this.identityValues(), redirectUri, now + 600_000, 'READY');
    });
  }
  claimState(hash, proofHash, redirectUri, codeHash, now) {
    return this.transaction(() => {
      const row = this.one('SELECT * FROM oauth_states WHERE state_hash = ?', hash);
      if (!this.owned(row)) throw new StateError(404, 'state_not_found');
      if (row.proof_hash !== proofHash || row.redirect_uri !== redirectUri) throw new StateError(403, 'browser_proof_invalid');
      if (row.expires_at <= now) throw new StateError(410, 'state_expired');
      if (row.status !== 'READY') throw new StateError(409, 'state_already_claimed');
      const { appId, provider } = this.identity;
      if (this.one('SELECT state_hash FROM oauth_code_claims WHERE app_id = ? AND provider = ? AND code_hash = ?', appId, provider, codeHash)) throw new StateError(409, 'authorization_code_already_claimed');
      this.sql.exec('INSERT INTO oauth_code_claims VALUES (?, ?, ?, ?, ?, ?)', appId, provider, codeHash, hash, 'UNKNOWN', now);
      this.sql.exec("UPDATE oauth_states SET status = 'UNKNOWN' WHERE state_hash = ?", hash);
      return row;
    });
  }
  saveConnection(stateHash, c) {
    this.transaction(() => {
      const state = this.one('SELECT * FROM oauth_states WHERE state_hash = ?', stateHash);
      if (!this.owned(state) || state.status !== 'UNKNOWN') throw new StateError(409, 'state_already_claimed');
      this.sql.exec('INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)', c.connectionId, ...this.identityValues(), c.subjectId, c.sealed, JSON.stringify(c.grantedScopes), c.expiresAt, c.refreshExpiresAt, c.authorizedAt, 'UNVERIFIED');
      this.sql.exec("UPDATE oauth_states SET status = 'CONNECTED', connection_id = ? WHERE state_hash = ?", c.connectionId, stateHash);
      this.sql.exec("UPDATE oauth_code_claims SET status = 'CONNECTED' WHERE state_hash = ?", stateHash);
    });
  }
  connection(id) { const c = this.one('SELECT * FROM connections WHERE connection_id = ?', id); if (!this.owned(c)) throw new StateError(404, 'account_not_found'); return c; }
  connections() { return this.rows('SELECT * FROM connections WHERE app_id = ? AND tenant_id = ? AND actor_id = ? AND provider = ?', ...this.identityValues()); }
  verification(id, { status, scopes, profile, settings, now }) {
    this.connection(id);
    this.sql.exec('UPDATE connections SET verification_status = ?, scopes = ?, profile = ?, settings = ?, verified_at = ? WHERE connection_id = ?', status, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify(settings), now, id);
  }
  upload(sha, url, expiresAt) { this.sql.exec('INSERT OR REPLACE INTO uploaded_assets VALUES (?, ?, ?)', sha, url, expiresAt); }
  asset(sha, url, now) { return this.one('SELECT * FROM uploaded_assets WHERE sha256 = ? AND url = ? AND expires_at > ?', sha, url, now + 1_800_000); }
  property(url, status, now) { this.sql.exec('INSERT OR REPLACE INTO url_properties VALUES (?, ?, ?)', url, status, now); }
  propertyRecord(url) { return this.one('SELECT * FROM url_properties WHERE url = ?', url); }
  claimProperty(url, now) {
    return this.transaction(() => {
      const previous = this.one('SELECT * FROM url_properties WHERE url = ?', url);
      if (previous) return { winner: false, row: previous };
      this.property(url, 0, now);
      return { winner: true };
    });
  }
  propertyVerified(url) { return this.one('SELECT * FROM url_properties WHERE url = ? AND property_status = 1', url); }
  publish(id) { const row = this.one('SELECT * FROM publish_requests WHERE request_id = ?', id); if (row && !this.owned(row)) throw new StateError(404, 'request_not_found'); return row; }
  claimPublish(input, intentHash, now, validate) {
    return this.transaction(() => {
      const existing = this.publish(input.requestId);
      if (existing) { if (existing.intent_hash !== intentHash) throw new StateError(409, 'request_intent_conflict'); return { winner: false, row: existing }; }
      if (this.one('SELECT request_id FROM publish_requests WHERE asset_sha256 = ?', input.assetSha256)) throw new StateError(409, 'asset_already_claimed');
      // Re-read all mutable gates inside this synchronous claim transaction.
      const account = validate();
      this.sql.exec('INSERT INTO publish_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)', input.requestId, intentHash, input.assetSha256, input.connectionId, ...this.identityValues(), 'UNKNOWN', '[]', now, now);
      return { winner: true, row: this.publish(input.requestId), account };
    });
  }
  updatePublish(id, { state, publishId, providerRequestId, providerStatus, postIds = [], now }) {
    const row = this.publish(id); if (!row) throw new StateError(404, 'request_not_found');
    this.sql.exec('UPDATE publish_requests SET state = ?, publish_id = ?, provider_request_id = ?, provider_status = ?, post_ids = ?, updated_at = ? WHERE request_id = ?', state, publishId || row.publish_id, providerRequestId || row.provider_request_id, providerStatus || row.provider_status, JSON.stringify(postIds), now, id);
    return this.publish(id);
  }
  observePublishStatus(id, { state, providerRequestId, providerStatus, postIds, now }) {
    return this.transaction(() => {
      // Re-read after the provider await: another poll may already have completed.
      const previous = this.publish(id); if (!previous) throw new StateError(404, 'request_not_found');
      const knownIds = JSON.parse(previous.post_ids);
      const sameIds = new Set(knownIds).size === knownIds.length && new Set(postIds).size === postIds.length &&
        knownIds.length === postIds.length && knownIds.every(value => postIds.includes(value));
      let disposition = 'OBSERVED';
      if (previous.state === 'COMPLETE' && (state !== 'COMPLETE' || !sameIds)) {
        disposition = ['PROCESSING', 'UNKNOWN', 'AWAITING_POST_IDS'].includes(state) ? 'STALE' : 'CONFLICT';
      } else if (previous.state === 'AWAITING_POST_IDS' && !['AWAITING_POST_IDS', 'COMPLETE'].includes(state)) {
        disposition = ['PROCESSING', 'UNKNOWN'].includes(state) ? 'STALE' : 'CONFLICT';
      }
      const row = disposition === 'OBSERVED' ? this.updatePublish(id, {
        state, providerRequestId, providerStatus,
        postIds: previous.state === 'COMPLETE' ? knownIds : postIds, now
      }) : previous;
      // Store safe contradictory/stale observations separately; never erase prior IDs.
      this.sql.exec('INSERT INTO publish_status_observations (request_id,state,provider_status,provider_request_id,post_ids,disposition,observed_at) VALUES (?,?,?,?,?,?,?)',
        id, state, providerStatus, providerRequestId, JSON.stringify(postIds), disposition, now);
      return { row, observation: { state, providerStatus, providerRequestId, postIds, disposition, observedAt: new Date(now).toISOString() } };
    });
  }
  saveReadback(requestId, receipt, now) { this.sql.exec('INSERT OR REPLACE INTO post_readbacks VALUES (?, ?, ?)', requestId, JSON.stringify(receipt), now); }
}
