import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readDashboardWorkflow } from '../apps/customer-service/operations-dashboard-workflow.mjs';

const day = '2026-11-14';
const shopId = '9000000000000000099';
const productId = '9000000000000000060';
const skuId = '9000000000000000058';
const sellerSku = 'VALID-FIXTURE';
const at = '2026-11-13T17:05:00.000Z';

async function withFixture(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'operations-workflow-test-'));
  const write = async (relative, contents) => {
    const file = join(workspaceRoot, 'outputs', relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  try {
    await run({ workspaceRoot, write });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

test('acknowledged submissions stay pending without an independently verified platform ID', () => withFixture(async ({ workspaceRoot, write }) => {
  const path = 'video-publishing-' + day;
  const jobId = 'EXACT-JOB';
  const sha = '1'.repeat(64);
  const pending = {
    job_id: jobId, account: 'example-creator-4', sha256: sha, product_id: productId, actual_date: day,
    status: 'posted_archive_pending', submit_attempted: true, published: true,
    published_at: at, original_submit_tool_call_id: 'submit-1', platform_video_id: null,
  };
  await write(path + '/actual-day-local-baseline.json', { actual_date: day, at, daily_target: 20, per_account_daily_cap: 4 });
  await write(path + '/发布记录.jsonl', [pending, pending, { ...pending, job_id: 'SAME-ASSET-ALIAS' }].map(row => JSON.stringify(row)).join('\n'));
  await write(path + '/native-publishing/' + jobId + '/independent-success.json', {
    at, success: true, original_submit_once: true, job_id: jobId, sha256: sha,
    account: pending.account, product_id: productId, independent_read_tool_call_id: 'read-1',
    original_submit_tool_call_id: 'submit-1', platform_video_id: null, public_anchor_verified: false,
  });
  const { publication } = await readDashboardWorkflow({ workspaceRoot, day });
  assert.equal(publication.officialCount, null);
  assert.equal(publication.platformCountComplete, false);
  assert.equal(publication.progressCount, 1);
  assert.equal(publication.pendingPublicAnchor, 1);
  assert.equal(publication.accounts.find(account => account.account === pending.account).progressCount, 1);
  assert.equal(publication.pendingReadback, 1);
  assert.equal(publication.acknowledged, 1);
  assert.equal(publication.target, 20);
  assert.equal(publication.perAccountCap, 4);
  assert.equal(publication.trend.length, 7);
  assert.equal(publication.trend.at(-1).progressCount, 1);
  assert.equal(publication.trend.at(-2).officialCount, null);
  const checkpointAt = '2026-11-14T08:01:00.000Z';
  const counts = { example-creator-1: 0, example-creator-2: 0, example-creator-3: 0, 'example-creator-4': 1, example-creator-5: 0 };
  await write(path + '/checkpoint.json', { actual_date: day, at: checkpointAt, verified_today_successes: 1, successes_by_account: counts });
  const reconciled = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(reconciled.accounts.find(account => account.account === 'example-creator-1').progressCount, 0);
  assert.equal(reconciled.accounts.find(account => account.account === 'example-creator-1').officialCount, null);
  assert.equal(reconciled.localObservedAt, checkpointAt);

  await write(path + '/checkpoint.json', { actual_date: day, at: checkpointAt, verified_today_successes: 2, successes_by_account: {...counts, example-creator-1: 1} });
  const incomplete = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(incomplete.progressCount, 1);
  assert.equal(incomplete.accounts.find(account => account.account === 'example-creator-1').progressCount, null);
  assert.equal(incomplete.localObservedAt, at);
}));

test('a recent analytics observation can have a lagging report date', () => withFixture(async ({ workspaceRoot, write }) => {
  const observedAt = '2026-11-14T10:08:00.000Z';
  await write('operations-shop-video-reconciliation/' + day + '/official-read-2026-11-14T10-08-00-000Z.json', {
    schema: 'operations-shop-video-reconciliation/v1', observedAt,
    shop: { id: shopId, region: 'MY', name: 'example-shop-my' },
    query: { startInclusive: '2026-11-07', endExclusive: day, latestAvailableDate: '2026-11-13' },
    coverage: { completeForPerformanceList: true, completeForPublicationHistory: false },
    datedVideos: [{ id: '9000000000000000132', account: 'example-creator-4', postDay: '2026-11-13', productIds: [productId] }],
  });
  const { publication } = await readDashboardWorkflow({ workspaceRoot, day });
  assert.equal(publication.officialCount, null);
  assert.equal(publication.officialObservedAt, null);
  assert.deepEqual(publication.officialCoverage, { state: 'report_date_lag', observedAt, latestAvailableDate: '2026-11-13' });
  assert.equal(publication.trend.at(-2).officialCount, 1);
}));

test('an empty publication ledger requires dated publisher evidence before displaying a local zero', () => withFixture(async ({ workspaceRoot, write }) => {
  const path = 'video-publishing-' + day;
  const accounts = ['example-creator-1', 'example-creator-2', 'example-creator-3', 'example-creator-4', 'example-creator-5'];
  await write(path + '/发布记录.jsonl', '');
  let publication = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(publication.progressCount, null);
  assert.equal(publication.officialCount, null);

  await write(path + '/checkpoint.json', { actual_date: day, at, verified_today_successes: 0,
    successes_by_account: Object.fromEntries(accounts.map(account => [account, 0])) });
  publication = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(publication.progressCount, 0);
  assert.equal(publication.localObservedAt, at);
  assert.equal(publication.officialCount, null);
}));

test('an analytics hit corroborates the exact product but leaves the public product card pending', () => withFixture(async ({ workspaceRoot, write }) => {
  const path = 'video-publishing-' + day;
  const account = 'example-creator-4';
  const jobId = 'MATCHED-JOB';
  const videoId = '9000000000000000132';
  const sha256 = 'a'.repeat(64);
  await write(path + '/发布记录.jsonl', JSON.stringify({
    job_id: jobId, account, sha256, product_id: productId, actual_date: day, status: 'posted_archive_pending',
    submit_attempted: true, published: true, published_at: at, original_submit_tool_call_id: 'submit-1',
  }));
  await write(path + '/native-publishing/' + jobId + '/independent-success.json', {
    at, success: true, original_submit_once: true, job_id: jobId, sha256, account, product_id: productId,
    independent_read_tool_call_id: 'read-1', original_submit_tool_call_id: 'submit-1',
    platform_video_id: null, public_anchor_verified: false,
  });
  const reportPath = 'operations-shop-video-reconciliation/2026-11-15/report-end-' + day + '/official-read-2026-11-15T08-00-00-000Z.json';
  const report = {
    schema: 'operations-shop-video-reconciliation/v1', observedAt: '2026-11-15T08:00:00.000Z',
    shop: { id: shopId, region: 'MY', name: 'example-shop-my' },
    query: { startInclusive: day, endExclusive: '2026-11-15', latestAvailableDate: day },
    coverage: { completeForPublicationHistory: false },
    datedVideos: [{ id: videoId, account, postDay: day, productIds: [] }],
    linkedHistoricalVideos: [{ platformVideoId: videoId, account, jobId, productId, originalSuccess: { sha256 } }],
  };
  await write(reportPath, report);
  const missingProduct = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(missingProduct.accounts.find(item => item.account === account).pending[0].platformMatched, false);

  report.datedVideos[0].productIds.push(productId);
  await write(reportPath, report);
  const matched = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(matched.officialCount, 1);
  assert.equal(matched.progressCount, 1);
  assert.equal(matched.pendingPublicAnchor, 1);
  assert.equal(matched.accounts.find(item => item.account === account).pending[0].platformMatched, true);

  await write(path + '/native-publishing/' + jobId + '/independent-success.json', {
    at, success: true, original_submit_once: true, job_id: jobId, sha256, account, product_id: productId,
    independent_read_tool_call_id: 'read-2', original_submit_tool_call_id: 'submit-1',
    platform_video_id: videoId, public_anchor_verified: true,
  });
  const publicVerified = (await readDashboardWorkflow({ workspaceRoot, day })).publication;
  assert.equal(publicVerified.officialCount, 1);
  assert.equal(publicVerified.progressCount, 1);
  assert.equal(publicVerified.pendingPublicAnchor, 0);
  assert.equal(publicVerified.pendingReadback, 0);
}));

test('the heatmap counts the earliest exact live SKU readback once in UTC+8', () => withFixture(async ({ workspaceRoot, write }) => {
  const path = 'operations-listings/MY/' + sellerSku;
  await write(path + '/create.result.json', {
    at: '2026-11-13T15:59:00.000Z', httpStatus: 200, code: 0, requestId: 'create-1',
    data: { product_id: productId, skus: [{ id: skuId, seller_sku: sellerSku }] },
  });
  const readback = {
    observedAt: at, shopId, sellerSku, productId, skuId,
    result: { status: 'LIVE_VERIFIED' }, request: { httpStatus: 200, code: 0, requestId: 'read-1' },
    platformState: 'ACTIVATE', auditState: 'APPROVED',
  };
  await write(path + '/readback-2026-11-13T15-59-30.000Z.json', { ...readback, observedAt: '2026-11-13T15:59:30.000Z', skuId: '9000000000000000059' });
  await write(path + '/readback-2026-11-13T17-05-00.000Z.json', readback);
  await write(path + '/readback-2026-11-13T17-10-00.000Z.json', { ...readback, observedAt: '2026-11-13T17:10:00.000Z' });
  const { listingHeatmap } = await readDashboardWorkflow({ workspaceRoot, day });
  assert.equal(listingHeatmap.days.length, 28);
  assert.equal(listingHeatmap.days.at(-2).verifiedCount, null);
  assert.deepEqual(listingHeatmap.days.at(-1), { day, verifiedCount: 1, entries: [{ productId, skuId, sellerSku, verifiedAt: at }] });
}));
