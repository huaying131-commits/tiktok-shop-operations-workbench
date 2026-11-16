import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeRoleDelivery, readDailyRoleQueue, reserveRoleDeliveries, runDailyRoleQueue } from '../scripts/operations/daily-role-queue.mjs';

const day = '2026-11-14';
const morning = new Date('2026-11-14T01:30:00Z');
const later = new Date('2026-11-14T01:45:00Z');
const sample = (key, role, amount) => ({ tasks: [{ key, role, title: key, detail: `数量 ${amount}`, priority: 'normal' }],
  summary: { amount }, sources: [] });

test('a failed module resumes after restart without rerunning or duplicating the successful module', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-role-queue-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let creativeCalls = 0;
  let stockCalls = 0;
  const collectors = {
    replenishment: async () => {
      stockCalls++;
      if (stockCalls === 1) throw new Error('offline with private URL');
      return sample('su27', 'procurement', 2);
    },
    creative: async () => {
      creativeCalls++;
      return sample('creative-a', 'video-production', 1);
    },
  };

  assert.deepEqual(readDailyRoleQueue({ dataDir }), { updatedAt: null, runs: [], tasks: [] });
  const first = await runDailyRoleQueue({ dataDir, collectors, now: morning });
  assert.equal(first.day, day);
  assert.equal(first.runs.find(run => run.module === 'replenishment').state, 'retry');
  assert.equal(first.runs.find(run => run.module === 'creative').state, 'done');
  assert.doesNotMatch(JSON.stringify(first), /private URL/);
  await runDailyRoleQueue({ dataDir, collectors, now: morning });
  assert.deepEqual([stockCalls, creativeCalls], [1, 1]);

  await runDailyRoleQueue({ dataDir, collectors, now: later });
  await runDailyRoleQueue({ dataDir, collectors, now: later });
  assert.deepEqual([stockCalls, creativeCalls], [2, 1]);
  const queue = readDailyRoleQueue({ dataDir });
  assert.equal(queue.tasks.length, 2);
  assert.equal(queue.runs.find(run => run.module === 'replenishment').attempts, 2);
  assert.deepEqual(readDailyRoleQueue({ dataDir, role: 'procurement' }).tasks.map(task => task.key), ['su27']);

  await runDailyRoleQueue({ dataDir, collectors: { ...collectors, replenishment: async () => ({ tasks: [], summary: {}, sources: [] }) },
    now: new Date('2026-11-15T01:45:00Z') });
  const next = readDailyRoleQueue({ dataDir });
  assert.equal(next.tasks.filter(task => task.key === 'creative-a').length, 1);
  assert.equal(next.tasks.find(task => task.key === 'su27').state, 'superseded');
});

test('concurrent ticks share the lease and one suspended process cannot dispatch twice', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'daily-role-queue-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let calls = 0;
  let started;
  let release;
  const collected = new Promise(resolve => { started = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const collectors = { replenishment: async () => {
    calls++;
    started();
    await resume;
    return sample('su27', 'procurement', 2);
  } };
  const first = runDailyRoleQueue({ dataDir, collectors, now: morning });
  await collected;
  await runDailyRoleQueue({ dataDir, collectors, now: morning });
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(readDailyRoleQueue({ dataDir }).tasks.length, 1);
  const deliveries = reserveRoleDeliveries({ dataDir, role: 'procurement' });
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].tasks.map(task => task.key), ['su27']);
  assert.deepEqual(reserveRoleDeliveries({ dataDir }), []);
  assert.equal(closeRoleDelivery(deliveries[0].id, 'unknown', dataDir), 1);
  assert.deepEqual(reserveRoleDeliveries({ dataDir }), []);
});
