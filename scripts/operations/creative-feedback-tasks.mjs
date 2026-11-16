import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { proposeCreativeReviews, summarizeAdsMetrics } from './gmv-max-review.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const runFile = promisify(execFile);
const shopId = '9000000000000000099';
const advertiserId = '9000000000000000096';
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short' });
const back = (day, offset) => new Date(Date.parse(day + 'T00:00:00Z') - offset * 86_400_000).toISOString().slice(0, 10);
const localFolder = 'C:/Users/Operator/Workspace/我的产品/产品视频/成功视频';
const frameMatchRef = 'outputs/operations-creative-feedback/2026-11-14/creative-match-shadow.json';
const existingPlanRef = 'outputs/video-production/2026-11-13/SU57-7orders-reference-review/hook-variant-plan.json';
const sameShop = shop => shop?.id === shopId && shop.region === 'MY' && shop.name === 'example-shop-my';
const sameDay = (time, day) => Number.isFinite(Date.parse(time)) && calendar.format(new Date(time)) === day;
const asRef = (root, file) => relative(root, file).split(sep).join('/');
const normalizeAccount = name => typeof name === 'string' ? name.replace(/^@/u, '').toLowerCase() : '';

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readNames(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function validAds(data, day, reportEnd) {
  return data?.schema === 'operations-gmv-max-read/v1' && sameShop(data.shop) &&
    data.shop.advertiserId === advertiserId && data.account?.advertiser_id === advertiserId &&
    data.account?.currency === 'USD' && data.account?.timezone === 'Asia/Kuala_Lumpur' &&
    data.requestIds?.account && data.requestIds?.shop && sameDay(data.observedAt, day) &&
    data.inProgressDay?.day === day && data.completeDays?.start === back(reportEnd, 6) &&
    data.completeDays?.end === reportEnd && Array.isArray(data.campaignDetails) &&
    Array.isArray(data.completeDays.productReports);
}

function validShopVideo(data, day, reportEnd) {
  return data?.schema === 'operations-shop-video-reconciliation/v1' && sameShop(data.shop) &&
    data.day === day && sameDay(data.observedAt, day) && data.coverage?.completeForPerformanceList === true &&
    data.query?.startInclusive === back(reportEnd, 6) && data.query?.endExclusive === back(reportEnd, -1) &&
    dayPattern.test(data.query?.latestAvailableDate ?? '') &&
    Array.isArray(data.linkedHistoricalVideos) && Array.isArray(data.productPerformance) &&
    Array.isArray(data.datedVideos);
}

const feeds = {
  ads: { directory: day => `outputs/ads-monitoring/${day}/live-read-validation`,
    filename: /^official-gmv-max-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/u,
    valid: validAds, script: 'read-gmv-max.mjs' },
  shopVideo: { directory: day => `outputs/operations-shop-video-reconciliation/${day}`,
    filename: /^official-read-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/u,
    valid: validShopVideo, script: 'run-shop-video-reconciliation.mjs' },
};

function receiptDirectory(root, day, feed, reportEnd) {
  const base = join(root, feed.directory(day));
  return reportEnd ? join(base, 'report-end-' + reportEnd) : base;
}

async function latestReceipt(root, day, feed, reportEnd) {
  const directory = receiptDirectory(root, day, feed, reportEnd);
  const names = (await readNames(directory)).filter(file => file.isFile() && feed.filename.test(file.name))
    .map(file => file.name).sort().reverse();
  for (const name of names) {
    const file = join(directory, name);
    const data = await readJson(file);
    if (feed.valid(data, day, reportEnd ?? back(day, 1))) return { sourceRef: asRef(root, file), data };
  }
  return null;
}

function childEnvironment(feed) {
  const env = { ...process.env };
  if (feed === feeds.ads && process.platform === 'win32' &&
      !Object.entries(env).some(([name, value]) => value && /^(?:all|https?)_proxy$/iu.test(name))) {
    env.HTTP_PROXY = 'http://127.0.0.1:10808';
    env.HTTPS_PROXY = env.HTTP_PROXY;
  }
  return env;
}

async function currentReceipt(root, day, feed, reportEnd) {
  const saved = await latestReceipt(root, day, feed, reportEnd);
  const now = Date.now();
  if (saved && Date.parse(saved.data.observedAt) <= now && now - Date.parse(saved.data.observedAt) <= 90 * 60_000) return saved;
  if (calendar.format(new Date(now)) !== day) throw new Error('Creative feed requires the current Malaysia report day');
  const script = join(root, 'scripts/operations', feed.script);
  const result = await runFile(process.execPath, [script, ...(reportEnd ? ['--report-end', reportEnd] : [])], {
    cwd: root, env: childEnvironment(feed), windowsHide: true, timeout: 150_000,
  });
  const { file } = JSON.parse(result.stdout);
  if (typeof file !== 'string') throw new Error('Creative source returned no evidence file');
  const path = resolve(root, file);
  const sourceRef = asRef(root, path);
  if (dirname(path) !== receiptDirectory(root, day, feed, reportEnd) || !feed.filename.test(basename(path))) {
    throw new Error('Creative source receipt path does not match the expected date');
  }
  const data = await readJson(path);
  if (!feed.valid(data, day, reportEnd ?? back(day, 1)) || Date.parse(data.observedAt) < now - 5000) {
    throw new Error('Creative source receipt did not pass live validation');
  }
  return { sourceRef, data };
}

async function verifyArchive(root, video) {
  const account = normalizeAccount(video.account);
  const sha = video.originalSuccess?.sha256;
  const source = video.originalSuccess?.source;
  if (!/^[a-z0-9_.]{2,24}$/u.test(account) || !/^[a-z0-9_-]+$/iu.test(video.jobId ?? '') ||
      !shaPattern.test(sha ?? '') || typeof source !== 'string') return null;
  const successPath = resolve(root, source);
  const publisherFolder = dirname(dirname(dirname(successPath)));
  if (dirname(publisherFolder) !== join(root, 'outputs') ||
      !/^video-publishing-\d{4}-\d{2}-\d{2}$/u.test(basename(publisherFolder)) ||
      basename(successPath) !== 'independent-success.json') return null;
  const archive = join(publisherFolder, 'archive', account, video.jobId);
  const media = join(archive, 'actual-upload.mp4');
  const taskPath = join(archive, '发布任务.json');
  const [task, success] = await Promise.all([readJson(taskPath), readJson(successPath)]);
  if (task?.market !== 'MY' || task.shop_key !== '跨境1' || task.target_account !== account ||
      task.video_id !== video.jobId || task.product_id !== video.productId || !isPlatformId(task.sku_id) ||
      success?.success !== true || success.original_submit_once !== true ||
      success.exact_message !== 'Your video has been posted!' || success.sha256 !== sha ||
      success.account !== account || success.job_id !== video.jobId ||
      (success.platform_video_id != null && success.platform_video_id !== video.platformVideoId)) return null;
  try {
    if (await sha256(media) !== sha) return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return { sha, skuId: task.sku_id, sellerSku: task.seller_sku ?? null, contentType: task.content_type ?? null,
    mediaRef: asRef(root, media), archiveTaskRef: asRef(root, taskPath), successRef: asRef(root, successPath) };
}

async function readFrameMatches(root, frameReceipt, checked) {
  const known = new Map(checked.map(item => [item.video.platformVideoId, item]));
  if (!Array.isArray(frameReceipt?.files) || typeof frameReceipt.adSource !== 'string') return { known, refs: [] };
  const expected = new Set(frameReceipt.files.filter(row => row.state === 'matched_by_sampled_frames_and_archive')
    .map(row => row.identity?.videoId).filter(isPlatformId));
  if ([...expected].every(id => known.has(id))) return { known, refs: [] };

  const dailyFile = resolve(root, frameReceipt.adSource);
  const dailyRef = asRef(root, dailyFile);
  const recordedDay = /^outputs\/operations-daily-work\/(\d{4}-\d{2}-\d{2})\/review-[^/]+\.json$/u.exec(dailyRef)?.[1];
  if (!recordedDay) return { known, refs: [] };
  const review = await readJson(dailyFile);
  const inputs = review?.growth?.result?.sources;
  const ads = await readOfficialReviewInput(root, inputs?.ads, recordedDay, feeds.ads);
  const shopVideo = await readOfficialReviewInput(root, inputs?.shopVideo, recordedDay, feeds.shopVideo);
  if (!ads || !shopVideo) return { known, refs: [] };

  let added = false;
  for (const video of shopVideo.data.linkedHistoricalVideos) {
    if (!expected.has(video.platformVideoId) || known.has(video.platformVideoId) ||
        !shopVideo.data.datedVideos.some(row => row.id === video.platformVideoId && row.account === video.account &&
          row.productIds?.includes(video.productId))) continue;
    const archive = await verifyArchive(root, video);
    if (!archive) continue;
    known.set(video.platformVideoId, { video, archive });
    added = true;
  }
  return { known, refs: added ? [dailyRef, ads.sourceRef, shopVideo.sourceRef] : [] };
}

async function readOfficialReviewInput(root, input, day, feed) {
  if (typeof input !== 'string') return null;
  const path = resolve(root, input);
  if (dirname(path) !== receiptDirectory(root, day, feed) || !feed.filename.test(basename(path))) return null;
  const data = await readJson(path);
  return feed.valid(data, day, back(day, 1)) ? { data, sourceRef: asRef(root, path) } : null;
}

function freshSignals(ads, shopVideo) {
  const candidates = new Map();
  const videos = new Map(shopVideo.linkedHistoricalVideos.map(video => [video.platformVideoId, video]));
  if (videos.size !== shopVideo.linkedHistoricalVideos.length) throw new Error('Duplicate video identities in shop receipt');
  const dated = new Map(shopVideo.datedVideos.map(video => [video.id, video]));
  if (dated.size !== shopVideo.datedVideos.length) throw new Error('Duplicate platform video IDs in shop receipt');
  let incompleteReports = 0;
  let qualifiedAdsVideos = 0;
  for (const campaign of ads.campaignDetails.filter(row => row.status === 'ENABLE' && row.type === 'PRODUCT')) {
    for (const productId of new Set(campaign.productIds ?? [])) {
      const reports = ads.completeDays.productReports.filter(report => report.campaignId === campaign.id);
      const creative = reports.length === 1 ? reports[0].creatives?.filter(row => row.productId === productId) : null;
      const report = creative?.length === 1 && creative[0].available === true ? creative[0].result : null;
      if (!Array.isArray(report?.rows) || report.dimensions?.length !== 1 || report.dimensions[0] !== 'item_id' ||
          new Set(report.rows.map(row => row.dimensions?.item_id)).size !== report.rows.length ||
          !report.requestIds?.length || report.requestIds.some(id => !id)) {
        incompleteReports++;
        continue;
      }
      for (const row of report.rows) {
        const id = row.dimensions?.item_id;
        const metrics = row.metrics;
        if (!isPlatformId(id) || metrics?.shop_content_type !== 'VIDEO' ||
            ['EXCLUDED', 'REJECTED', 'UNAVAILABLE', 'AUTHORIZATION_NEEDED'].includes(metrics.creative_delivery_status) ||
            !/^\d+$/u.test(metrics.orders ?? '') || Number(metrics.orders) < 3) continue;
        const performance = summarizeAdsMetrics([row]);
        qualifiedAdsVideos++;
        const video = videos.get(id);
        const listing = dated.get(id);
        const handle = normalizeAccount(metrics.tt_account_name);
        if (!video || video.productId !== productId || listing?.account !== video.account ||
            !listing.productIds?.includes(productId) ||
            (handle && !['0', '-'].includes(handle) && handle !== video.account)) continue;
        const candidate = { video, campaignId: campaign.id, ads: { ...performance, currency: 'USD',
          reportedRoi: metrics.roi ?? null, attribution: 'platform_report_includes_organic',
          window: { start: ads.completeDays.start, end: ads.completeDays.end }, requestIds: report.requestIds } };
        candidates.set(id, candidates.has(id) ? null : candidate);
      }
    }
  }
  if (incompleteReports) throw new Error('Current GMV Max creative pagination or coverage was incomplete');
  const joined = [...candidates.values()].filter(Boolean).sort((a, b) => b.ads.skuOrders - a.ads.skuOrders);
  return { joined, qualifiedAdsVideos };
}

async function indexLocalSuccess(root, directory, checked, frameReceipt) {
  try {
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && /\.mp4$/iu.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const bySha = new Map();
    for (const file of files) {
      const sha = await sha256(join(directory, file.name));
      if (!bySha.has(sha)) bySha.set(sha, []);
      bySha.get(sha).push(file.name);
    }
    const entries = [...bySha].map(([sha, filenames]) => {
      const matches = checked.filter(item => item.archive.sha === sha || frameReceipt?.files?.some(row =>
        row.state === 'matched_by_sampled_frames_and_archive' && row.sha256 === sha &&
        row.identity?.videoId === item.video.platformVideoId && row.identity.account === item.video.account &&
        row.identity.productId === item.video.productId && row.identity.skuId === item.archive.skuId &&
        row.identity.archiveSha256 === item.archive.sha && typeof row.identity.archive === 'string' &&
        resolve(root, row.identity.archive) === resolve(root, item.archive.mediaRef)));
      const verified = matches.length === 1 ? matches[0] : null;
      return { sha256: sha, filenames, videoId: verified?.video.platformVideoId ?? null,
        state: verified ? (verified.archive.sha === sha ? 'archive_hash_match' : 'verified_sampled_frame_match') : 'reference_unverified',
        usage: verified ? 'original_structure_review_only' : 'inspiration_only_rights_unknown' };
    });
    const matched = entries.filter(entry => entry.videoId);
    return { state: 'read', fileCount: files.length, distinctShaCount: bySha.size,
      matchedUniqueCount: new Set(matched.map(entry => entry.videoId)).size, matchedDistinctShaCount: matched.length, entries };
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    return { state: 'unavailable', fileCount: null, distinctShaCount: null,
      matchedUniqueCount: null, matchedDistinctShaCount: null, entries: [] };
  }
}

function sameEvidence(item, review) {
  return review?.id === item.video.platformVideoId && review.account === item.video.account &&
    review.productId === item.video.productId && review.jobId === item.video.jobId &&
    review.originalSuccess?.sha256 === item.archive.sha;
}

function reviewEvidence(review, sourceRefs, freshness) {
  return { window: review.window, engagement: review.productEngagement,
    engagementScope: 'TikTok Shop video × parent product', ads: { ...review.ads, currency: 'USD' },
    shopRequestIds: review.shopRequestIds, adsRequestIds: review.adsRequestIds, sourceRefs, freshness };
}

const primaryTitle = item => item.archive.sellerSku || item.archive.skuId;

function taskFor(item, sameWindowProof, currentRefs, detailRead) {
  const { video, archive, ads } = item;
  const object = `${shopId}:${video.account}:${video.productId}:${archive.skuId}:${video.platformVideoId}`;
  const key = `creative:single-opening-variable:${object}`;
  const detail = { shopId, videoId: video.platformVideoId, account: video.account, productId: video.productId,
    skuId: archive.skuId, sourceSha256: archive.sha, originalPostTime: video.originalSuccess.platformPostTime,
    archiveMediaRef: archive.mediaRef, archiveTaskRef: archive.archiveTaskRef, originalPublishRef: archive.successRef,
    currentAds: { ...ads, sourceRef: currentRefs[0] },
    currentShopAvailability: { state: detailRead?.state ?? 'UNKNOWN',
      latestAvailableDate: detailRead?.latestAvailableDate ?? null, sourceRef: currentRefs[1] },
    completeCrossSourceEvidence: sameWindowProof, actualProfitMyr: null,
    publicProductCardState: 'UNKNOWN', skuScope: 'intended SKU in original archive', usage: 'original_structure_review_only' };
  if (!sameWindowProof) {
    return { key, role: 'ads-analysis', priority: 'normal',
      title: `复核新素材信号 · ${primaryTitle(item)}`, detail: { ...detail,
        action: '广告已到阈值。等店铺视频商品分析覆盖同一完整统计窗，再核准确商品的曝光、点击和成交件数及来源。' },
      sourceRef: archive.archiveTaskRef };
  }
  return { key, role: 'video-production', priority: 'normal',
    title: `复看原片并提一个开场对照 · ${primaryTitle(item)}`, detail: { ...detail,
      action: '先复看原片前 3 秒、手部动作和商品细节证据。按同账号、同规格提一个只改开场的马来语原创对照，由制作岗选可真实拍出的镜头和话术。',
      comparison: '登记对照、父片 SHA、新版 SHA 和唯一变化。若口播密度也变，记为两项变化。实际公开后在 24 小时核商品卡、72 小时看同口径点击、7 天看结果，至少两次可比复验再讨论加拍。',
      proposedOnly: true }, sourceRef: archive.archiveTaskRef };
}

export async function collectCreativeFeedbackTasks({ day, root = projectRoot, successDirectory = localFolder, refresh = true }) {
  root = resolve(root);
  if (!dayPattern.test(day ?? '') || !Number.isFinite(Date.parse(day)) || back(day, 0) !== day) {
    throw new Error('Invalid creative report day');
  }
  const read = (feed, end) => refresh ? currentReceipt(root, day, feed, end) : latestReceipt(root, day, feed, end);
  const [ads, shopVideo, frameReceipt, existingPlan] = await Promise.all([
    read(feeds.ads), read(feeds.shopVideo), readJson(join(root, frameMatchRef)), readJson(join(root, existingPlanRef)),
  ]);
  if (!ads || !shopVideo) throw new Error('Official creative receipts for the requested day are unavailable');
  const signal = freshSignals(ads.data, shopVideo.data);
  const checked = [];
  for (const item of signal.joined) {
    const archive = await verifyArchive(root, item.video);
    if (archive) checked.push({ ...item, archive });
  }
  const sources = new Set([ads.sourceRef, shopVideo.sourceRef]);
  const paired = proposeCreativeReviews(ads.data, shopVideo.data);
  const currentRefs = [...sources];
  const ids = new Set(checked.map(item => item.video.platformVideoId));
  const details = shopVideo.data.productPerformance.filter(row => ids.has(row.platformVideoId));
  const latestDetail = details.map(row => row.latestAvailableDate).filter(date => dayPattern.test(date ?? '')).sort()[0];
  const lag = latestDetail && latestDetail < ads.data.completeDays.end && latestDetail >= back(day, 4);
  let alignedWindow = null;
  let alignedEvidence = [];
  let alignedRefs = [];
  if (lag && checked.some(item => !paired.some(review => sameEvidence(item, review)))) {
    const [alignedAds, alignedShop] = await Promise.all([read(feeds.ads, latestDetail), read(feeds.shopVideo, latestDetail)]);
    if (alignedAds && alignedShop) {
      alignedEvidence = proposeCreativeReviews(alignedAds.data, alignedShop.data);
      alignedRefs = [alignedAds.sourceRef, alignedShop.sourceRef];
      alignedRefs.forEach(ref => sources.add(ref));
      alignedWindow = { start: alignedAds.data.completeDays.start, end: alignedAds.data.completeDays.end,
        adsObservedAt: alignedAds.data.observedAt, shopObservedAt: alignedShop.data.observedAt };
    }
  }
  let history;
  const freshEvidence = [...paired, ...alignedEvidence];
  if (checked.some(item => !freshEvidence.some(review => sameEvidence(item, review)))) {
    const [pastAds, pastShop] = await Promise.all([
      latestReceipt(root, back(day, 1), feeds.ads), latestReceipt(root, back(day, 1), feeds.shopVideo),
    ]);
    if (pastAds && pastShop) {
      history = { rows: proposeCreativeReviews(pastAds.data, pastShop.data), refs: [pastAds.sourceRef, pastShop.sourceRef] };
    }
  }
  const frameEvidence = await readFrameMatches(root, frameReceipt, checked);
  const localSuccess = await indexLocalSuccess(root, successDirectory, [...frameEvidence.known.values()], frameReceipt);
  if (localSuccess.entries.some(entry => entry.state === 'verified_sampled_frame_match')) {
    [frameMatchRef, ...frameEvidence.refs].forEach(ref => sources.add(ref));
  }
  const tasks = [];
  const reusedHandoffs = [];
  const sameWindowCount = checked.filter(item => freshEvidence.some(review => sameEvidence(item, review))).length;
  for (const item of checked) {
    const today = paired.find(review => sameEvidence(item, review));
    const aligned = alignedEvidence.find(review => sameEvidence(item, review));
    const earlier = history?.rows.find(review => sameEvidence(item, review));
    const evidence = today ? reviewEvidence(today, currentRefs, 'current_window')
      : aligned ? reviewEvidence(aligned, alignedRefs, 'fresh_aligned_window')
        : earlier ? reviewEvidence(earlier, history.refs, 'previous_day_receipt') : null;
    if (evidence?.freshness === 'previous_day_receipt') history.refs.forEach(ref => sources.add(ref));
    const prior = existingPlan?.reference;
    if (existingPlan?.schema === 'video-production-reference-adaptation/v1' &&
        prior?.publishedVideoId === item.video.platformVideoId && prior.account === item.video.account &&
        prior.productId === item.video.productId && prior.skuId === item.archive.skuId &&
        prior.actualMediaSha256 === item.archive.sha && existingPlan.variant?.singleTestedCreativeVariable) {
      sources.add(existingPlanRef);
      reusedHandoffs.push({ videoId: item.video.platformVideoId, skuId: item.archive.skuId,
        state: existingPlan.state, currentAds: item.ads, completeCrossSourceEvidence: evidence,
        sourceRef: existingPlanRef });
      continue;
    }
    tasks.push(taskFor(item, evidence, currentRefs, details.find(row => row.platformVideoId === item.video.platformVideoId)));
  }
  const detailedDates = shopVideo.data.productPerformance.map(row => row.latestAvailableDate)
    .filter(date => dayPattern.test(date ?? '')).sort();
  const summary = {
    state: 'read_only_review', shopId,
    ads: { observedAt: ads.data.observedAt, start: ads.data.completeDays.start,
      end: ads.data.completeDays.end, currency: ads.data.account.currency },
    shopVideo: { observedAt: shopVideo.data.observedAt, listLatestAvailableDate: shopVideo.data.query.latestAvailableDate,
      detailEarliestAvailableDate: detailedDates[0] ?? null, detailLatestAvailableDate: detailedDates.at(-1) ?? null },
    alignedWindow, localSuccess, qualifiedAdsVideoRows: signal.qualifiedAdsVideos, archiveMatched: checked.length,
    sameWindowCount, proposed: tasks.filter(task => task.role === 'video-production').length,
    waitingForSameWindow: tasks.filter(task => task.role === 'ads-analysis').length, reusedHandoffs, platformWrites: 0,
  };
  return { tasks, summary, sources: [...sources] };
}
