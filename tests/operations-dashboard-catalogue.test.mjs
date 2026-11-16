import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDashboardCatalogue } from '../apps/customer-service/operations-dashboard-catalogue.mjs';

const day = '2026-11-15';
const shop = { id: '9000000000000000099', region: 'MY', name: 'example-shop-my' };
const makeSnapshot = (collectedAt, title) => ({
  shop, collectedAt, source: 'TikTok Shop Open API',
  products: { pages: 1, totalCount: 1, rows: [{ id: '9000000000000000016', title, status: 'ACTIVATE' }] },
});

test('same catalogue snapshots reuse their projection and newer receipts take effect immediately', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-dashboard-catalogue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'apps/customer-service/data/tiktok-shop', shop.id);
  await mkdir(directory, { recursive: true });
  const save = (stamp, snapshot) => writeFile(join(directory, `${stamp}-11111111-2222-3333-4444-555555555555.json`), JSON.stringify(snapshot));
  await save('20261115T010000000Z', makeSnapshot('2026-11-15T01:00:00Z', '早批'));
  const first = await readDashboardCatalogue({ day, root });
  assert.equal(first.rows[0].title, '早批');
  assert.equal(first.activeProducts, 1);
  assert.equal(first.productsTotal, 1);
  assert.strictEqual(await readDashboardCatalogue({ day, root }), first);
  await save('20261115T020000000Z', makeSnapshot('2026-11-15T02:00:00Z', '新分页'));
  const newer = await readDashboardCatalogue({ day, root });
  assert.equal(newer.rows[0].title, '新分页');
  assert.equal(newer.rowsSource.observedAt, '2026-11-15T02:00:00Z');
  const synced = makeSnapshot('2026-11-15T02:30:00Z', '调度更新');
  const latest = await readDashboardCatalogue({ day, root, synced });
  assert.equal(latest.rows[0].title, '调度更新');
  assert.strictEqual(await readDashboardCatalogue({ day, root, synced }), latest);
});
