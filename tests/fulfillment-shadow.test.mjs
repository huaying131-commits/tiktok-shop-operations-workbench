import assert from 'node:assert/strict';
import test from 'node:test';
import { planOverseas, readPlan } from '../scripts/operations/run-fulfillment-shadow.mjs';

const sku = { productId: '9000000000000000016', skuId: '9000000000000000027', quantity: 1 };
const row = { orderId: '900000000000000028', packages: ['9000000000000000009'], route: 'malaysia_overseas', skus: [sku] };
const activity = { activeOverseas: [], activeDomestic: [], complete: true };
const inventory = (warehouseId, goodsSkuId, availableStockNum) => ({
  warehouseId, sources: [], rows: new Map([[goodsSkuId, { goodsSkuOuterId: 'F/A-18', availableStockNum }]]),
});
const inventories = [inventory('148', '9000000000000000069', 1), inventory('80', '9000000000000000068', 63)];
const key = warehouseId => `${sku.productId}/${sku.skuId}/${warehouseId}`;
const bindings = new Map(inventories.map(({ warehouseId, rows }) => [
  key(warehouseId), { goodsSkuId: [...rows.keys()][0], goodsSkuOuterId: 'F/A-18' },
]));

test('uses the exact confirmed physical shortage without discarding the warehouse API response', () => {
  const confirmation = { confirmedAt: '2026-11-14T11:28:00+08:00', source: 'user_confirmed_out_of_stock' };
  const unavailable = new Map([[key('148'), confirmation]]);
  const plan = planOverseas(row, activity, inventories, bindings, unavailable);
  assert.equal(plan.warehouseId, '80');
  assert.equal(plan.bothEligible, false);
  assert.equal(plan.warehouses[0].goods[0].available, 0);
  assert.equal(plan.warehouses[0].goods[0].apiAvailable, 1);
  assert.deepEqual(plan.warehouses[0].goods[0].stockConfirmation, confirmation);

  assert.equal(planOverseas(row, activity, inventories, bindings, new Map()).warehouseId, '148');
  const otherRow = { ...row, skus: [{ ...sku, skuId: '9000000000000000020' }] };
  assert.equal(planOverseas(otherRow, activity, inventories, bindings, unavailable).warehouseId, null);
  assert.equal(planOverseas(row, { ...activity, complete: false }, inventories, bindings, unavailable).warehouseId, null);
  assert.equal(planOverseas(row, { ...activity, activeOverseas: [{ orderId: '7777777777', warehouseId: '148' }] },
    inventories, bindings, unavailable).warehouseId, null);
});

test('pending orders use the current run and dispatched orders use the latest pre-dispatch plan', () => {
  const before = { row, observedAt: '2026-11-14T00:00:00Z' };
  const make = (date, routingSource, warehouseId) => ({
    file: routingSource + '-plan',
    data: { schema: 'operations-shadow-overseas-plan/v1', observedAt: date, routingSource, writes: 0,
      rows: [{ orderId: row.orderId, packageId: row.packages[0], warehouseId, warehouses: [] }] },
  });
  const receipts = [
    make('2026-11-14T00:05:00Z', 'older-routing', '148'),
    make('2026-11-14T00:15:00Z', 'new-routing', '80'),
    make('2026-11-14T00:25:00Z', 'incomplete-routing', null),
  ];
  assert.equal(readPlan(receipts, before, 'new-routing').warehouseId, '80');
  assert.equal(readPlan(receipts, before, 'incomplete-routing').warehouseId, null);
  assert.equal(readPlan(receipts, before, 'missing-routing'), null);
  assert.equal(readPlan(receipts, { ...before, firstAfter: '2026-11-14T00:20:00Z' }).warehouseId, '80');
  assert.equal(readPlan(receipts, { ...before, firstAfter: '2026-11-14T00:10:00Z' }).warehouseId, '148');
});
