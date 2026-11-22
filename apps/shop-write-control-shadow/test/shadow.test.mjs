import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { config, proposal, promotion, approval, claimInput, proofFor } from './fixtures.mjs';

// The first RED run deliberately has no implementation modules yet.
const caps = await import('../src/capabilities.mjs').catch(() => ({}));
const intents = await import('../src/intents.mjs').catch(() => ({}));
const storage = await import('../src/write-store.mjs').catch(() => ({}));
const views = await import('../src/task-view.mjs').catch(() => ({}));
function surface() {
  assert.equal(typeof caps.createAuthority, 'function', 'trusted capability authority must exist');
  assert.equal(typeof intents.canonicalJson, 'function', 'strict canonicalization must exist');
  assert.equal(typeof intents.normalizeIntent, 'function', 'strict intents must exist');
  assert.equal(typeof storage.WriteStore, 'function', 'durable store must exist');
  assert.equal(typeof views.projectTask, 'function', 'fixture task projection must exist');
}
function setup(t, options = {}) {
  surface();
  const dir = mkdtempSync(join(tmpdir(), 'fixture-write-control-'));
  const authority = caps.createAuthority(config);
  const file = join(dir, 'shadow.sqlite');
  const opened = [];
  function open(extra = {}) {
    const value = new storage.WriteStore({ file, authority, clock: () => new Date('2026-11-22T12:00:00.000Z'), ...options, ...extra });
    opened.push(value);
    return value;
  }
  t.after(() => { for (const db of opened) db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, authority, open, author: authority.principal('fixture_author'), approver: authority.principal('fixture_approver') };
}
function denied(fn, code, status) {
  assert.throws(fn, (error) => error.code === code && error.status === status && !/bearer|token-value|secret-value/i.test(error.message));
}
function approved(s, store, request = proposal()) {
  const row = store.propose(s.author, request);
  return store.approveFixture(s.approver, approval(row));
}
function child(file, counter, mode = 'send') {
  const p = fork(fileURLToPath(new URL('./claim-worker.mjs', import.meta.url)), [file, counter, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  const ready = new Promise((resolve, reject) => {
    p.on('message', (message) => { messages.push(message); if (message.ready) resolve(); });
    p.once('error', reject);
    p.once('exit', () => { if (!messages.some((x) => x.ready)) reject(new Error('child failed before ready')); });
  });
  const exit = new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', (code) => resolve(code)); });
  return { p, ready, exit, messages };
}

test('trusted principals deny read-only writes, forged identity, foreign shops and actions before storage', (t) => {
  const s = setup(t); const db = s.open();
  const read = s.authority.principal('fixture_readonly');
  denied(() => db.propose(read, proposal()), 'ACCESS_DENIED', 403);
  denied(() => db.propose({ ...s.author }, proposal()), 'UNAUTHENTICATED', 401);
  denied(() => db.propose(caps.createAuthority(config).principal('fixture_author'), proposal()), 'UNAUTHENTICATED', 401);
  denied(() => db.propose(s.author, { ...proposal(), shop_id: 'fixture_shop_b' }), 'ACCESS_DENIED', 403);
  denied(() => db.propose(s.author, { ...proposal(), action: 'refund.create' }), 'ACTION_DENIED', 403);
  denied(() => db.propose(s.author, { ...proposal(), principal_id: 'fixture_foreign' }), 'INVALID_REQUEST', 400);
  denied(() => db.propose(s.author, { ...proposal(), tenant_id: 'fixture_tenant_b' }), 'INVALID_REQUEST', 400);
  denied(() => db.propose(s.authority.principal('fixture_foreign'), proposal()), 'ACCESS_DENIED', 403);
  denied(() => db.approveFixture(read, { request_id: proposal().request_id, shop_id: 'fixture_shop_a' }), 'ACCESS_DENIED', 403);
  denied(() => db.claimFixture(read, claimInput({ request_id: proposal().request_id, identity: { shop_id: 'fixture_shop_a' } })), 'ACCESS_DENIED', 403);
  assert.equal(db.list(s.author).length, 0);
});

test('canonical intent sorts object keys, preserves array order and includes server-bound identity', (t) => {
  const s = setup(t); const a = promotion();
  const b = { amount: a.amount, currency: a.currency, items: a.items.map((x) => ({ quantity: x.quantity, sku_id: x.sku_id })), action: a.action, shop_id: a.shop_id, request_id: a.request_id };
  const first = intents.normalizeIntent(s.authority, s.author, a);
  const second = intents.normalizeIntent(s.authority, s.author, b);
  assert.equal(first.intent_hash, second.intent_hash);
  assert.equal(first.intent_json, second.intent_json);
  assert.equal(first.intent.identity.tenant_id, 'fixture_tenant_a');
  const reversed = intents.normalizeIntent(s.authority, s.author, { ...a, items: [...a.items].reverse() });
  assert.notEqual(first.intent_hash, reversed.intent_hash);
  assert.ok(!first.intent_json.includes('capabilities'));
});

test('promotion existing SKU IDs must be present in trusted principal shop catalog', (t) => {
  const s = setup(t); const db = s.open();
  const request = promotion('unknown');
  request.items[0].sku_id = 'fixture_unknown_sku';
  denied(() => db.propose(s.author, request), 'TARGET_DENIED', 403);
  assert.equal(db.list(s.author).length, 0);
});

test('strict schema rejects floats, nondecimal money, missing IDs, metadata and hostile objects', (t) => {
  const s = setup(t); const db = s.open();
  const invalid = [
    { ...proposal(), request_id: undefined }, { ...proposal(), metadata: {} },
    ...[12.3, NaN, '12.3', '01.00', '-1.00', '1e2', '0.00'].map((amount) => ({ ...proposal(), listing: { ...proposal().listing, amount } })),
    ...[0, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1].map((quantity) => ({ ...proposal(), listing: { ...proposal().listing, quantity } })),
    { ...proposal(), listing: { ...proposal().listing, client_sku: 'actual-product' } },
    { ...proposal(), listing: { ...proposal().listing, currency: 'USD' } },
    { ...proposal(), listing: new Date() }, { ...proposal(), listing: Object.create({ client_sku: 'fixture_sku_new' }) }
  ];
  for (const value of invalid) denied(() => db.propose(s.author, value), 'INVALID_REQUEST', 400);
  const getter = { ...proposal() }; Object.defineProperty(getter, 'listing', { enumerable: true, get() { throw new Error('getter must never execute'); } });
  denied(() => db.propose(s.author, getter), 'INVALID_REQUEST', 400);
  const cyclic = {}; cyclic.self = cyclic;
  denied(() => intents.canonicalJson(cyclic), 'INVALID_REQUEST', 400);
  denied(() => intents.canonicalJson({ value: undefined }), 'INVALID_REQUEST', 400);
  denied(() => intents.canonicalJson([, 'fixture_value']), 'INVALID_REQUEST', 400);
  denied(() => intents.canonicalJson({ ['__proto__']: {} }), 'INVALID_REQUEST', 400);
});

test('same owner duplicate returns immutable original; changed intent conflicts and other owners cannot read it', (t) => {
  const s = setup(t); const db = s.open();
  const first = db.propose(s.author, proposal());
  const repeat = db.propose(s.author, proposal());
  assert.deepEqual(first, repeat);
  denied(() => db.propose(s.author, { ...proposal(), listing: { ...proposal().listing, quantity: 3 } }), 'INTENT_CONFLICT', 409);
  const other = s.authority.principal('fixture_other');
  denied(() => db.propose(other, proposal()), 'ACCESS_DENIED', 403);
  denied(() => db.get(other, { request_id: first.request_id, shop_id: 'fixture_shop_a' }), 'ACCESS_DENIED', 403);
  denied(() => db.get(other, { request_id: 'fixture_author:fixture_request_absent', shop_id: 'fixture_shop_a' }), 'ACCESS_DENIED', 403);
  assert.equal(db.get(s.author, { request_id: first.request_id, shop_id: 'fixture_shop_a' }).intent.listing.quantity, 2);
});

test('only exact fixture business approval binds hash, object, quantity and money; role approval and ACK fail', (t) => {
  const s = setup(t); const db = s.open(); const record = db.propose(s.author, proposal());
  const a = approval(record);
  denied(() => db.approveFixture(s.approver, { ...a, fixture_only: false }), 'INVALID_REQUEST', 400);
  denied(() => db.approveFixture(s.approver, { ...a, role_approved: true }), 'INVALID_REQUEST', 400);
  for (const change of [{ quantity: 3 }, { amount: '10.00' }, { client_sku: 'fixture_other_sku' }]) {
    denied(() => db.approveFixture(s.approver, { ...a, intent: { ...a.intent, listing: { ...a.intent.listing, ...change } } }), 'ACCESS_DENIED', 403);
  }
  denied(() => db.approveFixture(s.approver, { ...a, intent_hash: 'a'.repeat(64) }), 'ACCESS_DENIED', 403);
  denied(() => db.approveFixture(s.authority.principal('fixture_same_shop_foreign'), a), 'ACCESS_DENIED', 403);
  denied(() => db.claimFixture(s.author, claimInput(record)), 'APPROVAL_REQUIRED', 409);
  const exact = db.approveFixture(s.approver, a);
  assert.equal(exact.approval_state, 'FIXTURE_APPROVED');
  assert.equal(exact.approved_intent_hash, exact.intent_hash);
  assert.equal(exact.approval_actor, 'fixture_approver');
  assert.equal(exact.execution_state, 'NOT_CLAIMED');
});

test('two database connections receive only one durable opaque claim and never requeue UNKNOWN', (t) => {
  const s = setup(t); const db = s.open(); const record = approved(s, db); const second = s.open();
  const claim = db.claimFixture(s.author, claimInput(record));
  assert.equal(claim.claimed, true); assert.match(claim.claim_token, /^[a-f0-9]{64}$/);
  assert.equal(second.claimFixture(s.author, claimInput(record)).claimed, false);
  const stored = second.get(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a' });
  assert.equal(stored.execution_state, 'UNKNOWN');
  assert.equal(stored.provider_request_id, claimInput(record).provider_request_id);
  assert.ok(!JSON.stringify(stored).includes(claim.claim_token));
});

test('actual concurrent child processes increment the independent fake send counter at most once', async (t) => {
  const s = setup(t); const db = s.open(); const record = approved(s, db);
  const counter = join(s.dir, 'fake-sends.txt'); const children = [child(s.file, counter), child(s.file, counter)];
  t.after(() => { for (const value of children) if (value.p.exitCode === null) value.p.kill(); });
  await Promise.all(children.map((value) => value.ready));
  for (const value of children) value.p.send(claimInput(record));
  assert.deepEqual(await Promise.all(children.map((value) => value.exit)), [0, 0]);
  assert.equal(children.flatMap((x) => x.messages).filter((x) => x.claimed).length, 1);
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 1);
});

test('process crash after durable claim survives reopen without resend or lock stealing', async (t) => {
  const s = setup(t); const db = s.open(); const record = approved(s, db);
  const counter = join(s.dir, 'crash-sends.txt'); const worker = child(s.file, counter, 'crash');
  t.after(() => { if (worker.p.exitCode === null) worker.p.kill(); });
  await worker.ready; worker.p.send(claimInput(record)); assert.equal(await worker.exit, 19);
  db.close(); const reopened = s.open();
  assert.equal(reopened.get(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a' }).execution_state, 'UNKNOWN');
  assert.equal(reopened.claimFixture(s.author, claimInput(record)).claimed, false);
  assert.equal(existsSync(counter), false);
});

test('absent, stale, future, foreign, incomplete and invalid read evidence all remain UNKNOWN', async (t) => {
  let query; let returned = null;
  const s = setup(t, { readFixture: async (value) => { query = value; if (returned instanceof Error) throw returned; return returned; } });
  const db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const input = { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token };
  async function unknown(value) { returned = value; const result = await db.reconcileFixture(s.author, input); assert.equal(result.execution_state, 'UNKNOWN'); }
  await unknown(null);
  const exact = proofFor(query, intents.canonicalJson);
  await unknown({ ok: true, ack: 'accepted' });
  await unknown(proofFor(query, intents.canonicalJson, '2026-11-22T11:50:00.000Z'));
  await unknown(proofFor(query, intents.canonicalJson, '2026-11-22T12:10:00.000Z'));
  await unknown(proofFor({ ...query, identity: { ...query.identity, tenant_id: 'fixture_tenant_b' } }, intents.canonicalJson));
  await unknown(proofFor({ ...query, object_id: 'fixture_foreign_object' }, intents.canonicalJson));
  await unknown(proofFor({ ...query, provider_request_id: 'fixture_other_request' }, intents.canonicalJson));
  await unknown({ ...exact, evidence_sha256: '0'.repeat(64) });
  await unknown({ ...exact, evidence_ref: 'https://example.invalid/client-ack' });
  await unknown(new Error('secret-value unavailable'));
  assert.equal(db.claimFixture(s.author, claimInput(record)).claimed, false);
});

test('exact fresh trusted fixture proof verifies only original claim and intent; task labels remain fixture-only', async (t) => {
  const s = setup(t, { readFixture: async (query) => proofFor(query, intents.canonicalJson) });
  const db = s.open(); const proposalRow = db.propose(s.author, promotion());
  assert.equal(views.projectTask(proposalRow).state, '需要确认');
  assert.equal(views.projectTask(proposalRow).deadline, null);
  const record = db.approveFixture(s.approver, approval(proposalRow));
  const claim = db.claimFixture(s.author, claimInput(record));
  assert.equal(views.projectTask(db.get(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a' })).state, '结果待核');
  await assert.rejects(db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: '0'.repeat(64) }), (error) => error.code === 'CLAIM_MISMATCH' && error.status === 403);
  const result = await db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token });
  assert.equal(result.execution_state, 'FIXTURE_VERIFIED');
  const view = views.projectTask(result);
  assert.equal(view.state, '已核实'); assert.equal(view.fixtureOnly, true);
  assert.match(view.label, /仅离线样例/); assert.match(view.nextAction, /真实/);
  assert.deepEqual(view.object.items, promotion().items); assert.equal(view.responsibleActor, 'fixture_author');
  assert.equal(view.evidence.length, 1); assert.deepEqual(view.missingEvidence, []);
  assert.equal(db.claimFixture(s.author, claimInput(record)).claimed, false);
});

test('freshness is checked after async fixture read completes and before persisting success', async (t) => {
  let time = new Date('2026-11-22T12:00:00.000Z');
  const s = setup(t, { clock: () => time, readFixture: async (query) => {
    const proof = proofFor(query, intents.canonicalJson);
    await Promise.resolve();
    time = new Date('2026-11-22T12:02:00.000Z');
    return proof;
  } });
  const db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const result = await db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token });
  assert.equal(result.execution_state, 'UNKNOWN');
});

test('closed persistence after fixture read never reports success and reopened row remains UNKNOWN', async (t) => {
  let db;
  const s = setup(t, { readFixture: async (query) => { db.close(); return proofFor(query, intents.canonicalJson); } });
  db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const input = { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token };
  await assert.rejects(db.reconcileFixture(s.author, { ...input, proof: { ack: true } }), (error) => error.code === 'INVALID_REQUEST');
  await assert.rejects(db.reconcileFixture(s.author, input), (error) => error.code === 'STORE_CLOSED' && error.status === 503);
  const reopened = s.open({ readFixture: async () => null });
  assert.equal(reopened.get(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a' }).execution_state, 'UNKNOWN');
  assert.equal(reopened.claimFixture(s.author, claimInput(record)).claimed, false);
});

test('proof that expires before the persistence timestamp stays UNKNOWN', async (t) => {
  let clockCalls = 0;
  const s = setup(t, { clock: () => new Date(++clockCalls >= 5 ? '2026-11-22T12:02:00.000Z' : '2026-11-22T12:00:00.000Z'), readFixture: async (query) => proofFor(query, intents.canonicalJson) });
  const db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const result = await db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token });
  assert.equal(result.execution_state, 'UNKNOWN');
});

test('v1b proof even one millisecond in the future remains UNKNOWN after read', async (t) => {
  const s = setup(t, { readFixture: async (query) => proofFor(query, intents.canonicalJson, '2026-11-22T12:00:00.001Z') });
  const db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const result = await db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token });
  assert.equal(result.execution_state, 'UNKNOWN');
});

test('v1b proof ahead of commit clock by one millisecond remains UNKNOWN', async (t) => {
  let clockCalls = 0;
  const s = setup(t, {
    clock: () => new Date(++clockCalls === 4 ? '2026-11-22T12:00:00.001Z' : '2026-11-22T12:00:00.000Z'),
    readFixture: async (query) => proofFor(query, intents.canonicalJson, '2026-11-22T12:00:00.001Z')
  });
  const db = s.open(); const record = approved(s, db); const claim = db.claimFixture(s.author, claimInput(record));
  const result = await db.reconcileFixture(s.author, { request_id: record.request_id, shop_id: 'fixture_shop_a', claim_token: claim.claim_token });
  assert.equal(result.execution_state, 'UNKNOWN');
});

test('v1b inaccurate cross-principal approvals return identical 403 for present and absent requests', (t) => {
  const s = setup(t); const db = s.open(); const record = db.propose(s.author, proposal());
  const exact = approval(record);
  function publicError(input) {
    try { db.approveFixture(s.approver, input); return null; }
    catch (error) { return { status: error.status, code: error.code, message: error.message }; }
  }
  for (const inaccurate of [
    { ...exact, intent_hash: '0'.repeat(64) },
    { ...exact, intent: { ...exact.intent, listing: { ...exact.intent.listing, quantity: 3 } } },
    { ...exact, intent: { ...exact.intent, identity: { ...exact.intent.identity, tenant_id: 'fixture_foreign_tenant' } } }
  ]) {
    const present = publicError(inaccurate);
    const absent = publicError({ ...inaccurate, request_id: 'fixture_author:fixture_request_absent' });
    assert.deepEqual(present, { status: 403, code: 'ACCESS_DENIED', message: 'ACCESS_DENIED' });
    assert.deepEqual(present, absent);
  }
  assert.equal(db.approveFixture(s.approver, exact).approval_state, 'FIXTURE_APPROVED');
  denied(() => db.propose(s.author, { ...proposal(), listing: { ...proposal().listing, quantity: 3 } }), 'INTENT_CONFLICT', 409);
});
