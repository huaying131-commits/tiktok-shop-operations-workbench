import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const f14 = { productId: '9000000000000000016', skuId: '9000000000000000020' };
const imagePath = '/api/operations/dashboard/images/9000000000000000016/9000000000000000020';

test('only the exact product and SKU pair resolves to a verified JPEG', async () => {
  const { dashboardImageUrl, getDashboardImage, isDashboardImagePath } = await import('../apps/customer-service/operations-dashboard-images.mjs');
  assert.equal(dashboardImageUrl(f14), imagePath);
  assert.equal(dashboardImageUrl({ ...f14, productId: '9000000000000000044' }), null);
  assert.equal(dashboardImageUrl({ skuId: f14.skuId }), null);
  assert.equal(isDashboardImagePath('/api/operations/dashboard/images/'), true);
  assert.equal(isDashboardImagePath('/api/operations/dashboard/images-extra/'), false);
  for (const invalidPath of [imagePath + '/', imagePath + '.jpg', imagePath + '?size=2', imagePath.replace(f14.skuId, '%2E%2E')]) {
    assert.equal(await getDashboardImage(invalidPath), null);
  }
  const result = await getDashboardImage(imagePath);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.bytes.length, 70072);
});

test('missing files and workspace junctions leading outside the root yield no image', async () => {
  const { getDashboardImage } = await import('../apps/customer-service/operations-dashboard-images.mjs');
  const isolated = await mkdtemp(join(tmpdir(), 'operations-dashboard-image-'));
  const folder = 'outputs/video-production/2026-10-27/inventory-clearance-intake/product-sources';
  try {
    assert.equal(await getDashboardImage(imagePath, { workspaceRoot: isolated }), null);
    const junction = join(isolated, folder);
    await mkdir(dirname(junction), { recursive: true });
    await symlink(join(workspace, folder), junction, 'junction');
    assert.equal(await getDashboardImage(imagePath, { workspaceRoot: isolated }), null);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test('parent cover serves only the first official image with the exact product identity and digest', async () => {
  const { dashboardProductCoverUrl, getDashboardImage } = await import('../apps/customer-service/operations-dashboard-images.mjs');
  const isolated = await mkdtemp(join(tmpdir(), 'operations-dashboard-cover-'));
  const route = '/api/operations/dashboard/images/' + f14.productId + '/cover';
  const folder = join(isolated, 'outputs', 'operations-dashboard-product-covers', f14.productId);
  const filename = '2026-11-14T11-00-00-000Z-22f51ba7-571b-41ea-bbed-e415a0cbfd0a.image';
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);
  const receipt = {
    schema: 'operations-dashboard-product-cover/v1', productId: f14.productId, writes: 0,
    shop: { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' }, observedAt: '2026-11-14T11:00:00.000Z',
    requestId: '20261114110000F111E001', image: { position: 0, kind: 'product_main_image', filename, size: bytes.length,
      host: 'p16-oec-sg.ibyteimg.com', contentType: 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, filename), bytes);
    const manifest = join(folder, 'latest.json');
    await writeFile(manifest, JSON.stringify(receipt));
    assert.equal(await dashboardProductCoverUrl({ productId: f14.productId, workspaceRoot: isolated }), route);
    assert.deepEqual(await getDashboardImage(route, { workspaceRoot: isolated }), { bytes, contentType: 'image/jpeg' });
    await writeFile(manifest, JSON.stringify({ ...receipt, productId: f14.skuId }));
    assert.equal(await getDashboardImage(route, { workspaceRoot: isolated }), null);
    await writeFile(manifest, JSON.stringify(receipt));
    await writeFile(join(folder, filename), Buffer.from([0xff, 0xd8, 0xff, 0xcc, 0xff, 0xd9]));
    assert.equal(await getDashboardImage(route, { workspaceRoot: isolated }), null);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
