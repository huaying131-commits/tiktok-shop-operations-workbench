import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectCreativeFeedbackTasks } from '../scripts/operations/creative-feedback-tasks.mjs';

const day = '2026-11-14';
const videoId = '9000000000000000129';
const productId = '9000000000000000016';
const skuId = '9000000000000000018';
const advertiserId = '9000000000000000096';
const account = 'example-creator-3';
const jobId = 'ORIGINAL-01';
const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY', advertiserId };
const archive = 'outputs/video-publishing-2026-11-07/archive/' + account + '/' + jobId;
const successRef = 'outputs/video-publishing-2026-11-07/native-publishing/' + jobId + '/independent-success.json';
const media = Buffer.from('archive bytes');
const originalSha = createHash('sha256').update(media).digest('hex');
const listed = { id: videoId, account, productIds: [productId] };
const originalSuccess = { source: successRef, sha256: originalSha, platformPostTime: '2026-11-07 16:20:35' };
const linked = { platformVideoId: videoId, account, productId, jobId, originalSuccess };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'creative-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  await put(archive + '/actual-upload.mp4', media);
  await put(archive + '/发布任务.json', {
    market: 'MY', shop_key: '跨境1', target_account: account, video_id: jobId, product_id: productId, sku_id: skuId,
  });
  await put(successRef, { success: true, original_submit_once: true, exact_message: 'Your video has been posted!',
    account, job_id: jobId, sha256: originalSha });
  await put('success/verified.mp4', media);
  await put('success/duplicate.mp4', media);
  await put('success/桌拍出300单.mp4', Buffer.from('different video bytes'));

  async function receipts({ align = false, observedDay = day, mismatch = false } = {}) {
    const end = align || observedDay !== day ? '2026-11-12' : '2026-11-13';
    const start = end === '2026-11-12' ? '2026-11-06' : '2026-11-07';
    const endExclusive = end === '2026-11-12' ? '2026-11-13' : day;
    const lateDetail = '2026-11-12';
    const observedAt = observedDay + 'T04:30:00.000Z';
    const directory = align ? '/report-end-' + end : '';
    const stamp = observedDay + 'T04-30-00-000Z.json';
    const campaignId = '9000000000000004';
    await put('outputs/ads-monitoring/' + observedDay + '/live-read-validation' + directory + '/official-gmv-max-' + stamp, {
      schema: 'operations-gmv-max-read/v1', observedAt, shop, inProgressDay: { day: observedDay },
      account: { advertiser_id: advertiserId, currency: 'USD', timezone: 'Asia/Kuala_Lumpur' },
      requestIds: { account: 'account-read', shop: 'shop-read' },
      campaignDetails: [{ id: campaignId, type: 'PRODUCT', status: 'ENABLE', productIds: [productId] }],
      completeDays: { start, end, productReports: [{ campaignId, creatives: [{ productId, available: true,
        result: { requestIds: ['creative-read'], dimensions: ['item_id'],
          rows: [{ dimensions: { item_id: videoId }, metrics: { shop_content_type: 'VIDEO', creative_delivery_status: 'DELIVERING',
            tt_account_name: '0', orders: '4', cost: '0.15', gross_revenue: '20.00' } }] } }] }] },
    });
    await put('outputs/operations-shop-video-reconciliation/' + observedDay + directory + '/official-read-' + stamp, {
      schema: 'operations-shop-video-reconciliation/v1', observedAt, day: observedDay, shop,
      coverage: { completeForPerformanceList: true }, datedVideos: [mismatch ? { ...listed, account: 'other_handle' } : listed],
      query: { startInclusive: start, endExclusive, latestAvailableDate: end },
      linkedHistoricalVideos: [linked],
      productPerformance: [{ platformVideoId: videoId, state: 'product_analytics_confirmed', expectedProductId: productId,
        productIds: [productId], requestIds: ['shop-video-read'], latestAvailableDate: lateDetail,
        engagement: { startInclusive: start, endExclusive, impressions: 100, clicks: 10, unitsSold: 4 } }],
    });
  }
  const collect = (reportDay = day) => collectCreativeFeedbackTasks({ day: reportDay, root,
    successDirectory: join(root, 'success'), refresh: false });
  return { put, receipts, collect };
}

test('creative proposals require aligned windows and an archive match, and keep desktop labels out of the metrics', async t => {
  const { put, receipts, collect } = await fixture(t);
  await receipts();
  const partial = await collect();
  assert.equal(partial.tasks.length, 1);
  assert.equal(partial.tasks[0].role, 'ads-analysis');
  assert.equal(partial.tasks[0].detail.completeCrossSourceEvidence, null);
  assert.equal(partial.summary.localSuccess.fileCount, 3);
  assert.equal(partial.summary.localSuccess.distinctShaCount, 2);
  assert.equal(partial.summary.localSuccess.matchedUniqueCount, 1);
  assert.equal(partial.summary.localSuccess.entries.find(row => row.state === 'reference_unverified').videoId, null);

  await receipts({ align: true });
  const current = await collect();
  assert.equal(current.tasks.length, 1);
  assert.equal(current.tasks[0].role, 'video-production');
  assert.equal(current.tasks[0].key, partial.tasks[0].key);
  assert.equal(current.tasks[0].detail.currentAds.window.end, '2026-11-13');
  assert.equal(current.tasks[0].detail.completeCrossSourceEvidence.window.end, '2026-11-12');
  assert.equal(current.tasks[0].detail.completeCrossSourceEvidence.freshness, 'fresh_aligned_window');
  assert.equal(current.tasks[0].detail.currentAds.skuOrders, 4);
  assert.equal(current.tasks[0].detail.actualProfitMyr, null);
  assert.equal((await collect()).tasks[0].key, current.tasks[0].key);

  await put(archive + '/actual-upload.mp4', Buffer.from('different archive bytes'));
  assert.equal((await collect()).tasks.length, 0);
});

test('existing exact production plan is surfaced without a duplicate proposal and account mismatch blocks joining', async t => {
  const { put, receipts, collect } = await fixture(t);
  await receipts();
  await receipts({ align: true });
  await put('outputs/video-production/2026-11-13/SU57-7orders-reference-review/hook-variant-plan.json', {
    schema: 'video-production-reference-adaptation/v1', state: 'script_prepared',
    reference: { publishedVideoId: videoId, account, productId, skuId, actualMediaSha256: originalSha },
    variant: { singleTestedCreativeVariable: 'hook wording' },
  });
  const known = await collect();
  assert.equal(known.tasks.length, 0);
  assert.equal(known.summary.reusedHandoffs[0].state, 'script_prepared');
  await receipts({ mismatch: true });
  const unrelated = await collect();
  assert.equal(unrelated.summary.archiveMatched, 0);
  assert.equal(unrelated.summary.reusedHandoffs.length, 0);
  await assert.rejects(collect('2026-11-15'), /requested day are unavailable/u);
});

test('a verified sampled-frame match stays in the reference index after the fresh performance join is gone', async t => {
  const { put, receipts, collect } = await fixture(t);
  await receipts({ mismatch: true });
  await receipts({ observedDay: '2026-11-13' });
  const daily = 'outputs/operations-daily-work/2026-11-13/review-archive.json';
  const ads = 'outputs/ads-monitoring/2026-11-13/live-read-validation/official-gmv-max-2026-11-13T04-30-00-000Z.json';
  const shopVideo = 'outputs/operations-shop-video-reconciliation/2026-11-13/official-read-2026-11-13T04-30-00-000Z.json';
  await put(daily, { growth: { result: { sources: { ads, shopVideo } } } });
  await put('outputs/operations-creative-feedback/2026-11-14/creative-match-shadow.json', {
    adSource: daily,
    files: [{ state: 'matched_by_sampled_frames_and_archive',
      sha256: createHash('sha256').update('different video bytes').digest('hex'),
      identity: { account, productId, skuId, videoId, archiveSha256: originalSha, archive: archive + '/actual-upload.mp4' } }],
  });

  const known = await collect();
  assert.equal(known.tasks.length, 0);
  assert.equal(known.summary.localSuccess.matchedUniqueCount, 1);
  assert.equal(known.summary.localSuccess.matchedDistinctShaCount, 2);
  assert.equal(known.summary.localSuccess.entries.filter(entry => entry.state === 'verified_sampled_frame_match').length, 1);
  assert.ok(known.sources.includes(daily));
});
