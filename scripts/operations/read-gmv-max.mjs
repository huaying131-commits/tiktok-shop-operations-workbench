import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const server = 'tiktok_ads_reporting';
const endpoint = 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat';
const advertiserId = '9000000000000000096';
const shopId = '9000000000000000099';
const timezone = 'Asia/Kuala_Lumpur';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = ['advertiser_info_get', 'gmv_max_store_list_get', 'gmv_max_campaign_get',
  'gmv_max_report_get', 'campaign_gmv_max_info_get'];

export function openAppServer() {
  const child = spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', ['app-server', '--stdio',
    '-c', `mcp_servers.${server}.url=${JSON.stringify(endpoint)}`,
    '-c', `mcp_servers.${server}.enabled_tools=${JSON.stringify(tools)}`],
  { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  child.once('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.once('exit', code => rejectPending(new Error('Codex app-server exited (' + code + ')')));
  lines.on('line', line => {
    const response = JSON.parse(line);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  });

  return {
    notify(method) { send({ method }); },
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(method + ' timed out'));
        }, 45_000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    close() { child.stdin.end(); lines.close(); },
  };
}

function dateOffset(day, offset) {
  return new Date(Date.parse(day + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
}

export function reportDay(value) {
  return /^(\d{4}-\d{2}-\d{2})(?: 00:00:00)?$/u.exec(value ?? '')?.[1] ?? null;
}

async function pagedReport(read, args) {
  const rows = new Map();
  const requestIds = [];
  let total, pages, totals;
  for (let page = 1; ; page += 1) {
    const response = await read('gmv_max_report_get', { ...args, page, enable_total_metrics: page === 1 });
    const { list, page_info: info, total_metrics: metrics } = response.data;
    if (!Array.isArray(list) || !Number.isSafeInteger(info?.total_page) || info.total_page < 0 ||
        !Number.isSafeInteger(info.total_number) || info.total_number < 0 || info.page !== page) {
      throw new Error('Invalid product or creative report page');
    }
    if (page === 1) {
      total = info.total_number;
      pages = info.total_page;
      totals = metrics ?? null;
    }
    if (total !== info.total_number || pages !== info.total_page) throw new Error('GMV Max report changed during pagination');
    requestIds.push(response.request_id);
    for (const row of list) {
      const identity = args.dimensions.map(key => row.dimensions?.[key]);
      const key = JSON.stringify(identity);
      if (identity.some(value => typeof value !== 'string' || !value) || rows.has(key)) throw new Error('Invalid or duplicate GMV Max report row');
      rows.set(key, row);
    }
    if (page >= pages) break;
  }
  if (rows.size !== total) throw new Error('GMV Max report row count mismatch');
  return { requestIds, dimensions: args.dimensions, rows: [...rows.values()], totals };
}

async function tryReport(work) {
  try {
    return { available: true, result: await work() };
  } catch (error) {
    return { available: false, error: error.message, requestId: error.requestId ?? null, platformCode: error.platformCode ?? null };
  }
}

async function activeProductReports(read, args, campaigns) {
  const reports = [];
  for (const campaign of campaigns.filter(row => row.type === 'PRODUCT' && Array.isArray(row.productIds) && row.productIds.length)) {
    const filtering = { campaign_ids: [campaign.id] };
    const byDay = await tryReport(async () => {
      const report = await pagedReport(read, { ...args, dimensions: ['item_group_id', 'stat_time_day'], filtering });
      if (report.rows.some(row => {
        const day = reportDay(row.dimensions.stat_time_day);
        return !/^\d{8,30}$/u.test(row.dimensions.item_group_id) || !day || day < args.start_date || day > args.end_date;
      })) {
        throw new Error('Invalid product ID or day in GMV Max report');
      }
      return report;
    });
    const creatives = [];
    for (const productId of new Set(campaign.productIds)) {
      if (typeof productId !== 'string' || !/^\d{8,30}$/u.test(productId)) throw new Error('Invalid advertised product ID');
      const report = await tryReport(() => pagedReport(read, { ...args, dimensions: ['item_id'],
        metrics: [...args.metrics, 'shop_content_type', 'tt_account_name', 'creative_delivery_status'],
        filtering: { ...filtering, item_group_ids: [productId] } }));
      creatives.push({ productId, ...report });
    }
    reports.push({ campaignId: campaign.id, byDay, creatives });
  }
  return reports;
}

async function readGmvMax(reportEnd, { dashboardOnly = false } = {}) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short' }).format(new Date());
  const end = reportEnd ?? dateOffset(day, -1);
  if (reportDay(end) !== end || end < dateOffset(day, -4) || end >= day ||
      !Number.isFinite(Date.parse(end)) || dateOffset(end, 0) !== end) {
    throw new Error('Report end must be one of the last four completed Malaysia calendar days');
  }
  const start = dateOffset(end, -6);
  const client = openAppServer();
  try {
    await client.request('initialize', { clientInfo: { name: 'tiktok-operations', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    client.notify('initialized');
    const inventory = await client.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    const connector = inventory.data?.find(item => item.name === server);
    if (connector?.authStatus !== 'oAuth') throw new Error('TikTok for Business OAuth is unavailable');
    if (!tools.every(tool => connector.tools?.[tool]?.annotations?.readOnlyHint === true)) {
      throw new Error('Official read-only tool inventory is incomplete');
    }
    const reportSchema = connector.tools.gmv_max_report_get.inputSchema?.properties;
    const reportDimensions = reportSchema?.dimensions?.items?.enum;
    const reportMetrics = reportSchema?.metrics?.items?.enum;
    const reportContract = {
      dimensions: Array.isArray(reportDimensions) ? reportDimensions : null,
      orderIdDimensionAvailable: Array.isArray(reportDimensions) ? reportDimensions.includes('order_id') : null,
      paidOrderMetricAvailable: Array.isArray(reportMetrics) ? reportMetrics.includes('paid_orders') : null,
    };
    const thread = await client.request('thread/start', { cwd: root, ephemeral: true });
    async function read(tool, args) {
      if (!tools.includes(tool)) throw new Error('Unsupported GMV Max read tool');
      const result = await client.request('mcpServer/tool/call',
        { threadId: thread.thread.id, server, tool, arguments: args });
      const body = result.structuredContent ?? JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? '{}');
      if (result.isError || (body.code !== undefined && body.code !== 0) || !body.data || !body.request_id) {
        const error = new Error(tool + ' failed: ' + (body.message ?? 'incomplete response'));
        error.requestId = body.request_id;
        error.platformCode = body.code;
        throw error;
      }
      return body;
    }
    const [accountResponse, shopResponse] = await Promise.all([
      read('advertiser_info_get', { advertiser_ids: [advertiserId],
        fields: ['advertiser_id', 'name', 'currency', 'timezone', 'status'] }),
      read('gmv_max_store_list_get', { advertiser_id: advertiserId }),
    ]);
    const account = accountResponse.data.list?.find(row => row.advertiser_id === advertiserId);
    const store = shopResponse.data.store_list?.find(row => row.store_id === shopId);
    if (account?.timezone !== timezone || !account.currency || store?.store_name !== 'example-shop-my' ||
        !store.targeting_region_codes?.includes('MY') || store.is_gmv_max_available !== true ||
        store.exclusive_authorized_advertiser_info?.advertiser_id !== advertiserId) {
      throw new Error('Malaysia Cross1 account and shop do not match');
    }

    const reportArgs = { advertiser_id: advertiserId, store_ids: [shopId], start_date: start, end_date: end,
      metrics: ['cost', 'gross_revenue', 'orders', 'roi', 'cost_per_order'], enable_total_metrics: true, page_size: 1000 };
    const accountArgs = { ...reportArgs, metrics: [...reportArgs.metrics, 'net_cost'] };
    const [accountByDay, today, campaigns, campaignByDay] = await Promise.all([
      read('gmv_max_report_get', { ...accountArgs, dimensions: ['advertiser_id', 'stat_time_day'] }),
      read('gmv_max_report_get', { ...accountArgs, start_date: day, end_date: day,
        dimensions: [dashboardOnly ? 'advertiser_id' : 'campaign_id', 'stat_time_day'] }),
      dashboardOnly ? null : read('gmv_max_campaign_get', { advertiser_id: advertiserId, page_size: 100,
        filtering: { store_ids: [shopId], gmv_max_promotion_types: ['PRODUCT_GMV_MAX', 'LIVE_GMV_MAX'] } }),
      dashboardOnly ? null : read('gmv_max_report_get', { ...reportArgs, dimensions: ['campaign_id', 'stat_time_day'] }),
    ]);
    for (const response of dashboardOnly ? [accountByDay, today] : [accountByDay, today, campaigns, campaignByDay]) {
      const { list, page_info: page } = response.data;
      if (!Array.isArray(list) || !Number.isInteger(page?.total_page) || page.total_page > 1 ||
          page.total_number !== list.length) throw new Error('GMV Max report pagination incomplete');
    }
    const enabled = campaigns?.data.list.filter(row => row.operation_status === 'ENABLE') ?? [];
    const campaignDetails = await Promise.all(enabled.map(async row => {
      const response = await read('campaign_gmv_max_info_get', { advertiser_id: advertiserId, campaign_id: row.campaign_id });
      const detail = response.data;
      if (detail.advertiser_id !== advertiserId || detail.store_id !== shopId || detail.campaign_id !== row.campaign_id) {
        throw new Error('GMV Max campaign detail identity mismatch');
      }
      return { requestId: response.request_id, id: detail.campaign_id, name: detail.campaign_name, status: detail.operation_status,
        type: detail.shopping_ads_type, targetRoi: detail.roas_bid, budget: detail.budget, autoBudget: detail.auto_budget,
        productIds: detail.item_group_ids };
    }));
    const productReports = await activeProductReports(read, reportArgs, campaignDetails);
    const observedAt = new Date().toISOString();
    const receipt = { schema: 'operations-gmv-max-read/v1', observedAt, source: 'TikTok for Business official MCP, read-only', account,
      shop: { id: shopId, name: store.store_name, region: 'MY', gmvMaxAvailable: true, advertiserId },
      completeDays: { start, end, accountByDay, ...(!dashboardOnly && { campaignByDay, productReports }) },
      inProgressDay: { day, report: today }, ...(!dashboardOnly && { campaigns, campaignDetails }),
      reportContract,
      requestIds: { account: accountResponse.request_id, shop: shopResponse.request_id } };
    const directory = join(root, 'outputs/ads-monitoring', day, 'live-read-validation',
      ...(reportEnd ? ['report-end-' + end] : []));
    await mkdir(directory, { recursive: true });
    const prefix = dashboardOnly ? 'official-gmv-max-dashboard-' : 'official-gmv-max-';
    const file = join(directory, prefix + observedAt.replace(/[:.]/gu, '-') + '.json');
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ file, observedAt, currency: account.currency, start, end, totals: accountByDay.data.total_metrics,
      today: today.data.total_metrics, campaignDetails, productReports: productReports.map(row => ({ campaignId: row.campaignId,
        productDays: row.byDay.result?.rows.length ?? null, productError: row.byDay.error ?? null,
        creative: row.creatives.map(item => ({ productId: item.productId, rows: item.result?.rows.length ?? null, error: item.error ?? null })) })) }, null, 2));
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'report-end': { type: 'string' }, 'dashboard-only': { type: 'boolean' } } });
    await readGmvMax(values['report-end'], { dashboardOnly: values['dashboard-only'] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
