import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFulfillment, projectPublishing } from '../apps/customer-service/operations-activity.mjs';

const order = { orderId: '900000000000000004', status: 'AWAITING_COLLECTION', route: 'malaysia_overseas',
  packages: ['9000000000000000001'], identityVerified: true, serviceMatches: true, packageLineIdentityVerified: true,
  skus: [{ skuId: '9000000000000000014', productId: '9000000000000000015', quantity: 1 }], address: 'private' };
const routing = { file: 'official-read.json', data: { observedAt: '2026-11-14T04:00:00Z', rows: [order] } };
const shadowRow = { orderId: order.orderId, packageId: order.packages[0], route: order.route, currentStatus: order.status,
  comparison: { observedWarehouse: '80', originalPackageMatch: true, platformRouteMatch: true,
    warehouseReadComplete: true, duplicateAcrossWarehouses: false, warehouseOnWrongRoute: false } };

test('fulfillment counts once, separates awaiting carrier, and does not expose addresses', () => {
  const result = projectFulfillment({ routing, shadow: { file: 'shadow-run.json', data: { rows: [shadowRow] } },
    now: new Date('2026-11-14T04:20:00Z'), day: '2026-11-14' });
  assert.equal(result.pendingShipment, 0);
  assert.equal(result.awaitingCollection, 1);
  const warehouse = result.warehouses.find(item => item.warehouseId === '80');
  assert.equal(warehouse.count, 1);
  assert.equal(warehouse.orders[0].orderId, order.orderId);
  assert.equal(warehouse.orders[0].statusCode, 'AWAITING_COLLECTION');
  assert.equal(Object.hasOwn(warehouse.orders[0], 'address'), false);
});

test('conflicting warehouse evidence stays unassigned and stale snapshots keep observed rows without current counts', () => {
  const result = projectFulfillment({ routing, shadow: { file: 'shadow-run.json', data: { rows: [{ ...shadowRow,
    comparison: { ...shadowRow.comparison, duplicateAcrossWarehouses: true } }] } },
  now: new Date('2026-11-14T13:00:00Z'), day: '2026-11-14' });
  assert.equal(result.status, 'stale');
  assert.equal(result.count, null);
  assert.equal(result.warehouses.find(item => item.warehouseId === 'unassigned').orders.length, 1);
});

test('publishing deduplicates platform IDs, observes MY day boundaries, and retains unresolved independent confirmations', () => {
  const accounts = [{ accountId: 'example-creator-1', name: '主账号' }, { accountId: 'example-creator-5', name: 'Baikyunee' }];
  const row = { videoId: '9000000000000000121', accountId: 'example-creator-1', publishedAt: '2026-11-13T16:00:00Z', source: 'official.json' };
  const candidate = { jobId: 'job', accountId: 'example-creator-5', productId: '9000000000000000015',
    publishedAt: '2026-11-13T16:01:01Z', observedAt: '2026-11-13T16:01:01Z', source: 'proof.json' };
  const result = projectPublishing({ day: '2026-11-14', accounts, content: [row, row,
    { ...row, videoId: '9000000000000000122', publishedAt: '2026-11-13T15:59:59Z' }], local: [candidate, candidate], coverage: [] });
  assert.equal(result.count, 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.accounts[0].videos.length, 1);
  assert.equal(result.accounts[1].count, null);
  assert.equal(result.accounts[1].pending[0].jobId, 'job');
});
