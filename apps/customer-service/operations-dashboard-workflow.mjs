import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayKey, readJson } from './operations-board-evidence.mjs';
import { isPlatformId } from './tiktok-shop-read.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const accountNames = ['example-creator-1', 'example-creator-2', 'example-creator-3', 'example-creator-4', 'example-creator-5'];
const dayMs = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const jobPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;

const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const onDay = (value, day) => isTime(value) && dayKey(new Date(value)) === day;
const newestTime = values => values.filter(isTime).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
const shiftDay = (day, days) => new Date(Date.parse(day + 'T00:00:00.000Z') + days * dayMs).toISOString().slice(0, 10);
const daysEnding = (day, count) => Array.from({ length: count }, (_, index) => shiftDay(day, index - count + 1));

async function directories(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && jobPattern.test(entry.name)).map(entry => entry.name);
}

async function files(path, pattern) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => entry.name);
}

async function readLedger(path) {
  const contents = await readFile(path, 'utf8').catch(() => null);
  if (contents === null) return null;
  const rows = [];
  let complete = true;
  for (const line of contents.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      else complete = false;
    } catch {
      // A truncated append does not establish a publication.
      complete = false;
    }
  }
  return { rows, complete };
}

async function readOfficialFolder(folder) {
  const reportEnds = (await directories(folder)).filter(name => /^report-end-\d{4}-\d{2}-\d{2}$/u.test(name));
  const located = await Promise.all([folder, ...reportEnds.map(name => join(folder, name))].map(async directory =>
    (await files(directory, /^official-read-[\dTZ.-]+\.json$/u)).map(name => join(directory, name))));
  return Promise.all(located.flat().map(readJson));
}

function officialReceiptReader(outputs) {
  const reconciliation = join(outputs, 'operations-shop-video-reconciliation');
  const folders = directories(reconciliation);
  const cache = new Map();
  return async day => {
    const reportDays = (await folders).filter(date => datePattern.test(date) && date >= day && date <= shiftDay(day, 14));
    const reports = await Promise.all(reportDays.map(date => {
      if (!cache.has(date)) cache.set(date, readOfficialFolder(join(reconciliation, date)));
      return cache.get(date);
    }));
    return officialEvidenceForDay(reports.flat(), day);
  };
}

function officialEvidenceForDay(reports, day) {
  const possible = reports.filter(report =>
    report?.schema === 'operations-shop-video-reconciliation/v1' &&
    report.shop?.id === shopId && report.shop.region === 'MY' && report.shop.name === 'example-shop-my' &&
    datePattern.test(report.query?.startInclusive ?? '') && datePattern.test(report.query?.endExclusive ?? '') &&
    datePattern.test(report.query?.latestAvailableDate ?? '') && report.query.startInclusive <= day &&
    report.query.endExclusive >= day && report.query.startInclusive < report.query.endExclusive &&
    isTime(report.observedAt) && Array.isArray(report.datedVideos)
  ).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const official = possible.find(report => report.query.endExclusive > day && report.query.latestAvailableDate >= day) ?? null;
  const lastRead = official ?? possible[0];
  const state = official ? (official.coverage?.completeForPublicationHistory === true ? 'complete' : 'partial') :
    !lastRead ? 'not_observed' : lastRead.query.latestAvailableDate < day ? 'report_date_lag' : 'day_not_requested';
  return { official, officialCoverage: { state, observedAt: lastRead?.observedAt ?? null,
    latestAvailableDate: lastRead?.query.latestAvailableDate ?? null } };
}

function independentAck(row, receipt, day) {
  if (!(receipt?.success === true && receipt.original_submit_once === true &&
    receipt.job_id === row.job_id && receipt.account === row.account && receipt.sha256 === row.sha256 &&
    onDay(receipt.at, day) && Date.parse(receipt.at) === Date.parse(row.published_at))) return false;
  if (receipt.product_id != null && receipt.product_id !== row.product_id) return false;
  if (row.original_submit_tool_call_id && receipt.original_submit_tool_call_id !== row.original_submit_tool_call_id) return false;
  if (receipt.independent_read_tool_call_id) {
    return receipt.independent_read_tool_call_id !== receipt.original_submit_tool_call_id;
  }
  // Older receipts lack a separate read call ID. Require the matched ledger's
  // original publish prompt evidence pointer before treating them as acknowledged.
  const pointer = typeof row.success_evidence === 'string' ? row.success_evidence.replaceAll('\\', '/') : '';
  return row.published === true && pointer.endsWith('/native-publishing/' + row.job_id + '/independent-success.json');
}

async function readPublication(outputs, day, readOfficialEvidence) {
  const root = join(outputs, 'video-publishing-' + day);
  const [summaryNames, blockerNames] = await Promise.all([
    files(root, /^\d{4}-live-publications-and-handoff\.json$/u),
    files(root, /^\d{4}-no-live-publishing-route-blocker\.json$/u),
  ]);
  const [policy, checkpoint, ledger, { official, officialCoverage }, summaries, blockers] = await Promise.all([
    readJson(join(root, 'actual-day-local-baseline.json')),
    readJson(join(root, 'checkpoint.json')),
    readLedger(join(root, '发布记录.jsonl')),
    readOfficialEvidence(day),
    Promise.all(summaryNames.map(name => readJson(join(root, name)))),
    Promise.all(blockerNames.map(name => readJson(join(root, name)))),
  ]);
  const officialById = new Map();
  const publicAnchorsById = new Map();
  const productsById = new Map();
  const disputedIds = new Set();
  const addOfficial = (id, account) => {
    if (!isPlatformId(id) || !accountNames.includes(account) || disputedIds.has(id)) return;
    if (officialById.has(id) && officialById.get(id) !== account) {
      officialById.delete(id);
      disputedIds.add(id);
      return;
    }
    officialById.set(id, account);
  };
  for (const video of official?.datedVideos ?? []) {
    if (video?.postDay !== day) continue;
    addOfficial(video.id, video.account);
    productsById.set(video.id, new Set((Array.isArray(video.productIds) ? video.productIds : []).filter(isPlatformId)));
  }
  const attempts = new Map();
  for (const row of ledger?.rows ?? []) {
    if (row?.actual_date !== day || !accountNames.includes(row.account) || !jobPattern.test(row.job_id ?? '') ||
        !fingerprintPattern.test(row.sha256 ?? '') || !isPlatformId(row.product_id) ||
        row.submit_attempted !== true || !onDay(row.published_at ?? row.submit_intent_at ?? row.attempt_at, day) ||
        ![row.original_submit_tool_call_id, row.action_key].some(value => typeof value === 'string' && value.length > 0)) continue;
    attempts.set(row.account + '/' + row.job_id + '/' + row.sha256, row);
  }
  const local = await Promise.all([...attempts.values()].filter(row => !/fail|reject|cancel|not_posted/i.test(row.status ?? '')).map(async row => {
    const receipt = await readJson(join(root, 'native-publishing', row.job_id, 'independent-success.json'));
    const acknowledged = independentAck(row, receipt, day);
    if (acknowledged && receipt.public_anchor_verified === true && receipt.product_id === row.product_id &&
      isPlatformId(receipt.platform_video_id)) {
      addOfficial(receipt.platform_video_id, row.account);
      publicAnchorsById.set(receipt.platform_video_id, row.account + '/' + row.product_id);
    }
    return { row, acknowledged, receipt };
  }));
  const exactLinksByJob = new Map();
  for (const link of official?.linkedHistoricalVideos ?? []) {
    if (officialById.get(link?.platformVideoId) !== link?.account || !isPlatformId(link?.productId) ||
        !jobPattern.test(link.jobId ?? '') || !fingerprintPattern.test(link.originalSuccess?.sha256 ?? '')) continue;
    const key = link.account + '/' + link.jobId + '/' + link.productId + '/' + link.originalSuccess.sha256;
    exactLinksByJob.set(key, link.platformVideoId);
  }
  const byAsset = new Map();
  for (const item of local) {
    const { row, acknowledged, receipt } = item;
    const key = row.account + '/' + row.job_id + '/' + row.product_id + '/' + row.sha256;
    const anchorKey = row.account + '/' + row.product_id;
    const verified = [acknowledged ? receipt.platform_video_id : null, exactLinksByJob.get(key), row.platform_video_id]
      .some(id => officialById.get(id) === row.account &&
        (productsById.get(id)?.has(row.product_id) || publicAnchorsById.get(id) === anchorKey));
    const publicAnchorVerified = verified && officialById.get(receipt?.platform_video_id) === row.account &&
      publicAnchorsById.get(receipt?.platform_video_id) === anchorKey;
    const confidence = publicAnchorVerified ? 3 : verified ? 2 : acknowledged ? 1 : 0;
    const asset = row.account + '/' + row.sha256;
    if (!byAsset.has(asset) || byAsset.get(asset).confidence < confidence) {
      byAsset.set(asset, { row, acknowledged, confidence });
    }
  }
  const records = [...byAsset.values()];
  const unresolved = records.filter(item => item.confidence < 3);
  const onDaySummaries = summaries.filter(summary => onDay(summary?.at, day));
  const latestSummary = onDaySummaries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const datedPolicy = policy?.actual_date === day && onDay(policy.at, day) ? policy : null;
  const datedCheckpoint = checkpoint?.actual_date === day && onDay(checkpoint.at, day) ? checkpoint : null;
  const counted = records.filter(item => item.confidence > 0);
  const countsByAccount = new Map(accountNames.map(account =>
    [account, counted.filter(item => item.row.account === account).length]));
  const latestSuccessAt = newestTime(local.filter(item => item.acknowledged).map(item => item.receipt.at));
  const agreesWithLedger = (observedAt, total, counts) => ledger?.complete && total === counted.length &&
    (!latestSuccessAt || Date.parse(observedAt) >= Date.parse(latestSuccessAt)) &&
    accountNames.every(account => counts?.[account] === countsByAccount.get(account));
  const reconciledCheckpoint = datedCheckpoint && agreesWithLedger(datedCheckpoint.at,
    datedCheckpoint.verified_today_successes, datedCheckpoint.successes_by_account);
  const reconciledSummary = latestSummary && agreesWithLedger(latestSummary.at, latestSummary.confirmed, latestSummary.counts);
  const ledgerCountVerified = Boolean(reconciledCheckpoint || reconciledSummary);
  const localObservedAt = newestTime([reconciledCheckpoint ? datedCheckpoint.at : null,
    reconciledSummary ? latestSummary.at : null, latestSuccessAt,
    ...(ledgerCountVerified && records.length === 0 ? blockers.filter(row => row?.actualDate === day && onDay(row.at, day) &&
      row.confirmedPosts === 0 && row.verifiedBusinessDispatchInThisTurn?.submit === 0).map(row => row.at) : [])]);
  const cap = Number.isInteger(datedPolicy?.per_account_daily_cap) && datedPolicy.per_account_daily_cap > 0
    ? datedPolicy.per_account_daily_cap : null;
  const nextByAccount = datedCheckpoint?.next_eligible_by_account ?? latestSummary?.next ?? {};
  const platformCountComplete = official?.coverage?.completeForPublicationHistory === true;
  const verifiedCount = number => number > 0 || platformCountComplete ? number : null;
  const localCount = number => number > 0 || ledgerCountVerified ? number : null;
  const accounts = accountNames.map(account => {
    const local = records.filter(item => item.row.account === account);
    const pending = local.filter(item => item.confidence < 3);
    return {
      account,
      officialCount: verifiedCount([...officialById.values()].filter(name => name === account).length),
      progressCount: localCount(countsByAccount.get(account)),
      pendingPublicAnchor: local.length > 0 || ledgerCountVerified ? local.filter(item => item.confidence > 0 && item.confidence < 3).length : null,
      pendingReadback: local.length > 0 || ledgerCountVerified ? pending.length : null,
      acknowledged: local.length > 0 || ledgerCountVerified ? pending.filter(item => item.acknowledged).length : null,
      nextAt: isTime(nextByAccount[account]) ? nextByAccount[account] : null,
      pending: pending.map(({ row, acknowledged, confidence }) => ({
        jobId: row.job_id,
        productId: row.product_id,
        attemptedAt: row.published_at ?? row.submit_intent_at ?? row.attempt_at,
        acknowledged,
        platformMatched: confidence === 2,
      })),
    };
  });
  return {
    day, target: Number.isInteger(datedPolicy?.daily_target) && datedPolicy.daily_target > 0 ? datedPolicy.daily_target : null,
    perAccountCap: cap,
    observedAt: newestTime([localObservedAt, official?.observedAt]),
    localObservedAt,
    officialObservedAt: official?.observedAt ?? null,
    officialCoverage,
    platformCountComplete,
    sourceLabel: '本地发布账本与平台回读',
    accounts,
    officialCount: verifiedCount(officialById.size),
    progressCount: localCount(counted.length),
    pendingPublicAnchor: records.length > 0 || ledgerCountVerified ? counted.filter(item => item.confidence < 3).length : null,
    pendingReadback: records.length > 0 || ledgerCountVerified ? unresolved.length : null,
    acknowledged: records.length > 0 || ledgerCountVerified ? unresolved.filter(item => item.acknowledged).length : null,
  };
}

async function listingEvidence(root, sellerSku) {
  const dir = join(root, sellerSku);
  const [creation, filenames] = await Promise.all([
    readJson(join(dir, 'create.result.json')),
    files(dir, /^readback-[\dTZ.-]+\.json$/u),
  ]);
  if (creation?.httpStatus !== 200 || creation.code !== 0 || typeof creation.requestId !== 'string' ||
      !creation.requestId || !isTime(creation.at) || !isPlatformId(creation.data?.product_id) ||
      !Array.isArray(creation.data?.skus)) return [];
  const productId = creation.data.product_id;
  const createdSkuIds = new Set(creation.data.skus.filter(sku => sku?.seller_sku === sellerSku && isPlatformId(sku.id)).map(sku => sku.id));
  const receipts = await Promise.all(filenames.map(name => readJson(join(dir, name))));
  return receipts.filter(receipt => receipt?.shopId === shopId && receipt.sellerSku === sellerSku &&
    receipt.productId === productId && createdSkuIds.has(receipt.skuId) && isTime(receipt.observedAt) &&
    Date.parse(receipt.observedAt) >= Date.parse(creation.at) &&
    receipt.result?.status === 'LIVE_VERIFIED' && receipt.platformState === 'ACTIVATE' && receipt.auditState === 'APPROVED' &&
    receipt.request?.httpStatus === 200 && receipt.request.code === 0 && typeof receipt.request.requestId === 'string' &&
    receipt.request.requestId && receipt.request.requestId !== creation.requestId
  ).map(receipt => ({ productId, skuId: receipt.skuId, sellerSku, verifiedAt: receipt.observedAt }));
}

async function readListingHeatmap(outputs, day) {
  const root = join(outputs, 'operations-listings', 'MY');
  const lookup = new Map();
  const batches = await Promise.all((await directories(root)).map(sellerSku => listingEvidence(root, sellerSku)));
  const records = batches.flat().sort((a, b) => Date.parse(a.verifiedAt) - Date.parse(b.verifiedAt));
  for (const record of records) {
    const key = record.productId + '/' + record.skuId;
    if (!lookup.has(key)) lookup.set(key, record);
  }
  const days = daysEnding(day, 28).map(date => {
    const entries = [...lookup.values()].filter(record => onDay(record.verifiedAt, date));
    return { day: date, verifiedCount: entries.length || null, entries };
  });
  return {
    startDay: days[0].day, endDay: day,
    observedAt: newestTime(days.flatMap(cell => cell.entries.map(entry => entry.verifiedAt))),
    sourceLabel: '创建回执与平台独立生效回读，空白日缺可核记录',
    days,
  };
}

export async function readDashboardWorkflow({ workspaceRoot = defaultRoot, day = dayKey(new Date()) } = {}) {
  const timestamp = typeof day === 'string' && datePattern.test(day) ? Date.parse(day + 'T00:00:00.000Z') : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) throw new TypeError('Invalid dashboard day');
  const outputs = join(workspaceRoot, 'outputs');
  const readOfficialEvidence = officialReceiptReader(outputs);
  const [publicationDays, listingHeatmap] = await Promise.all([
    Promise.all(daysEnding(day, 7).map(date => readPublication(outputs, date, readOfficialEvidence))),
    readListingHeatmap(outputs, day),
  ]);
  const publication = {
    ...publicationDays.at(-1),
    trend: publicationDays.map(({ day, officialCount, progressCount, platformCountComplete, pendingReadback, acknowledged, observedAt, officialObservedAt }) =>
      ({ day, officialCount, progressCount, platformCountComplete, pendingReadback, acknowledged, observedAt, officialObservedAt })),
  };
  return { publication, listingHeatmap };
}
