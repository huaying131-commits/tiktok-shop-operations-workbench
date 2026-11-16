import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readOperationsDashboard } from '../apps/customer-service/operations-dashboard-data.mjs';

const day = '2026-11-15';
const advertiser = '9000000000000000096';
const observedAt = '2026-11-15T09:29:00Z';
const receipt = {
  schema: 'operations-gmv-max-read/v1', observedAt,
  shop: { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId: advertiser },
  account: { advertiser_id: advertiser, currency: 'USD', timezone: 'Asia/Kuala_Lumpur' },
};

function report(requestId, dates, pageCount = 1) {
  const total_metrics = { cost: '4.54', gross_revenue: '42.90', roi: '9.45', orders: '8' };
  const list = dates.map(date => ({ dimensions: { advertiser_id: advertiser, stat_time_day: `${date} 00:00:00` }, metrics: total_metrics }));
  return { code: 0, request_id: requestId, data: { total_metrics, list, page_info: { page: 1, total_page: pageCount, total_number: list.length } } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-ads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, save: async (file, value) => {
    const path = join(root, 'outputs/ads-monitoring', day, 'live-read-validation', file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  } };
}

test('uses the newest valid same-day totals, preserves campaign evidence, and labels the platform attribution', async t => {
  const { root, save } = await fixture(t);
  await save('official-gmv-max-dashboard-1.json', {
    ...receipt, inProgressDay: { day, report: report('today-verified', [day]) },
    completeDays: { start: '2026-11-08', end: '2026-11-14', accountByDay: report('week-verified', ['2026-11-14']) },
  });
  await save('official-gmv-max-dashboard-2.json', {
    ...receipt, observedAt: '2026-11-15T09:30:00Z', inProgressDay: { day, report: report('today-incomplete', [day], 2) },
  });
  await save('official-gmv-max-details.json', {
    ...receipt, observedAt: '2026-11-15T01:00:00Z',
    campaignDetails: [{ id: '9000000000000004', requestId: 'campaign', name: 'MY Product Campaign', status: 'ENABLE' }],
  });
  const { ads } = await readOperationsDashboard({ root, day });
  assert.equal(ads.inProgress.requestId, 'today-verified');
  assert.equal(ads.inProgress.source.observedAt, observedAt);
  assert.equal(ads.inProgress.spend, '4.54');
  assert.equal(ads.inProgress.roi, '9.45');
  assert.equal(ads.inProgress.attribution, 'platform_may_include_organic');
  assert.equal(ads.complete.requestId, 'week-verified');
  assert.equal(ads.campaigns[0].id, '9000000000000004');
});

test('keeps previous-day figures and partial windows out of the Today and seven-day views', async t => {
  const { root, save } = await fixture(t);
  await save('official-gmv-max-previous.json', {
    ...receipt, inProgressDay: { day: '2026-11-14', report: report('previous', ['2026-11-14']) },
    completeDays: { start: '2026-11-08', end: '2026-11-12', accountByDay: report('five-days', ['2026-11-12']) },
  });
  const { ads } = await readOperationsDashboard({ root, day });
  assert.equal(ads.inProgress, null);
  assert.equal(ads.complete, null);
  assert.equal(ads.missingReason.today, 'official_report_unavailable');
  assert.equal(ads.missingReason.week, 'complete_seven_day_report_unavailable');
});

test('refresh uses the verified receipt timestamp and observes the Malaysia reporting hours', async t => {
  const { refreshDashboardAdvertising } = await import('../apps/customer-service/operations-dashboard-ads.mjs');
  const { root, save } = await fixture(t);
  await save('official-gmv-max-dashboard-verified.json', {
    ...receipt, inProgressDay: { day, report: report('today-verified', [day]) },
  });
  await save('official-gmv-max-dashboard-other-shop.json', {
    ...receipt, observedAt: '2026-11-15T09:45:00Z', shop: { ...receipt.shop, id: '9000000000000000100' },
    inProgressDay: { day, report: report('wrong-shop', [day]) },
  });
  assert.deepEqual(await refreshDashboardAdvertising({ root, now: new Date('2026-11-15T09:53:59Z') }),
    { state: 'fresh', day, observedAt });
  assert.deepEqual(await refreshDashboardAdvertising({ root, now: new Date('2026-11-14T23:59:59Z') }),
    { state: 'outside_hours', day });
});
