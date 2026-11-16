import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBoardEvidence, dayKey, listNames, readJson } from './operations-board-evidence.mjs';
import { createRunEvidence } from './operations-board-runs.mjs';
import { auditShopPromotions } from './audit-tiktok-promotions.mjs';
import { syncFromLocalService } from './sync-tiktok-shop.mjs';
import { snapshotFilename } from './tiktok-shop-finance.mjs';
import { canCloseEmptyPilot, openMyShopSession, readLivePilotOutcome, readPilotChain } from '../../scripts/operations/verify-promotion-outcome.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const myShop = '9000000000000000099';
const oneDay = 24 * 60 * 60 * 1000;
const pollMinutes = 30;
const paymentPollMinutes = 5;

async function saveBoardJson(destination, data) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(data) + '\n', { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function summarizeShop(snapshot) {
  const snapshotTime = Date.parse(snapshot.collectedAt);
  if (snapshot.shop?.id !== myShop || snapshot.shop.region !== 'MY' || !Number.isFinite(snapshotTime)) {
    throw new Error('Invalid MY shop snapshot');
  }
  const { rows: orders } = snapshot.orders;
  const { rows: products } = snapshot.products;
  const counts = new Map();
  for (const order of orders) {
    if (!Number.isSafeInteger(order.createdAt)) continue;
    const day = dayKey(new Date(order.createdAt * 1000));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const dates = Array.from({ length: 7 }, (_, index) => dayKey(new Date(snapshotTime - (6 - index) * oneDay)));
  return {
    shop: snapshot.shop.name,
    collectedAt: snapshot.collectedAt,
    activeProducts: products.filter(product => product.status === 'ACTIVATE').length,
    productsTotal: products.length,
    orders7d: orders.length,
    unmatchedOrderDates: orders.length - [...counts.values()].reduce((sum, count) => sum + count, 0),
    awaitingShipment: orders.filter(order => order.status === 'AWAITING_SHIPMENT').length,
    awaitingCollection: orders.filter(order => order.status === 'AWAITING_COLLECTION').length,
    orderActivity: snapshot.orderActivity ?? null,
    trend: dates.map(day => ({ day, count: counts.get(day) ?? 0 })),
  };
}

async function latestSnapshot(directory) {
  const filename = (await listNames(directory)).filter(name => snapshotFilename.test(name)).sort().at(-1);
  return filename ? readJson(join(directory, filename)) : null;
}

async function financeSummary(directory) {
  const data = await latestSnapshot(join(directory, 'finance'));
  if (data?.kind !== 'order-finance' || data.shop?.id !== myShop) return null;
  return {
    collectedAt: data.collectedAt,
    settledLines: data.counts?.settlementSkusMatched ?? null,
    returns: data.returns?.status === 'available' ? data.counts?.ordersWithReturnRecords ?? null : null,
  };
}

function promotionSummary(raw) {
  if (raw?.state !== 'verified' || !Array.isArray(raw.rows) || !Number.isFinite(Date.parse(raw.checkedAt))) return null;
  const { rows, priority, ...summary } = raw;
  return {
    ...summary,
    priority: (priority ?? []).map(({ label, coverage }) => ({ label, coverage })),
    toReview: rows.filter(row => row.coverage !== 'all').map(({ title, skuCount, coveredSkus, coverage, costMatchedSkus }) =>
      ({ title, skuCount, coveredSkus, coverage, costMatchedSkus })),
  };
}

async function readTrackedPilot(root, boardDirectory, previous) {
  const settings = await readJson(join(root, 'config', 'operations-trial-defaults.json'));
  if (!settings?.trackedPromotionPilot) return null;
  const { promotion, listing } = readPilotChain(join(root, settings.trackedPromotionPilot), myShop);
  const { pilot, activityId } = promotion;
  if (previous?.activityId === activityId && canCloseEmptyPilot(previous)) return previous;
  const outcome = await readLivePilotOutcome(pilot, activityId, await openMyShopSession(myShop));
  const directory = join(boardDirectory, 'pilot-receipts', activityId);
  await mkdir(directory, { recursive: true });
  const filename = outcome.observedAt.replace(/[:.]/gu, '-') + '.json';
  await writeFile(join(directory, filename), JSON.stringify({ shopId: myShop, productId: listing.productId, skuId: listing.skuId,
    sellerSku: listing.sellerSku, ...outcome }, null, 2) + '\n', { flag: 'wx' });
  return { sellerSku: listing.sellerSku, skuId: listing.skuId, activityId, observedAt: outcome.observedAt, state: outcome.activity.state,
    price: outcome.activity.configuredActivityPrice, regularPrice: outcome.listing?.regularPrice ?? null,
    listedQuantity: outcome.listing?.listedQuantity ?? null, limitUsage: outcome.activity.limitUsage,
    orderLines: outcome.orders?.exactOrderRows.length ?? null,
    windowCovered: outcome.orders?.wholePilotCovered ?? null,
    ordersCountVerified: Number.isSafeInteger(outcome.orders?.platformOrderCount) &&
      outcome.orders.platformOrderCount === outcome.orders.checkedOrderCount && outcome.orders.requestIds.length === outcome.orders.pages &&
      Boolean(outcome.activity.requestId),
    checkoutOrders: outcome.orderEconomics?.filter(row => row.checkout).length ?? null,
    statementReferences: outcome.orderEconomics?.filter(row => row.settlement).length ?? null,
    paidStatementOrders: outcome.statementPayments?.state === 'index_read'
      ? outcome.statementPayments.orders.filter(row => row.paymentStatus === 'PAID').length : null,
    receipt: `pilot-receipts/${activityId}/${filename}` };
}

export function createOperationsBoard({ root = defaultRoot, scheduled = false,
  scheduleDirectory = process.env.TTS_OPERATIONS_SCHEDULE_DIR ||
    (process.platform === 'win32' ? 'C:\\Users\\Operator\\.codex\\automations' : join(homedir(), '.codex', 'automations')),
  syncShop = syncFromLocalService, auditPromotions = auditShopPromotions, refreshAdvertising,
  refreshShopSales, refreshPayments, now = Date.now } = {}) {
  const dataDirectory = join(root, 'apps', 'customer-service', 'data');
  const snapshots = join(dataDirectory, 'tiktok-shop', myShop);
  const boardDirectory = join(dataDirectory, 'operations-board');
  const reports = join(boardDirectory, 'days');
  const promotionFile = join(boardDirectory, 'promotion.json');
  const catalogueFile = join(boardDirectory, 'catalogue-live.json');
  const readRuns = createRunEvidence(scheduleDirectory);
  let metrics;
  let initial;
  let timer;
  let inFlight = false;
  let attemptedAt = null;
  let nextAt = null;
  let error = null;
  let lastSuccessfulRun = null;
  let promotionError = null;
  let trackedPilot;
  let pilotError = null;
  let syncedCatalogue;
  let paymentTimer;
  let manualCheckAt = null;
  const feedReaders = { advertising: refreshAdvertising, shopSales: refreshShopSales, payments: refreshPayments };
  const feedStates = { advertising: null, shopSales: null, payments: null };
  const feedRuns = new Map();

  function loadCached() {
    initial ??= (async () => {
      const [raw, names, savedCatalogue] = await Promise.all([
        latestSnapshot(snapshots), listNames(reports), readJson(catalogueFile),
      ]);
      const latest = names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().at(-1);
      const saved = latest && await readJson(join(reports, latest));
      const rawMetrics = raw ? summarizeShop(raw) : null;
      metrics ??= saved?.metrics && (!rawMetrics || Date.parse(saved.metrics.collectedAt) >= Date.parse(rawMetrics.collectedAt))
        ? saved.metrics : rawMetrics;
      trackedPilot ??= saved?.trackedPilot ?? null;
      syncedCatalogue ??= savedCatalogue;
    })().catch(() => {});
    return initial;
  }

  function syncState() {
    return { scheduled, running: inFlight, intervalMinutes: pollMinutes, paymentIntervalMinutes: paymentPollMinutes,
      attemptedAt, nextAt, error, lastSuccessfulRun, promotionError, pilotError, ...feedStates,
      activeReads: [...feedRuns.keys()] };
  }

  function collectFeed(name) {
    const reader = feedReaders[name];
    if (!reader) return null;
    if (feedRuns.has(name)) return feedRuns.get(name);
    const started = new Date(now());
    const pending = Promise.resolve().then(() => reader({ root, now: started }))
      .then(result => { feedStates[name] = result; })
      .catch(() => { feedStates[name] = { state: 'unavailable' }; })
      .finally(() => feedRuns.delete(name));
    feedRuns.set(name, pending);
    return pending;
  }

  function paymentCheck() {
    if (inFlight || feedRuns.has('shopSales')) return null;
    return collectFeed('payments');
  }

  function refreshSources() {
    if (!scheduled) return false;
    if (inFlight || (manualCheckAt !== null && now() - manualCheckAt < 30_000)) return false;
    manualCheckAt = now();
    if (!attemptedAt || now() - Date.parse(attemptedAt) >= paymentPollMinutes * 60_000) {
      clearTimeout(timer);
      timer = null;
      void refresh();
      return true;
    }
    void collectFeed('advertising');
    const payments = paymentCheck() ?? feedRuns.get('payments');
    void Promise.resolve(payments).then(() => {
      if (!inFlight) void collectFeed('shopSales');
    });
    return true;
  }

  async function evidence(day, currentMetrics, finance, promotion, sync) {
    const runs = await readRuns();
    return collectBoardEvidence({ root, scheduleDirectory, day, metrics: currentMetrics, finance, promotion, trackedPilot, sync, runs });
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    attemptedAt = new Date(now()).toISOString();
    error = null;
    void collectFeed('advertising');
    try {
      await Promise.all([feedRuns.get('payments'), feedRuns.get('shopSales')]);
      await loadCached();
      const snapshot = await syncShop(myShop, { directory: dataDirectory, persist: false });
      const updated = summarizeShop(snapshot);
      syncedCatalogue = { shop: snapshot.shop, source: snapshot.source, collectedAt: snapshot.collectedAt, products: snapshot.products };
      await mkdir(reports, { recursive: true });
      await saveBoardJson(catalogueFile, syncedCatalogue);
      const day = dayKey(new Date(updated.collectedAt));
      const [finance, savedPromotion] = await Promise.all([financeSummary(snapshots), readJson(promotionFile)]);
      let promotion = promotionSummary(savedPromotion);
      if (!promotion || dayKey(new Date(promotion.checkedAt)) !== day) {
        try {
          promotion = promotionSummary(await auditPromotions({ catalog: snapshot, directory: dataDirectory, root }));
          promotionError = null;
        } catch {
          promotionError = '当日促销读取待恢复。';
        }
      } else {
        promotionError = null;
      }
      try {
        trackedPilot = await readTrackedPilot(root, boardDirectory, trackedPilot);
        pilotError = null;
      } catch {
        pilotError = '本轮试点价格或订单回查未完成。';
      }
      const modules = await evidence(day, updated, finance, promotion, { ...syncState(), running: false });
      const { toReview, ...dailyPromotion } = promotion ?? {};
      await saveBoardJson(join(reports, day + '.json'), { day, metrics: updated, finance,
        promotion: promotion ? dailyPromotion : null, trackedPilot, modules });
      metrics = updated;
      lastSuccessfulRun = new Date(now()).toISOString();
    } catch (cause) {
      error = cause.code === 'ECONNREFUSED' ? '授权服务暂未启动，显示上次成功数据。' : '本轮读取或保存未完成，显示上次成功数据。';
    } finally {
      inFlight = false;
      nextAt = new Date(now() + pollMinutes * 60_000).toISOString();
      timer = setTimeout(() => void refresh(), pollMinutes * 60_000);
      timer.unref();
      void collectFeed('shopSales');
    }
  }

  function start() {
    if (!scheduled) return;
    if (!timer && !inFlight) void refresh();
    if (refreshPayments && !paymentTimer) {
      paymentTimer = setInterval(paymentCheck, paymentPollMinutes * 60_000);
      paymentTimer.unref();
    }
  }

  async function status(requestedDay, { includeModules = true } = {}) {
    await loadCached();
    const today = dayKey(new Date(now()));
    const day = requestedDay ?? today;
    const sync = syncState();
    const [finance, rawPromotion, names] = await Promise.all([
      financeSummary(snapshots), readJson(promotionFile), includeModules ? listNames(reports) : [],
    ]);
    const promotion = promotionSummary(rawPromotion);
    const modules = includeModules ? await evidence(today, metrics, finance, promotion, sync) : null;
    const dates = [today, ...names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).map(name => name.slice(0, 10))];
    const current = { day: today, metrics, finance, promotion, trackedPilot: trackedPilot ?? null, modules };
    const report = day === today ? current : await readJson(join(reports, day + '.json'));
    return { checkedAt: new Date(now()).toISOString(), today, current, sync, report, days: [...new Set(dates)].sort().reverse().slice(0, 30) };
  }

  return { start, status, refreshSources, catalogueSnapshot: () => syncedCatalogue };
}
