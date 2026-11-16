import { execFile } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dayKey } from './operations-board-evidence.mjs';
import { dashboardProductCoverUrl } from './operations-dashboard-images.mjs';
import { dashboardAdReceiptPattern, isDashboardAdReceipt, summarizeDashboardAdvertising } from './operations-dashboard-ads.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const shop = { id: '9000000000000000099', name: 'example-shop-my', region: 'MY' };
const timezone = 'Asia/Kuala_Lumpur';
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const ids = /^\d{14,22}$/u;
const accountPattern = /^[a-z0-9_.]{2,24}$/u;
const list = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const metricCount = value => /^\d+$/u.test(String(value)) ? count(Number(value)) : null;
const amount = value => typeof value === 'string' && /^-?\d+(?:\.\d{1,2})?$/u.test(value) ? value : null;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const exactShop = value => value?.id === shop.id && value?.name === shop.name && value?.region === shop.region;
const dayValid = day => datePattern.test(day ?? '') && stamp(`${day}T00:00:00Z`) &&
  new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const range = (start, endExclusive) => dayValid(start) && dayValid(endExclusive) && start < endExclusive
  ? { start, endExclusive } : null;
const sameRange = (window, start, endExclusive) => window.start === start && window.endExclusive === endExclusive;
const text = value => typeof value === 'string' ? value.trim().slice(0, 180) : null;
const source = (root, path, observedAt) => ({ path: relative(root, path).replace(/\\/gu, '/'), observedAt });
const byNewest = (a, b) => Date.parse(b.at) - Date.parse(a.at);
const videoReceiptPattern = /^official-read-[\w.-]+\.json$/u;
const dailyReceiptPattern = /^review-[\w.-]+\.json$/u;
const shopPerformanceDirectory = 'operations-dashboard-shop-performance';
const isShopPerformanceReceipt = value => exactShop(value.shop) &&
  value.schema === 'operations-dashboard-shop-performance/v1' && value.writes === 0 && dayValid(value.day);
const warehouseNames = [
  ['879', '好货来东莞', 'china_direct'], ['892', '好货来义乌', 'china_direct'],
  ['148', '神牛', 'malaysia_overseas'], ['80', '战马', 'malaysia_overseas'],
];
const receiptCache = new Map();
const receiptCacheMaxFiles = 384;
const receiptCacheMaxBytes = 40 * 1024 * 1024;
const receiptCacheMaxFileBytes = 1024 * 1024;
let receiptCacheBytes = 0;
const missingFile = error => ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code);

async function json(file) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error instanceof SyntaxError || missingFile(error)) return null;
    throw error;
  }
}

function forgetReceipt(file, entry) {
  receiptCache.delete(file);
  receiptCacheBytes -= entry.size;
}

function keepReceipt(file, entry) {
  if (entry.size > receiptCacheMaxFileBytes) return;
  while (receiptCache.size >= receiptCacheMaxFiles || receiptCacheBytes + entry.size > receiptCacheMaxBytes) {
    let oldest;
    for (const current of receiptCache) {
      if (!oldest || current[1].mtimeMs < oldest[1].mtimeMs) oldest = current;
    }
    // Keep newer receipts when a scan repeatedly walks more history than fits.
    if (!oldest || oldest[1].mtimeMs >= entry.mtimeMs) return;
    forgetReceipt(...oldest);
  }
  receiptCache.set(file, entry);
  receiptCacheBytes += entry.size;
}

async function receiptJson(file) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
  if (!info.isFile()) return null;
  const { size, ctimeMs, mtimeMs, dev, ino } = info;
  const fingerprint = [size, ctimeMs, mtimeMs, dev, ino].join('/');
  const cached = receiptCache.get(file);
  if (cached?.fingerprint === fingerprint) return cached.value;
  const value = await json(file);
  const previous = receiptCache.get(file);
  if (previous?.fingerprint === fingerprint) return previous.value;
  if (previous) forgetReceipt(file, previous);
  if (value !== null) keepReceipt(file, { value, fingerprint, size, mtimeMs });
  return value;
}

async function names(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
}

async function receiptPaths(directories, pattern) {
  return (await Promise.all(directories.map(async directory => (await names(directory))
    .filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => join(directory, entry.name))))).flat();
}

async function readReceipt(file, validate, timeField = 'observedAt') {
  const value = await receiptJson(file);
  const at = value?.[timeField];
  return stamp(at) && validate(value) ? { file, value, at } : null;
}

function routingFileTime(file) {
  // Routing writers derive immutable filenames from their observedAt timestamps.
  // Legacy filenames without an encoded time still use their JSON evidence.
  const match = /(?:^|[\\/])(?:official-read|shadow-run|domestic-packing)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.json$/u.exec(file);
  return match ? Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`) : NaN;
}

async function receipts(directories, pattern, validate, timeField = 'observedAt', notBefore = null) {
  const paths = await receiptPaths(directories, pattern);
  const candidates = notBefore === null ? paths : paths.filter(file => {
    const writtenAt = routingFileTime(file);
    return !Number.isFinite(writtenAt) || writtenAt >= notBefore;
  });
  return (await Promise.all(candidates.map(file => readReceipt(file, validate, timeField)))).filter(Boolean).sort(byNewest);
}

async function datedDirectories(root, path, day, limit) {
  const directory = join(root, 'outputs', path);
  return (await names(directory)).filter(entry => entry.isDirectory() && dayValid(entry.name) && entry.name <= day)
    .map(entry => entry.name).sort().reverse().slice(0, limit).map(name => join(directory, name));
}

function catalogue(day, boardSnapshot, saved) {
  const metrics = [boardSnapshot?.metrics, saved?.day === day ? saved.metrics : null].filter(row =>
    row?.shop === shop.name && stamp(row.collectedAt) && dayKey(new Date(row.collectedAt)) === day)
    .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))[0];
  if (!metrics) return null;
  return { activeProducts: count(metrics.activeProducts), productsTotal: count(metrics.productsTotal), orders7d: count(metrics.orders7d),
    pendingShipment: count(metrics.awaitingShipment), awaitingCollection: count(metrics.awaitingCollection),
    trend: list(metrics.trend).filter(row => dayValid(row.day) && count(row.count) !== null).map(({ day, count }) => ({ day, count })),
    source: { path: `apps/customer-service/data/operations-board/days/${day}.json`, observedAt: metrics.collectedAt } };
}

function validOrderActivity(row, day) {
  const dayStart = Date.parse(day + 'T00:00:00+08:00') / 1000;
  return row?.day === day && row.currency === 'MYR' &&
    stamp(row.observedAt) && dayKey(new Date(row.observedAt)) === day && count(row.paidOrders) !== null &&
    ['complete_for_order_window', 'partial'].includes(row.paymentCoverage) &&
    (row.paymentCoverage === 'partial' || amount(row.buyerPayment) !== null) &&
    Number.isSafeInteger(row.window?.startInclusive) && Number.isSafeInteger(row.window.endExclusive) &&
    row.window.startInclusive <= dayStart && row.window.endExclusive > dayStart && row.window.endExclusive < dayStart + 86_400 &&
    Array.isArray(row.requestIds) && row.requestIds.length > 0 && row.requestIds.every(id => typeof id === 'string' && id);
}

function currentOrderActivity(root, day, direct, boardSnapshot, saved) {
  const boardFile = join(root, 'apps/customer-service/data/operations-board/days', `${day}.json`);
  const candidates = [...direct.map(({ file, value }) => ({ file, activity: value.orderActivity })),
    ...[boardSnapshot, saved].filter(snapshot => snapshot?.day === day && snapshot.metrics?.shop === shop.name)
      .map(snapshot => ({ file: boardFile, activity: snapshot.metrics.orderActivity }))];
  const verified = candidates.filter(({ activity }) => validOrderActivity(activity, day));
  const selected = verified.sort((a, b) => b.activity.window.endExclusive - a.activity.window.endExclusive)[0];
  if (!selected) return null;
  const { activity: row, file } = selected;
  return { day, currency: 'MYR', paidOrders: row.paidOrders,
    buyerPayment: row.paymentCoverage === 'complete_for_order_window' ? amount(row.buyerPayment) : null,
    paymentCoverage: row.paymentCoverage, unknownSamplePayments: count(row.unknownSamplePayments),
    unknownAmounts: count(row.unknownAmounts), window: row.window, source: source(root, file, row.observedAt) };
}

const sameDaySales = (today, day) => today?.state === 'official_same_day_snapshot' &&
  today.day === day && today.requestId && dayValid(today.latestAvailableDate) && today.latestAvailableDate >= day &&
  amount(today.gmv) !== null && count(today.orders) !== null;
const pendingSales = (today, day) => ['report_pending', 'day_not_verified'].includes(today?.state) &&
  today.requestId && dayValid(today.latestAvailableDate) && today.latestAvailableDate < day;
const validSalesRead = (today, day) => sameDaySales(today, day) || pendingSales(today, day);
const runFile = promisify(execFile);
const shopRefreshes = new Map();

async function latestShopRead(root, day, orders, limitAt) {
  const directory = join(root, 'outputs', shopPerformanceDirectory, day);
  const runs = await receipts([directory], videoReceiptPattern, isShopPerformanceReceipt);
  return runs.find(({ at, value }) => value.day === day && dayKey(new Date(at)) === day &&
    Date.parse(at) <= limitAt && (orders ? validOrderActivity(value.orderActivity, day) && validStatusCounts(value.orderStatus) :
      validSalesRead(value.today, day)));
}

async function runShopRefresh(root, now, orders) {
  const day = dayKey(now);
  const previous = await latestShopRead(root, day, orders, now.getTime());
  const freshFor = orders ? 4 * 60_000 : 25 * 60_000;
  if (previous && now.getTime() - Date.parse(previous.at) < freshFor) {
    return { state: 'fresh', day, observedAt: previous.at };
  }

  const env = { ...process.env };
  let executable = process.execPath;
  if (process.platform === 'win32') {
    env.HTTPS_PROXY ||= 'http://127.0.0.1:10808';
    env.NO_PROXY = [...new Set([...(env.NO_PROXY ?? '').split(',').filter(Boolean), '127.0.0.1', 'localhost'])].join(',');
    env.NODE_USE_ENV_PROXY = '1';
    if (env.SystemRoot) env.PSModulePath = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const bundled = env.USERPROFILE && join(env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime',
      'dependencies', 'node', 'bin', 'node.exe');
    if (bundled && await access(bundled).then(() => true, () => false)) executable = bundled;
  }
  const args = executable !== process.execPath || process.allowedNodeEnvironmentFlags.has('--use-env-proxy') ?
    ['--use-env-proxy'] : [];
  try {
    await runFile(executable, [...args, join(root, 'scripts', 'operations', 'read-dashboard-store-visuals.mjs'),
      orders ? '--orders-only' : '--sales-only'], { cwd: root, env, windowsHide: true, timeout: orders ? 75_000 : 120_000 });
  } catch {
    return { state: 'unavailable', day, observedAt: previous?.at, reason: 'official_read_failed' };
  }
  const latest = await latestShopRead(root, day, orders, Date.now());
  if (!latest || latest.at === previous?.at) {
    return { state: 'unavailable', day, observedAt: previous?.at, reason: 'new_receipt_unavailable' };
  }
  return { state: 'refreshed', day, observedAt: latest.at };
}

function refreshShopData({ root = defaultRoot, now = new Date() }, orders) {
  const workspace = resolve(root);
  const key = workspace + (orders ? '/orders' : '/sales');
  const running = shopRefreshes.get(key);
  if (running) return running;
  const task = runShopRefresh(workspace, now, orders).finally(() => shopRefreshes.delete(key));
  shopRefreshes.set(key, task);
  return task;
}

export function refreshDashboardPayments(options = {}) {
  return refreshShopData(options, true);
}

export function refreshDashboardShopSales(options = {}) {
  return refreshShopData(options, false);
}

function sales(root, day, daily, direct, orderActivity) {
  const saved = daily.filter(({ value }) => value.shopChannelPerformance?.available === true).map(({ file, value }) =>
    ({ file, data: value.shopChannelPerformance.result }));
  const directRuns = direct.map(({ file, value }) => ({ file, data: value.analytics }));
  const candidates = [...directRuns, ...saved].sort((a, b) =>
    (b.data?.window?.endDateExclusive ?? '').localeCompare(a.data?.window?.endDateExclusive ?? '') ||
    ((b.data?.window?.days ?? 0) - (a.data?.window?.days ?? 0)));
  const dayReads = direct.filter(({ value, at }) => value.day === day && dayKey(new Date(at)) === day);
  const latestDayRead = dayReads.find(({ value }) => value.today?.requestId && dayValid(value.today?.latestAvailableDate));
  const latestCheck = dayReads.find(({ value }) => ['official_same_day_snapshot', 'report_pending', 'day_not_verified',
    'day_read_unavailable'].includes(value.today?.state));
  const validDayRead = dayReads.find(({ value }) => sameDaySales(value.today, day));
  const today = validDayRead ? { day, currency: 'MYR', gmv: amount(validDayRead.value.today.gmv),
    orders: count(validDayRead.value.today.orders), source: source(root, validDayRead.file, validDayRead.at) } : null;
  const latestAvailableDate = latestDayRead?.value.today.latestAvailableDate ?? null;
  const todayCoverage = latestCheck ? {
    state: pendingSales(latestCheck.value.today, day) ? 'report_pending' : latestCheck.value.today.state,
    latestAvailableDate,
    source: source(root, latestCheck.file, latestCheck.at),
  } : null;
  for (const { file, data } of candidates) {
    if (!data?.requestIds?.aggregate || !data.requestIds.daily || !stamp(data.observedAt)) continue;
    const window = range(data.window?.startDate, data.window?.endDateExclusive);
    const summary = data.summary;
    if (!window || window.endExclusive > day || amount(summary?.gmvMyr) === null || count(summary?.orders) === null) continue;
    const series = list(data.daily).filter(row => dayValid(row.start_date) && row.start_date >= window.start &&
      row.start_date < window.endExclusive && row.end_date === shift(row.start_date, 1) &&
      row.sales?.gmv?.currency === 'MYR').map(row => ({ day: row.start_date,
      gmv: amount(row.sales.gmv.amount), orders: count(row.sales.orders_count) }))
      .sort((a, b) => a.day.localeCompare(b.day));
    const days = (Date.parse(window.endExclusive) - Date.parse(window.start)) / 86_400_000;
    if (series.length !== days || series.some((row, index) => row.day !== shift(window.start, index) ||
      row.gmv === null || row.orders === null)) continue;
    return { currency: 'MYR', window, gmv: amount(summary.gmvMyr), orders: count(summary.orders), today, todayCoverage, orderActivity,
      latestAvailableDate: latestAvailableDate ?? (dayValid(data.window.latestAvailableDate) ? data.window.latestAvailableDate : null),
      videoGmv: amount(summary.videoAttributedMyr), creatorVideoGmv: amount(summary.creatorVideoAttributedMyr),
      sellerVideoGmv: amount(summary.sellerVideoAttributedMyr), productCardGmv: amount(summary.productCardAttributedMyr),
      liveGmv: amount(summary.liveAttributedMyr), series, source: source(root, file, data.observedAt) };
  }
  return today || todayCoverage || orderActivity
    ? { currency: 'MYR', today, todayCoverage, orderActivity, latestAvailableDate, window: null, series: [], source: null } : null;
}

function overview(root, day, daily) {
  for (const { file, value } of daily) {
    const data = value.publishing?.videoOverview?.available === true && value.publishing.videoOverview.result;
    if (data?.shopId !== shop.id || data.currency !== 'MYR' || !dayValid(data.day) || data.day > day || !stamp(data.observedAt)) continue;
    const rows = list(data.rows).filter(row => row.requestId && ['ALL', 'OFFICIAL_ACCOUNTS', 'MARKETING_ACCOUNTS', 'AFFILIATE_ACCOUNTS'].includes(row.accountType))
      .map(row => ({ accountType: row.accountType, impressions: count(row.productImpressions), clicks: count(row.productClicks),
        skuOrders: count(row.attributedSkuOrders), gmv: amount(row.attributedGmv) }));
    if (rows.some(row => row.accountType === 'ALL')) return { day: data.day, currency: 'MYR', rows, source: source(root, file, data.observedAt) };
  }
  return null;
}

function ranking(root, day, videoReceipts, daily, imageUrl) {
  for (const { file, at, value } of videoReceipts) {
    const window = range(value.query?.startInclusive, value.query?.endExclusive);
    if (!window || window.endExclusive > day || value.coverage?.completeForPerformanceList !== true) continue;
    const links = new Map(list(value.linkedHistoricalVideos).map(row => [row.platformVideoId, row]));
    const reviews = new Map();
    for (const receipt of daily) for (const row of list(receipt.value.growth?.result?.creativeReviews)) {
      if (!reviews.has(row.id) && dayValid(row.window?.end) && sameRange(window, row.window.start, shift(row.window.end, 1))) reviews.set(row.id, row);
    }
    const rows = list(value.productPerformance).flatMap(row => {
      const link = links.get(row.platformVideoId);
      const engagement = row.engagement;
      if (row.state !== 'product_analytics_confirmed' || !ids.test(row.platformVideoId ?? '') || !ids.test(row.expectedProductId ?? '') ||
          !link || !accountPattern.test(link.account ?? '') || link.productId !== row.expectedProductId || !list(row.requestIds).length ||
          !dayValid(row.latestAvailableDate) || row.latestAvailableDate < shift(window.endExclusive, -1) ||
          !sameRange(window, engagement?.startInclusive, engagement?.endExclusive) || count(engagement.unitsSold) === null) return [];
      const review = reviews.get(row.platformVideoId);
      const matched = review?.productId === row.expectedProductId && review.account === link.account && review.jobId === link.jobId;
      const skuId = matched && ids.test(review.skuId ?? '') ? review.skuId : null;
      const ads = matched && review.ads?.attribution === 'platform_report_includes_organic' ? {
        currency: 'USD', spend: amount(review.ads.spend), grossRevenue: amount(review.ads.grossRevenue),
        skuOrders: metricCount(review.ads.skuOrders), roi: amount(review.ads.reportedRoi),
        status: /^[A-Z_]+$/u.test(review.deliveryStatus ?? '') ? review.deliveryStatus : null, includesOrganic: true,
      } : null;
      return [{ videoId: row.platformVideoId, account: link.account, productId: row.expectedProductId, skuId,
        label: text(matched ? review.sellerSku : null) ?? text(link.jobId),
        impressions: count(engagement.impressions), clicks: count(engagement.clicks), unitsSold: count(engagement.unitsSold), ads,
        imageUrl: skuId ? imageUrl({ productId: row.expectedProductId, skuId }) : null }];
    }).sort((a, b) => b.unitsSold - a.unitsSold || b.clicks - a.clicks || b.impressions - a.impressions);
    if (rows.length) return { window, rows: rows.slice(0, 12), coverage: rows.length, source: source(root, file, at) };
  }
  return null;
}

function sameBatch(receipt, file, at) {
  return Date.parse(receipt.at) >= Date.parse(at) && typeof receipt.value.routingSource === 'string' &&
    resolve(receipt.value.routingSource) === resolve(file);
}

function warehouseBreakdown(root, route, shadows) {
  const { file, at, value } = route;
  const shadow = shadows.find(receipt => sameBatch(receipt, file, at) && receipt.value.summary?.writes === 0);
  const warehouses = warehouseNames.map(([warehouseId, name, route]) => ({ warehouseId, name, route,
    pendingShipment: 0, awaitingCollection: 0 }));
  const assignedOrders = new Map();
  const expected = new Map();
  for (const row of list(value.rows)) {
    if (!['AWAITING_SHIPMENT', 'AWAITING_COLLECTION'].includes(row.status) || !ids.test(row.orderId ?? '') ||
        row.identityVerified !== true || row.serviceMatches !== true || row.packageLineIdentityVerified !== true ||
        row.packages?.length !== 1 || !ids.test(row.packages[0])) continue;
    expected.set(row.orderId, expected.has(row.orderId) ? null : row);
  }
  const comparisons = new Map();
  for (const row of list(shadow?.value.rows)) comparisons.set(row.orderId, comparisons.has(row.orderId) ? null : row);
  for (const [orderId, order] of expected) {
    const readback = comparisons.get(orderId);
    const evidence = readback?.comparison;
    if (!order || !evidence || readback.packageId !== order.packages[0] || readback.route !== order.route ||
        readback.currentStatus !== order.status || evidence.originalPackageMatch !== true || evidence.platformRouteMatch !== true ||
        evidence.warehouseReadComplete !== true || evidence.expectedRouteRecords !== 1 || evidence.otherRouteRecords !== 0 ||
        evidence.crossRouteDuplicate !== false || evidence.duplicateAcrossWarehouses !== false || evidence.warehouseOnWrongRoute !== false) continue;
    const warehouse = warehouses.find(row => row.warehouseId === evidence.observedWarehouse && row.route === order.route);
    if (!warehouse) continue;
    warehouse[order.status === 'AWAITING_SHIPMENT' ? 'pendingShipment' : 'awaitingCollection']++;
    assignedOrders.set(orderId, warehouse.warehouseId);
  }
  const remainder = (total, verified) => total !== null && verified <= total ? total - verified : null;
  const shipmentTotal = count(value.summary.pendingShipment);
  const collectionTotal = count(value.summary.pendingCollection);
  const collectionRows = list(value.rows).filter(row => row.status === 'AWAITING_COLLECTION' &&
    row.nextAction === 'check_existing_package_and_carrier');
  const collectionRouteComparable = collectionRows.length === collectionTotal &&
    new Set(collectionRows.map(row => row.orderId)).size === collectionRows.length;
  const routeCoverage = (total, bins) => total !== null && bins.every(Number.isInteger)
    ? remainder(total, bins.reduce((sum, n) => sum + n, 0)) : null;
  const routes = [...new Set(warehouseNames.map(([, , route]) => route))];
  const byRoute = routes.map(route => {
    const routeWarehouses = warehouses.filter(row => row.route === route);
    const pendingShipment = shipmentTotal === 0 ? 0 : count(value.summary.pendingShipmentByRoute?.[route]);
    const awaitingCollection = collectionRouteComparable
      ? collectionRows.filter(row => row.route === route && row.serviceMatches === true).length : null;
    return { route, pendingShipment, awaitingCollection,
      unassignedPendingShipment: remainder(pendingShipment, routeWarehouses.reduce((sum, row) => sum + row.pendingShipment, 0)),
      unassignedAwaitingCollection: remainder(awaitingCollection, routeWarehouses.reduce((sum, row) => sum + row.awaitingCollection, 0)) };
  });
  const pendingRouteUnknown = routeCoverage(shipmentTotal, byRoute.map(row => row.pendingShipment));
  const collectionRouteUnknown = routeCoverage(collectionTotal, byRoute.map(row => row.awaitingCollection));
  const pendingShipment = remainder(shipmentTotal, warehouses.reduce((sum, row) => sum + row.pendingShipment, 0));
  const awaitingCollection = remainder(collectionTotal, warehouses.reduce((sum, row) => sum + row.awaitingCollection, 0));
  const evidenceSource = shadow ? source(root, shadow.file, shadow.at) : source(root, file, at);
  const coverage = (row, pendingComplete, collectionComplete) => ({ ...row,
    pendingCoverage: pendingComplete ? 'verified' : 'partial',
    collectionCoverage: collectionComplete ? 'verified' : 'partial',
    coverage: pendingComplete && collectionComplete ? 'verified' : 'partial',
    source: evidenceSource });
  return { byRoute, pendingRouteUnknown, collectionRouteUnknown, assignedOrders,
    warehouses: [...warehouses.map(row => {
      const route = byRoute.find(item => row.route === item.route);
      return coverage(row, pendingShipment === 0 || (pendingRouteUnknown === 0 && route.unassignedPendingShipment === 0),
        awaitingCollection === 0 || (collectionRouteUnknown === 0 && route.unassignedAwaitingCollection === 0));
    }), coverage({ warehouseId: 'unassigned', name: '仓库归属待核', pendingShipment, awaitingCollection },
      pendingShipment === 0, awaitingCollection === 0)] };
}

function isRoutingReceipt(value) {
  return exactShop(value.shop) && value.schema === 'operations-fulfillment-routing-replay/v1' &&
    value.orderSource === 'live_order_list' &&
    value.summary?.writes === 0 && count(value.summary.pendingShipment) !== null &&
    count(value.summary.pendingCollection) !== null && Array.isArray(value.rows) &&
    Array.isArray(value.trace) && value.trace.some(row =>
      row.path === '/order/202507/orders' && row.status === 200 && row.code === 0 && row.requestId);
}

async function latestRoutingReceipt(directories, day) {
  const paths = await receiptPaths(directories, videoReceiptPattern);
  const dated = [];
  const legacy = [];
  for (const file of paths) {
    const writtenAt = routingFileTime(file);
    if (Number.isFinite(writtenAt)) dated.push({ file, writtenAt });
    else legacy.push(file);
  }
  const valid = value => isRoutingReceipt(value) && dayKey(new Date(value.observedAt)) <= day;
  const checkedLegacy = (await Promise.all(legacy.map(file => readReceipt(file, valid)))).filter(Boolean).sort(byNewest)[0];
  let latest = checkedLegacy ?? null;
  dated.sort((a, b) => b.writtenAt - a.writtenAt);
  for (const { file, writtenAt } of dated) {
    if (latest && writtenAt < Date.parse(latest.at)) break;
    const receipt = await readReceipt(file, valid);
    if (receipt && (!latest || byNewest(receipt, latest) < 0)) latest = receipt;
  }
  return latest;
}

function fulfillment(root, day, receipt, packing, shadows) {
  if (!receipt) return null;
  const { file, at, value } = receipt;
  const snapshotDay = dayKey(new Date(at));
  const reportSource = source(root, file, at);
  const { warehouses, byRoute, pendingRouteUnknown, collectionRouteUnknown, assignedOrders } =
    warehouseBreakdown(root, receipt, shadows.filter(({ at }) => dayKey(new Date(at)) <= day));
  const rows = list(value.rows).filter(row => row.status === 'AWAITING_SHIPMENT' && ids.test(row.orderId ?? '')).flatMap(row => {
    const [packageId] = list(row.packages);
    const exact = row.identityVerified === true && row.serviceMatches === true && row.packageLineIdentityVerified === true &&
      row.packages?.length === 1 && ids.test(packageId ?? '');
    const candidate = exact && row.route === 'china_direct' && packing.find(({ value: data, at: packedAt }) =>
      dayKey(new Date(packedAt)) <= day && data.writes === 0 && sameBatch({ value: data, at: packedAt }, file, at) &&
      data.packing?.orderId === row.orderId && data.packing?.packageId === packageId);
    return list(row.skus).filter(sku => ids.test(sku.skuId ?? '')).map(sku => {
      const data = candidate?.value;
      const exactLine = data?.platform?.order?.id === row.orderId && data.platform?.package?.id === packageId &&
        list(data.platform.order.lines).some(line => line.skuId === sku.skuId && line.packageId === packageId);
      const aliases = new Set(list(data?.history).filter(entry => entry.skuId === sku.skuId).map(entry => entry.goodsSkuOuterId));
      const inventory = exactLine ? list(data.inventory).filter(entry => aliases.has(entry.goodsSkuOuterId)).map(entry => ({
        warehouseId: ids.test(entry.warehouseId ?? '') || /^\d{2,6}$/u.test(entry.warehouseId ?? '') ? entry.warehouseId : null,
        available: entry.exactRows === 1 ? count(entry.available) : null, locked: entry.exactRows === 1 ? count(entry.locked) : null,
      })) : [];
      const state = exactLine && /^[a-z_]+$/u.test(data.packing?.state ?? '') ? data.packing.state : 'warehouse_evidence_pending';
      return { orderSuffix: row.orderId.slice(-4), skuId: sku.skuId, quantity: count(sku.quantity),
        warehouseId: assignedOrders.get(row.orderId) ?? null,
        route: row.identityVerified === true && row.serviceMatches === true && ['china_direct', 'malaysia_overseas'].includes(row.route)
          ? row.route : null,
        state, inventory, source: reportSource, evidenceAt: exactLine ? candidate.at : null };
    });
  });
  return { kind: 'routing', snapshotDay, isCurrentDay: snapshotDay === day,
    pendingShipment: count(value.summary.pendingShipment), awaitingCollection: count(value.summary.pendingCollection),
    pendingChinaDirect: count(value.summary.pendingShipmentByRoute?.china_direct),
    pendingMalaysiaOverseas: count(value.summary.pendingShipmentByRoute?.malaysia_overseas),
    pendingUnresolved: count(value.summary.pendingUnresolved), source: reportSource, rows,
    warehouses, byRoute, pendingRouteUnknown, collectionRouteUnknown };
}

function validStatusCounts(status) {
  return count(status?.pendingShipment) !== null && count(status?.awaitingCollection) !== null;
}

function currentFulfillmentTotals(root, day, catalogue, orderReceipts) {
  const latest = orderReceipts.find(({ value }) => {
    const status = value.orderStatus;
    return value.day === day && validOrderActivity(value.orderActivity, day) && validStatusCounts(status) &&
      status.observedAt === value.orderActivity.observedAt;
  });
  const totals = latest?.value.orderStatus;
  if (totals && (!validStatusCounts(catalogue) ||
      Date.parse(totals.observedAt) > Date.parse(catalogue?.source?.observedAt))) {
    return { pendingShipment: totals.pendingShipment, awaitingCollection: totals.awaitingCollection,
      source: source(root, latest.file, totals.observedAt) };
  }
  return validStatusCounts(catalogue) ? { pendingShipment: catalogue.pendingShipment, awaitingCollection: catalogue.awaitingCollection,
    source: catalogue.source } : null;
}

function fulfillmentTotals(day, totals) {
  if (!totals) return null;
  const { pendingShipment, awaitingCollection, source: evidence } = totals;
  const warehouseRow = (warehouseId, name, route, shipment, collection) => ({ warehouseId, name, route,
    pendingShipment: shipment, awaitingCollection: collection, pendingCoverage: 'partial', collectionCoverage: 'partial',
    coverage: 'partial', source: evidence });
  return { kind: 'orders_snapshot', snapshotDay: day, isCurrentDay: true, pendingShipment, awaitingCollection,
    pendingChinaDirect: null, pendingMalaysiaOverseas: null, pendingUnresolved: pendingShipment, source: evidence, rows: [],
    warehouses: [...warehouseNames.map(([id, name, route]) => warehouseRow(id, name, route, null, null)),
      warehouseRow('unassigned', '仓库归属待核', null, pendingShipment, awaitingCollection)], byRoute: [],
    pendingRouteUnknown: pendingShipment, collectionRouteUnknown: awaitingCollection };
}

async function productPerformance(root, day, receipts) {
  for (const { file, at, value } of receipts) {
    const window = range(value.window?.startDate, value.window?.endDateExclusive);
    const summary = value.summary;
    const coverage = count(summary?.activeProductsInAnalytics);
    if (!window || window.endExclusive > day || coverage === null || count(value.analyticsPages) < 1 ||
        list(value.rows).length !== coverage) continue;
    const origin = source(root, file, at);
    const rows = list(value.rows).filter(row => ids.test(row.productId ?? '') && count(row.orderDetailOrders) > 0)
      .map(row => ({ productId: row.productId, skuId: null, title: text(row.title), impressions: count(row.impressions),
        clicks: count(row.clicks), orders: count(row.orderDetailOrders), analyticsOrders: count(row.analyticsOrders),
        itemsSold: count(row.itemsSold), refundedItems: count(row.refundedItems), imageUrl: null }))
      .sort((a, b) => b.orders - a.orders || b.itemsSold - a.itemsSold || b.clicks - a.clicks).slice(0, 10);
    await Promise.all(rows.map(async row => {
      row.imageUrl = await dashboardProductCoverUrl({ productId: row.productId, workspaceRoot: root });
    }));
    return { productRank: { window, coverage, rows, source: origin }, funnel: { window, coverage,
      impressions: count(summary.impressions), clicks: count(summary.clicks), orders: count(summary.analyticsProductOrders),
      exactOrders: count(summary.exactPlatformOrders), cartAdds: null, source: origin } };
  }
  return { productRank: null, funnel: null };
}

function promotion(day, snapshot) {
  const raw = snapshot?.promotion;
  const trial = snapshot?.trackedPilot;
  const coverage = raw?.shop === shop.name && raw.state === 'verified' && stamp(raw.checkedAt) && dayKey(new Date(raw.checkedAt)) <= day ? {
    activeProducts: count(raw.activeProducts), coveredProducts: count(raw.coveredProducts), uncoveredProducts: count(raw.uncoveredProducts),
    partiallyCoveredProducts: count(raw.partialProducts), ongoingActivities: count(raw.ongoingActivities),
    source: { path: `apps/customer-service/data/operations-board/days/${day}.json`, observedAt: raw.checkedAt },
  } : null;
  const pilot = ids.test(trial?.activityId ?? '') && ids.test(trial?.skuId ?? '') && trial.price?.currency === 'MYR' &&
    stamp(trial.observedAt) && dayKey(new Date(trial.observedAt)) <= day &&
    /^pilot-receipts\/\d+\/[\dTZ.-]+\.json$/u.test(trial.receipt ?? '') ? {
      activityId: trial.activityId, skuId: trial.skuId, sellerSku: text(trial.sellerSku),
      state: /^[a-z_]+$/u.test(trial.state ?? '') ? trial.state : null, currency: 'MYR', price: amount(trial.price.amount),
      regularPrice: amount(trial.regularPrice), listedQuantity: count(trial.listedQuantity), activityLimit: count(trial.limitUsage?.total),
      perBuyerLimit: count(trial.limitUsage?.perBuyer), used: count(trial.limitUsage?.used),
      orderLines: trial.ordersCountVerified === true ? count(trial.orderLines) : null,
      source: { path: `apps/customer-service/data/operations-board/${trial.receipt}`, observedAt: trial.observedAt },
    } : null;
  return coverage || pilot ? { coverage, pilot } : null;
}

function finance(root, day, daily, snapshot) {
  const summary = snapshot?.finance;
  const hasSummary = stamp(summary?.collectedAt) && dayKey(new Date(summary.collectedAt)) <= day;
  for (const { file, value } of daily) {
    const data = value.operatingReview?.available === true && value.operatingReview.result;
    if (data?.currency !== 'MYR' || !stamp(data.observedAt) || !Number.isSafeInteger(data.orderWindow?.startInclusive) ||
        !Number.isSafeInteger(data.orderWindow?.endExclusive) || data.orderWindow.startInclusive >= data.orderWindow.endExclusive) continue;
    const financeGroup = value => amount(value?.net) === null || count(value?.orderCount) === null ? null
      : { orderCount: value.orderCount, net: value.net };
    return { currency: 'MYR', settledLines: hasSummary ? count(summary.settledLines) : null,
      returns: hasSummary ? count(summary.returns) : null, paidNet: amount(data.paidNet), paidOrders: count(data.paidOrders),
      estimatedNet: amount(data.estimatedNet), estimatedOrders: count(data.estimatedOrders),
      paymentStatusUnknownCount: count(data.paymentStatusUnknownCount), actualProfit: null,
      platformPaid: financeGroup(data.paymentBreakdown?.platformPaid),
      settledAwaitingPaymentProof: financeGroup(data.paymentBreakdown?.settledAwaitingPaymentProof),
      bankReceiptVerified: data.paymentBreakdown?.bankReceiptVerified === true ? true : null,
      remainingOrderCount: count(data.remainingOrderCount),
      window: { startAt: new Date(data.orderWindow.startInclusive * 1000).toISOString(),
        endExclusiveAt: new Date(data.orderWindow.endExclusive * 1000).toISOString() },
      source: source(root, file, data.observedAt), summaryAt: hasSummary ? summary.collectedAt : null,
      summarySource: hasSummary ? { path: `apps/customer-service/data/operations-board/days/${day}.json`,
        observedAt: summary.collectedAt } : null };
  }
  return hasSummary ? { currency: 'MYR', settledLines: count(summary.settledLines), returns: count(summary.returns),
    paidNet: null, estimatedNet: null, actualProfit: null,
    source: { path: `apps/customer-service/data/operations-board/days/${day}.json`, observedAt: summary.collectedAt } } : null;
}

const openReturnsStatus = 'RETURN_OR_REFUND_REQUEST_PENDING';
const returnsQuery = '/return_refund/202602/returns/search';
const serviceReceiptPattern = /^(?:open-aftersales|official-read)-[\w.-]+\.json$/u;
const serviceRead = (value, path) => list(value.requests).filter(request =>
  request?.path === path && request.status === 200 && request.code === 0 &&
  typeof request.requestId === 'string' && request.requestId.length > 0);

function openAfterSales(value, evidence) {
  const raw = value.schema === 'operations-open-aftersales-read/v1' ? value.openAfterSales
    : value.openAfterSales?.available === true ? value.openAfterSales.data : null;
  if (!raw || raw.replacementAndExchangeCoverage !== 'recent_update_window_only' ||
      !Array.isArray(raw.lists) || raw.lists.length !== 2 || !Array.isArray(raw.rows) || raw.distinctCases !== raw.rows.length ||
      raw.rows.some(row => !ids.test(row?.returnId ?? '') || !ids.test(row?.orderId ?? '') ||
        !(row.status === openReturnsStatus || row.arbitrationStatus === 'IN_PROGRESS')) ||
      new Set(raw.rows.map(row => row.returnId)).size !== raw.rows.length ||
      raw.exactMatches !== raw.rows.filter(row => row.exact === true).length) return null;
  const successful = new Set(serviceRead(value, returnsQuery).map(request => request.requestId));
  const requestIds = raw.lists.flatMap(row => list(row?.requestIds));
  if (new Set(requestIds).size !== requestIds.length) return null;
  const listCount = (key, matches) => {
    const match = raw.lists.find(row => row?.key === key);
    const expected = raw.rows.filter(matches).length;
    return match && match.count === expected && count(match.pages) > 0 && Array.isArray(match.requestIds) &&
      match.requestIds.length === match.pages && match.requestIds.every(id => successful.has(id)) ? expected : null;
  };
  const pendingReturnRefund = listCount('pending_return_or_refund', row => row.status === openReturnsStatus);
  const inArbitration = listCount('in_arbitration', row => row.arbitrationStatus === 'IN_PROGRESS');
  if (pendingReturnRefund === null || inArbitration === null) return null;
  return { pendingReturnRefund, inArbitration, distinctCases: raw.distinctCases, exactMatches: raw.exactMatches,
    replacementAndExchangeCoverage: raw.replacementAndExchangeCoverage,
    rows: raw.rows.map(row => ({ orderSuffix: row.orderId.slice(-4),
      pendingReturnRefund: row.status === openReturnsStatus, inArbitration: row.arbitrationStatus === 'IN_PROGRESS',
      exact: row.exact === true, amount: row.currency === 'MYR' ? amount(row.amount) : null,
      updatedAt: count(row.updatedAt) !== null ? row.updatedAt : null })),
    source: evidence };
}

function recentAfterSales(value, evidence) {
  const data = value.returns?.available === true && value.returns.data;
  if (!data || !Number.isSafeInteger(data.startInclusive) || !Number.isSafeInteger(data.endExclusive) ||
      data.startInclusive >= data.endExclusive || count(data.pages) < 1 ||
      serviceRead(value, returnsQuery).length < data.pages || !Array.isArray(data.rows) || data.records !== data.rows.length ||
      ![data.pendingSellerReview, data.platformArbitrationInProgress, data.exactOrderAndSkuMatches]
        .every(number => count(number) !== null && number <= data.records)) return null;
  return { records: data.records, pendingSellerReview: data.pendingSellerReview,
    platformArbitrationInProgress: data.platformArbitrationInProgress,
    exactOrderAndSkuMatches: data.exactOrderAndSkuMatches,
    window: { startInclusive: data.startInclusive, endExclusive: data.endExclusive }, source: evidence };
}

function customerInbox(value, evidence) {
  const data = value.conversations?.available === true && value.conversations.data;
  if (!data || data.coverage !== 'all_cursor_pages' || data.morePages !== false ||
      count(data.pages) < 1 || serviceRead(value, '/customer_service/202309/conversations').length < data.pages + 1 ||
      count(data.count) === null) return null;
  return { conversationCount: data.count, unreadConversations: count(data.unreadConversations),
    unreadMessages: count(data.unreadMessages), unreadReplyable: count(data.unreadReplyable), source: evidence };
}

function afterSales(root, service) {
  let open = null;
  let recent = null;
  let inbox = null;
  for (const { file, at, value } of service) {
    const evidence = source(root, file, at);
    open ??= openAfterSales(value, evidence);
    recent ??= recentAfterSales(value, evidence);
    inbox ??= customerInbox(value, evidence);
    if (open && recent && inbox) break;
  }
  return open || recent || inbox ? { open, recent, inbox } : null;
}

function procurement(day, queue) {
  const receiptPath = path => typeof path === 'string' &&
    /^outputs\/operations-stock-planning\/\d{4}-\d{2}-\d{2}\/daily-replenishment-[\da-f-]+\.json$/u.test(path) &&
    path.split('/')[2] === day;
  const summary = list(queue?.runs).find(run =>
    run.day === day && run.module === 'replenishment' && run.state === 'done')?.summary;
  const runSource = summary?.day === day && summary.shopId === shop.id && summary.writes === 0 &&
    stamp(summary.observedAt) && dayKey(new Date(summary.observedAt)) === day && receiptPath(summary.receipt)
    ? { path: summary.receipt, observedAt: summary.observedAt } : null;
  const rows = list(queue?.tasks).filter(row => row.lastDay === day && row.role === 'procurement' &&
    ['approval', 'queued', 'retry'].includes(row.state)).map(row => ({ title: text(row.title), state: row.state,
    source: row.sourceRef === runSource?.path ? runSource :
      receiptPath(row.sourceRef) && stamp(row.updatedAt) && dayKey(new Date(row.updatedAt)) === day
        ? { path: row.sourceRef, observedAt: row.updatedAt } : null }));
  if (!runSource && rows.length === 0) return null;
  const rowSources = rows.flatMap(row => row.source ? [row.source] : []);
  const latestRow = rowSources.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
  return { approvalCount: rows.filter(row => row.state === 'approval').length, rows, source: runSource ?? latestRow };
}

function suggestions(root, day, daily, queue, shipping, videoRanking, ads) {
  const result = [];
  const missing = shipping?.isCurrentDay && shipping.rows.find(row => row.state === 'warehouse_sku_unverified' ||
    (row.state === 'stock_or_card_unverified' && row.inventory.some(item => item.available === 0)));
  if (missing) result.push({ kind: 'fulfillment', title: `核对订单尾号 ${missing.orderSuffix} 的可发库存`,
    detail: missing.state === 'warehouse_sku_unverified' ? '仓库 SKU 对应关系待核，确认准确规格与可用量。' :
      '已查到的仓库可用量为 0，先核锁定件归属与其他仓库存。',
    action: '查看履约', productId: null, source: missing.source, evidenceAt: missing.evidenceAt });
  if (queue?.approvalCount) result.push({ kind: 'procurement', title: `${queue.approvalCount} 项补货草案待确认`,
    detail: '核对实际库存、在途、采购报价及到仓时间。', action: '查看采购任务', productId: null,
    source: queue.source });
  const creative = videoRanking?.rows.find(row => row.skuId && row.ads && row.unitsSold > 0);
  if (creative) result.push({ kind: 'video', title: '复看成交最高的原片',
    detail: `${creative.label} 在该统计期售出 ${creative.unitsSold} 件，商品点击 ${creative.clicks ?? '待核'} 次。`,
    action: '沿用同规格和账号，先提一条只改一个镜头的对照', productId: creative.productId,
    window: videoRanking.window, source: videoRanking.source });
  const campaign = ads.campaigns.length === 1 && ads.campaigns[0].status === 'ENABLE' ? ads.campaigns[0] : null;
  if (campaign && ads.complete?.roi !== null && ads.complete?.roi !== undefined && campaign.targetRoi !== null) {
    result.push({ kind: 'ads', title: '先核在投商品的广告后利润',
      detail: `账户报表 ROAS ${ads.complete.roi}×，计划目标 ${campaign.targetRoi}×。报表可能包含自然成交。`,
      action: '核对应 SKU 的结算、退款和实际成本，再评估预算', productId: campaign.productIds[0] ?? null,
      window: ads.complete.window, source: ads.complete.source });
  }
  for (const { file, at, value } of daily) {
    const data = value.growth?.available === true && value.growth.result;
    const window = range(data?.checkoutWindow?.startDate, data?.checkoutWindow?.endDateExclusive);
    if (!window || window.endExclusive > day || data.checkoutWindow.days < 5) continue;
    for (const row of list(data.checkoutReviews).filter(item => ids.test(item.productId ?? '') && count(item.clicks) >= 20 &&
      item.analyticsOrders === 0 && item.orderDetailOrders === 0).slice(0, 4)) {
      result.push({ kind: 'checkout', title: text(row.title), detail: `${row.clicks} 次点击，两份订单来源均为 0。`,
        action: '核对结账价、配送和可售规格', productId: row.productId, window, source: source(root, file, at) });
    }
    break;
  }
  return result;
}

export async function readOperationsDashboard({ root = defaultRoot, day = dayKey(new Date()), board, queue, imageUrl = () => null } = {}) {
  if (!dayValid(day)) throw new RangeError('Invalid operations dashboard day');
  const [dailyDirs, adDates, videoDates, productDates, shopDates, routeDirs, serviceDirs] = await Promise.all([
    datedDirectories(root, 'operations-daily-work', day, 3), datedDirectories(root, 'ads-monitoring', day, 3),
    datedDirectories(root, 'operations-shop-video-reconciliation', day, 3), datedDirectories(root, 'operations-product-finance-review', day, 3),
    datedDirectories(root, shopPerformanceDirectory, day, 3),
    datedDirectories(root, 'operations-fulfillment-routing-replay', day, 3),
    datedDirectories(root, 'operations-service-fulfillment', day, 3),
  ]);
  const adDirs = adDates.map(dir => join(dir, 'live-read-validation'));
  const additionalWindows = async dirs => (await Promise.all(dirs.map(async dir => (await names(dir))
    .filter(entry => entry.isDirectory() && /^report-end-\d{4}-\d{2}-\d{2}$/u.test(entry.name))
    .map(entry => join(dir, entry.name))))).flat();
  const [adHistorical, videoHistorical] = await Promise.all([additionalWindows(adDirs), additionalWindows(videoDates)]);
  const routing = latestRoutingReceipt(routeDirs, day).then(async route => {
    if (!route) return { route, packing: [], shadows: [] };
    // Packing writers create the filename and body timestamps separately.
    const notBefore = Date.parse(route.at) - 1_000;
    const [packing, shadows] = await Promise.all([
      receipts(routeDirs, /^domestic-packing-[\w.-]+\.json$/u,
        value => exactShop(value.shop) && value.schema === 'operations-domestic-packing/v1', 'observedAt', notBefore),
      receipts(routeDirs, /^shadow-run-[\w.-]+\.json$/u,
        value => exactShop(value.shop) && value.schema === 'operations-fulfillment-shadow-run/v1', 'observedAt', notBefore),
    ]);
    return { route, packing, shadows };
  });
  const [saved, daily, ads, video, { route, packing, shadows }, products, shopPerformance, service] = await Promise.all([
    json(join(root, 'apps/customer-service/data/operations-board/days', `${day}.json`)),
    receipts(dailyDirs, dailyReceiptPattern, value => value.schema === 'operations-daily-work/v1' &&
      value.defaults?.shopId === shop.id && dayValid(value.day) && value.day <= day, 'recordedAt'),
    receipts([...adDirs, ...adHistorical], dashboardAdReceiptPattern, isDashboardAdReceipt),
    receipts([...videoDates, ...videoHistorical], videoReceiptPattern, value => exactShop(value.shop) &&
      value.schema === 'operations-shop-video-reconciliation/v1' && dayValid(value.day) && value.day <= day),
    routing,
    receipts(productDates, videoReceiptPattern, value => exactShop(value.shop) && value.schema === 'operations-product-finance-review/v1' &&
      value.analyticsCoverage === 'LIVE' && dayValid(value.day) && value.day <= day),
    receipts(shopDates, videoReceiptPattern, value => isShopPerformanceReceipt(value) && value.day <= day),
    receipts(serviceDirs, serviceReceiptPattern, value => exactShop(value.shop) && dayKey(new Date(value.observedAt)) === value.day &&
      value.day <= day && ((value.schema === 'operations-open-aftersales-read/v1' && value.writes === 0) ||
        (value.schema === 'operations-service-fulfillment-read/v1' && (value.writes ?? 0) === 0))),
  ]);
  const boardSnapshot = board?.report?.day === day ? board.report : board?.day === day ? board : saved?.day === day ? saved : null;
  const shopCatalogue = catalogue(day, boardSnapshot, saved);
  const routed = fulfillment(root, day, route, packing, shadows);
  const currentTotals = currentFulfillmentTotals(root, day, shopCatalogue, shopPerformance);
  const shipping = routed?.isCurrentDay ? routed : fulfillmentTotals(day, currentTotals) ?? routed;
  if (shipping && currentTotals && Date.parse(currentTotals.source.observedAt) >= Date.parse(shipping.source.observedAt)) {
    shipping.liveTotals = currentTotals;
  }
  const purchase = procurement(day, queue);
  const adsReport = summarizeDashboardAdvertising(root, day, ads);
  const videoRanking = ranking(root, day, video, daily, imageUrl);
  const orderActivity = currentOrderActivity(root, day, shopPerformance, boardSnapshot, saved);
  return { day, timezone, shop: { ...shop, catalogue: shopCatalogue, sales: sales(root, day, daily, shopPerformance, orderActivity) },
    ads: adsReport, videos: { overview: overview(root, day, daily), ranking: videoRanking },
    fulfillment: shipping, suggestions: suggestions(root, day, daily, purchase, shipping, videoRanking, adsReport), procurement: purchase,
    promotion: promotion(day, boardSnapshot), finance: finance(root, day, daily, boardSnapshot),
    afterSales: afterSales(root, service), ...await productPerformance(root, day, products) };
}
