import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShopAgentServer } from './server.mjs';

test('the agent API authenticates each agent and only serves the snapshot fields and referenced images', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shop-agent-api-'));
  const imageDir = join(dir, 'images');
  const snapshot = join(dir, 'catalogue.json');
  await mkdir(imageDir);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YoAAAAASUVORK5CYII=', 'base64');
  const filename = bytes => createHash('sha256').update(bytes).digest('hex') + '.png';
  const image = '/v1/images/' + filename(png);
  const missing = Buffer.concat([png, Buffer.from('fixture')]);
  t.after(async () => {
    await Promise.all([snapshot, join(imageDir, filename(png)), join(imageDir, filename(missing))]
      .map(path => rm(path, { force: true })));
    await rmdir(imageDir);
    await rmdir(dir);
  });
  await writeFile(join(imageDir, filename(png)), png);
  await writeFile(join(imageDir, filename(missing)), missing);

  const productId = '9000000000000000016';
  const source = {
    schema: 'shop-agent-catalogue/v1', shop: { name: 'example-shop-my', market: 'MY', shopCipher: 'private' },
    observedAt: '2026-01-01T00:00:00Z', inputPath: 'private',
    products: [
      { productId, title: 'Model Plane', imageUrl: image, status: 'ACTIVATE', cost: 'private',
        variants: [{ skuId: '9000000000000000027', sellerSku: 'F-18F', imageUrl: image, internalStock: 55 }] },
      { productId: '9000000000000000017', title: 'Blue wagon', imageUrl: null, variants: [] },
    ],
  };
  await writeFile(snapshot, JSON.stringify(source));
  const muse = randomBytes(32).toString('hex');
  const grok = randomBytes(32).toString('hex');
  assert.throws(() => createShopAgentServer({ cataloguePath: snapshot, tokens: JSON.stringify({ muse, grok: muse }) }));
  const server = createShopAgentServer({ cataloguePath: snapshot, tokens: JSON.stringify({ muse, grok }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, token, method = 'GET') => fetch(base + path, {
    method, headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });

  assert.deepEqual(await (await req('/healthz')).json(), { status: 'ok' });
  assert.equal((await req('/v1/products')).status, 401);
  assert.equal((await req('/v1/products', 'invalid')).status, 401);
  assert.equal((await req('/v1/products?limit=999', muse)).status, 400);
  assert.equal((await req('/v1/products?limit=1&limit=2', muse)).status, 400);
  assert.equal((await req(`/v1/products/${productId}`, muse, 'POST')).status, 405);
  assert.equal((await req('/api/operations/tasks', muse)).status, 404);

  const detail = await req(`/v1/products/${productId}`, grok);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('access-control-allow-origin'), null);
  const detailData = await detail.json();
  assert.deepEqual(detailData, {
    shop: { name: 'example-shop-my', market: 'MY' }, observedAt: '2026-01-01T00:00:00.000Z',
    product: { productId, title: 'Model Plane', imageUrl: image,
      variants: [{ skuId: '9000000000000000027', sellerSku: 'F-18F', imageUrl: image }] },
  });
  const hit = await (await req('/v1/products?q=model%20f-18f', muse)).json();
  assert.equal(hit.products[0].productId, productId);
  const unhyphenated = await (await req('/v1/products?q=f18f', muse)).json();
  assert.equal(unhyphenated.products[0]?.productId, productId);
  assert.equal((await (await req('/v1/products?limit=1', muse)).json()).hasMore, true);

  assert.equal((await req(image)).status, 401);
  const downloaded = await req(image, muse);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await req('/v1/images/' + filename(missing), muse)).status, 404);
  await writeFile(join(imageDir, filename(png)), missing);
  assert.equal((await req(image, muse)).status, 404);

  source.products[0].status = 'DEACTIVATED';
  await writeFile(snapshot, JSON.stringify(source));
  assert.equal((await req('/v1/products', muse)).status, 503);
});
