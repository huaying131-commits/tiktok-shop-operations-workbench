const CHUNK_SIZE = 64 * 1024;
const MAX_MEDIA_SIZE = 20 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const encoder = new TextEncoder();
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function rows(sql, statement, ...bindings) {
  return sql.exec(statement, ...bindings).toArray();
}

function timestamp(now) {
  const value = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must be an epoch millisecond timestamp');
  return value;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function requireTransactions(sql) {
  if (typeof sql?.transactionSync !== 'function') throw new TypeError('media storage requires sql.transactionSync');
}

export function initMedia(sql) {
  requireTransactions(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_assets (
    asset_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 20971520),
    chunk_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_chunks (
    asset_id TEXT NOT NULL REFERENCES media_assets(asset_id),
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (asset_id, chunk_index)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_tokens (
    token_hash TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES media_assets(asset_id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_verifications (
    file_name TEXT PRIMARY KEY,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

export async function putMedia(sql, { sha256, bytes, contentType, now, randomBytes, ttlMs = 48 * HOUR }) {
  requireTransactions(sql);
  if (typeof sha256 !== 'string' || !SHA_PATTERN.test(sha256)) throw new TypeError('sha256 must be lowercase hexadecimal');
  if (contentType !== 'video/mp4') throw new TypeError('contentType must be video/mp4');
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new TypeError('bytes must be a Uint8Array or ArrayBuffer');
  const length = bytes.byteLength;
  if (length < 1 || length > MAX_MEDIA_SIZE) throw new RangeError('media size must be 1 byte to 20 MiB');
  const createdAt = timestamp(now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 24 * HOUR || ttlMs > 72 * HOUR) throw new RangeError('ttlMs must be 24 to 72 hours');
  const expiresAt = createdAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError('media expiry is outside the timestamp range');
  // Own the input so a caller cannot mutate bytes after SHA verification.
  const ownedBytes = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes.slice(0));
  if (await hash(ownedBytes) !== sha256) throw new TypeError('sha256 does not match the media bytes');
  const generate = randomBytes ?? (size => crypto.getRandomValues(new Uint8Array(size)));
  const random = async size => {
    const value = await generate(size);
    if (!(value instanceof Uint8Array) || value.byteLength !== size) throw new TypeError('randomBytes must return exactly the requested bytes');
    return new Uint8Array(value);
  };
  const newAssetId = hex(await random(16));
  const downloadToken = hex(await random(32));
  const tokenHash = await hash(encoder.encode(downloadToken));

  // There are no awaits inside the transaction. An asset and all its chunks
  // become visible together, while a duplicate SHA only gains a new token.
  const asset = sql.transactionSync(() => {
    let stored = rows(sql, 'SELECT asset_id, size, content_type FROM media_assets WHERE sha256 = ?', sha256)[0];
    if (!stored) {
      const chunkCount = Math.ceil(length / CHUNK_SIZE);
      sql.exec('INSERT INTO media_assets (asset_id, sha256, content_type, size, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?)', newAssetId, sha256, contentType, length, chunkCount, createdAt);
      for (let index = 0; index < chunkCount; index++) {
        const chunk = ownedBytes.slice(index * CHUNK_SIZE, Math.min(length, (index + 1) * CHUNK_SIZE));
        sql.exec('INSERT INTO media_chunks (asset_id, chunk_index, data) VALUES (?, ?, ?)', newAssetId, index, chunk.buffer);
      }
      stored = { asset_id: newAssetId, size: length, content_type: contentType };
    } else if (stored.size !== length || stored.content_type !== contentType) {
      throw new Error('stored media metadata does not match verified bytes');
    }
    sql.exec('INSERT INTO media_tokens (token_hash, asset_id, expires_at, created_at) VALUES (?, ?, ?, ?)', tokenHash, stored.asset_id, expiresAt, createdAt);
    return stored;
  });
  return { sha256, urlPath: `/media/${asset.asset_id}/${sha256}.mp4`, downloadToken, size: asset.size, expiresAt };
}

export function putVerification(sql, { fileName, signature, now }) {
  if (typeof fileName !== 'string' || !FILE_PATTERN.test(fileName)) throw new TypeError('fileName must be a safe basename');
  if (typeof signature !== 'string' || encoder.encode(signature).byteLength < 1 || encoder.encode(signature).byteLength > 4096) throw new TypeError('signature must be 1 to 4096 UTF-8 bytes');
  const createdAt = timestamp(now);
  sql.exec('INSERT INTO media_verifications (file_name, signature, created_at) VALUES (?, ?, ?) ON CONFLICT(file_name) DO UPDATE SET signature = excluded.signature, created_at = excluded.created_at', fileName, signature, createdAt);
}

function headers(contentType, length) {
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
}

function notFound(method) {
  const body = 'Not found';
  return new Response(method === 'HEAD' ? null : body, { status: 404, headers: headers('text/plain; charset=utf-8', encoder.encode(body).length) });
}

function rangeBounds(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) {
    if (last <= 0) return null;
    return { start: Math.max(0, size - last), end: size - 1, partial: true };
  }
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1), partial: true };
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error('stored chunk is not binary');
}

export async function serveMedia(sql, request, { now }) {
  const url = new URL(request.url);
  if (url.pathname !== '/media' && !url.pathname.startsWith('/media/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(request.method);
  const verification = /^\/media\/([A-Za-z0-9][A-Za-z0-9_.-]{0,199})$/.exec(url.pathname);
  if (verification) {
    const file = rows(sql, 'SELECT signature FROM media_verifications WHERE file_name = ?', verification[1])[0];
    if (!file) return notFound(request.method);
    const body = encoder.encode(file.signature);
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: headers('text/plain; charset=utf-8', body.length) });
  }
  const media = /^\/media\/([a-f0-9]{32})\/([a-f0-9]{64})\.mp4$/.exec(url.pathname);
  const tokens = url.searchParams.getAll('t');
  if (!media || tokens.length !== 1 || !SHA_PATTERN.test(tokens[0])) return notFound(request.method);
  const tokenHash = await hash(encoder.encode(tokens[0]));
  const asset = rows(sql, `SELECT a.asset_id, a.size, a.content_type, a.chunk_count
    FROM media_assets a JOIN media_tokens t ON t.asset_id = a.asset_id
    WHERE a.asset_id = ? AND a.sha256 = ? AND t.token_hash = ? AND t.expires_at > ?`, media[1], media[2], tokenHash, timestamp(now))[0];
  if (!asset) return notFound(request.method);
  const bounds = rangeBounds(request.headers.get('range'), asset.size);
  const responseHeaders = headers(asset.content_type, bounds ? bounds.end - bounds.start + 1 : 0);
  responseHeaders.set('Accept-Ranges', 'bytes');
  if (!bounds) {
    responseHeaders.set('Content-Range', `bytes */${asset.size}`);
    return new Response(null, { status: 416, headers: responseHeaders });
  }
  if (bounds.partial) responseHeaders.set('Content-Range', `bytes ${bounds.start}-${bounds.end}/${asset.size}`);
  const status = bounds.partial ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers: responseHeaders });
  const firstChunk = Math.floor(bounds.start / CHUNK_SIZE);
  const lastChunk = Math.floor(bounds.end / CHUNK_SIZE);
  const chunks = rows(sql, 'SELECT chunk_index, data FROM media_chunks WHERE asset_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index', asset.asset_id, firstChunk, lastChunk);
  if (chunks.length !== lastChunk - firstChunk + 1) return notFound(request.method);
  const body = new Uint8Array(bounds.end - bounds.start + 1);
  let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const expectedIndex = firstChunk + index;
    const data = asBytes(chunk.data);
    const expectedSize = Math.min(CHUNK_SIZE, asset.size - expectedIndex * CHUNK_SIZE);
    if (chunk.chunk_index !== expectedIndex || data.byteLength !== expectedSize) return notFound(request.method);
    const start = Math.max(0, bounds.start - expectedIndex * CHUNK_SIZE);
    const end = Math.min(data.byteLength, bounds.end - expectedIndex * CHUNK_SIZE + 1);
    body.set(data.subarray(start, end), offset);
    offset += end - start;
  }
  return new Response(body, { status, headers: responseHeaders });
}
