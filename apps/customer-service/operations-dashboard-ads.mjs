import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dayKey } from './operations-board-evidence.mjs';
import { reportDay } from '../../scripts/operations/read-gmv-max.mjs';

const currency = 'USD';
const advertiser = '9000000000000000096';
const timeZone = 'Asia/Kuala_Lumpur';
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const hourInMalaysia = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
const refreshAgeMs = 25 * 60_000;
const refreshesInFlight = new Map();
const execFileAsync = promisify(execFile);
export const dashboardAdReceiptPattern = /^official-gmv-max-[\w.-]+\.json$/u;
export const isDashboardAdReceipt = value => value?.schema === 'operations-gmv-max-read/v1' &&
  value.shop?.id === '9000000000000000099' && value.shop.name === 'example-shop-my' && value.shop.region === 'MY' &&
  value.shop.advertiserId === advertiser && value.account?.advertiser_id === advertiser && value.account.currency === currency;
const amount = value => typeof value === 'string' && /^-?\d+(?:\.\d{1,2})?$/u.test(value) ? value : null;
const shift = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
const validDay = value => /^\d{4}-\d{2}-\d{2}$/u.test(value ?? '') && Number.isFinite(Date.parse(value)) && shift(value, 0) === value;
const source = (root, { file, at }) => ({ path: relative(root, file).replace(/\\/gu, '/'), observedAt: at });

function metrics(values) {
  const orders = /^\d+$/u.test(String(values?.orders)) ? Number(values.orders) : null;
  return {
    spend: amount(values?.cost),
    netSpend: amount(values?.net_cost),
    grossRevenue: amount(values?.gross_revenue),
    roi: amount(values?.roi),
    skuOrders: Number.isSafeInteger(orders) ? orders : null,
    costPerOrder: amount(values?.cost_per_order),
  };
}

function summary(root, receipt, report, start, endExclusive, state) {
  if (report?.code !== 0 || typeof report.request_id !== 'string' || !report.request_id) return null;
  const { list, page_info: page, total_metrics: totals } = report.data ?? {};
  if (page && (!Array.isArray(list) || page.page !== 1 || ![0, 1].includes(page.total_page) ||
    page.total_number !== list.length || (page.total_page === 0 && list.length > 0))) return null;
  const values = metrics(totals);
  if (values.spend === null && values.grossRevenue === null && values.roi === null) return null;

  const series = [];
  const rowKeys = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const dimensions = row?.dimensions;
    const day = reportDay(dimensions?.stat_time_day);
    const key = state === 'same_day_snapshot' ? `${day}/${dimensions?.campaign_id ?? ''}` : day;
    if (!validDay(day) || day < start || day >= endExclusive || rowKeys.has(key) ||
        (dimensions.advertiser_id != null && dimensions.advertiser_id !== receipt.value.account.advertiser_id)) return null;
    rowKeys.add(key);
    series.push({ day, ...metrics(row.metrics) });
  }
  series.sort((a, b) => a.day.localeCompare(b.day));
  return {
    currency, window: { start, endExclusive }, state, requestId: report.request_id, ...values, series,
    attribution: 'platform_may_include_organic', source: source(root, receipt),
  };
}

export function summarizeDashboardAdvertising(root, day, receipts) {
  // Report cutoff and capture time are independent. Keep same-day and completed
  // intervals separate, and find campaign data in its own receipt.
  const available = receipts.filter(({ at }) => dayKey(new Date(at)) <= day)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const completeCandidates = available.filter(({ value }) => {
    const { start, end } = value.completeDays ?? {};
    return validDay(end) && end < day && start === shift(end, -6);
  }).sort((a, b) => b.value.completeDays.end.localeCompare(a.value.completeDays.end));
  const complete = completeCandidates.map(receipt => {
    const { start, end, accountByDay } = receipt.value.completeDays ?? {};
    return summary(root, receipt, accountByDay, start, shift(end, 1), 'complete_seven_day_window');
  }).find(Boolean) ?? null;
  const inProgress = available.filter(({ value, at }) => value.inProgressDay?.day === day && dayKey(new Date(at)) === day)
    .map(receipt => summary(root, receipt, receipt.value.inProgressDay.report, day, shift(day, 1), 'same_day_snapshot'))
    .find(Boolean) ?? null;

  const campaignReceipt = available.find(({ value }) => Array.isArray(value.campaignDetails));
  const validId = value => /^\d{14,22}$/u.test(value ?? '');
  const positive = value => Number.isFinite(value) && value >= 0 ? value : null;
  const campaigns = (campaignReceipt?.value.campaignDetails ?? []).filter(row => validId(row?.id) && row.requestId)
    .map(row => ({
      id: row.id, name: typeof row.name === 'string' ? row.name.trim().slice(0, 180) : null,
      status: /^[A-Z_]+$/u.test(row.status ?? '') ? row.status : null,
      targetRoi: positive(row.targetRoi), budget: positive(row.budget), currency,
      productIds: Array.isArray(row.productIds) ? row.productIds.filter(validId) : [], source: source(root, campaignReceipt),
    }));
  return {
    complete, inProgress, campaigns,
    missingReason: {
      today: inProgress ? null : 'official_report_unavailable',
      week: complete ? null : 'complete_seven_day_report_unavailable',
    },
  };
}

async function latestToday(root, day, latestAllowedAt) {
  const directory = join(root, 'outputs', 'ads-monitoring', day, 'live-read-validation');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const receipts = await Promise.all(entries.filter(entry => entry.isFile() && dashboardAdReceiptPattern.test(entry.name)).map(async entry => {
    const file = join(directory, entry.name);
    try {
      const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
      const at = value?.observedAt;
      return isDashboardAdReceipt(value) && typeof at === 'string' && Date.parse(at) <= latestAllowedAt
        ? { file, at, value } : null;
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return summarizeDashboardAdvertising(root, day, receipts.filter(Boolean)).inProgress?.source.observedAt ?? null;
}

async function runDashboardRefresh(root, day, now) {
  let observedAt;
  try {
    observedAt = await latestToday(root, day, now.getTime());
  } catch {
    return { state: 'unavailable', day, reason: 'receipt_read_failed' };
  }
  if (observedAt && now.getTime() - Date.parse(observedAt) < refreshAgeMs) {
    return { state: 'fresh', day, observedAt };
  }

  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.HTTPS_PROXY ||= 'http://127.0.0.1:10808';
    env.HTTP_PROXY ||= env.HTTPS_PROXY;
    env.NO_PROXY = [...new Set([...(env.NO_PROXY ?? '').split(',').filter(Boolean), '127.0.0.1', 'localhost'])].join(',');
  }
  try {
    await execFileAsync(process.execPath, [join(root, 'scripts', 'operations', 'read-gmv-max.mjs'), '--dashboard-only'],
      { cwd: root, env, windowsHide: true, timeout: 120_000 });
    const refreshedAt = await latestToday(root, day, Date.now());
    if (!refreshedAt || refreshedAt === observedAt) {
      return { state: 'unavailable', day, observedAt, reason: 'new_receipt_unavailable' };
    }
    return { state: 'refreshed', day, observedAt: refreshedAt };
  } catch {
    return { state: 'unavailable', day, observedAt, reason: 'official_read_failed' };
  }
}

export function refreshDashboardAdvertising({ root = defaultRoot, now = new Date() } = {}) {
  const day = dayKey(now);
  if (Number(hourInMalaysia.format(now)) < 8) return Promise.resolve({ state: 'outside_hours', day });
  const key = resolve(root);
  const pending = refreshesInFlight.get(key);
  if (pending) return pending;
  const refresh = runDashboardRefresh(key, day, now).finally(() => refreshesInFlight.delete(key));
  refreshesInFlight.set(key, refresh);
  return refresh;
}
