import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initMedia, putMedia, serveMedia, putVerification } from '../src/media-store.mjs';

const NOW = Date.parse('2026-11-23T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const CHUNK = 64 * 1024;

function database() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(statement, ...bindings) {
      const query = db.prepare(statement);
      const args = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const result = query.columns().length ? query.all(...args) : (query.run(...args), []);
      return { toArray: () => result, one: () => { assert.equal(result.length, 1); return result[0]; } };
    },
    transactionSync(callback) {
      db.exec('SAVEPOINT test_media');
      try {
        const result = callback();
        db.exec('RELEASE SAVEPOINT test_media');
        return result;
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT test_media');
        db.exec('RELEASE SAVEPOINT test_media');
        throw error;
      }
    },
  };
  initMedia(sql);
  return { sql, db };
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomGenerator() {
  let seed = 1;
  return length => Uint8Array.from({ length }, (_, index) => (seed + index) % 256).map(value => (value + seed++) % 256);
}

async function store(sql, bytes = Uint8Array.from({ length: CHUNK + 9 }, (_, i) => i % 251), extras = {}) {
  return { bytes, asset: await putMedia(sql, { bytes, sha256: await digest(bytes), contentType: 'video/mp4', now: NOW, randomBytes: randomGenerator(), ...extras }) };
}

function request(asset, options = {}, token = asset.downloadToken) {
  return new Request(`https://example.test${asset.urlPath}${token ? `?t=${token}` : ''}`, options);
}

test('stores actual bytes in 64KiB SQLite chunks and serves their exact content', async () => {
  const { sql } = database();
  const { asset, bytes } = await store(sql);
  assert.match(asset.urlPath, new RegExp(`^/media/[a-f0-9]{32}/${asset.sha256}\\.mp4$`));
  assert.match(asset.downloadToken, /^[a-f0-9]{64}$/);
  assert.equal(asset.size, bytes.length);
  assert.equal(asset.expiresAt, NOW + 48 * HOUR);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_chunks').one().count, 2);
  assert.equal(sql.exec('SELECT length(data) AS size FROM media_chunks WHERE chunk_index = ?', 0).one().size, CHUNK);
  const response = await serveMedia(sql, request(asset), { now: NOW });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const tokenRow = sql.exec('SELECT * FROM media_tokens').one();
  assert.equal(tokenRow.token_hash, await digest(new TextEncoder().encode(asset.downloadToken)));
  assert.ok(!JSON.stringify(tokenRow).includes(asset.downloadToken));
});

test('rejects wrong sha, non-MP4 content, unsupported bytes, empty and oversized media before storage', async () => {
  const { sql } = database();
  const bytes = new Uint8Array([1, 2, 3]);
  const base = { bytes, sha256: await digest(bytes), contentType: 'video/mp4', now: NOW };
  await assert.rejects(putMedia(sql, { ...base, sha256: '0'.repeat(64) }), /sha256/i);
  await assert.rejects(putMedia(sql, { ...base, contentType: 'video/mp4\r\nInjected: yes' }), /contentType/i);
  await assert.rejects(putMedia(sql, { ...base, bytes: [1, 2, 3] }), /bytes/i);
  await assert.rejects(putMedia(sql, { ...base, bytes: new Uint8Array() }), /size/i);
  await assert.rejects(putMedia(sql, { ...base, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), /size/i);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_assets').one().count, 0);
});

test('reuses identical SHA chunks and keeps both separately issued download tokens valid', async () => {
  const { sql } = database();
  const randomBytes = randomGenerator();
  const { asset, bytes } = await store(sql, undefined, { randomBytes });
  const second = await putMedia(sql, { bytes: bytes.buffer, sha256: asset.sha256, contentType: 'video/mp4', now: NOW + HOUR, randomBytes });
  assert.equal(second.urlPath, asset.urlPath);
  assert.notEqual(second.downloadToken, asset.downloadToken);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_assets').one().count, 1);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_chunks').one().count, 2);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_tokens').one().count, 2);
  assert.equal((await serveMedia(sql, request(asset), { now: NOW + 2 * HOUR })).status, 200);
  assert.equal((await serveMedia(sql, request(second), { now: NOW + 2 * HOUR })).status, 200);
});

test('HEAD has matching headers and no body; Range supports bounded, open and suffix spans', async () => {
  const { sql } = database();
  const { asset, bytes } = await store(sql);
  const head = await serveMedia(sql, request(asset, { method: 'HEAD' }), { now: NOW });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    [`bytes=${CHUNK - 2}-${CHUNK + 3}`, CHUNK - 2, CHUNK + 3],
    [`bytes=${CHUNK}-`, CHUNK, bytes.length - 1],
    ['bytes=-4', bytes.length - 4, bytes.length - 1],
    [`bytes=3-${bytes.length + 900}`, 3, bytes.length - 1],
  ]) {
    const response = await serveMedia(sql, request(asset, { headers: { Range: range } }), { now: NOW });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(start, end + 1));
  }
  for (const range of ['bytes=0-1,4-5', 'bytes=-0', `bytes=${bytes.length}-`, 'bytes=9-3', 'items=0-3', 'bytes=-', 'bytes=9007199254740993-']) {
    const response = await serveMedia(sql, request(asset, { headers: { Range: range } }), { now: NOW });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal(response.headers.get('content-length'), '0');
  }
});

test('missing, wrong, duplicate or expired token returns indistinguishable 404', async () => {
  const { sql } = database();
  const { asset } = await store(sql);
  const urls = [request(asset, {}, null), request(asset, {}, 'f'.repeat(64)), new Request(`https://example.test${asset.urlPath}?t=${asset.downloadToken}&t=${asset.downloadToken}`), new Request(`https://example.test${asset.urlPath.replace(asset.sha256, '0'.repeat(64))}?t=${asset.downloadToken}`)];
  for (const req of urls) {
    const response = await serveMedia(sql, req, { now: NOW });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  }
  assert.equal((await serveMedia(sql, request(asset), { now: asset.expiresAt })).status, 404);
  assert.equal(await serveMedia(sql, new Request('https://example.test/health'), { now: NOW }), null);
});

test('download lifetimes are bounded to 24-72 hours and never silently extended', async () => {
  const { sql } = database();
  const { asset, bytes } = await store(sql, undefined, { ttlMs: 24 * HOUR });
  assert.equal(asset.expiresAt, NOW + 24 * HOUR);
  const base = { bytes, sha256: asset.sha256, contentType: 'video/mp4', now: NOW };
  await assert.rejects(putMedia(sql, { ...base, ttlMs: 24 * HOUR - 1 }), /ttl/i);
  await assert.rejects(putMedia(sql, { ...base, ttlMs: 72 * HOUR + 1 }), /ttl/i);
  const max = await putMedia(sql, { ...base, ttlMs: 72 * HOUR });
  assert.equal(max.expiresAt, NOW + 72 * HOUR);
});

test('public verification file preserves exact signature and exact safe basename path', async () => {
  const { sql } = database();
  const signature = 'tiktok=签名\nexact proof\r\n';
  putVerification(sql, { fileName: 'tiktok_proof-ABC123.txt', signature, now: NOW });
  const response = await serveMedia(sql, new Request('https://example.test/media/tiktok_proof-ABC123.txt'), { now: NOW });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('content-length'), String(new TextEncoder().encode(signature).length));
  assert.equal(await response.text(), signature);
  const head = await serveMedia(sql, new Request('https://example.test/media/tiktok_proof-ABC123.txt', { method: 'HEAD' }), { now: NOW });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const fileName of ['../proof.txt', 'proof/test.txt', 'proof\\test.txt', 'test.txt\r\nX: y', '.hidden', '%2e%2e', '']) {
    assert.throws(() => putVerification(sql, { fileName, signature: 'a', now: NOW }), /fileName/i);
  }
  assert.throws(() => putVerification(sql, { fileName: 'good.txt', signature: '中'.repeat(1366), now: NOW }), /signature/i);
  for (const path of ['/media/tiktok_proof-ABC123.txt.txt', '/media/tiktok_proof-ABC123.txt/extra', '/media/%74iktok_proof-ABC123.txt', '/media/..%2Fproof']) {
    assert.equal((await serveMedia(sql, new Request(`https://example.test${path}`), { now: NOW })).status, 404);
  }
});

test('transaction failure after a chunk leaves no partial asset, chunks or token', async () => {
  const { sql } = database();
  let chunks = 0;
  const failingSql = {
    transactionSync: sql.transactionSync,
    exec(statement, ...bindings) {
      if (statement.startsWith('INSERT INTO media_chunks') && ++chunks === 2) throw new Error('injected storage failure');
      return sql.exec(statement, ...bindings);
    },
  };
  await assert.rejects(store(failingSql), /injected storage failure/);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_assets').one().count, 0);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_chunks').one().count, 0);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_tokens').one().count, 0);
  await store(sql);
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_assets').one().count, 1);
});

test('media transaction wrapper nests under a core transaction without committing it', async () => {
  const { sql } = database();
  sql.exec('BEGIN');
  await store(sql);
  sql.exec('ROLLBACK');
  assert.equal(sql.exec('SELECT COUNT(*) AS count FROM media_assets').one().count, 0);
});

test('rejects a SQL interface without the Durable Object transactionSync wrapper', async () => {
  const { sql } = database();
  const unsupported = { exec: sql.exec };
  assert.throws(() => initMedia(unsupported), { name: 'TypeError', message: /transactionSync/ });
  await assert.rejects(store(unsupported), { name: 'TypeError', message: /transactionSync/ });
});
