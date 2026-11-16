import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const accountTypes = ['OFFICIAL_ACCOUNTS', 'MARKETING_ACCOUNTS'];
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u;
const daysAgo = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
const handle = value => typeof value === 'string' ? value.replace(/^@/u, '').toLowerCase() : '';
const caption = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';

async function accountVideos(client, token, shop, accountType, start, end) {
  let latestAvailableDate;
  const result = await collectPages(async cursor => {
    const page = await client.videoPerformancePage(token, shop, start, end, accountType, cursor);
    const nextToken = page.next_page_token ?? '';
    if (!Array.isArray(page.videos) || !Number.isSafeInteger(page.total_count) ||
        typeof nextToken !== 'string' || !datePattern.test(page.latest_available_date ?? '') ||
        (latestAvailableDate && page.latest_available_date !== latestAvailableDate)) {
      throw new Error('Shop video performance page changed or is incomplete');
    }
    latestAvailableDate = page.latest_available_date;
    const rows = page.videos.map(video => {
      const account = handle(video.creator?.user_name);
      if (!isPlatformId(video.id) || !account || video.creator.author_type !== accountType) {
        throw new Error('Shop video response contains an unexpected video or account');
      }
      const rawPostTime = video.video_post_time ?? null;
      return { id: video.id, account, accountType, rawPostTime, title: caption(video.title),
        postDay: dateTimePattern.test(rawPostTime ?? '') ? rawPostTime.slice(0, 10) : null,
        productIds: [...new Set((video.products ?? []).map(product => product.id).filter(isPlatformId))] };
    });
    return { rows, totalCount: page.total_count, nextToken };
  }, Date.now() + 60_000);
  return { ...result, accountType, latestAvailableDate };
}

async function readOriginalSuccess(source, row, video) {
  if (typeof row.successEvidence !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '')) return null;
  const file = resolve(root, row.successEvidence);
  if (!file.startsWith(dirname(source) + sep) || basename(file) !== 'independent-success.json') return null;
  let evidence;
  try {
    evidence = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!evidence || typeof evidence !== 'object') return null;
  const observation = Date.parse(evidence.at);
  const postTime = Date.parse(video.rawPostTime.replace(' ', 'T') + '+08:00');
  const gapSeconds = (observation - postTime) / 1000;
  if (evidence.success !== true || evidence.original_submit_once !== true ||
      evidence.exact_message !== 'Your video has been posted!' || evidence.job_id !== row.jobId ||
      handle(evidence.account) !== row.account || evidence.sha256 !== row.sha256 ||
      (evidence.platform_video_id && evidence.platform_video_id !== video.id) ||
      !Number.isFinite(gapSeconds) || gapSeconds < -3 || gapSeconds > 90) return null;
  return { source: file, sha256: row.sha256, observedAt: evidence.at, platformPostTime: video.rawPostTime,
    observationGapSeconds: gapSeconds };
}

async function readLocalLedger(day, videos) {
  const source = join(root, 'outputs', 'video-publishing-' + day, '发布记录.jsonl');
  let ledger;
  try {
    ledger = await readFile(source, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { day, source, available: false, withPlatformId: null, withoutPlatformId: null,
      exactMatches: [], unresolvedIds: [], captionCandidates: [] };
  }
  const rows = new Map();
  for (const line of ledger.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line);
    const at = Date.parse(row.published_at ?? row.at);
    if (row.published !== true || !Number.isFinite(at) || dateFormat.format(at) !== day) continue;
    const key = row.job_id ?? row.sha256 ?? row.platform_video_id;
    if (!key) continue;
    const account = handle(row.account);
    const productId = isPlatformId(row.product_id) ? row.product_id : null;
    const platformId = isPlatformId(row.platform_video_id) ? row.platform_video_id : null;
    const prior = rows.get(key);
    if (prior && (prior.account !== account || prior.productId !== productId ||
        (prior.platformId && platformId && prior.platformId !== platformId))) {
      throw new Error('Conflicting identity in original publishing ledger for ' + day);
    }
    const description = caption(row.description);
    const tags = Array.isArray(row.tags) ? row.tags.join(' ') : '';
    rows.set(key, { account, productId, platformId: platformId ?? prior?.platformId ?? null,
      captions: description ? [description, caption(description + ' ' + tags)] : [],
      sha256: row.sha256 ?? prior?.sha256, successEvidence: row.success_evidence ?? prior?.successEvidence });
  }
  const exactMatches = [];
  const unresolvedIds = [];
  const captionCandidates = [];
  let withoutPlatformId = 0;
  for (const [jobId, row] of rows) {
    const { account, productId, platformId, captions } = row;
    const identity = { jobId, account, productId };
    if (!platformId) {
      withoutPlatformId++;
      const matches = [...videos.values()].filter(video => video.account === account && video.postDay === day &&
        video.productIds.includes(productId) && captions.includes(video.title));
      if (matches.length === 1) {
        const originalSuccess = await readOriginalSuccess(source, { jobId, ...row }, matches[0]);
        captionCandidates.push({ ...identity, candidatePlatformId: matches[0].id, originalSuccess });
      }
      continue;
    }
    const platform = videos.get(platformId);
    if (platform?.account === account && platform.postDay === day && platform.productIds.includes(productId)) {
      exactMatches.push({ ...identity, platformId, officialPostTime: platform.rawPostTime });
    } else {
      unresolvedIds.push({ ...identity, platformId, reason: platform ? 'account_product_or_post_day_mismatch' : 'outside_visible_analytics' });
    }
  }
  const candidateUses = new Map();
  for (const row of captionCandidates) candidateUses.set(row.candidatePlatformId, (candidateUses.get(row.candidatePlatformId) ?? 0) + 1);
  const matchedIds = new Set(exactMatches.map(row => row.platformId));
  return { day, source, available: true, withPlatformId: exactMatches.length + unresolvedIds.length,
    withoutPlatformId, exactMatches, unresolvedIds,
    captionCandidates: captionCandidates.filter(row => candidateUses.get(row.candidatePlatformId) === 1 && !matchedIds.has(row.candidatePlatformId)) };
}

async function verifyBatchDetails(client, token, shop, start, end, candidates, videos) {
  if (!candidates.length) return { state: 'no_candidates', matched: [] };
  try {
    const ids = candidates.map(row => row.candidatePlatformId);
    const data = await client.batchVideoPerformance(token, shop, start, end, ids);
    if (!Array.isArray(data.videos) || !datePattern.test(data.latest_available_date ?? '')) {
      throw new Error('Invalid batch video detail response');
    }
    const counts = new Map();
    for (const row of data.videos) {
      const detail = row.video;
      const listed = videos.get(detail?.id);
      if (row.error?.code || !listed || listed.account !== handle(detail.username) ||
          listed.rawPostTime !== detail.video_post_time || listed.title !== caption(detail.title)) continue;
      counts.set(detail.id, (counts.get(detail.id) ?? 0) + 1);
    }
    return { state: 'read', latestAvailableDate: data.latest_available_date,
      matched: ids.filter(id => counts.get(id) === 1) };
  } catch (error) {
    return { state: 'unavailable', matched: [], error: publicPlatformError(error, error.message) };
  }
}

export async function readHistoricalVideoProduct(client, token, shop, start, end, video) {
  const requestIds = [];
  let latestAvailableDate;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const result = await collectPages(async cursor => {
    const { data, requestId } = await client.videoProductPerformancePage(token, shop, start, end, video.platformVideoId, cursor);
    const nextToken = data.next_page_token ?? '';
    const products = data.products ?? (data.total_count === 0 && !nextToken ? [] : null);
    if (!requestId || !Array.isArray(products) || !Number.isSafeInteger(data.total_count) ||
        typeof nextToken !== 'string' || !datePattern.test(data.latest_available_date ?? '') ||
        (latestAvailableDate && latestAvailableDate !== data.latest_available_date) || products.some(row => !isPlatformId(row?.id))) {
      throw new Error('Incomplete video product performance response');
    }
    latestAvailableDate = data.latest_available_date;
    requestIds.push(requestId);
    return { rows: products.map(row => ({ id: row.id, impressions: count(row.product_impressions),
      clicks: count(row.product_clicks), unitsSold: count(row.units_sold) })), totalCount: data.total_count, nextToken };
  }, Date.now() + 45_000);
  const productIds = result.rows.map(row => row.id);
  if (new Set(productIds).size !== productIds.length) throw new Error('Duplicate product in video performance');
  const exact = result.rows.find(row => row.id === video.productId);
  return { platformVideoId: video.platformVideoId, expectedProductId: video.productId,
    state: exact ? 'product_analytics_confirmed' : 'expected_product_not_returned',
    latestAvailableDate, productIds, requestIds, pages: result.pages,
    engagement: exact ? { startInclusive: start, endExclusive: end, impressions: exact.impressions,
      clicks: exact.clicks, unitsSold: exact.unitsSold } : null };
}

async function main(reportEnd) {
  const day = dateFormat.format(new Date());
  if (reportEnd != null && (!datePattern.test(reportEnd) || !Number.isFinite(Date.parse(reportEnd)) ||
      daysAgo(reportEnd, 0) !== reportEnd || reportEnd < daysAgo(day, 4) || reportEnd >= day)) {
    throw new Error('Report end must be one of the last four completed Malaysia calendar days');
  }
  const end = reportEnd ? daysAgo(reportEnd, -1) : day;
  const start = daysAgo(end, 7);
  const [credentials, authorization] = await Promise.all([loadLocalAppCredentials(), loadLocalAuthorization()]);
  const { tokens } = authorization;
  if (authorization.serviceId !== credentials.serviceId || tokens?.user_type !== 0 || !tokens.access_token) {
    throw new Error('Matching TikTok Shop seller authorization is required');
  }
  const requests = [];
  const client = createTikTokClient({ ...credentials, async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ method: options.method, path: url.pathname, accountType: url.searchParams.get('account_type'),
      status: response.status, code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const token = tokens.access_token;
  const shop = (await client.authorizedShops(token)).find(row => row.id === shopId && row.region === 'MY' && row.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia Cross1 shop is required');
  const snapshots = await Promise.all(accountTypes.map(type => accountVideos(client, token, shop, type, start, end)));
  const latestAvailableDate = snapshots.map(snapshot => snapshot.latestAvailableDate).sort()[0];
  const platformRows = snapshots.flatMap(snapshot => snapshot.rows);
  const videos = new Map(platformRows.map(row => [row.id, row]));
  if (videos.size !== platformRows.length) throw new Error('Official and marketing video ID sets overlap');
  const datedVideos = platformRows.filter(row => row.postDay >= start && row.postDay < end && row.postDay <= latestAvailableDate);
  const ledgerDays = await Promise.all(Array.from({ length: 7 }, (_, index) => readLocalLedger(daysAgo(end, 7 - index), videos)));
  const candidates = ledgerDays.flatMap(row => row.captionCandidates).filter(row => row.originalSuccess);
  const details = await verifyBatchDetails(client, token, shop, start, end, candidates, videos);
  const corroborated = new Set(details.matched);
  const linkedHistoricalVideos = candidates.filter(row => corroborated.has(row.candidatePlatformId))
    .map(({ candidatePlatformId, ...row }) => ({ ...row, platformVideoId: candidatePlatformId }));
  const productPerformance = [];
  for (let index = 0; index < linkedHistoricalVideos.length; index += 4) {
    const videosToCheck = linkedHistoricalVideos.slice(index, index + 4);
    const checked = await Promise.allSettled(videosToCheck.map(video => readHistoricalVideoProduct(client, token, shop, start, end, video)));
    productPerformance.push(...checked.map((read, offset) => read.status === 'fulfilled' ? read.value : {
      platformVideoId: videosToCheck[offset].platformVideoId, expectedProductId: videosToCheck[offset].productId,
      state: 'unavailable', error: publicPlatformError(read.reason, 'Video product performance unavailable'),
    }));
  }
  const byAccount = {};
  for (const { account, postDay, productIds } of datedVideos) {
    byAccount[account] ??= { listedPostedInWindow: 0, withProductIds: 0, byPostDay: {} };
    const aggregate = byAccount[account];
    aggregate.listedPostedInWindow++;
    aggregate.withProductIds += Number(productIds.length > 0);
    aggregate.byPostDay[postDay] = (aggregate.byPostDay[postDay] ?? 0) + 1;
  }
  const observedAt = new Date().toISOString();
  const result = { schema: 'operations-shop-video-reconciliation/v1', day, observedAt, shop: { id: shop.id, name: shop.name, region: shop.region },
    query: { startInclusive: start, endExclusive: end, latestAvailableDate, timeBasis: 'platform_calendar_date_as_returned' },
    pagination: snapshots.map(({ accountType, pages, totalCount, latestAvailableDate: availableDate }) =>
      ({ accountType, pages, totalCount, latestAvailableDate: availableDate })),
    coverage: { completeForPerformanceList: true, completeForPublicationHistory: false, publicAnchorIndependentlyVerified: false },
    summary: { listedVideos: videos.size, listedPostedInWindow: datedVideos.length,
      withProductIds: datedVideos.filter(row => row.productIds.length > 0).length,
      localLedgerDays: ledgerDays.filter(row => row.available).length,
      localWithoutPlatformId: ledgerDays.reduce((count, row) => count + (row.withoutPlatformId ?? 0), 0),
      exactMatches: ledgerDays.reduce((count, row) => count + row.exactMatches.length, 0),
      captionCandidates: ledgerDays.reduce((count, row) => count + row.captionCandidates.length, 0),
      originalSuccessReceiptsMatched: candidates.length, linkedHistoricalVideoIds: linkedHistoricalVideos.length,
      productPerformanceConfirmed: productPerformance.filter(row => row.state === 'product_analytics_confirmed').length,
      productPerformanceWithClicks: productPerformance.filter(row => row.engagement?.clicks > 0).length,
      productPerformanceNotReturned: productPerformance.filter(row => row.state === 'expected_product_not_returned').length,
      productPerformanceUnavailable: productPerformance.filter(row => row.state === 'unavailable').length, byAccount },
    datedVideos: datedVideos.map(({ title, ...row }) => row), ledgerDays,
    detailRead: { state: details.state, latestAvailableDate: details.latestAvailableDate ?? null, error: details.error ?? null },
    linkedHistoricalVideos, productPerformance, requests };
  const directory = join(root, 'outputs/operations-shop-video-reconciliation', day,
    ...(reportEnd ? ['report-end-' + reportEnd] : []));
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, day, query: result.query, pagination: result.pagination, ...result.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'report-end': { type: 'string' } } });
    await main(values['report-end']);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
