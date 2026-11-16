import { createHash, timingSafeEqual } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shop = Object.freeze({ name: 'example-shop-my', market: 'MY' });
const idPattern = /^[0-9]{14,22}$/u;
const bearerPattern = /^[A-Za-z0-9_.~-]{32,128}$/u;
const imagePattern = /^\/v1\/images\/([a-f0-9]{64})\.(jpg|png|webp)$/u;
const cdnHosts = new Set([
  'p16-oec-va.ibyteimg.com', 'p19-oec-va.ibyteimg.com', 'p16-oec-sg.ibyteimg.com', 'p19-oec-sg.ibyteimg.com',
]);
const imageTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const fileLimit = 8 * 1024 * 1024;
const securityHeaders = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};

const sha256 = input => createHash('sha256').update(input).digest();

function authorizationMatcher(raw) {
  let mapping;
  try {
    mapping = JSON.parse(raw);
  } catch {
    throw new Error('SHOP_AGENT_TOKENS must be a JSON object of distinct agent tokens.');
  }
  const entries = Object.entries(mapping ?? {});
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || entries.length === 0 || entries.length > 32 ||
      entries.some(([name, token]) => !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(name) ||
        typeof token !== 'string' || !bearerPattern.test(token)) || new Set(entries.map(([, token]) => token)).size !== entries.length) {
    throw new Error('SHOP_AGENT_TOKENS must be a JSON object of distinct agent tokens.');
  }
  const allowed = entries.map(([, token]) => sha256(token));
  return header => {
    const token = typeof header === 'string' ? /^Bearer (\S+)$/iu.exec(header)?.[1] : null;
    if (!token || !bearerPattern.test(token)) return false;
    const candidate = sha256(token);
    let matched = 0;
    for (const digest of allowed) matched |= Number(timingSafeEqual(digest, candidate));
    return matched === 1;
  };
}

function snapshotField(value, limit, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Invalid catalogue text');
  return value.trim();
}

function snapshotImage(value, assets) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid catalogue image');
  if (imagePattern.test(value)) {
    assets.add(value);
    return value;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || !cdnHosts.has(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw new Error('Invalid catalogue image');
  }
  return url.href;
}

function catalogueSnapshot(data) {
  const observed = Date.parse(data?.observedAt);
  if (data?.schema !== 'shop-agent-catalogue/v1' || data.shop?.name !== shop.name || data.shop?.market !== shop.market ||
      typeof data.observedAt !== 'string' || !Number.isFinite(observed) || data.observedAt.length > 40 ||
      !Array.isArray(data.products) || data.products.length > 2000) throw new Error('Invalid catalogue snapshot');

  // Rebuild the public representation from the allowlist instead of passing source rows through.
  const assets = new Set();
  const products = new Map();
  for (const row of data.products) {
    if (typeof row?.productId !== 'string' || !idPattern.test(row.productId) || products.has(row.productId) ||
        (row.status != null && row.status !== 'ACTIVATE') || !Array.isArray(row.variants) || row.variants.length > 500) {
      throw new Error('Invalid catalogue product');
    }
    const ids = new Set();
    const variants = row.variants.map(variant => {
      if (typeof variant?.skuId !== 'string' || !idPattern.test(variant.skuId) || ids.has(variant.skuId)) {
        throw new Error('Invalid catalogue SKU');
      }
      ids.add(variant.skuId);
      return { skuId: variant.skuId, sellerSku: snapshotField(variant.sellerSku, 200, true),
        imageUrl: snapshotImage(variant.imageUrl, assets) };
    });
    const product = { productId: row.productId, title: snapshotField(row.title, 600),
      imageUrl: snapshotImage(row.imageUrl, assets), variants };
    const searchable = [product.productId, product.title, ...variants.flatMap(sku => [sku.skuId, sku.sellerSku])]
      .filter(Boolean).map(normalizeSearch);
    products.set(product.productId, { product, searchable });
  }
  return { observedAt: new Date(observed).toISOString(), products, assets };
}

async function readBounded(file) {
  const descriptor = await open(file, 'r');
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size === 0 || info.size > fileLimit) throw new Error('Invalid file size');
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await descriptor.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('File changed while reading');
    return bytes.subarray(0, offset);
  } finally {
    await descriptor.close();
  }
}

function catalogueReader(file) {
  let cached;
  return async () => {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > fileLimit) throw new Error('Invalid catalogue file');
    const stamp = [info.dev, info.ino, info.mtimeMs, info.ctimeMs, info.size].join('/');
    if (cached?.stamp === stamp) return cached.value;
    const value = readBounded(file).then(bytes => catalogueSnapshot(JSON.parse(bytes.toString('utf8'))));
    cached = { stamp, value };
    try {
      return await value;
    } catch (error) {
      if (cached?.value === value) cached = null;
      throw error;
    }
  };
}

function imageSignatureMatches(bytes, extension) {
  if (extension === 'jpg') return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (extension === 'png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function referencedImage(catalogueFile, match) {
  const [, hash, extension] = match;
  const name = hash + '.' + extension;
  const expectedFolder = join(await realpath(dirname(catalogueFile)), 'images');
  const folder = await realpath(expectedFolder);
  if (relative(expectedFolder, folder) !== '') return null;
  const file = await realpath(join(folder, name));
  if (relative(folder, file) !== name) return null;
  const bytes = await readBounded(file);
  return imageSignatureMatches(bytes, extension) && sha256(bytes).toString('hex') === hash ? bytes : null;
}

function json(response, code, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(code, { ...securityHeaders, ...headers, 'content-type': 'application/json; charset=utf-8',
    'content-length': data.length });
  response.end(data);
}

function normalizeSearch(value) {
  return value.normalize('NFKC').toLowerCase().replace(/(?<=[a-z0-9])[-‐‑–](?=[a-z0-9])/gu, '');
}

function search(snapshot, params) {
  const query = params.get('q') ?? '';
  const rawLimit = params.get('limit') ?? '20';
  const limit = Number(rawLimit);
  if (query.length > 120 || !/^\d{1,3}$/u.test(rawLimit) || limit < 1 || limit > 100 ||
      [...params.keys()].some(name => !['q', 'limit'].includes(name) || params.getAll(name).length !== 1)) return null;

  const terms = normalizeSearch(query).trim().split(/\s+/u).filter(Boolean);
  if (terms.length > 12) return null;
  const matches = [];
  for (const { product, searchable } of snapshot.products.values()) {
    if (terms.every(term => searchable.some(value => value.includes(term)))) matches.push(product);
    if (matches.length > limit) break;
  }
  return { count: Math.min(matches.length, limit), hasMore: matches.length > limit, products: matches.slice(0, limit) };
}

export function createShopAgentServer({ cataloguePath = process.env.SHOP_AGENT_CATALOGUE, tokens = process.env.SHOP_AGENT_TOKENS } = {}) {
  if (typeof cataloguePath !== 'string' || !cataloguePath.trim()) throw new Error('SHOP_AGENT_CATALOGUE must name the snapshot file.');
  const file = resolve(cataloguePath);
  const authorized = authorizationMatcher(tokens);
  const load = catalogueReader(file);

  async function handle(request, response) {
    const target = request.url;
    if (!target?.startsWith('/') || target.startsWith('//') || target.length > 2048 || target.includes('\\')) {
      return json(response, 400, { error: 'invalid_request' });
    }
    const url = new URL(target, 'http://127.0.0.1');
    const { pathname, searchParams } = url;
    const detail = /^\/v1\/products\/([0-9]{14,22})$/u.exec(pathname);
    const image = imagePattern.exec(pathname);
    const listing = pathname === '/v1/products';
    const health = pathname === '/healthz';
    if (!listing && !detail && !image && !health) return json(response, 404, { error: 'not_found' });
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    if (!health && !authorized(request.headers.authorization)) {
      return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }
    if (!listing && url.search) return json(response, 400, { error: 'invalid_query' });

    const snapshot = await load().catch(() => null);
    if (health) return json(response, snapshot ? 200 : 503, { status: snapshot ? 'ok' : 'unavailable' });
    if (!snapshot) return json(response, 503, { error: 'catalogue_unavailable' });

    if (image) {
      if (!snapshot.assets.has(pathname)) return json(response, 404, { error: 'not_found' });
      const bytes = await referencedImage(file, image).catch(() => null);
      if (!bytes) return json(response, 404, { error: 'not_found' });
      response.writeHead(200, { ...securityHeaders, 'content-type': imageTypes[image[2]], 'content-length': bytes.length });
      response.end(bytes);
      return;
    }
    const base = { shop, observedAt: snapshot.observedAt };
    if (detail) {
      const row = snapshot.products.get(detail[1]);
      return row ? json(response, 200, { ...base, product: row.product }) : json(response, 404, { error: 'not_found' });
    }
    const results = search(snapshot, searchParams);
    return results ? json(response, 200, { ...base, ...results }) : json(response, 400, { error: 'invalid_query' });
  }

  return createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: 'internal_error' });
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.SHOP_AGENT_PORT ?? '8730');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SHOP_AGENT_PORT must be a valid port.');
  const server = createShopAgentServer();
  server.listen(port, '127.0.0.1', () => console.log(`Shop agent reader listening on 127.0.0.1:${port}`));
}
