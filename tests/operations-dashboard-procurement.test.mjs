import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readOperationsDashboard } from '../apps/customer-service/operations-dashboard-data.mjs';

const day = '2026-11-15';
const stockAt = '2026-11-15T00:00:16.852Z';
const queueAt = '2026-11-15T10:07:43.705Z';
const receipt = `outputs/operations-stock-planning/${day}/daily-replenishment-f3f6cb40-268a-4822-9f88-03a205054199.json`;

async function load(t, queue) {
  const root = await mkdtemp(join(tmpdir(), 'operations-dashboard-procurement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return readOperationsDashboard({ root, day, queue });
}

test('procurement timestamp follows the completed stock scan, independent of creative retries', async t => {
  const data = await load(t, {
    updatedAt: queueAt,
    runs: [
      { day, module: 'creative', state: 'retry', updatedAt: queueAt },
      { day, module: 'replenishment', state: 'done', updatedAt: stockAt,
        summary: { day, shopId: '9000000000000000099', writes: 0, observedAt: stockAt, receipt } },
    ],
    tasks: [{ lastDay: day, role: 'procurement', state: 'approval', sourceRef: receipt, updatedAt: stockAt, title: '飞机' }],
  });
  assert.equal(data.procurement.approvalCount, 1);
  assert.deepEqual(data.procurement.source, { path: receipt, observedAt: stockAt });
  assert.deepEqual(data.suggestions[0].source, data.procurement.source);
});

test('a creative-only queue update leaves the procurement count unavailable', async t => {
  const data = await load(t, {
    updatedAt: queueAt,
    runs: [{ day, module: 'creative', state: 'done', updatedAt: queueAt }],
    tasks: [],
  });
  assert.equal(data.procurement, null);
});
