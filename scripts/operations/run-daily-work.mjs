import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { snapshotFilename } from '../../apps/customer-service/tiktok-shop-finance.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { limits } from '../publisher/lib/planner.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';
import { proposeCreativeReviews, refreshAffiliateCreativeMatches, reviewAircraftCreativeDecisions, reviewGmvMaxProducts } from './gmv-max-review.mjs';
import { refreshActivePromotionCheckout } from './read-active-promotion-checkout.mjs';
import { readMerchantPromotionPreflight, readNewArrivalSalesHistory } from './read-promotion-preflight.mjs';
import { readDailyListingCandidates, readDailySelectionHandoffs } from './run-handoff-reconciliation.mjs';
import { compareEstimatedSettlements, comparePaidOrderWindows, compareUnsettledRevisions, matchStatementPayment, readPaidStatementCoverage, summarizeSettlementPayments } from './run-settlement-reconciliation.mjs';
import { compareProductFinance } from './run-product-finance-review.mjs';
import { previousCollectionCandidates, summarizeWarehouseStages } from './run-fulfillment-routing-replay.mjs';
import { reviewSupportTriage } from './support-triage.mjs';
import { comparePilotMarketPrice, linkPilotStatementPayments, openMyShopSession, planPilotRepricing, readLivePilotOutcome, readPilotChain, readPromotionInventory, reviewPilotOrders } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const runFile = promisify(execFile);
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const yesterday = day => new Date(Date.parse(day + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);

export function publicationCounts(rows, day) {
  const confirmed = new Set();
  const local = new Set();
  for (const row of rows) {
    const time = Date.parse(row.published_at ?? row.at);
    if (row.published !== true || !Number.isFinite(time) || dateFormat.format(time) !== day) continue;
    if (row.platform_video_id) confirmed.add(row.platform_video_id);
    else if (row.job_id || row.sha256) local.add(row.job_id ?? row.sha256);
  }
  return { confirmedVideoIds: confirmed.size, localSuccessWithoutPlatformId: local.size };
}

export function productFollowups(rows) {
  const result = [];
  for (const row of rows) {
    let reason;
    if (row.refunds > 0) reason = 'review_refunds';
    else if (row.impressions > 0 && row.clicks === 0) reason = 'review_click_rate';
    else if (row.clicks > 0 && row.orders === 0) reason = 'review_checkout';
    if (reason) result.push({ ...row, reason });
  }
  const priority = ['review_refunds', 'review_click_rate', 'review_checkout'];
  return result.sort((a, b) => priority.indexOf(a.reason) - priority.indexOf(b.reason) ||
    (b.impressions ?? 0) - (a.impressions ?? 0));
}

export function growthReview(ads, shopVideos, productFinance) {
  const candidates = ads?.source && shopVideos?.source ? proposeCreativeReviews(json(ads.source), json(shopVideos.source)) : [];
  const creativeReviews = [];
  const reviewedFiles = new Set();
  for (const candidate of candidates) {
    if (creativeReviews.length >= 3) break;
    if (reviewedFiles.has(candidate.originalSuccess.sha256)) continue;
    if (!/^[a-z0-9_.]{2,24}$/u.test(candidate.account) || !/^[A-Z0-9_-]+$/iu.test(candidate.jobId)) continue;
    const archive = join(dirname(dirname(dirname(candidate.originalSuccess.source))), 'archive', candidate.account, candidate.jobId);
    const taskSource = join(archive, '发布任务.json');
    const media = join(archive, 'actual-upload.mp4');
    if (!existsSync(taskSource) || !existsSync(media) || !existsSync(candidate.originalSuccess.source)) continue;
    const task = json(taskSource);
    const original = json(candidate.originalSuccess.source);
    if (task.product_id !== candidate.productId || !isPlatformId(task.sku_id) || task.target_account !== candidate.account ||
        task.video_id !== candidate.jobId || original.success !== true ||
        (original.platform_video_id != null && original.platform_video_id !== candidate.id) ||
        original.account !== candidate.account || original.job_id !== candidate.jobId ||
        original.sha256 !== candidate.originalSuccess.sha256 ||
        createHash('sha256').update(readFileSync(media)).digest('hex') !== original.sha256) continue;
    reviewedFiles.add(original.sha256);
    creativeReviews.push({ ...candidate, taskSource, media, skuId: task.sku_id, sellerSku: task.seller_sku ?? null,
      productionAction: 'review_original_and_propose_one_new_variant',
      reviewInstructions: '先看原片并写下可复现的一个要素，再做同规格的一条新版本和对照。保留原片 SHA 与新版本关系。',
      actualProfitMyr: null, deliveryState: 'local_review_ready' });
  }
  const finance = productFinance?.source ? json(productFinance.source) : null;
  const exactFinance = finance?.schema === 'operations-product-finance-review/v1' && finance.shop?.id === '9000000000000000099' && finance.shop.region === 'MY' &&
    finance.shop.name === 'example-shop-my' && finance.analyticsCoverage === 'LIVE' && finance.window?.days >= 5;
  const checkoutReviews = exactFinance ? (finance.reviewQueue?.clickedWithoutOrders ?? []).filter(row => row.clicks >= 20 &&
    row.analyticsOrders === 0 && row.orderDetailOrders === 0 && isPlatformId(row.productId)).slice(0, 5)
    .map(row => ({ productId: row.productId, title: row.title, impressions: row.impressions, clicks: row.clicks,
      analyticsOrders: row.analyticsOrders, orderDetailOrders: row.orderDetailOrders,
      action: 'verify_checkout_price_delivery_and_variant_availability' })) : [];
  return { creativeReviews, checkoutReviews, checkoutWindow: exactFinance ? finance.window : null,
    sources: { ads: ads?.source ?? null, shopVideo: shopVideos?.source ?? null, productFinance: exactFinance ? productFinance.source : null },
    reviewRules: { minimumReportedSkuOrders: 3, minimumProductClicksForCheckoutReview: 20, minimumCheckoutWindowDays: 5 },
    platformWrites: 0 };
}

export async function readShopChannelPerformance({ client, token, shop }, day, days = 7) {
  const dates = [];
  for (let date = day; dates.length < days;) {
    date = yesterday(date);
    dates.unshift(date);
  }
  const startDate = dates[0];
  const daily = await client.shopPerformance(token, shop, startDate, day, '1D');
  const latest = daily.data.latest_available_date;
  if (!daily.requestId || !/^\d{4}-\d{2}-\d{2}$/u.test(latest ?? '') ||
      !Array.isArray(daily.data.performance?.intervals)) throw new Error('Shop analytics daily evidence incomplete');
  const available = dates.filter(date => date <= latest);
  if (!available.length) throw new Error('Shop analytics has no complete day in the requested window');
  const endDateExclusive = dates[available.length] ?? day;
  const aggregate = await client.shopPerformance(token, shop, startDate, endDateExclusive, 'ALL');
  const intervals = aggregate.data.performance?.intervals;
  const [total] = intervals ?? [];
  if (!aggregate.requestId || aggregate.data.latest_available_date !== latest || intervals?.length !== 1 ||
      total.start_date !== startDate || total.end_date !== endDateExclusive) {
    throw new Error('Shop analytics aggregate evidence incomplete');
  }
  const rows = new Map();
  for (const row of daily.data.performance.intervals) {
    const i = dates.indexOf(row.start_date);
    if (i < 0 || rows.has(row.start_date) || row.end_date !== (dates[i + 1] ?? day)) {
      throw new Error('Shop analytics daily interval mismatch');
    }
    rows.set(row.start_date, row);
  }
  if (available.some(date => !rows.has(date))) throw new Error('Shop analytics omitted a complete day');
  const money = field => field?.currency === 'MYR' && typeof field.amount === 'string' &&
    /^-?\d+(?:\.\d{1,2})?$/u.test(field.amount) ? field.amount : null;
  const gmvMyr = money(total.sales?.gmv);
  const orders = total.sales?.orders_count;
  if (gmvMyr === null || !Number.isSafeInteger(orders) || orders < 0) throw new Error('Shop analytics totals are invalid');
  return { observedAt: new Date().toISOString(), requestIds: { daily: daily.requestId, aggregate: aggregate.requestId },
    window: { startDate, endDateExclusive, days: available.length, latestAvailableDate: latest },
    provisionalDays: dates.slice(available.length), summary: { gmvMyr, orders,
      videoAttributedMyr: money(total.sales?.video_attributed_gmv), creatorVideoAttributedMyr: money(total.sales?.creator_video_attributed_gmv),
      sellerVideoAttributedMyr: money(total.sales?.seller_video_attributed_gmv),
      productCardAttributedMyr: money(total.sales?.product_card_attributed_gmv), liveAttributedMyr: money(total.sales?.live_attributed_gmv),
      shopTabAttributedMyr: money(total.breakdowns?.shop_tab_and_search?.shop_tab_attributed),
      searchAttributedMyr: money(total.breakdowns?.shop_tab_and_search?.search_attributed) },
    daily: available.map(date => rows.get(date)), aggregate: total };
}

export async function readTodayVideoOverview(client, token, shop, day) {
  if (shop.id !== '9000000000000000099' || shop.name !== 'example-shop-my' || shop.region !== 'MY' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error('Current Malaysia Cross1 video overview required');
  const end = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const accountTypes = ['ALL', 'OFFICIAL_ACCOUNTS', 'MARKETING_ACCOUNTS', 'AFFILIATE_ACCOUNTS'];
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const rows = await Promise.all(accountTypes.map(async accountType => {
    const { data, requestId } = await client.todayVideoOverview(token, shop, day, end, accountType);
    const intervals = data.performance?.intervals;
    const row = intervals?.[0];
    if (!requestId || !Array.isArray(intervals) || intervals.length !== 1 || row?.today !== true ||
        row.start_date !== day || row.end_date !== end) throw new Error('Current video overview window or request identity unverified');
    const gmv = row.video_attributed_gmv;
    return { accountType, requestId, latestCompleteDay: data.latest_available_date ?? null,
      productImpressions: count(row.product_impressions), productClicks: count(row.product_clicks),
      attributedSkuOrders: count(row.video_attributed_sku_orders),
      attributedGmv: gmv?.currency === 'MYR' && /^-?\d+(?:\.\d{1,2})?$/u.test(gmv.amount ?? '') ? gmv.amount : null };
  }));
  return { observedAt: new Date().toISOString(), shopId: shop.id, day, currency: 'MYR', rows };
}

export async function readShopChannelOrders({ client, token, shop }, channels) {
  const { startDate, endDateExclusive } = channels.window;
  const midnight = date => Date.parse(date + 'T00:00:00+08:00') / 1000;
  const start = midnight(startDate);
  const end = midnight(endDateExclusive);
  const requestIds = [];
  const seen = new Set();
  const orders = await collectPages(async cursor => {
    const page = await client.ordersPage(token, shop, 100, cursor, start, end, { includePaymentEvidence: true });
    if (!page.requestId) throw new Error('Order list request ID missing');
    requestIds.push(page.requestId);
    for (const order of page.rows) {
      if (!isPlatformId(order.id) || seen.has(order.id) || order.createdAt < start || order.createdAt >= end ||
          !Number.isSafeInteger(order.createdAt) || !order.status) throw new Error('Exact order cohort is inconsistent');
      seen.add(order.id);
    }
    return page;
  }, Date.now() + 45_000);
  const status = rows => Object.fromEntries([...new Set(rows.map(row => row.status))].sort()
    .map(key => [key, rows.filter(row => row.status === key).length]));
  function summarize(rows, reportOrders) {
    const cancelled = rows.filter(row => row.status === 'CANCELLED');
    const samples = rows.filter(row => row.sampleOrder === true);
    const paid = rows.filter(row => row.paidAt !== null);
    const paidRegular = paid.filter(row => row.sampleOrder === false);
    const cashOnDelivery = rows.filter(row => row.cashOnDelivery === true);
    return { reportOrders, createdOrders: rows.length, status: status(rows), cancelled: cancelled.length,
      cancelledPaid: cancelled.filter(row => row.paidAt !== null).length, sampleOrders: samples.length,
      unknownSampleFlag: rows.filter(row => row.sampleOrder === null).length, paidTimestamp: paid.length,
      paidRegular: paidRegular.length, paidSamples: paid.filter(row => row.sampleOrder === true).length,
      noPaidTimestamp: rows.length - paid.length, cashOnDelivery: cashOnDelivery.length,
      cashOnDeliveryWithoutPaidTimestamp: cashOnDelivery.filter(row => row.paidAt === null).length,
      paidOnDifferentDate: paid.filter(row => dateFormat.format(row.paidAt * 1000) !== dateFormat.format(row.createdAt * 1000)).length,
      paidOutsideWindow: paid.filter(row => row.paidAt < start || row.paidAt >= end).length,
      reportMinusCreated: Number.isSafeInteger(reportOrders) ? reportOrders - rows.length : null,
      reportMinusPaidRegular: Number.isSafeInteger(reportOrders) ? reportOrders - paidRegular.length : null };
  }
  return { observedAt: new Date().toISOString(), window: channels.window, cohortBasis: 'create_time',
    pages: orders.pages, platformTotal: orders.totalCount,
    requestIds, summary: summarize(orders.rows, channels.summary.orders),
    daily: channels.daily.map(interval => ({ day: interval.start_date,
      ...summarize(orders.rows.filter(row => row.createdAt >= midnight(interval.start_date) && row.createdAt < midnight(interval.end_date)),
        interval.sales?.orders_count ?? null) })),
    rows: orders.rows.map(({ skus, ...order }) => ({ ...order, orderLineIds: skus?.map(line => line.lineId) ?? null })) };
}

async function inspect(work) {
  try {
    return { available: true, result: await work() };
  } catch (error) {
    return { available: false, error: publicPlatformError(error, error.message) };
  }
}

async function publisherShadow(path) {
  if (path) {
    const receipt = json(resolve(path));
    return { observedAt: receipt.at, accepted: receipt.accepted, rejected: receipt.rejected,
      reasons: receipt.reasons, accounts: receipt.accounts, unknownUploads: receipt.unknownUploads,
      unknownSubmissions: receipt.unknownSubmissions, source: resolve(path) };
  }
  const state = await mkdtemp(join(tmpdir(), 'tiktok-daily-publisher-'));
  const entry = join(root, 'scripts/publisher/cli.mjs');
  async function run(command) {
    try {
      const { stdout } = await runFile(process.execPath, [entry, command, '--state-dir', state],
        { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 150_000 });
      return JSON.parse(stdout);
    } catch (error) {
      if ([10, 20].includes(error.code) && error.stdout) return JSON.parse(error.stdout);
      throw error;
    }
  }
  const intake = await run('intake');
  const plan = await run('plan');
  return { observedAt: plan.at, accepted: intake.accepted, rejected: intake.rejected,
    reasons: intake.reason_distribution, accounts: plan.accounts, unknownUploads: plan.unknown_uploads?.length,
    unknownSubmissions: plan.unknown_submissions?.length, state };
}

async function productSignals({ client, token, shop }, day) {
  const startDate = yesterday(day);
  const folder = join(root, 'apps/customer-service/data/tiktok-shop', shop.id);
  const filename = readdirSync(folder).filter(name => snapshotFilename.test(name)).sort().at(-1);
  const catalog = filename ? json(join(folder, filename)) : null;
  const titles = new Map(catalog?.shop.id === shop.id ? catalog.products.rows.map(row => [row.id, row.title]) : []);
  const result = new Map();
  const cursors = new Set();
  let cursor;
  for (let i = 0; i < 20; i += 1) {
    const page = await client.productPerformancePage(token, shop, startDate, day, cursor);
    if (!Array.isArray(page.products)) throw new Error('Invalid product performance page');
    for (const row of page.products) {
      const productId = row.id ?? row.product_id;
      if (!productId || result.has(productId)) throw new Error('Missing or duplicated product performance ID');
      const m = row.total_performance;
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
      result.set(productId, { productId, title: row.title ?? row.product_name ?? titles.get(productId) ?? null,
        impressions: count(m?.product_impressions), clicks: count(m?.product_clicks),
        orders: count(m?.orders), refunds: count(m?.refunded_items) });
    }
    cursor = page.next_page_token;
    if (!cursor) return { startDate, endDateExclusive: day, catalogTitleSnapshot: filename ?? null, count: result.size,
      followups: productFollowups([...result.values()]) };
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw new Error('Product performance pagination incomplete');
}

async function selectionSample({ client, token, shop }) {
  const result = await client.productOpportunitySample(token, shop);
  const list = result.opportunities ?? result.data?.opportunities;
  if (!Array.isArray(list)) throw new Error('Invalid opportunity response');
  return { count: list.length, coverage: 'first_page', rows: list.map(row => ({
    id: row.id, title: row.title, category: row.category_name_level_3 ?? null, demandSource: 'tiktok_shop_opportunity',
  })) };
}

function getLedger(day) {
  const source = join(root, 'outputs', 'video-publishing-' + day, '发布记录.jsonl');
  try {
    const rows = readFileSync(source, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    return { source, available: true, ...publicationCounts(rows, day) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { source, available: false, confirmedVideoIds: 0, localSuccessWithoutPlatformId: 0 };
  }
}

async function gmvMaxEvidence(day, shopId, refresh) {
  let refreshError = null;
  if (refresh) {
    try {
      await runFile(process.execPath, [join(root, 'scripts/operations/read-gmv-max.mjs')],
        { cwd: root, windowsHide: true, timeout: 120_000 });
    } catch (error) {
      refreshError = error.stderr?.includes('mcpServerStatus/list timed out') ? 'GMV Max 授权服务状态查询超时' : 'GMV Max 本轮读取未完成';
    }
  }
  const folder = join(root, 'outputs/ads-monitoring', day, 'live-read-validation');
  const name = readdirSync(folder).filter(file => /^official-gmv-max-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file)).sort().at(-1);
  if (!name) throw new Error(refreshError ?? 'No official GMV Max receipt for ' + day);
  const source = join(folder, name);
  const receipt = json(source);
  const today = receipt.inProgressDay?.report;
  const range = receipt.completeDays;
  const costs = today?.data?.total_metrics?.cost;
  if (receipt.schema !== 'operations-gmv-max-read/v1' || receipt.shop?.id !== shopId ||
      receipt.shop.region !== 'MY' || receipt.shop.advertiserId !== receipt.account?.advertiser_id ||
      dateFormat.format(new Date(receipt.observedAt)) !== day || receipt.inProgressDay?.day !== day ||
      today?.code !== 0 || !today.request_id || typeof costs !== 'string' || !/^\d+(\.\d+)?$/u.test(costs)) {
    throw new Error('Official GMV Max receipt does not match the current shop and day');
  }
  return { source, observedAt: receipt.observedAt, advertiserId: receipt.account.advertiser_id,
    currency: receipt.account.currency, start: range.start, end: range.end, refreshError,
    totals: range.accountByDay.data.total_metrics, today: today.data.total_metrics, campaigns: receipt.campaignDetails };
}

function affiliateCreativeEvidence(day, adsSource, report) {
  const folder = dirname(adsSource);
  for (const file of readdirSync(folder).filter(name => /^affiliate-content-join-.*\.json$/u.test(name)).sort().reverse()) {
    const source = join(folder, file);
    const receipt = json(source);
    if (typeof receipt.adSource !== 'string' || !isPlatformId(receipt.skuId) ||
        typeof receipt.feeSource !== 'string' || !Number.isFinite(Date.parse(receipt.observedAt)) ||
        dateFormat.format(new Date(receipt.observedAt)) !== day) continue;
    const originalAdsSource = resolve(root, receipt.adSource);
    if (dirname(originalAdsSource) !== folder || !/^official-gmv-max-.*\.json$/u.test(basename(originalAdsSource)) ||
        !existsSync(originalAdsSource)) continue;
    const feeSource = resolve(root, receipt.feeSource);
    if (dirname(feeSource) !== join(root, 'outputs/operations-order-unit-economics', day, receipt.skuId) ||
        !/^exact-sku-fee-reconciliation-.*\.json$/u.test(feeSource.split(/[\\/]/u).at(-1)) || !existsSync(feeSource)) continue;
    const originalAds = originalAdsSource === adsSource ? report : json(originalAdsSource);
    const result = refreshAffiliateCreativeMatches(receipt, originalAds, report, json(feeSource));
    if (result) return { ...result, source, feeSource, originalAdsSource, currentAdsSource: adsSource };
  }
  return null;
}

async function shopVideoEvidence(day, shopId, refresh) {
  if (refresh) {
    await runFile(process.execPath, [join(root, 'scripts/operations/run-shop-video-reconciliation.mjs')],
      { cwd: root, windowsHide: true, timeout: 90_000 });
  }
  const directory = join(root, 'outputs/operations-shop-video-reconciliation', day);
  const filename = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().at(-1);
  if (!filename) throw new Error('No official shop video receipt for ' + day);
  const source = join(directory, filename);
  const receipt = json(source);
  if (receipt.schema !== 'operations-shop-video-reconciliation/v1' || receipt.shop?.id !== shopId ||
      receipt.shop.region !== 'MY' || receipt.day !== day || dateFormat.format(new Date(receipt.observedAt)) !== day ||
      receipt.coverage?.completeForPerformanceList !== true || receipt.coverage.completeForPublicationHistory !== false) {
    throw new Error('Official shop video receipt does not match the current shop, date, or coverage');
  }
  return { source, observedAt: receipt.observedAt, query: receipt.query, pagination: receipt.pagination,
    coverage: receipt.coverage, summary: receipt.summary };
}

function publisherApiPreflight(day, shopId, production) {
  if (!production?.available) return null;
  const job = production.result;
  const directory = join(root, 'outputs/operations-creator-auth', day);
  if (!existsSync(directory)) return null;
  for (const filename of readdirSync(directory).filter(file => /^api-preflight-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, filename);
    const receipt = json(source);
    if (receipt.schema === 'tiktok-shop-shoppable-readiness/v1' && receipt.channel === 'tiktok-shop-api' &&
        receipt.shop_id === shopId && receipt.market === 'MY' && dateFormat.format(new Date(receipt.observed_at)) === day &&
        receipt.job_id === job.videoId && receipt.account === job.account && receipt.file?.sha256 === job.sha256 &&
        receipt.product_id === job.officialListing?.productId && receipt.sku_id === job.officialListing?.skuId &&
        receipt.read_only === true && receipt.upload_performed === false && receipt.submission === false) return { ...receipt, source };
  }
  return null;
}

async function serviceFulfillmentEvidence(day, shopId, refresh) {
  let refreshError = null;
  if (refresh) {
    try {
      await runFile(process.execPath, [join(root, 'scripts/operations/run-service-fulfillment-read.mjs')],
        { cwd: root, windowsHide: true, timeout: 300_000 });
    } catch (error) {
      refreshError = error.stderr?.includes('fetch failed') ? '客服全量读取连接失败' : '客服全量读取未完成';
    }
  }
  const directory = join(root, 'outputs/operations-service-fulfillment', day);
  const filename = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().at(-1);
  if (!filename) throw new Error(refreshError ?? 'No official service and fulfillment receipt for ' + day);
  const source = join(directory, filename);
  const receipt = json(source);
  if (receipt.schema !== 'operations-service-fulfillment-read/v1' || receipt.shop?.id !== shopId ||
      receipt.shop.region !== 'MY' || receipt.day !== day || dateFormat.format(new Date(receipt.observedAt)) !== day) {
    throw new Error('Official service and fulfillment receipt does not match the current shop and day');
  }
  return { source, observedAt: receipt.observedAt, refreshError, conversations: receipt.conversations, performance: receipt.performance,
    packages: receipt.packages, caseLinkage: receipt.caseLinkage, packageOrderLinkage: receipt.packageOrderLinkage,
    returns: receipt.returns, openAfterSales: receipt.openAfterSales ?? null };
}

export function returnQualityEvidence(day, shopId) {
  const directory = join(root, 'outputs/operations-return-quality', day);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory).sort().reverse();
  const logisticsReceipts = files.filter(file => /^logistics-reconciliation-.*\.json$/u.test(file)).map(filename => {
    const source = join(directory, filename);
    return { source, receipt: json(source) };
  });
  const warehouseReceipts = files.filter(file => /^return-warehouse-followup-.*\.json$/u.test(file)).map(filename => {
    const source = join(directory, filename);
    return { source, receipt: json(source) };
  });
  const statusReceipts = files.filter(file => /^return-status-followup-.*\.json$/u.test(file)).map(filename => {
    const source = join(directory, filename);
    return { source, receipt: json(source) };
  });
  const eventReceipts = files.filter(file => /^return-event-records-.*\.json$/u.test(file)).map(filename => {
    const source = join(directory, filename);
    return { source, receipt: json(source) };
  });
  const buyerReviews = files.filter(file => /^return-buyer-evidence-review-.*\.json$/u.test(file)).map(filename => {
    const source = join(directory, filename);
    return { source, receipt: json(source) };
  });
  const results = new Map();
  for (const filename of files.filter(file => /^finance-read-.*\.json$/u.test(file))) {
    const source = join(directory, filename);
    const finance = json(source);
    if (finance.schema !== 'operations-return-quality-finance/v1' || finance.shop?.id !== shopId || finance.shop.region !== 'MY' ||
        finance.shop.name !== 'example-shop-my' || !isPlatformId(finance.returnId) || results.has(finance.returnId) || finance.shopWrites !== 0 ||
        typeof finance.source !== 'string') continue;
    const caseSource = resolve(root, finance.source);
    if (dirname(caseSource) !== directory) continue;
    const original = json(caseSource);
    const exact = original.exactLines?.find(line => line.skuId === finance.skuId && line.productId === finance.productId);
    const orderTx = original.settlement?.skuTransactions?.find(row => row.skuId === finance.skuId && row.statementId === finance.statementId);
    const statement = finance.statement?.result;
    const ledgerRows = statement?.exactRows?.filter(row => row.orderId === finance.orderId && row.amount === finance.settlement?.net);
    if (original.schema !== 'operations-return-quality-case/v1' || original.shop?.id !== shopId || original.shop.region !== 'MY' ||
        original.return?.id !== finance.returnId || original.order?.id !== finance.orderId || original.return.orderId !== finance.orderId ||
        original.return.status !== 'RETURN_OR_REFUND_REQUEST_COMPLETE' || original.return.currency !== 'MYR' ||
        typeof original.return.amount !== 'string' || !/^\d+(?:\.\d+)?$/u.test(original.return.amount) || !exact || !orderTx ||
        orderTx.settlementAmount !== finance.settlement?.net || !finance.statement?.available || statement.header?.id !== finance.statementId ||
        statement.header.currency !== 'MYR' || ledgerRows?.length !== 1) continue;
    const payment = finance.payment?.result?.exact;
    const variant = original.products?.find(row => row.skuId === finance.skuId && row.productId === finance.productId && row.exactCurrentSku);
    const logistics = logisticsReceipts.find(({ receipt }) =>
      receipt.schema === 'operations-return-logistics-reconciliation/v1' && receipt.shop?.id === shopId &&
      receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' && receipt.shopWrites === 0 &&
      receipt.returnId === finance.returnId && receipt.orderId === finance.orderId && receipt.skuId === finance.skuId &&
      receipt.productId === finance.productId && typeof receipt.source === 'string' && resolve(root, receipt.source) === caseSource &&
      typeof receipt.financeSource === 'string' && resolve(root, receipt.financeSource) === source &&
      isPlatformId(exact.packageId) && receipt.originalOutbound?.packageId === exact.packageId &&
      isPlatformId(exact.orderLineId) && receipt.returnLogistics?.orderLineId === exact.orderLineId);
    const followup = statusReceipts.find(({ receipt }) =>
      receipt.schema === 'operations-exact-return-status-followup/v1' && receipt.shop?.id === shopId &&
      receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' && receipt.shopWrites === 0 &&
      receipt.returnId === finance.returnId && receipt.orderId === finance.orderId && receipt.skuId === finance.skuId &&
      receipt.productId === finance.productId && receipt.orderLineId === exact.orderLineId &&
      typeof receipt.source === 'string' && resolve(root, receipt.source) === caseSource &&
      typeof receipt.status === 'string' && receipt.updatedAt >= original.return.updatedAt &&
      receipt.trace?.some(request => request.method === 'POST' && request.path === '/return_refund/202602/returns/search' &&
        request.status === 200 && request.code === 0 && request.requestId));
    const warehouse = logistics && warehouseReceipts.find(({ receipt }) =>
      receipt.schema === 'operations-return-warehouse-read/v1' && receipt.shop?.id === shopId && receipt.shop.region === 'MY' &&
      receipt.shop.name === 'example-shop-my' && receipt.platformWrites === 0 && receipt.returnId === finance.returnId &&
      receipt.orderId === finance.orderId && receipt.skuId === finance.skuId && receipt.productId === finance.productId &&
      receipt.orderLineId === exact.orderLineId && receipt.warehouseId === logistics.receipt.originalOutbound.wmsWarehouseId &&
      Date.parse(receipt.observedAt) >= Date.parse(logistics.receipt.observedAt) &&
      typeof receipt.source === 'string' && resolve(root, receipt.source) === logistics.source &&
      Array.isArray(receipt.warehouse?.rows) && typeof receipt.warehouse.complete === 'boolean' &&
      receipt.requests?.some(request => request.path === '/return_refund/202602/returns/search' && request.status === 200 &&
        request.code === 0 && typeof request.requestId === 'string' && request.requestId));
    const warehouseMatch = warehouse?.receipt.exactTrackingAndOrderMatch && warehouse.receipt.warehouse.rows.length === 1
      ? warehouse.receipt.warehouse.rows[0] : null;
    const events = eventReceipts.find(({ receipt }) =>
      receipt.schema === 'operations-exact-return-event-records/v1' && receipt.shop?.id === shopId &&
      receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' && receipt.shopWrites === 0 &&
      receipt.returnId === finance.returnId && receipt.orderId === finance.orderId && receipt.skuId === finance.skuId &&
      receipt.productId === finance.productId && receipt.orderLineId === exact.orderLineId &&
      typeof receipt.source === 'string' && resolve(root, receipt.source) === caseSource && Array.isArray(receipt.records) &&
      receipt.trace?.some(request => request.method === 'GET' && request.path === '/return_refund/202309/returns/' + finance.returnId + '/records' &&
        request.status === 200 && request.code === 0 && request.requestId));
    const records = events?.receipt.records ?? [];
    const buyer = records.find(row => row.role === 'BUYER' && row.event === 'ORDER_RETURN');
    const eventTime = code => records.find(row => row.event === code && Number.isSafeInteger(row.at))?.at ?? null;
    const buyerReview = events && buyerReviews.find(({ receipt }) =>
      receipt.schema === 'operations-return-buyer-evidence-review/v1' && receipt.shop?.id === shopId &&
      receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' && receipt.shopWrites === 0 &&
      receipt.returnId === finance.returnId && receipt.orderId === finance.orderId && receipt.skuId === finance.skuId &&
      receipt.productId === finance.productId && receipt.orderLineId === exact.orderLineId &&
      typeof receipt.source === 'string' && resolve(root, receipt.source) === events.source &&
      Date.parse(receipt.observedAt) >= Date.parse(events.receipt.observedAt) &&
      receipt.physicalCauseVerified === false && typeof receipt.observedSymptom === 'string' && receipt.observedSymptom.trim());
    results.set(finance.returnId, { source, caseSource, observedAt: finance.observedAt, orderId: finance.orderId,
      returnId: finance.returnId, skuId: finance.skuId, productId: finance.productId,
      variation: variant?.attributes?.[0]?.value ?? null, buyerRefund: original.return.amount, reasonCode: original.return.reasonCode,
      settlement: finance.settlement, statementId: finance.statementId,
      paymentStatus: payment?.id === finance.statementId && payment.currency === 'MYR' ? payment.paymentStatus : null,
      warehouse: finance.warehouse, physicalCauseVerified: finance.physicalCauseVerified === true,
      statusReadback: followup ? { source: followup.source, observedAt: followup.receipt.observedAt,
        status: followup.receipt.status, updatedAt: followup.receipt.updatedAt } : null,
      eventRecords: events ? { source: events.source, observedAt: events.receipt.observedAt, count: records.length,
        buyerImageCount: buyer?.images ?? null, buyerVideoCount: buyer?.videos ?? null,
        buyerShippedAt: eventTime('BUYER_SHIPPED'), platformRefundAt: eventTime('REFUND_SUCCESS'),
        platformReviewTimeoutAt: eventTime('SELLER_REJECT_RECEIVE_DELIVERED_TIMEOUT') } : null,
      buyerEvidenceReview: buyerReview ? { source: buyerReview.source, observedAt: buyerReview.receipt.observedAt,
        observedSymptom: buyerReview.receipt.observedSymptom, physicalCauseVerified: false } : null,
      warehouseReturn: warehouse ? { source: warehouse.source, observedAt: warehouse.receipt.observedAt,
        complete: warehouse.receipt.warehouse.complete, matched: warehouse.receipt.warehouse.rows.length,
        state: warehouseMatch?.tab ?? null, signedAt: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u.test(warehouseMatch?.gmtSign ?? '')
          ? warehouseMatch.gmtSign : null } : null,
      logistics: logistics ? { source: logistics.source, observedAt: logistics.receipt.observedAt,
        originalOutbound: logistics.receipt.originalOutbound, returnLogistics: logistics.receipt.returnLogistics } : null });
  }
  return [...results.values()];
}

export function matchDomesticShipping(packing, row) {
  if (packing.state !== 'packing_inputs_verified' || row.orderId !== packing.orderId || row.packageId !== packing.packageId ||
      row.kind !== 'pending' || row.orderStatus !== 'AWAITING_SHIPMENT' || row.packageStatus !== 'TO_FULFILL' ||
      typeof row.hasTrackingNumber !== 'boolean') return null;
  const prefix = `/fulfillment/202309/packages/${row.packageId}`;
  const { handover, documents } = row;
  if (handover?.path !== prefix + '/handover_time_slots' || handover.status !== 200 || handover.code !== 0 || !handover.requestId ||
      typeof handover.data?.canDropOff !== 'boolean' || documents?.path !== prefix + '/shipping_documents' ||
      documents.status !== 200 || !documents.requestId) return null;
  const labelAvailable = documents.code === 0 ? documents.data?.labelUrlReturned === true && documents.data?.hasTrackingNumber === true :
    documents.code === 21042104 ? false : null;
  return { canDropOff: handover.data.canDropOff, labelAvailable, hasTrackingNumber: row.hasTrackingNumber };
}

export function retainDomesticPacking(plan, routingObservedAt, verifiedPending) {
  const planTime = Date.parse(plan.observedAt);
  const routingTime = Date.parse(routingObservedAt);
  if (verifiedPending?.orderId === plan.orderId && verifiedPending.packageId === plan.packageId &&
      Date.parse(verifiedPending.observedAt) >= Math.max(planTime, routingTime)) return verifiedPending.stillPending === true;
  return planTime >= routingTime;
}

export function matchDomesticFulfillmentControl(row, { shop, trace, history, warehouse }) {
  if (![row.orderId, row.packageId, row.warehouseOrderId, row.productId, row.skuId].every(isPlatformId) ||
      !['879', '892'].includes(row.warehouseId) || !Number.isSafeInteger(row.skuUnits) || row.skuUnits < 1 ||
      row.platformOrderStatus !== 'IN_TRANSIT' || row.platformPackageStatus !== 'FULFILLING' ||
      row.platformTrackingPresent !== true || row.wmsTrackingPresent !== true || row.wmsCardQuantity !== 1 ||
      typeof row.pickupSuccessSeen !== 'boolean' || !Number.isSafeInteger(row.trackingEvents) || row.trackingEvents < 1) return false;
  const paths = ['/authorization/202309/shops', '/order/202507/orders', `/fulfillment/202309/packages/${row.packageId}`,
    `/fulfillment/202309/orders/${row.orderId}/tracking`];
  if (!paths.every(path => trace.some(call => call.path === path && call.method === 'GET' && call.code === 0 &&
      call.status === 200 && call.requestId))) return false;
  const bindings = history.filter(item => item.orderId === row.orderId && item.packageId === row.packageId &&
    item.warehouseId === row.warehouseId && item.productId === row.productId && item.skuId === row.skuId && item.source === row.wmsSource);
  const [binding] = bindings;
  const orders = warehouse.data?.orderList;
  if (bindings.length !== 1 || warehouse.operation !== 'orders' || warehouse.code !== 'success' ||
      Number(warehouse.data?.total) !== 1 || orders?.length !== 1) return false;
  const [order] = orders;
  if (order.platformShopId !== shop.id || order.shopName !== shop.name || order.site !== shop.region ||
      order.orderId !== row.warehouseOrderId || order.platformOrderSn !== row.orderId || order.platformPackageId !== row.packageId ||
      order.warehouseId !== row.warehouseId || order.stage !== 'has_pack' || row.wmsStage !== order.stage ||
      order.orderStatus !== row.wmsStatus || typeof order.trackingNo !== 'string' || !order.trackingNo.trim()) return false;
  const items = order.items?.filter(item => item.platformItemId === row.productId && item.platformSkuId === row.skuId);
  const goods = items?.[0]?.goodsSkuList;
  const cards = order.giftList?.filter(item => item.goodsSkuOuterId === 'SKU20251211113951022');
  return items?.length === 1 && Number(items[0].quantity) === row.skuUnits && goods?.length === 1 &&
    goods[0].goodsSkuId === binding.goodsSkuId && goods[0].goodsSkuOuterId === binding.goodsSkuOuterId &&
    Number(goods[0].quantity) === row.skuUnits && cards?.length === 1 && Number(cards[0].quantity) === row.wmsCardQuantity;
}

function domesticFulfillmentControls(directory, day, shopId) {
  for (const name of readdirSync(directory).filter(file => /^domestic-fulfilled-control-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, name);
    const control = json(source);
    const observedAt = Date.parse(control.observedAt);
    if (control.schema !== 'operations-domestic-fulfilled-control/v1' || control.shop?.id !== shopId || control.shop.name !== 'example-shop-my' ||
        control.shop.region !== 'MY' || control.writes !== 0 || !Number.isFinite(observedAt) || dateFormat.format(observedAt) !== day ||
        !Array.isArray(control.rows) || !Array.isArray(control.trace) || typeof control.source !== 'string') continue;
    const packingSource = resolve(root, control.source);
    if (dirname(packingSource) !== directory || !/^domestic-packing-.*\.json$/u.test(basename(packingSource)) || !existsSync(packingSource)) continue;
    const packing = json(packingSource);
    if (packing.schema !== 'operations-domestic-packing/v1' || packing.shop?.id !== shopId || packing.day !== day || packing.writes !== 0 ||
        !Array.isArray(packing.history)) continue;
    const verified = new Map();
    for (const row of control.rows) {
      if (typeof row.wmsSource !== 'string' || verified.has(row.orderId)) continue;
      const warehouseSource = resolve(root, row.wmsSource);
      if (dirname(warehouseSource) !== directory || !/^hhl-packing-\d+-has_process-.*\.json$/u.test(basename(warehouseSource)) ||
          !existsSync(warehouseSource)) continue;
      if (matchDomesticFulfillmentControl(row, { shop: control.shop, trace: control.trace, history: packing.history, warehouse: json(warehouseSource) })) {
        verified.set(row.orderId, row);
      }
    }
    if (verified.size) return { source, observedAt: control.observedAt, packedInTransit: verified.size,
      pickupScansVerified: [...verified.values()].filter(row => row.pickupSuccessSeen).length };
  }
  return null;
}

function collectionTransitionEvidence(transition, followup, directory, basis) {
  if (!transition || typeof transition.previousSource !== 'string') return null;
  const source = resolve(root, transition.previousSource);
  if (dirname(source) !== directory || !/^official-read-.*\.json$/u.test(basename(source)) || !existsSync(source)) return null;
  const previous = json(source);
  if (previous.schema !== basis.schema || previous.day !== basis.day || previous.shop?.id !== basis.shop.id ||
      previous.shop.region !== 'MY' || previous.shop.name !== 'example-shop-my' || previous.summary?.writes !== 0 ||
      previous.orderSource !== 'live_order_list' || !Array.isArray(previous.rows) ||
      !(Date.parse(previous.observedAt) < Date.parse(basis.observedAt))) return null;
  const changed = new Map(previousCollectionCandidates(previous.rows, basis.rows).map(row => [row.orderId, row.packages]));
  if (!changed.size) return null;
  const rows = transition.rows;
  if (!Array.isArray(rows) || rows.length !== changed.size || new Set(rows.map(row => row.orderId)).size !== rows.length ||
      !rows.every(row => changed.has(row.orderId) && row.packages?.length === changed.get(row.orderId).length &&
        changed.get(row.orderId).every(id => row.packages.some(pkg => pkg.packageId === id)))) {
    return transition.error ? { previousSource: source, checked: changed.size, error: transition.error } : null;
  }
  const advanced = rows.filter(row => row.exact && !row.packageWarehouseConflict &&
    ['IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(row.orderStatus));
  const hasTrace = path => followup.trace?.some(call => call.path === path && call.method === 'GET' &&
    call.status === 200 && call.code === 0 && call.requestId);
  const confirmed = advanced.filter(row => row.packages.every(pkg => pkg.belongsToOriginalOrder &&
    hasTrace('/fulfillment/202309/packages/' + pkg.packageId)));
  return { previousSource: source, checked: changed.size, advanced: confirmed.length,
    withPickup: confirmed.filter(row => row.tracking?.pickupSuccessSeen === true &&
      hasTrace('/fulfillment/202309/orders/' + row.orderId + '/tracking')).length,
    unresolved: rows.filter(row => !row.exact || row.packageWarehouseConflict).length };
}

async function fulfillmentRoutingEvidence(day, shopId, { refresh, wmsEvidence, refreshPackages, readOverseasWms, readDomesticWms }) {
  let refreshError = null;
  if (refresh) {
    const args = (wmsEvidence ?? []).flatMap(file => ['--wms-evidence', resolve(file)]);
    try {
      await runFile(process.execPath, [join(root, 'scripts/operations/run-fulfillment-routing-replay.mjs'), '--live-orders', ...args],
        { cwd: root, windowsHide: true, timeout: 90_000 });
    } catch (error) {
      refreshError = error.stderr?.trim() || error.message;
    }
  }
  const directory = join(root, 'outputs/operations-fulfillment-routing-replay', day);
  if (!existsSync(directory) && refreshError) throw new Error(refreshError);
  const filename = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().at(-1);
  if (!filename) throw new Error(refreshError ?? 'No official fulfillment routing receipt for ' + day);
  const source = join(directory, filename);
  const receipt = json(source);
  if (receipt.schema !== 'operations-fulfillment-routing-replay/v1' || receipt.shop?.id !== shopId ||
      receipt.shop.region !== 'MY' || receipt.day !== day || dateFormat.format(new Date(receipt.observedAt)) !== day ||
      receipt.summary?.writes !== 0) throw new Error('Fulfillment replay does not match the current shop and day');
  const packageRefresh = refreshPackages && !refreshError ? await inspect(() => runFile(process.execPath,
    [join(root, 'scripts/operations/run-fulfillment-routing-replay.mjs'), '--pending-from', source,
      ...(readOverseasWms ? ['--read-overseas-wms'] : []),
      ...(readDomesticWms ? ['--read-domestic-wms'] : [])],
    { cwd: root, windowsHide: true, timeout: readDomesticWms ? 150_000 : 90_000 })) : null;
  const pending = new Map(receipt.rows.filter(row => row.nextAction === 'check_existing_package_and_carrier')
    .map(row => [row.orderId, row.packages]));
  const awaitingShipment = new Map(receipt.rows.filter(row => row.status === 'AWAITING_SHIPMENT' &&
    row.serviceMatches && row.packageLineIdentityVerified).map(row => [row.orderId, row.packages]));
  let domesticPackingRefresh = null;
  if (refreshPackages && readDomesticWms && !refreshError) {
    const orders = receipt.rows.filter(row => awaitingShipment.get(row.orderId)?.length === 1 && row.route === 'china_direct' &&
      row.identityVerified && isPlatformId(row.orderId));
    const checks = [];
    for (let offset = 0; offset < orders.length; offset += 2) {
      const batch = await Promise.all(orders.slice(offset, offset + 2).map(async ({ orderId, packages }) => {
        const check = await inspect(async () => {
          const { stdout } = await runFile(process.execPath,
            [join(root, 'scripts/operations/read-domestic-packing.mjs'), '--routing', source, '--order-id', orderId],
            { cwd: root, windowsHide: true, timeout: 120_000 });
          const { source: packingSource, packing } = JSON.parse(stdout);
          if (packing?.orderId !== orderId || packing.packageId !== packages[0] || packing.writes !== 0 || typeof packingSource !== 'string') {
            throw new Error('China-direct packing result did not match the original order and package');
          }
          return { source: packingSource, state: packing.state };
        });
        return { orderId, packageId: packages[0], ...check };
      }));
      checks.push(...batch);
    }
    domesticPackingRefresh = { checked: checks.length, completed: checks.filter(check => check.available).length, checks };
  }
  const shipmentStock = new Map();
  for (const name of readdirSync(directory).filter(file => /^shipment-stock-readback-.*\.json$/u.test(file)).sort().reverse()) {
    const stockSource = join(directory, name);
    const stock = json(stockSource);
    if (stock.schema !== 'operations-shipment-stock-readback/v1' || stock.shop?.id !== shopId || stock.shop.region !== 'MY' ||
        stock.shop.name !== 'example-shop-my' || stock.writes !== 0 || !Number.isFinite(Date.parse(stock.observedAt)) ||
        dateFormat.format(new Date(stock.observedAt)) !== day || !Array.isArray(stock.rows)) continue;
    const platform = json(resolve(root, stock.platformSource));
    if (platform.shop?.id !== shopId || platform.shop.region !== 'MY' || platform.writes !== 0 ||
        !Array.isArray(platform.orders) || !platform.trace?.some(call => call.path === '/order/202507/orders' &&
          call.code === 0 && call.status === 200 && call.requestId)) continue;
    for (const row of stock.rows) {
      if (shipmentStock.has(row.orderId)) continue;
      const order = receipt.rows.find(entry => entry.orderId === row.orderId && entry.status === 'AWAITING_SHIPMENT' &&
        entry.route === row.route && entry.serviceMatches && entry.packageLineIdentityVerified && entry.packages.length === 1 &&
        entry.packages[0] === row.packageId && entry.skus.length === 1 && entry.skus[0].productId === row.productId &&
        entry.skus[0].skuId === row.skuId && entry.skus[0].quantity === row.quantity);
      const latest = platform.orders.find(entry => entry.id === row.orderId);
      if (!order || latest?.status !== 'AWAITING_SHIPMENT' || latest.warehouseId !== order.warehouseId ||
          latest.packageIds?.length !== 1 || latest.packageIds[0] !== row.packageId || latest.lines?.length !== row.quantity ||
          latest.lines.some(line => line.packageId !== row.packageId || line.productId !== row.productId || line.skuId !== row.skuId) ||
          !Array.isArray(row.warehouses) || row.warehouses.length !== 2) continue;
      const eligible = row.warehouses.find(warehouse => warehouse.warehouseId === row.eligibleWarehouseCandidate);
      if (!Number.isSafeInteger(eligible?.available) || eligible.available < row.quantity ||
          (row.route === 'china_direct' && !(eligible.card?.available >= 1)) ||
          (row.route === 'malaysia_overseas' && row.warehouses.some(warehouse => warehouse.existingOutboundRecords !== 0))) continue;
      shipmentStock.set(row.orderId, { ...row, source: stockSource, observedAt: stock.observedAt });
    }
  }
  const domestic = new Map();
  for (const name of readdirSync(directory).filter(file => /^domestic-shipment-readback-.*\.json$/u.test(file)).sort().reverse()) {
    const domesticSource = join(directory, name);
    const readback = json(domesticSource);
    if (readback.schema !== 'operations-domestic-shipment-readback/v1' || readback.shop?.id !== shopId ||
        readback.shop.region !== 'MY' || readback.shop.name !== 'example-shop-my' || readback.writes !== 0 ||
        readback.state !== 'visible_waiting_to_submit' || !Number.isFinite(Date.parse(readback.observedAt)) ||
        dateFormat.format(new Date(readback.observedAt)) !== day || domestic.has(readback.orderId)) continue;
    const expected = receipt.rows.find(row => row.orderId === readback.orderId && row.status === 'AWAITING_SHIPMENT' &&
      row.route === 'china_direct' && row.serviceMatches && row.packageLineIdentityVerified && row.packages.length === 1 &&
      row.packages[0] === readback.packageId && row.skus.length === 1 && row.skus[0].productId === readback.productId &&
      row.skus[0].skuId === readback.skuId && row.skus[0].quantity === readback.quantity);
    if (!expected || !['wait_submit', 'part_submit', 'wait_process', 'has_process', 'has_problem', 'has_closed'].every(tab =>
      readback.statuses?.some(row => row.tab === tab && row.exactRecords === (tab === 'wait_submit' ? 1 : 0) && row.source))) continue;
    domestic.set(readback.orderId, { source: domesticSource, observedAt: readback.observedAt, orderId: readback.orderId,
      variation: readback.variation, quantity: readback.quantity, state: readback.state,
      assignedDomesticWarehouse: readback.assignedDomesticWarehouse, matchedWarehouseGoods: readback.matchedWarehouseGoods });
  }
  const domesticPacking = new Map();
  for (const name of readdirSync(directory).filter(file => /^domestic-packing-.*\.json$/u.test(file)).sort().reverse()) {
    const packingSource = join(directory, name);
    const plan = json(packingSource);
    const row = plan.packing;
    if (plan.schema !== 'operations-domestic-packing/v1' || plan.day !== day || plan.shop?.id !== shopId ||
        plan.shop.region !== 'MY' || plan.shop.name !== 'example-shop-my' || plan.writes !== 0 || row?.writes !== 0 ||
        plan.warehouseSubmissionVerified !== false || !Number.isFinite(Date.parse(plan.observedAt)) ||
        dateFormat.format(new Date(plan.observedAt)) !== day || domesticPacking.has(row.orderId) ||
        plan.platform?.order?.id !== row.orderId || !Array.isArray(plan.platform.cancellations) ||
        !['/order/202507/orders', '/return_refund/202602/returns/search', '/return_refund/202309/cancellations/search',
          '/fulfillment/202309/packages/' + row.packageId].every(path =>
          plan.trace?.some(call => call.path === path && call.status === 200 && call.code === 0 && call.requestId))) continue;
    const expected = receipt.rows.find(order => order.orderId === row.orderId && order.status === 'AWAITING_SHIPMENT' &&
      order.route === 'china_direct' && order.serviceMatches && order.packageLineIdentityVerified && order.packages.length === 1 &&
      order.packages[0] === row.packageId);
    if (!expected) continue;
    const pkg = plan.platform.package;
    const shipping = plan.platform.shipping;
    const hasShippingTrace = (endpoint, result, code) => result?.requestId && plan.trace.some(call =>
      call.path === `/fulfillment/202309/packages/${row.packageId}/${endpoint}` && call.method === 'GET' &&
      call.status === 200 && call.code === code && call.requestId === result.requestId);
    const canDropOff = shipping?.handover?.available === true && hasShippingTrace('handover_time_slots', shipping.handover, 0)
      ? shipping.handover.canDropOff : null;
    const label = shipping?.label;
    const labelAvailable = label?.available === true && hasShippingTrace('shipping_documents', label, 0)
      ? label.labelUrlReturned === true && label.hasTrackingNumber === true
      : label?.code === 21042104 && hasShippingTrace('shipping_documents', label, label.code) ? false : null;
    const ready = row.state === 'packing_inputs_verified' && plan.platform.order.status === 'AWAITING_SHIPMENT' &&
      pkg?.id === row.packageId && pkg.status === 'TO_FULFILL' && typeof pkg.hasTrackingNumber === 'boolean' &&
      expected.warehouseId === plan.platform.order.warehouseId && plan.platform.returns === 0 &&
      plan.platform.cancellations.length === 0 && ['879', '892'].includes(row.warehouseId) &&
      row.items?.length === expected.skus.length && expected.skus.every(sku => row.items.filter(item => item.productId === sku.productId &&
        item.skuId === sku.skuId && item.quantity === sku.quantity && Number.isSafeInteger(item.available) && item.available >= item.quantity).length === 1) &&
      row.card?.goodsSkuOuterId === 'SKU20251211113951022' && row.card.quantity === 1 && Number.isSafeInteger(row.card.available) && row.card.available >= 1;
    domesticPacking.set(row.orderId, { orderId: row.orderId, packageId: row.packageId, source: packingSource, observedAt: plan.observedAt,
      state: ready || row.state === 'platform_after_sales_needs_review' ? row.state : 'packing_inputs_unverified',
      warehouseId: ready ? row.warehouseId : null,
      items: ready ? row.items : [], card: ready ? row.card : null, hasTrackingNumber: ready ? pkg.hasTrackingNumber : null,
      canDropOff: ready ? canDropOff : null, labelAvailable: ready ? labelAvailable : null, submitted: false });
  }
  for (const name of readdirSync(directory).filter(file => /^shipping-documents-[\dTZ-]+\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, name);
    const shipping = json(source);
    const observedAt = Date.parse(shipping.observedAt);
    if (shipping.schema !== 'operations-shipping-document-read/v1' || shipping.shop?.id !== shopId ||
        shipping.shop.region !== 'MY' || shipping.shop.name !== 'example-shop-my' || shipping.writes !== 0 ||
        !Number.isFinite(observedAt) || dateFormat.format(observedAt) !== day || !Array.isArray(shipping.rows)) continue;
    for (const row of shipping.rows) {
      const packing = domesticPacking.get(row.orderId);
      if (!packing || packing.shippingSource || observedAt < Date.parse(packing.observedAt)) continue;
      const match = matchDomesticShipping(packing, row);
      if (match) Object.assign(packing, match, { shippingSource: source, shippingObservedAt: shipping.observedAt });
    }
  }
  let packageFollowup = null;
  const shipmentWarehouseConflicts = new Set();
  const verifiedDomesticPending = new Map();
  for (const name of readdirSync(directory).filter(file => /^pending-package-followup-.*\.json$/u.test(file)).sort().reverse()) {
    const followupSource = join(directory, name);
    const followup = json(followupSource);
    if (followup.schema !== 'operations-pending-package-followup/v1' || followup.day !== day ||
        followup.shop?.id !== shopId || followup.shop.region !== 'MY' || followup.shop.name !== 'example-shop-my' ||
        followup.summary?.writes !== 0 || typeof followup.source !== 'string' || resolve(root, followup.source) !== source ||
        !Number.isFinite(Date.parse(followup.observedAt)) || dateFormat.format(new Date(followup.observedAt)) !== day ||
        Date.parse(followup.observedAt) < Date.parse(receipt.observedAt) ||
        !Array.isArray(followup.rows) || followup.rows.length !== pending.size ||
        new Set(followup.rows.map(row => row.orderId)).size !== pending.size ||
        followup.rows.some(row => !pending.has(row.orderId) || !Array.isArray(row.packages) ||
          row.packages.length !== pending.get(row.orderId).length ||
          !pending.get(row.orderId).every(id => row.packages.some(item => item.packageId === id)))) continue;
    const wmsRows = followup.wms?.rows;
    const wms = Array.isArray(wmsRows) && wmsRows.length === followup.wms.checkedOrders &&
      new Set(wmsRows.map(row => row.orderId)).size === wmsRows.length && wmsRows.every(row =>
        followup.rows.some(order => order.orderId === row.orderId && order.exact && !order.packageWarehouseConflict && order.route === 'malaysia_overseas' &&
          order.orderStatus === 'AWAITING_COLLECTION') && Array.isArray(row.packageMatches) &&
        row.packageMatches.length === pending.get(row.orderId)?.length &&
        pending.get(row.orderId).every(id => row.packageMatches.some(match => match.packageId === id))) ? {
      ...followup.wms, ...summarizeWarehouseStages(wmsRows),
    } : null;
    const deadlines = followup.rows.filter(row => row.exact && row.orderStatus === 'AWAITING_COLLECTION' &&
      Number.isSafeInteger(row.collectionDueAt)).map(row => row.collectionDueAt);
    const domesticWmsRows = followup.domesticWms?.rows;
    const domesticCollection = Array.isArray(domesticWmsRows) &&
      new Set(domesticWmsRows.map(row => row.orderId)).size === domesticWmsRows.length && domesticWmsRows.every(row =>
        followup.rows.some(order => order.orderId === row.orderId && order.exact && !order.packageWarehouseConflict &&
          order.route === 'china_direct' && order.orderStatus === 'AWAITING_COLLECTION' &&
          order.packages.length === 1 && order.packages[0].packageId === row.packageId)) ? {
      checked: domesticWmsRows.length,
      waitingPack: domesticWmsRows.filter(row => row.state === 'verified' && row.stage === 'wait_pack').length,
      packed: domesticWmsRows.filter(row => row.state === 'verified' && row.stage === 'has_pack').length,
      withCard: domesticWmsRows.filter(row => row.state === 'verified' && row.cardVerified === true).length,
      platformOnly: domesticWmsRows.filter(row => row.state === 'platform_package_only_in_warehouse_queue').length,
      unverified: domesticWmsRows.filter(row => !['verified', 'platform_package_only_in_warehouse_queue'].includes(row.state)).length,
    } : null;
    const shipmentChecks = Array.isArray(followup.shipmentChecks) && followup.shipmentChecks.length === awaitingShipment.size &&
      new Set(followup.shipmentChecks.map(row => row.orderId)).size === awaitingShipment.size &&
      followup.shipmentChecks.every(row => awaitingShipment.has(row.orderId) && Array.isArray(row.packages) &&
        row.packages.length === awaitingShipment.get(row.orderId).length &&
        awaitingShipment.get(row.orderId).every(id => row.packages.some(item => item.packageId === id)))
      ? followup.shipmentChecks.filter(row => row.exact) : null;
    const verifiedShipment = shipmentChecks?.filter(row => row.orderStatus === 'AWAITING_SHIPMENT') ?? null;
    const overseasShipment = verifiedShipment?.filter(row => !row.packageWarehouseConflict && row.route === 'malaysia_overseas');
    const shipmentRows = followup.shipmentWms?.rows;
    const shipmentWms = overseasShipment && Array.isArray(shipmentRows) &&
      shipmentRows.length === overseasShipment.length && new Set(shipmentRows.map(row => row.orderId)).size === overseasShipment.length &&
      shipmentRows.every(row => overseasShipment.some(order => order.orderId === row.orderId &&
        Array.isArray(row.packageMatches) && row.packageMatches.length === order.packages.length &&
        order.packages.every(item => row.packageMatches.some(match => match.packageId === item.packageId))))
      ? { expectedOrders: receipt.rows.filter(row => awaitingShipment.has(row.orderId) && row.route === 'malaysia_overseas').length,
        ...followup.shipmentWms } : null;
    const shipmentDeadlines = (verifiedShipment ?? []).filter(row => !row.packageWarehouseConflict &&
      Number.isSafeInteger(row.fulfillmentDeadlines?.readyToShipSlaAt)).map(row => ({ orderId: row.orderId, route: row.route,
        ...row.fulfillmentDeadlines })).sort((a, b) => a.readyToShipSlaAt - b.readyToShipSlaAt);
    const domesticShippingDocuments = (shipmentChecks ?? []).flatMap(row => {
      const [pkg] = row.packages;
      const shipping = pkg?.shipping;
      if (row.route !== 'china_direct' || row.packageWarehouseConflict || row.packages.length !== 1 ||
          !pkg.belongsToOriginalOrder) return [];
      const stillPending = row.orderStatus === 'AWAITING_SHIPMENT' && pkg.status === 'TO_FULFILL';
      verifiedDomesticPending.set(row.orderId, { orderId: row.orderId, packageId: pkg.packageId, observedAt: followup.observedAt, stillPending });
      if (!stillPending || !shipping) return [];
      const requested = (endpoint, code, requestId) => requestId && followup.trace?.some(call => call.method === 'GET' &&
        call.path === `/fulfillment/202309/packages/${pkg.packageId}/${endpoint}` && call.status === 200 &&
        call.code === code && call.requestId === requestId);
      const canDropOff = typeof shipping.canDropOff === 'boolean' && requested('handover_time_slots', 0, shipping.handoverRequestId)
        ? shipping.canDropOff : null;
      const labelAvailable = typeof shipping.labelAvailable === 'boolean' && [0, 21042104].includes(shipping.labelCode) &&
        (shipping.labelCode === 0 || shipping.labelAvailable === false) &&
        requested('shipping_documents', shipping.labelCode, shipping.labelRequestId) ? shipping.labelAvailable : null;
      const packing = domesticPacking.get(row.orderId);
      if (packing?.packageId === pkg.packageId && packing.state === 'packing_inputs_verified' &&
          Date.parse(followup.observedAt) >= Date.parse(packing.shippingObservedAt ?? packing.observedAt)) {
        Object.assign(packing, { canDropOff, labelAvailable, hasTrackingNumber: pkg.hasTrackingNumber,
          shippingSource: followupSource, shippingObservedAt: followup.observedAt });
      }
      return [{ orderId: row.orderId, packageId: pkg.packageId, canDropOff, labelAvailable, hasTrackingNumber: pkg.hasTrackingNumber }];
    });
    for (const row of shipmentChecks ?? []) if (row.packageWarehouseConflict) shipmentWarehouseConflicts.add(row.orderId);
    packageFollowup = { source: followupSource, observedAt: followup.observedAt, ...followup.summary, wms, shipmentWms, domesticCollection,
      collectionTransition: collectionTransitionEvidence(followup.collectionTransition, followup, directory, receipt),
      shipmentDeadlines, domesticShippingDocuments, shipmentWarehouseConflicts: verifiedShipment ? shipmentWarehouseConflicts.size : null,
      knownCollectionDeadlines: deadlines.length,
      earliestCollectionDeadline: deadlines.length ? new Date(Math.min(...deadlines) * 1000).toISOString() : null };
    break;
  }
  return { source, observedAt: receipt.observedAt, orderSource: receipt.orderSource ?? 'saved_catalog', orderWindow: receipt.orderWindow,
    summary: receipt.summary, packageFollowup, domesticShipmentReadbacks: [...domestic.values()],
    domesticFulfillmentControl: domesticFulfillmentControls(directory, day, shopId),
    domesticPacking: [...domesticPacking.values()].filter(row => !shipmentWarehouseConflicts.has(row.orderId) &&
      retainDomesticPacking(row, receipt.observedAt, verifiedDomesticPending.get(row.orderId))).map(row => ({ ...row,
      priorWarehouseEvidence: Date.parse(row.observedAt) < Date.parse(receipt.observedAt) })),
    shipmentStock: [...shipmentStock.values()].filter(row => !shipmentWarehouseConflicts.has(row.orderId)), domesticPackingRefresh, refreshError,
    packageRefreshError: packageRefresh?.available === false ? packageRefresh.error : null };
}

function handoffEvidence(day, shopId) {
  const directory = join(root, 'outputs/operations-handoff-reconciliation', day);
  const filename = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().at(-1);
  if (!filename) throw new Error('No reconciled handoff receipt for ' + day);
  const source = join(directory, filename);
  const receipt = json(source);
  if (receipt.schema !== 'operations-handoff-reconciliation/v1' || receipt.shop?.id !== shopId ||
      receipt.shop.region !== 'MY' || receipt.day !== day || !Array.isArray(receipt.candidates) ||
      dateFormat.format(new Date(receipt.observedAt)) !== day) throw new Error('Handoff receipt does not match the current shop and day');
  const summary = { total: receipt.candidates.length, live: 0, draft: 0, noMatch: 0, unresolved: 0 };
  for (const row of receipt.candidates) {
    const matches = row.result?.products;
    if (!row.available || !Array.isArray(matches) || matches.length > 1) summary.unresolved++;
    else if (matches.length === 0) summary.noMatch++;
    else if (matches[0].state === 'ACTIVATE' && matches[0].audit === 'APPROVED') summary.live++;
    else if (matches[0].state === 'DRAFT') summary.draft++;
    else summary.unresolved++;
  }
  return { source, observedAt: receipt.observedAt, summary, candidates: receipt.candidates, production: receipt.production };
}

function pilotPricingReview(directory, listing) {
  if (!directory || !listing) return null;
  const source = join(directory, 'pricing-review.json');
  if (!existsSync(source)) return null;
  const receipt = json(source);
  const money = /^\d+\.\d{2}$/u;
  if (receipt.schema !== 'operations-pilot-pricing-review/v1' || receipt.shopId !== listing.shopId ||
      receipt.market !== 'MY' || receipt.currency !== 'MYR' || receipt.productId !== listing.productId ||
      receipt.skuId !== listing.skuId || receipt.sellerSku !== listing.sellerSku || !Array.isArray(receipt.models) ||
      !receipt.models.length || !Number.isFinite(Date.parse(receipt.reviewedAt)) ||
      !Array.isArray(receipt.sources) || !receipt.sources.length ||
      receipt.sources.some(entry => typeof entry.file !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '') ||
        createHash('sha256').update(readFileSync(resolve(root, entry.file))).digest('hex') !== entry.sha256) ||
      receipt.models.some(row => ![row.regularPrice, row.firstStagePrice, row.secondStagePrice].every(price => typeof price === 'string' && money.test(price)) ||
        Math.round(Number(row.regularPrice) * 57) !== Math.round(Number(row.firstStagePrice) * 100) ||
        Math.round(Number(row.regularPrice) * 50) !== Math.round(Number(row.secondStagePrice) * 100)) ||
      receipt.platformPriceWritten !== false) throw new Error('Pricing review does not match the exact pilot listing or calculated stages');
  return { ...receipt, source };
}

function pilotPlatformCheck(directory, listing) {
  if (!directory || !listing) return null;
  const liveDirectory = join(directory, 'live');
  const files = readdirSync(liveDirectory).filter(file => /^platform-check-.*\.json$/u.test(file)).sort().reverse();
  if (!files.length) return null;
  const original = json(join(liveDirectory, 'create.intent.json'));
  const created = json(join(liveDirectory, 'create.result.json'));
  const checkPayloadHash = createHash('sha256').update(JSON.stringify(original.plan.check.body)).digest('hex');
  for (const file of files) {
    const source = join(liveDirectory, file);
    const receipt = json(source);
    if (receipt.schema === 'operations-live-listing-platform-check/v1' && receipt.shopId === listing.shopId &&
        receipt.sellerSku === listing.sellerSku && receipt.productId === listing.productId && receipt.skuId === listing.skuId &&
        receipt.originalCreateRequestId === created.requestId && receipt.originalPayloadHash === original.plan.payloadHash &&
        receipt.checkPayloadHash === checkPayloadHash && receipt.shopWrites === 0 && receipt.mediaUploads === 0 &&
        receipt.listing?.status === 'LIVE_VERIFIED' && typeof receipt.requestId === 'string' && receipt.requestId &&
        typeof receipt.productRequestId === 'string' && receipt.productRequestId && ['PASS', 'FAILED'].includes(receipt.state)) {
      return { ...receipt, source };
    }
  }
  return null;
}

function promotionReadiness(day, shopId) {
  const directory = join(root, 'outputs/operations-promotion-readiness', day);
  if (!existsSync(directory)) return [];
  const latest = new Map();
  for (const filename of readdirSync(directory).filter(file => /^readiness-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, filename);
    const receipt = json(source);
    if (receipt.schema !== 'operations-promotion-candidate-readiness/v1' || receipt.shop?.id !== shopId ||
        receipt.shop.region !== 'MY' || receipt.shop.name !== 'example-shop-my' || receipt.day !== day ||
        !isPlatformId(receipt.productId) || !isPlatformId(receipt.skuId) || latest.has(receipt.skuId)) continue;
    latest.set(receipt.skuId, { ...receipt, source });
  }
  return [...latest.values()];
}

function savedNewArrivalSales(directory, item, day, shopId) {
  for (const name of readdirSync(directory).filter(file => /^new-arrival-sales-history-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, name);
    const row = json(source);
    if (row.schema !== 'operations-new-arrival-sales-history/v1' || row.writes !== 0 || row.shop?.id !== shopId ||
        row.shop.region !== 'MY' || row.shop.name !== 'example-shop-my' || row.productId !== item.productId || row.skuId !== item.skuId ||
        !row.productRequestId || !Number.isFinite(Date.parse(row.observedAt)) || dateFormat.format(new Date(row.observedAt)) !== day ||
        !row.windows?.length || !Number.isSafeInteger(row.productCreatedAt) || !Number.isSafeInteger(row.orderCutoffExclusive) ||
        row.orderCutoffExclusive * 1000 > Date.parse(row.observedAt) ||
        row.windows.some((window, index) => window.startInclusive !== (row.windows[index - 1]?.endExclusive ?? row.productCreatedAt) ||
          !Number.isSafeInteger(window.endExclusive) || window.endExclusive <= window.startInclusive ||
          !Number.isSafeInteger(window.orders) || window.orders < 0 || !Number.isSafeInteger(window.pages) || window.pages < 1 ||
          window.requestIds?.length !== window.pages || window.requestIds.some(id => typeof id !== 'string' || !id)) ||
        row.windows.at(-1).endExclusive !== row.orderCutoffExclusive || row.windows.reduce((sum, window) => sum + window.orders, 0) !== row.shopOrders ||
        !Array.isArray(row.matches) || row.matches.length !== row.matchingProductOrders ||
        row.matches.filter(match => match.lines?.some(line => line.id === item.skuId)).length !== row.matchingSkuOrders) continue;
    return { ...row, source };
  }
  return null;
}

async function promotionSalesHistory(day, shopId, candidates, session, refresh) {
  const items = candidates.filter(row => row.routes?.requestedTool?.type === 'NEW_ARRIVAL_DISCOUNT');
  if (!items.length) return [];
  const directory = join(root, 'outputs/operations-promotion-readiness', day);
  const histories = [];
  for (const item of items) {
    const saved = savedNewArrivalSales(directory, item, day, shopId);
    if (!refresh) {
      if (saved) histories.push(saved);
      continue;
    }
    try {
      const receipt = await readNewArrivalSalesHistory(item, await session);
      if (dateFormat.format(new Date(receipt.observedAt)) !== day) throw new Error('Shop day changed during the new arrival check');
      const source = join(directory, 'new-arrival-sales-history-' + receipt.observedAt.replace(/[:.]/gu, '-') + '.json');
      await writeFile(source, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
      histories.push({ ...receipt, source });
    } catch (error) {
      if (!saved) throw error;
      histories.push({ ...saved, refreshError: publicPlatformError(error, 'New arrival order history refresh failed') });
    }
  }
  return histories;
}

function promotionToolCoverage(day, shopId) {
  const directory = join(root, 'outputs/operations-promotion-readiness', day);
  if (!existsSync(directory)) return null;
  for (const filename of readdirSync(directory).filter(file => /^merchant-tool-coverage-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, filename);
    const receipt = json(source);
    if (receipt.schema !== 'operations-promotion-tool-coverage/v1' || receipt.shop?.id !== shopId ||
        receipt.shop.region !== 'MY' || receipt.shop.name !== 'example-shop-my' || receipt.writes !== 0 ||
        !Number.isFinite(Date.parse(receipt.observedAt)) || dateFormat.format(new Date(receipt.observedAt)) !== day) continue;
    const newArrival = receipt.cases?.find(row => row.kind === 'seller_center_new_arrival_discount');
    const fixedPrice = receipt.cases?.find(row => row.kind === 'merchant_fixed_price_control');
    const getRequest = (row, code) => isPlatformId(row?.id) && receipt.requests?.some(request =>
      request.method === 'GET' && request.path === '/promotion/202309/activities/' + row.id &&
      request.status === 200 && request.code === code && request.requestId);
    if (newArrival?.available !== false || newArrival.code !== 17029036 || !getRequest(newArrival, newArrival.code) ||
        fixedPrice?.idMatches !== true || fixedPrice.type !== 'FIXED_PRICE' || fixedPrice.status !== 'ONGOING' || !getRequest(fixedPrice, 0) ||
        receipt.search?.status !== 'ONGOING' || !receipt.search.matchedExactIds?.includes(fixedPrice.id) ||
        receipt.search.matchedExactIds.includes(newArrival.id)) continue;
    return { source, observedAt: receipt.observedAt,
      newArrival: { id: newArrival.id, readState: 'activity_type_unsupported', code: newArrival.code },
      fixedPrice: { id: fixedPrice.id, readState: 'verified', status: fixedPrice.status } };
  }
  return null;
}

function opportunityEvidence(day, shopId) {
  const directory = join(root, 'outputs/operations-selection-opportunities', day);
  if (!existsSync(directory)) return null;
  for (const filename of readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, filename);
    const receipt = json(source);
    if (receipt.schema !== 'operations-selection-opportunities/v1' || receipt.shop?.id !== shopId ||
        receipt.shop.region !== 'MY' || receipt.shop.name !== 'example-shop-my' || receipt.day !== day || receipt.shopWrites !== 0 ||
        receipt.state !== 'research_leads' || !Array.isArray(receipt.categories) ||
        !Number.isSafeInteger(receipt.product?.platformCount) || !Number.isSafeInteger(receipt.keyword?.platformCount) ||
        receipt.product?.rows?.length !== receipt.product?.platformCount || receipt.keyword?.rows?.length !== receipt.keyword?.platformCount) continue;
    return { source, observedAt: receipt.observedAt, coverage: receipt.coverage, state: receipt.state,
      products: receipt.product.platformCount, keywords: receipt.keyword.platformCount, categories: receipt.categories, details: receipt.details };
  }
  return null;
}

async function selectionOpportunityEvidence(day, shopId, refresh) {
  const cached = opportunityEvidence(day, shopId);
  if (cached && !refresh) return cached;
  try {
    await runFile(process.execPath, [join(root, 'scripts/operations/run-selection-opportunities.mjs')],
      { cwd: root, windowsHide: true, timeout: 90_000 });
  } catch (error) {
    if (!cached) throw error;
    return { ...cached, refreshError: error.stderr?.trim() || error.message };
  }
  return opportunityEvidence(day, shopId);
}

export function matchesPaidWarehouseCohort(warehouseRows, original, current) {
  if (!Array.isArray(warehouseRows) || !warehouseRows.length) return false;
  const orderMap = receipt => new Map(receipt.rows.filter(row => ['DELIVERED', 'COMPLETED'].includes(row.status))
    .map(row => [row.orderId, row]));
  const before = orderMap(original);
  const after = orderMap(current);
  if ([before.size, after.size, original.summary.deliveredOrders, current.summary.deliveredOrders,
    new Set(warehouseRows.map(row => row.orderId)).size].some(size => size !== warehouseRows.length)) return false;
  return warehouseRows.every(row => {
    const old = before.get(row.orderId);
    const fresh = after.get(row.orderId);
    return old?.packageIds.includes(row.packageId) && fresh?.packageIds.includes(row.packageId) &&
      old.settlement.statementId === fresh.settlement.statementId &&
      old.settlement.quantity === fresh.settlement.quantity && Number(fresh.settlement.quantity) === row.itemQuantity &&
      old.settlement.net === row.platformSettlementNetMyr && fresh.settlement.net === row.platformSettlementNetMyr;
  });
}

function unitEconomicsEvidence(day, shopId, financeFile, followups) {
  return followups.flatMap(({ productId, skuId, versions }) => {
    if (!isPlatformId(skuId)) return [];
    const directory = join(root, 'outputs/operations-order-unit-economics', day, skuId);
    if (!existsSync(directory)) return [];
    const files = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse();
    for (const filename of files) {
      const source = join(directory, filename);
      const receipt = json(source);
      if (receipt.schema !== 'operations-order-unit-economics/v1' || receipt.shop?.id !== shopId ||
          receipt.shop.region !== 'MY' || receipt.day !== day || receipt.financeFile !== financeFile ||
          receipt.productId !== productId || receipt.skuId !== skuId || dateFormat.format(new Date(receipt.observedAt)) !== day) continue;
      const name = versions.at(-1)?.name?.split(' / ')[0] ?? skuId;
      const warehouseFiles = readdirSync(directory).filter(file => /^paid-warehouse-reconciliation-.*\.json$/u.test(file)).sort().reverse();
      let warehouse = null;
      for (const file of warehouseFiles) {
        const warehouseSource = join(directory, file);
        const candidate = json(warehouseSource);
        if (candidate.schema !== 'operations-paid-sku-warehouse-reconciliation/v1' || candidate.shop?.id !== shopId ||
            candidate.shop.region !== 'MY' || candidate.day !== day || candidate.financeFile !== financeFile ||
            candidate.productId !== productId || candidate.skuId !== skuId || candidate.platformWrites !== 0 ||
            typeof candidate.sources?.platform !== 'string') continue;
        const originalSource = resolve(root, candidate.sources.platform);
        if (!files.some(file => join(directory, file) === originalSource)) continue;
        const original = originalSource === source ? receipt : json(originalSource);
        if (original.schema !== receipt.schema || original.shop?.id !== shopId || original.shop.region !== 'MY' ||
            original.day !== day || original.financeFile !== financeFile || original.catalogFile !== receipt.catalogFile ||
            original.productId !== productId || original.skuId !== skuId ||
            !matchesPaidWarehouseCohort(candidate.rows, original, receipt)) continue;
        warehouse = { source: warehouseSource, observedAt: candidate.observedAt, ...candidate.warehouse,
          actualWarehouseDebit: candidate.actualWarehouseDebit, estimated: candidate.estimated };
        break;
      }
      return [{ source, observedAt: receipt.observedAt, productId, skuId, name, offer: receipt.offer, summary: receipt.summary,
        deliveredSettlementBreakdown: receipt.deliveredSettlementBreakdown ?? null, warehouse }];
    }
    return [];
  });
}

async function paidStatementTransitions(day, shopId, currentSource, paid, refreshCoverage) {
  const directory = join(root, 'outputs/operations-statement-payment', day);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory).sort().reverse();
  const wallets = files.filter(file => /^wallet-followup-.*\.json$/u.test(file)).map(file => {
    const source = join(directory, file);
    return { source, receipt: json(source) };
  });
  const seen = new Set();
  const results = [];
  for (const file of files.filter(name => /^transition-.*\.json$/u.test(name))) {
    const source = join(directory, file);
    const receipt = json(source);
    const statement = receipt.statement;
    const orders = receipt.cohort?.orders;
    if (receipt.schema !== 'operations-statement-payment-transition/v1' || receipt.shop?.id !== shopId || receipt.shop.region !== 'MY' ||
        receipt.platformWrites !== 0 || statement?.paymentStatus !== 'PAID' || statement.currency !== 'MYR' ||
        !isPlatformId(statement.id) || !isPlatformId(statement.paymentId) || seen.has(statement.id) ||
        typeof receipt.current !== 'string' || dirname(resolve(root, receipt.current)) !== dirname(currentSource) ||
        !Array.isArray(orders) || !orders.length || orders.length !== receipt.cohort.orderCount ||
        new Set(orders.map(row => row.orderId)).size !== orders.length ||
        !orders.every(row => paid.orders.some(order => order.orderId === row.orderId && order.net === row.net &&
          order.statementIds.length === 1 && order.statementIds[0] === statement.id)) ||
        !receipt.requests?.some(row => row.path === '/finance/202309/statements' && row.code === 0 && row.requestId)) continue;
    const originalPaid = resolve(root, receipt.current) === currentSource ? paid : json(resolve(root, receipt.current)).settlement?.paid;
    if (!Array.isArray(originalPaid?.orders) || !orders.every(row => originalPaid.orders.some(order =>
      order.orderId === row.orderId && order.net === row.net && order.statementIds.length === 1 && order.statementIds[0] === statement.id))) continue;
    const wallet = wallets.find(({ receipt: row }) => row.schema === 'operations-paid-statement-wallet-followup/v1' &&
      row.shop?.id === shopId && row.shop.region === 'MY' && row.platformWrites === 0 && row.statementId === statement.id &&
      row.paymentId === statement.paymentId && typeof row.source === 'string' && resolve(root, row.source) === source &&
      Array.isArray(row.exact) && row.requests?.some(request => request.path === '/finance/202309/withdrawals' &&
        request.code === 0 && request.requestId));
    let coverage = null;
    let coverageError = null;
    const orderWindow = json(resolve(root, receipt.current)).orderWindow;
    for (const filename of files.filter(name => /^statement-coverage-.*\.json$/u.test(name))) {
      const file = join(directory, filename);
      const row = json(file);
      if (row.schema !== 'operations-paid-statement-coverage/v1' || row.shop?.id !== shopId || row.shop.region !== 'MY' ||
          row.platformWrites !== 0 || typeof row.transitionSource !== 'string' || resolve(root, row.transitionSource) !== source ||
          row.statement?.id !== statement.id || row.statement.currency !== statement.currency ||
          row.statement.paymentId !== statement.paymentId || row.statement.paymentStatus !== 'PAID' ||
          row.windowOrderCount !== orders.length || row.windowOrderNet !== receipt.cohort.net ||
          row.orderWindow?.startInclusive !== orderWindow?.startInclusive || row.orderWindow?.endExclusive !== orderWindow?.endExclusive ||
          row.bankReceiptVerified !== false || !row.requests?.some(request => request.code === 0 && request.requestId &&
            request.path === `/finance/202501/statements/${statement.id}/statement_transactions`)) continue;
      coverage = { ...row, source: file };
      break;
    }
    if (refreshCoverage) {
      const checked = await inspect(async () => {
        const requests = [];
        const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
          const response = await fetch(url, options);
          const envelope = await response.clone().json().catch(() => null);
          requests.push({ path: url.pathname, status: response.status, code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
          return response;
        } });
        const detail = await readPaidStatementCoverage(client, token, shop, receipt, orderWindow);
        const observedAt = new Date().toISOString();
        const file = join(directory, `statement-coverage-${observedAt.replace(/[:.]/gu, '-')}-${statement.id}.json`);
        const data = { schema: 'operations-paid-statement-coverage/v1', observedAt, transitionSource: source,
          shop: { id: shop.id, name: shop.name, region: shop.region }, ...detail, requests, platformWrites: 0 };
        await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
        return { ...data, source: file };
      });
      coverage = checked.result ?? coverage;
      coverageError = checked.error ?? null;
    }
    seen.add(statement.id);
    results.push({ source, observedAt: receipt.observedAt, statementId: statement.id, paymentId: statement.paymentId,
      paymentTime: statement.paymentTime, statementPayable: statement.payable, currency: 'MYR',
      orderCount: orders.length, orderNet: receipt.cohort.net,
      wallet: wallet ? { source: wallet.source, observedAt: wallet.receipt.observedAt, exactLinks: wallet.receipt.exact.length } : null,
      coverage, coverageError, bankReceiptVerified: false });
  }
  return results;
}

async function refreshPaymentIndex(day, shopId, source, statements) {
  const candidates = statements.filter(statement => statement.status === 'SETTLED' && statement.currency === 'MYR' &&
    isPlatformId(statement.id) && Number.isSafeInteger(statement.createdAt));
  if (!candidates.length) return;
  const requests = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ path: url.pathname, status: response.status, responseCode: envelope?.code ?? null,
      requestId: envelope?.request_id ?? null });
    return response;
  } });
  const startInclusive = Math.min(...candidates.map(statement => statement.createdAt)) - 86_400;
  const endExclusive = Math.floor(Date.now() / 1000);
  const index = await collectPages(cursor => client.statementsPage(token, shop, startInclusive, endExclusive, cursor),
    Date.now() + 60_000);
  const matches = new Map(candidates.map(statement => [statement.id, matchStatementPayment(statement, index.rows)]));
  const paymentIds = new Set([...matches.values()].filter(row => row?.paymentStatus === 'PAID' && isPlatformId(row.paymentId))
    .map(row => row.paymentId));
  const payments = paymentIds.size ? await inspect(async () => {
    const seen = new Set();
    const page = await collectPages(async cursor => {
      const result = await client.paymentsPage(token, shop, startInclusive, endExclusive, cursor);
      for (const row of result.rows) {
        if (seen.has(row.id)) throw new Error('Duplicate payment ID in register');
        seen.add(row.id);
      }
      return result;
    }, Date.now() + 60_000);
    return { pages: page.pages, count: page.rows.length,
      exact: new Map(page.rows.filter(row => paymentIds.has(row.id)).map(row => [row.id, row])) };
  }) : null;
  const observedAt = new Date().toISOString();
  const directory = join(root, 'outputs/operations-statement-payment', day);
  await mkdir(directory, { recursive: true });
  for (const statement of candidates) {
    const exact = matches.get(statement.id);
    const registerRow = exact?.paymentStatus === 'PAID' ? payments?.result?.exact.get(exact.paymentId) ?? null : null;
    const report = { schema: 'operations-statement-payment/v1', observedAt, source,
      shop: { id: shop.id, name: shop.name, region: shop.region }, statement,
      window: { startInclusive, endExclusive },
      index: { all: { count: index.rows.length, pages: index.pages, exact: exact ? [exact] : [] } },
      paymentRegister: !payments ? null : payments.available ? { count: payments.result.count,
        pages: payments.result.pages, exact: registerRow } : { error: payments.error },
      bankReceiptVerified: false, requests };
    const file = join(directory, `official-read-${observedAt.replace(/[:.]/gu, '-')}-${statement.id}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

async function settlementEvidence(day, shopId, financeFile, { refresh, refreshPayments }) {
  if (!snapshotFilename.test(financeFile ?? '')) throw new Error('Current finance snapshot unavailable');
  if (refresh) {
    const snapshot = join(root, 'apps/customer-service/data/tiktok-shop', shopId, 'finance', financeFile);
    await runFile(process.execPath, [join(root, 'scripts/operations/run-settlement-reconciliation.mjs'), snapshot],
      { cwd: root, windowsHide: true, timeout: 120_000 });
  }
  const directory = join(root, 'outputs/operations-settlement-reconciliation', day);
  const files = readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse();
  let source, receipt;
  for (const filename of files) {
    const path = join(directory, filename);
    const candidate = json(path);
    if (candidate.schema === 'operations-settlement-reconciliation/v1' && candidate.shop?.id === shopId &&
        candidate.shop.region === 'MY' && candidate.day === day && candidate.financeFile === financeFile &&
        dateFormat.format(new Date(candidate.observedAt)) === day) {
      source = path;
      receipt = candidate;
      break;
    }
  }
  if (!receipt) throw new Error('Settlement reconciliation does not match the current finance snapshot');
  const { paid, estimated, currency, orderCount, remainingOrderCount, remainingByStatus } = receipt.settlement;
  let estimateTransition = null;
  let estimateRevision = null;
  let paidWindowComparison = null;
  for (const file of files) {
    const previousSource = join(directory, file);
    const previous = json(previousSource);
    if (previous.schema !== receipt.schema || previous.shop?.id !== shopId || previous.shop.region !== 'MY' ||
        previous.shop.name !== receipt.shop.name || previous.day !== day ||
        !(previous.orderWindow?.endExclusive <= receipt.orderWindow.endExclusive) ||
        !(Date.parse(previous.observedAt) < Date.parse(receipt.observedAt)) || !Array.isArray(previous.settlement?.estimated?.orders)) continue;
    if (!estimateRevision && previous.settlement.currency === currency && Array.isArray(estimated.orders)) {
      estimateRevision = { previousSource, previousObservedAt: previous.observedAt,
        ...compareUnsettledRevisions(previous.settlement.estimated.orders, estimated.orders) };
    }
    if (!estimateTransition && previous.financeFile !== financeFile && previous.orderWindow.endExclusive < receipt.orderWindow.endExclusive) {
      estimateTransition = { previousSource, previousObservedAt: previous.observedAt,
        ...compareEstimatedSettlements(previous.settlement.estimated.orders, [...paid.orders, ...receipt.deliveredDetails?.orders ?? []]) };
      paidWindowComparison = await inspect(() => {
        if (![previous.catalogFile, receipt.catalogFile].every(file => snapshotFilename.test(file ?? ''))) {
          throw new Error('Exact settlement catalog filenames are required');
        }
        const catalogDirectory = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
        return { previousSource, previousObservedAt: previous.observedAt,
          ...comparePaidOrderWindows(previous, receipt, json(join(catalogDirectory, previous.catalogFile)),
            json(join(catalogDirectory, receipt.catalogFile))) };
      });
    }
    if (estimateTransition && estimateRevision) break;
  }
  const { orderCount: deliveredDetailCount = 0, net: deliveredDetailAmount = null, indexedPaidOrderCount,
    indexedPaidNet, paymentStatusUnknownCount } = receipt.deliveredDetails ?? {};
  const funds = receipt.sellerFunds;
  const paymentChecks = [];
  const statements = receipt.deliveredDetails?.statements ?? [];
  const paymentRefresh = refreshPayments
    ? await inspect(() => refreshPaymentIndex(day, shopId, source, statements)) : null;
  const laterStatuses = new Map();
  const checked = new Set();
  const paymentDirectory = join(root, 'outputs/operations-statement-payment', day);
  if (existsSync(paymentDirectory)) {
    for (const filename of readdirSync(paymentDirectory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse()) {
      const file = join(paymentDirectory, filename);
      const check = json(file);
      const statement = statements.find(row => row.id === check.statement?.id);
      if (check.schema !== 'operations-statement-payment/v1' || check.shop?.id !== shopId || check.shop.region !== 'MY' ||
          !statement || check.statement.currency !== statement.currency || check.statement.createdAt !== statement.createdAt ||
          typeof check.source !== 'string' || resolve(root, check.source) !== source ||
          !(Date.parse(check.observedAt) > Date.parse(receipt.observedAt))) continue;
      const exact = matchStatementPayment(statement, check.index?.all?.exact ?? []);
      if (exact?.paymentStatus && !laterStatuses.has(statement.id)) laterStatuses.set(statement.id, exact.paymentStatus);
      if (!checked.has(statement.id)) {
        checked.add(statement.id);
        paymentChecks.push({ source: file, observedAt: check.observedAt, statement,
          indexed: Boolean(exact), paidIndexed: exact?.paymentStatus === 'PAID',
          paymentRegisterPaid: exact?.paymentStatus === 'PAID' && isPlatformId(exact.paymentId) &&
            check.paymentRegister?.exact?.id === exact.paymentId && check.paymentRegister.exact.status === 'PAID' &&
            check.requests?.some(request => request.path === '/finance/202605/payments' && request.responseCode === 0 &&
              request.status === 200 && request.requestId) ? true : null,
          bankReceiptVerified: check.bankReceiptVerified });
      }
    }
  }
  const paymentBreakdown = summarizeSettlementPayments(paid, receipt.deliveredDetails?.orders, laterStatuses);
  return { source, observedAt: receipt.observedAt, orderWindow: receipt.orderWindow, currency, orderCount,
    paidOrders: paid.orderCount, paidNet: paid.net, estimatedOrders: estimated.orderCount, estimatedNet: estimated.netEstimate,
    deliveredDetailCount, deliveredDetailAmount, indexedPaidOrderCount, indexedPaidNet, paymentStatusUnknownCount,
    sellerFunds: funds ? { state: funds.state, exactStatements: funds.matches.filter(row => row.exact.length > 0).length,
      bankReceiptVerified: funds.bankReceiptVerified } : null,
    paymentChecks, paymentBreakdown, estimateTransition, estimateRevision, paidWindowComparison,
    paidStatementTransitions: await paidStatementTransitions(day, shopId, source, paid, refreshPayments),
    paymentRefreshError: paymentRefresh?.available === false ? paymentRefresh.error : null,
    remainingOrderCount, remainingByStatus, costFollowups: receipt.costFollowups,
    unitEconomics: unitEconomicsEvidence(day, shopId, financeFile, receipt.costFollowups ?? []) };
}

function productFinanceFollowups(directory, reportSource, report) {
  const files = readdirSync(directory).sort().reverse();
  const sampleDeliveries = files.filter(name => /^sample-delivery-followup-.*\.json$/u.test(name)).map(name => {
    const source = join(directory, name);
    return { source, receipt: json(source) };
  });
  const checks = new Map();
  for (const filename of files.filter(name => /^order-type-followup-.*\.json$/u.test(name))) {
    const source = join(directory, filename);
    const typed = json(source);
    const row = report.rows?.find(item => item.productId === typed.productId);
    if (!row || checks.has(typed.productId) || typed.schema !== 'operations-product-order-type-followup/v1' || typed.shopWrites !== 0 ||
        typed.day !== report.day || typed.shop?.id !== report.shop.id || typed.shop.name !== report.shop.name || typed.shop.region !== 'MY' ||
        typeof typed.reviewSource !== 'string' || resolve(root, typed.reviewSource) !== reportSource ||
        typed.window?.startInclusive !== report.window.startInclusive || typed.window.endExclusive !== report.window.endExclusive ||
        typed.summary?.orders !== row.orderDetailOrders || typed.rows?.length !== row.orderDetailOrders ||
        typed.summary.settledSkuRows !== row.directSettlementSkuRows || typed.settlementRows?.length !== row.directSettlementSkuRows ||
        typeof typed.followupSource !== 'string') continue;
    const paymentSource = resolve(root, typed.followupSource);
    if (dirname(paymentSource) !== directory || !existsSync(paymentSource)) continue;
    const payment = json(paymentSource);
    if (payment.schema !== 'operations-product-payment-followup/v1' || payment.shop?.id !== report.shop.id || payment.shopWrites !== 0 ||
        payment.productId !== typed.productId || payment.reviewSource !== typed.reviewSource ||
        payment.summary?.exactSkuRows !== typed.summary.settledSkuRows || payment.summary.netMyr !== typed.summary.settledNetMyr) continue;
    const sample = typed.summary.negativeOrder;
    const delivery = sample?.sampleOrder === true ? sampleDeliveries.find(({ receipt }) =>
      receipt.schema === 'operations-exact-sample-delivery-followup/v1' && receipt.shop?.id === report.shop.id && receipt.shopWrites === 0 &&
      receipt.productId === typed.productId && receipt.orderId === sample.orderId && receipt.skuId === sample.skuId &&
      typeof receipt.source === 'string' && resolve(root, receipt.source) === source) : null;
    const application = delivery?.receipt.applications?.result?.rows;
    const exactApplication = application?.length === 1 && application[0].orderId === sample?.orderId &&
      application[0].productId === typed.productId ? application[0] : null;
    checks.set(typed.productId, { source, observedAt: typed.observedAt, productId: typed.productId, orderTypes: typed.summary,
      payment: { source: paymentSource, observedAt: payment.observedAt, ...payment.summary },
      sampleDelivery: delivery ? { source: delivery.source, observedAt: delivery.receipt.observedAt,
        applicationStatus: exactApplication?.status ?? null, fulfillmentStatus: exactApplication?.fulfillmentStatus ?? null,
        contentReadVerified: delivery.receipt.fulfillment?.available === true } : null });
  }
  return [...checks.values()];
}

async function productFinanceEvidence(day, shopId, financeFile, refresh) {
  if (!snapshotFilename.test(financeFile ?? '')) throw new Error('Current finance snapshot unavailable');
  let refreshError = null;
  if (refresh) {
    const snapshot = join(root, 'apps/customer-service/data/tiktok-shop', shopId, 'finance', financeFile);
    try {
      await runFile(process.execPath, [join(root, 'scripts/operations/run-product-finance-review.mjs'), snapshot],
        { cwd: root, windowsHide: true, timeout: 90_000 });
    } catch (error) {
      refreshError = error.stderr?.trim() || error.message;
    }
  }
  const directory = join(root, 'outputs/operations-product-finance-review', day);
  if (!existsSync(directory) && refreshError) throw new Error(refreshError);
  for (const filename of readdirSync(directory).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse()) {
    const source = join(directory, filename);
    const receipt = json(source);
    if (receipt.schema !== 'operations-product-finance-review/v1' || receipt.shop?.id !== shopId || receipt.shop.region !== 'MY' ||
        receipt.day !== day || receipt.financeFile !== financeFile || dateFormat.format(new Date(receipt.observedAt)) !== day) continue;
    return { source, observedAt: receipt.observedAt, window: receipt.window, summary: receipt.summary,
      mostOrdered: receipt.mostOrdered, settlementSource: receipt.directSettlementSource,
      followups: productFinanceFollowups(directory, source, receipt), refreshError };
  }
  throw new Error(refreshError ?? 'No product review for the current finance snapshot');
}

async function main() {
  const { values } = parseArgs({ options: { 'shadow-receipt': { type: 'string' }, 'pilot-dir': { type: 'string' },
    'refresh-handoffs': { type: 'boolean' },
    'refresh-ads': { type: 'boolean' }, 'refresh-video-analytics': { type: 'boolean' },
    'refresh-settlement': { type: 'boolean' }, 'refresh-statement-payments': { type: 'boolean' }, 'refresh-service-fulfillment': { type: 'boolean' },
    'refresh-fulfillment-routing': { type: 'boolean' }, 'refresh-pending-packages': { type: 'boolean' },
    'read-overseas-wms': { type: 'boolean' }, 'read-domestic-wms': { type: 'boolean' },
    'fulfillment-wms-evidence': { type: 'string', multiple: true },
    'refresh-product-finance': { type: 'boolean' }, 'refresh-selection-opportunities': { type: 'boolean' },
    'refresh-promotion-sales': { type: 'boolean' }, 'refresh-promotion-checkout': { type: 'boolean' } } });
  if ((values['read-overseas-wms'] || values['read-domestic-wms']) && !values['refresh-pending-packages']) {
    throw new Error('Warehouse reads require --refresh-pending-packages');
  }
  if (process.platform === 'win32' && process.env.SystemRoot) {
    process.env.PSModulePath = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  const day = dateFormat.format(new Date());
  const defaults = json(join(root, 'config/operations-trial-defaults.json'));
  const policy = limits(json(join(root, 'operations/module-execution-policy.json')));
  const pilotDirectory = values['pilot-dir'] ? resolve(values['pilot-dir']) :
    defaults.trackedPromotionPilot && join(root, defaults.trackedPromotionPilot);
  const pilot = pilotDirectory ? await inspect(() => readPilotChain(pilotDirectory, defaults.shopId)) : null;
  const session = openMyShopSession(defaults.shopId);
  const [board, finance, publishing, products, selection, ads, support, handoff, shopVideos, livePilotOutcome,
    fulfillmentRouting, listingCandidates, selectionOpportunities, selectionHandoffs, shopChannelPerformance, videoOverview] = await Promise.all([
    inspect(async () => {
      const response = await fetch('http://127.0.0.1:3377/api/operations', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Operations board unavailable');
      return (await response.json()).current;
    }),
    inspect(() => {
      const data = reviewFinanceSnapshot();
      const pilotTerms = pilot?.result?.promotion.pilot;
      const pilotSettlement = pilotTerms ? reviewPilotOrders(pilotTerms,
        json(join(root, 'apps/customer-service/data/tiktok-shop', defaults.shopId, data.catalogFile)), data) : null;
      return { observedAt: data.financeCollectedAt, file: data.financeFile,
        summary: data.summary, costReviewQueue: data.costReviewQueue, pilotSettlement };
    }),
    inspect(() => publisherShadow(values['shadow-receipt'])),
    inspect(async () => productSignals(await session, day)),
    inspect(async () => selectionSample(await session)),
    inspect(() => gmvMaxEvidence(day, defaults.shopId, values['refresh-ads'])),
    inspect(() => serviceFulfillmentEvidence(day, defaults.shopId, values['refresh-service-fulfillment'])),
    inspect(async () => {
      if (values['refresh-handoffs']) await runFile(process.execPath, [join(root, 'scripts/operations/run-handoff-reconciliation.mjs')],
        { cwd: root, windowsHide: true, timeout: 150_000 });
      return handoffEvidence(day, defaults.shopId);
    }),
    inspect(() => shopVideoEvidence(day, defaults.shopId, values['refresh-video-analytics'])),
    pilot?.available ? inspect(async () => {
      const promotion = pilot.result.promotion;
      return readLivePilotOutcome(promotion.pilot, promotion.activityId, await session, { includeBuyerUrl: true });
    }) : null,
    inspect(() => fulfillmentRoutingEvidence(day, defaults.shopId, {
      refresh: values['refresh-fulfillment-routing'], wmsEvidence: values['fulfillment-wms-evidence'],
      refreshPackages: values['refresh-pending-packages'], readOverseasWms: values['read-overseas-wms'],
      readDomesticWms: values['read-domestic-wms'],
    })),
    inspect(async () => readDailyListingCandidates(day, await session)),
    inspect(() => selectionOpportunityEvidence(day, defaults.shopId, values['refresh-selection-opportunities'])),
    inspect(async () => readDailySelectionHandoffs(day, await session)),
    inspect(async () => readShopChannelPerformance(await session, day)),
    inspect(async () => {
      const { client, token, shop } = await session;
      return readTodayVideoOverview(client, token, shop, day);
    }),
  ]);
  const roles = Object.fromEntries((board.result?.modules ?? []).map(module => [module.id, module]));
  const shopChannelOrders = shopChannelPerformance.available ? await inspect(async () =>
    readShopChannelOrders(await session, shopChannelPerformance.result)) : null;
  const adsDirectory = join(root, 'outputs/ads-monitoring');
  const latestAdsDirectory = await inspect(() => readdirSync(adsDirectory).filter(name => /^\d{4}-\d{2}-\d{2}$/u.test(name)).sort().at(-1));
  const operatingReview = await inspect(() => settlementEvidence(day, defaults.shopId, finance.result?.file, {
    refresh: values['refresh-settlement'], refreshPayments: values['refresh-statement-payments'],
  }));
  const productFinance = await inspect(() => productFinanceEvidence(day, defaults.shopId, finance.result?.file, values['refresh-product-finance']));
  const adsProductReview = ads.available ? await inspect(() => {
    const report = json(ads.result.source);
    if (!report.completeDays.productReports) return null;
    const productSource = productFinance.result?.source;
    const videoSource = shopVideos.result?.source;
    const finances = productSource ? json(productSource) : null;
    const catalogSource = snapshotFilename.test(finances?.catalogFile ?? '')
      ? join(root, 'apps/customer-service/data/tiktok-shop', defaults.shopId, finances.catalogFile) : null;
    if (catalogSource && finances.rows.some(row => !Array.isArray(row.orderDays) || row.orderDays.some(entry => !Number.isSafeInteger(entry.exactLineItems)))) {
      const catalog = json(catalogSource);
      if (catalog.shop?.id !== defaults.shopId || catalog.shop.region !== 'MY' ||
          catalog.orderWindow.startInclusive > finances.window.startInclusive ||
          catalog.orderWindow.endExclusive < finances.window.endExclusive) throw new Error('GMV Max order cohort source mismatch');
      const orderDays = new Map(compareProductFinance(finances.rows, catalog.orders.rows, [], finances.window).rows
        .map(row => [row.productId, row.orderDays]));
      finances.rows = finances.rows.map(row => ({ ...row, orderDays: orderDays.get(row.productId) }));
    }
    return { ...reviewGmvMaxProducts(report, finances, videoSource && json(videoSource)),
      affiliateCreativeMatches: affiliateCreativeEvidence(day, ads.result.source, report),
      sources: { ads: ads.result.source, productFinance: productSource ?? null, catalog: catalogSource, shopVideo: videoSource ?? null } };
  }) : null;
  const adDecisions = ads.available ? await inspect(() => {
    const result = reviewAircraftCreativeDecisions(json(ads.result.source));
    return result ? { ...result, source: ads.result.source, refreshError: ads.result.refreshError } : null;
  }) : null;
  const growth = await inspect(() => growthReview(ads.result, shopVideos.result, productFinance.result));
  const promotionCandidates = await inspect(() => promotionReadiness(day, defaults.shopId));
  const candidates = promotionCandidates.result ?? [];
  const liveListing = pilot?.result?.listing;
  const promotionItems = liveListing && !candidates.some(row => row.skuId === liveListing.skuId) ? [...candidates, liveListing] : candidates;
  const [promotionInventory, merchantPreflight, promotionSales, promotionCheckout] = await Promise.all([
    inspect(async () => promotionItems.length ? readPromotionInventory(promotionItems, await session) : null),
    inspect(async () => promotionItems.length ? readMerchantPromotionPreflight(promotionItems, await session) : null),
    inspect(() => promotionSalesHistory(day, defaults.shopId, candidates, session, values['refresh-promotion-sales'])),
    values['refresh-promotion-checkout'] ? inspect(refreshActivePromotionCheckout) : null,
  ]);
  const pricing = await inspect(() => pilotPricingReview(pilotDirectory, pilot?.result?.listing));
  const repricing = pricing.result && livePilotOutcome?.available ? await inspect(() =>
    planPilotRepricing(pricing.result, pilot.result.promotion.pilot, livePilotOutcome.result)) : null;
  const marketComparison = pricing.result ? await inspect(() => {
    const source = join(pilotDirectory, `market-comparison-${day}.json`);
    if (!existsSync(source)) return null;
    const evidence = json(source);
    if (evidence.schema !== 'operations-pilot-market-comparison/v1' || evidence.shopId !== defaults.shopId ||
        evidence.productId !== pricing.result.productId || evidence.skuId !== pricing.result.skuId ||
        evidence.platformWrites !== 0 || !Number.isFinite(Date.parse(evidence.observedAt)) ||
        dateFormat.format(new Date(evidence.observedAt)) !== day) throw new Error('Market comparison does not match the current pilot');
    return { source, observedAt: evidence.observedAt, retailer: evidence.retailer,
      ...comparePilotMarketPrice(evidence, pricing.result.models, repricing?.result?.regularPrice ?? null) };
  }) : null;
  const listingPlatformCheck = await inspect(() => pilotPlatformCheck(pilotDirectory, pilot?.result?.listing));
  const promotionCoverage = await inspect(() => promotionToolCoverage(day, defaults.shopId));
  const supportTriage = support.available ? await inspect(() => ({ source: support.result.source, ...reviewSupportTriage(json(support.result.source)) })) : null;
  const returnQuality = await inspect(() => returnQualityEvidence(day, defaults.shopId));
  const ledger = getLedger(day);
  const apiPreflight = await inspect(() => publisherApiPreflight(day, defaults.shopId, handoff.result?.production));
  const pilotPaymentReconciliation = linkPilotStatementPayments(livePilotOutcome?.result?.orderEconomics, finance.result?.pilotSettlement);
  const result = { schema: 'operations-daily-work/v1', day, recordedAt: new Date().toISOString(),
    defaults, board, finance, operatingReview, productFinance, shopChannelPerformance, shopChannelOrders,
    selection: { ...selection, handoff, dailyHandoffs: selectionHandoffs, opportunities: selectionOpportunities },
    products, growth, pilot, pricing, repricing, marketComparison, livePilotOutcome, pilotPaymentReconciliation,
    promotion: { receipt: roles.promotion ?? null, defaults: defaults.newArrivalDiscount, candidates: promotionCandidates, inventory: promotionInventory,
      toolCoverage: promotionCoverage, merchantPreflight, salesHistory: promotionSales, checkout: promotionCheckout },
    listing: { receipt: roles.listing ?? null, defaults: defaults.newListing, candidates: listingCandidates, platformCheck: listingPlatformCheck },
    production: { receipt: roles.production ?? null, input: 'qualified_new_listing_and_product_followups',
      handoff: handoff.result?.production ?? null },
    publishing: { policy, ledger, shadow: publishing, apiPreflight, shopVideos, videoOverview, platformTotalVerified: false },
    fulfillment: { receipt: roles.fulfillment ?? null, officialRead: support.result?.packageOrderLinkage ?? null, routing: fulfillmentRouting },
    ads: { receipt: roles.ads ?? null, latestLocalDirectory: latestAdsDirectory, officialRead: ads,
      currentSpendVerified: ads.available && !ads.result?.refreshError, productReview: adsProductReview, decisions: adDecisions },
    service: { receipt: roles.service ?? null, officialRead: support, triage: supportTriage, returnQuality } };
  const directory = join(root, 'outputs/operations-daily-work', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'review-' + result.recordedAt.replace(/[:.]/gu, '-') + '-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  const currentListing = livePilotOutcome?.result?.listing;
  const settlement = finance.result?.pilotSettlement;
  const observedPilotOrders = settlement && settlement.snapshotWindow.endExclusive > settlement.pilotWindow.startInclusive &&
    settlement.snapshotWindow.startInclusive < settlement.pilotWindow.endExclusive ? settlement.orders.length : null;
  console.log(JSON.stringify({ file, day, productCount: products.result?.count ?? null,
    productFollowups: products.result?.followups.length ?? null, productError: products.error ?? null,
    growthReview: growth.result ? { creativeReviewCount: growth.result.creativeReviews.length,
      checkoutReviewCount: growth.result.checkoutReviews.length } : null, growthError: growth.error ?? null,
    selectionLeads: selection.result?.count ?? null, selectionError: selection.error ?? null,
    selectedCategoryOpportunities: selectionOpportunities.result ? {
      source: selectionOpportunities.result.source, products: selectionOpportunities.result.products,
      keywords: selectionOpportunities.result.keywords, categories: selectionOpportunities.result.categories.length,
    } : null,
    selectedCategoryOpportunitiesError: selectionOpportunities.error ?? selectionOpportunities.result?.refreshError ?? null,
    dailySelectionHandoffs: selectionHandoffs.result?.rows ?? null, dailySelectionHandoffsError: selectionHandoffs.error ?? null,
    confirmedVideoIds: ledger.confirmedVideoIds, ledgerPresent: ledger.available, publishingTarget: policy.total,
    todayVideoTraffic: videoOverview.result?.rows?.find(row => row.accountType === 'ALL') ?? null,
    todayVideoTrafficError: videoOverview.error ?? null,
    shadowReady: publishing.result?.accepted ?? null, shadowError: publishing.error ?? null,
    publisherApiPreflight: apiPreflight.result?.conclusion ?? null,
    shopVideoAnalytics: shopVideos.result?.summary ?? null, shopVideoAnalyticsError: shopVideos.error ?? null,
    financeCostFollowups: finance.result?.costReviewQueue.length ?? null,
    pilotListing: currentListing?.status === 'ACTIVATE' && currentListing.auditStatus === 'APPROVED'
      ? 'LIVE_VERIFIED' : currentListing?.status ?? null,
    pilotRegularPrice: currentListing?.regularPrice ?? null,
    pilotBuyerUrl: currentListing?.buyerUrl ?? null,
    promotionInventory: promotionInventory.result ?? null, promotionInventoryError: promotionInventory.error ?? null,
    pilotListingPlatformCheck: listingPlatformCheck.result?.state ?? null,
    pilotPricing: pricing.result?.models ?? null, pilotPricingError: pricing.error ?? null,
    repricing: repricing?.result ?? null, repricingError: repricing?.error ?? null,
    dailyListingCandidates: listingCandidates.result?.rows.map(row => ({ sku: row.sku, salePrice: row.salePrice,
      validatedDraft: row.validatedDraft?.result ?? null, draftError: row.validatedDraft?.error ?? null, shadow: row.shadow,
      missingFields: row.local.fields ?? [], matches: row.official.matches ?? null, officialError: row.official.error ?? null })) ?? null,
    dailyListingCandidatesError: listingCandidates.error ?? null,
    pilotPromotion: livePilotOutcome?.result?.activity.state ?? null, pilotError: livePilotOutcome?.error ?? pilot?.error ?? null,
    promotionCandidates: promotionCandidates.result?.map(row => ({ sku: row.sellerSku, state: row.state, trial: row.trial,
      pending: row.pending, source: row.source })) ?? null,
    promotionCandidatesError: promotionCandidates.error ?? null,
    promotionCheckout: promotionCheckout?.result ?? null, promotionCheckoutError: promotionCheckout?.error ?? null,
    merchantPromotionPreflight: merchantPreflight.result?.map(row => ({ sku: row.product.sellerSku,
      couponCheck: row.couponCheck, activities: row.activities, openAffiliate: row.openAffiliate })) ?? null,
    merchantPromotionPreflightError: merchantPreflight.error ?? null,
    observedPilotOrders: livePilotOutcome?.result?.orders?.exactOrderRows.length ?? null,
    exactPilotCheckoutOrders: livePilotOutcome?.result?.orderEconomics?.filter(row => row.checkout).length ?? null,
    exactPilotSettlementReferences: livePilotOutcome?.result?.orderEconomics?.filter(row => row.settlement).length ?? null,
    paidPilotOrdersFromLiveStatementIndex: livePilotOutcome?.result?.statementPayments?.state === 'index_read'
      ? livePilotOutcome.result.statementPayments.orders.filter(row => row.paymentStatus === 'PAID').length : null,
    pilotOrderDetailError: livePilotOutcome?.result?.orderEconomicsError ?? null,
    paidPilotOrdersVerified: pilotPaymentReconciliation?.filter(row => row.paidStatementVerified).length ?? null,
    pilotWindowCovered: livePilotOutcome?.result?.orders?.wholePilotCovered ?? null,
    financeMatchedPilotOrders: observedPilotOrders, financePilotWindowCovered: settlement?.windowCovered ?? null,
    gmvMaxSpendVerified: result.ads.currentSpendVerified, gmvMaxTodaySpend: ads.result?.today.cost ?? null,
    gmvMaxCurrency: ads.result?.currency ?? null, gmvMaxError: ads.error ?? ads.result?.refreshError ?? null,
    gmvMaxProductReview: adsProductReview?.result?.rows.map(row => ({ productId: row.productId, report: row.ads,
      productReadError: row.productReadError, creativeReadError: row.creativeReadError, linkedVideos: row.creative?.matchedOriginalVideos ?? null,
      sameWindow: row.sameWindow })) ?? null,
    gmvMaxProductReviewError: adsProductReview?.error ?? null,
    gmvMaxDecisions: adDecisions?.result ?? null, gmvMaxDecisionsError: adDecisions?.error ?? null,
    supportOrderLinks: support.result?.caseLinkage?.data?.orderDetailsConfirmed ?? null,
    inboxPages: support.result?.conversations?.data?.pages ?? null,
    unreadConversations: support.result?.conversations?.data?.unreadConversations ?? null,
    unreadWithVerifiedOrder: support.result?.caseLinkage?.data?.unreadWithVerifiedOrder ?? null,
    verifiedCollectionPackages: support.result?.packageOrderLinkage?.data?.confirmedAwaitingCollection ?? null,
    verifiedPackageTracking: support.result?.packageOrderLinkage?.data?.collection?.exactTrackingReadbacks ?? null,
    collectionCarrierChecks: support.result?.packageOrderLinkage?.data?.collection?.needsCarrierCheck ?? null,
    fulfillmentRouting: fulfillmentRouting.result?.summary ?? null,
    fulfillmentRoutingError: fulfillmentRouting.error ?? fulfillmentRouting.result?.refreshError ?? null,
    returnRequests: support.result?.returns?.data?.records ?? null,
    exactReturnSkuMatches: support.result?.returns?.data?.exactOrderAndSkuMatches ?? null,
    supportTriage: supportTriage?.result?.routes ?? null, supportTriageError: supportTriage?.error ?? null,
    supportOrdersWithCancellationRecords: supportTriage?.result?.ordersWithCancellationRecords ?? null,
    supportPendingCancellationOrders: supportTriage?.result?.pendingCancellationOrders ?? null,
    verifiedReturnQualityCases: returnQuality.result ?? null, returnQualityError: returnQuality.error ?? null,
    supportEvidenceError: support.error ?? support.result?.refreshError ?? null, selectionHandoffSummary: handoff.result?.summary ?? null,
    operatingReview: operatingReview.result ?? null, operatingReviewError: operatingReview.error ?? null,
    productFinance: productFinance.result?.summary ?? null, productFinanceError: productFinance.error ?? productFinance.result?.refreshError ?? null,
    shopChannelPerformance: shopChannelPerformance.result ? { ...shopChannelPerformance.result.window,
      ...shopChannelPerformance.result.summary } : null, shopChannelPerformanceError: shopChannelPerformance.error ?? null,
    shopChannelOrders: shopChannelOrders?.result?.summary ?? null, shopChannelOrdersError: shopChannelOrders?.error ?? null }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
