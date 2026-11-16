import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoState, REPLY_WINDOW_MS } from './demo-data.mjs';
import { createOperationsBoard } from './operations-board.mjs';
import { refreshDashboardAdvertising } from './operations-dashboard-ads.mjs';
import { readDashboardCatalogue } from './operations-dashboard-catalogue.mjs';
import { readOperationsDashboard, refreshDashboardPayments, refreshDashboardShopSales } from './operations-dashboard-data.mjs';
import { dashboardImageUrl, getDashboardImage, isDashboardImagePath } from './operations-dashboard-images.mjs';
import { dashboardVideoMedia, getDashboardVideo, isDashboardVideoPath, mediaRange } from './operations-dashboard-media.mjs';
import { readDashboardWorkflow } from './operations-dashboard-workflow.mjs';
import { dayKey } from './operations-board-evidence.mjs';
import { readDailyRoleQueue } from '../../scripts/operations/daily-role-queue.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const stateFile = resolve(process.env.DESK_STATE_FILE || join(directory, 'data', 'test-state.json'));
const port = Number(process.env.DESK_PORT ?? '3377');
const MAX_BODY_BYTES = 8_192;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_IDEMPOTENCY_KEYS = 256;
const operationsBoard = createOperationsBoard({
  scheduled: process.env.TTS_OPERATIONS_BOARD === '1', refreshAdvertising: refreshDashboardAdvertising,
  refreshShopSales: refreshDashboardShopSales, refreshPayments: refreshDashboardPayments,
});
const queueDirectory = resolve(process.env.TTS_OPERATIONS_QUEUE_DIR || join(directory, 'data', 'operations-role-queue'));
const queueRoles = new Set(['procurement', 'video-production', 'video-publishing', 'ads-analysis']);
const rolePages = new Map([
  ['procurement', '/operations?tab=inventory#procurement-tasks'],
  ['video-production', '/operations?tab=content#production-tasks'],
  ['video-publishing', '/operations?tab=publishing#publish-review'],
  ['ads-analysis', '/operations?tab=ads#ads-tasks'],
]);
const operationsHomepage = ['operations-dashboard-live.html', 'text/html; charset=utf-8'];
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/buyer', ['index.html', 'text/html; charset=utf-8']],
  ['/buyer/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/operations', ['operations.html', 'text/html; charset=utf-8']],
  ['/operations/', ['operations.html', 'text/html; charset=utf-8']],
  ['/operations.css', ['operations.css', 'text/css; charset=utf-8']],
  ['/operations.js', ['operations.js', 'text/javascript; charset=utf-8']],
  ['/operations-dashboard-live.css', ['operations-dashboard-live.css', 'text/css; charset=utf-8']],
  ['/operations-dashboard-live.js', ['operations-dashboard-live.js', 'text/javascript; charset=utf-8']],
  ['/operations-dashboard-detail.js', ['operations-dashboard-detail.js', 'text/javascript; charset=utf-8']],
  ['/operations-dashboard-detail.css', ['operations-dashboard-detail.css', 'text/css; charset=utf-8']],
]);

function dashboardDay(raw) {
  if (raw === null) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? new Date(raw + 'T00:00:00Z') : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new RequestError(400, '日期格式错误。');
  }
  return raw;
}

const dashboardReads = new Map();
const recentDashboards = new Map();
const dashboardCacheMs = 5_000;

function getDashboard(reportDay = dayKey(new Date())) {
  const recent = recentDashboards.get(reportDay);
  if (recent && Date.now() - recent.at < dashboardCacheMs) return recent.value;
  if (dashboardReads.has(reportDay)) return dashboardReads.get(reportDay);
  const pending = (async () => {
    const board = await operationsBoard.status(reportDay, { includeModules: false });
    const queue = readDailyRoleQueue({ dataDir: queueDirectory });
    const [dashboard, workflow, catalogue] = await Promise.all([
      readOperationsDashboard({ day: reportDay, board, queue, imageUrl: dashboardImageUrl }),
      readDashboardWorkflow({ day: reportDay }),
      readDashboardCatalogue({ day: reportDay, synced: operationsBoard.catalogueSnapshot() }),
    ]);
    if (catalogue) {
      const summary = dashboard.shop.catalogue;
      const newerSummary = Date.parse(summary?.source?.observedAt) > Date.parse(catalogue.rowsSource?.observedAt);
      dashboard.shop.catalogue = { ...summary, ...catalogue,
        ...(newerSummary && { activeProducts: summary.activeProducts, productsTotal: summary.productsTotal }),
        countsSource: newerSummary ? summary.source : catalogue.rowsSource,
      };
    }
    for (const video of dashboard.videos?.ranking?.rows ?? []) video.media = dashboardVideoMedia(video);
    const data = { schema: 'operations-dashboard/v1', sync: board.sync, ...dashboard, workflow,
      roleTasks: queue.tasks.filter(task => task.lastDay === reportDay && queueRoles.has(task.role) &&
        ['approval', 'queued', 'retry'].includes(task.state)).map(({ key, role, title, state, priority, updatedAt }) =>
        ({ key, role, title, state, priority, updatedAt })),
    };
    const json = JSON.stringify(data);
    const value = { data, json, etag: '"' + createHash('sha256').update(json).digest('base64url') + '"' };
    const at = Date.now();
    for (const [date, cached] of recentDashboards) {
      if (at - cached.at >= dashboardCacheMs) recentDashboards.delete(date);
    }
    if (recentDashboards.size >= 8) recentDashboards.delete(recentDashboards.keys().next().value);
    recentDashboards.set(reportDay, { at, value });
    return value;
  })().finally(() => dashboardReads.delete(reportDay));
  dashboardReads.set(reportDay, pending);
  return pending;
}

function legacyActivity({ day, fulfillment, workflow }) {
  const publication = workflow.publication;
  const verifiedPending = fulfillment?.pendingShipment ?? null;
  return {
    day,
    fulfillment: {
      status: fulfillment ? 'partial' : 'unavailable',
      asOf: fulfillment?.source?.observedAt,
      snapshotDay: fulfillment?.snapshotDay,
      isCurrentDay: fulfillment?.isCurrentDay,
      pendingShipment: verifiedPending,
      awaitingCollection: fulfillment?.awaitingCollection ?? null,
      message: fulfillment?.isCurrentDay === false ? '显示上次官方订单回查。等待今日回查。' : '分仓数量按已匹配的仓库回执汇总。待核订单保留在待分仓。',
      warehouses: (fulfillment?.warehouses ?? []).map(warehouse => ({
        ...warehouse,
        orders: fulfillment.rows.filter(row => (row.warehouseId ?? 'unassigned') === warehouse.warehouseId).map(row => ({
          orderId: '尾号 ' + row.orderSuffix,
          statusCode: 'AWAITING_SHIPMENT',
          skuId: row.skuId,
          quantity: row.quantity,
          nextAction: row.state === 'warehouse_sku_unverified' ? '核仓库货号及可发量' : '核对原包裹和库房记录',
          source: row.source?.path,
        })),
      })),
    },
    publishing: {
      status: publication.officialCount === null ? 'unavailable' : 'partial',
      asOf: publication.observedAt,
      count: publication.officialCount,
      target: publication.target,
      message: '平台已核和原提交待回查分别统计。',
      trend: publication.trend.map(item => ({ day: item.day, count: item.officialCount })),
      accounts: publication.accounts.map(item => ({
        name: '@' + item.account,
        count: item.officialCount,
        pendingCount: item.pendingReadback,
        target: publication.perAccountCap,
        pending: item.pending.map(video => ({
          title: video.jobId,
          status: video.acknowledged ? '有成功提示 · 平台 ID 待核' : '提交结果待核',
          nextAction: '回查原账号的视频 ID、公开状态和商品卡',
        })),
      })),
    },
  };
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    if (saved.state?.mode !== 'test' || !Array.isArray(saved.state.conversations)) {
      throw new Error('Invalid local test state');
    }
    return { state: saved.state, receipts: saved.receipts ?? [] };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { state: createDemoState(), receipts: [] };
  }
}

async function saveState(next) {
  await mkdir(dirname(stateFile), { recursive: true });
  const pendingFile = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(pendingFile, JSON.stringify(next, null, 2), { flag: 'wx' });
    await rename(pendingFile, stateFile);
  } catch (error) {
    await unlink(pendingFile).catch(() => {});
    throw error;
  }
}

function pushMessage(conversation, from, text, now) {
  conversation.messages.push({ id: randomUUID(), from, text, at: new Date(now).toISOString() });
}

function handoff(conversation) {
  conversation.status = 'human';
  conversation.assignee = '人工客服';
}

function getAutomaticReply(conversation, message) {
  const text = message.toLowerCase();
  const isMalay = /\b(boleh|saya|anda|terima|pesanan|bungkusan|penghantaran|dah|saiz|ukuran|dimensi)\b/u.test(text);

  if (/refund|return|damag|broken|wrong item|retak|rosak|pulangan|pulangkan|bayaran balik|退款|退货|破损/u.test(text)) {
    return null;
  }

  const shipment = conversation.order?.shipment;
  if (shipment && /track|parcel|shipment|deliver|shipping|penjejakan|bungkusan|penghantaran|物流|快递/u.test(text)) {
    const delivered = shipment.status === '已送达';
    const status = isMalay
      ? (delivered ? 'sudah dihantar' : 'sedang dalam perjalanan')
      : (delivered ? 'has been delivered' : 'is in transit');
    return isMalay
      ? `Hai! Bungkusan anda ${status}. Nombor penjejakan ujian: ${shipment.tracking}.`
      : `Hi! Your parcel ${status}. Test tracking number: ${shipment.tracking}.`;
  }

  const isOrganiser = /organi[sz]er|meja|收纳架/u.test(text)
    || conversation.order?.product.includes('桌面收纳架')
    || conversation.topic === '商品规格';
  if (isOrganiser && /dimensions?|\bsize\b|saiz|ukuran|dimensi|尺寸/u.test(text)) {
    return isMalay
      ? 'Hai! Pengatur meja ujian ini berukuran 25 × 14 × 11 cm.'
      : 'Hi! The demo desk organiser measures 25 × 14 × 11 cm.';
  }

  return null;
}

function applyAction(conversation, action, text, now) {
  if (action === 'buyer') {
    const lastMessage = conversation.messages.at(-1);
    if (conversation.status === 'resolved' || lastMessage?.from !== 'buyer') {
      conversation.dueAt = new Date(now + REPLY_WINDOW_MS).toISOString();
    }
    if (conversation.status === 'resolved') {
      conversation.status = conversation.assignee ? 'human' : 'open';
    }
    pushMessage(conversation, 'buyer', text, now);
    if (conversation.status === 'open') {
      const reply = getAutomaticReply(conversation, text);
      if (reply) pushMessage(conversation, 'auto', reply, now);
      else handoff(conversation);
    }
  } else if (action === 'reply') {
    handoff(conversation);
    pushMessage(conversation, 'agent', text, now);
  } else if (action === 'handoff') {
    handoff(conversation);
  } else {
    conversation.status = 'resolved';
  }
}

let store = await loadState();
let writes = Promise.resolve();

function updateState(id, action, text, key) {
  const queued = writes.then(async () => {
    const receipt = key && store.receipts.find(entry => entry.key === key);
    if (receipt) {
      if (receipt.id !== id || receipt.action !== action || receipt.text !== text) {
        throw new RequestError(409, '此操作标识已经用于其他请求。');
      }
      return store.state;
    }

    const next = structuredClone(store);
    const conversation = next.state.conversations.find(item => item.id === id);
    if (!conversation) throw new RequestError(404, '找不到该测试会话。');
    applyAction(conversation, action, text, Date.now());
    if (key) next.receipts = [...next.receipts, { key, id, action, text }].slice(-MAX_IDEMPOTENCY_KEYS);
    await saveState(next);
    store = next;
    return store.state;
  });
  writes = queued.catch(() => {});
  return queued;
}

function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
    throw new RequestError(415, '请求需要使用 JSON。');
  }

  return new Promise((accept, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(413, '请求内容过长。'));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
        accept(value);
      } catch {
        reject(new RequestError(400, '请求内容格式有误。'));
      }
    });
  });
}

function send(response, status, type, value, head = false, headers = {}) {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  response.end(head ? undefined : value);
}

function sendJSON(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function handle(request, response) {
  const listenerPort = server.address().port;
  const localHosts = [`127.0.0.1:${listenerPort}`, `localhost:${listenerPort}`];
  const host = (request.headers.host ?? '').toLowerCase();
  const origin = request.headers.origin;
  if (!localHosts.includes(host) || (origin && origin !== `http://${host}`)) {
    throw new RequestError(403, '此测试应用只允许本机同源访问。');
  }

  const { pathname, searchParams } = new URL(request.url, 'http://localhost');
  const method = request.method;
  const isOperations = pathname === '/operations' || pathname === '/operations/';
  const legacyOperations = searchParams.get('view') === 'legacy';
  const rolePage = rolePages.get(searchParams.get('role'));
  if (isOperations && !legacyOperations && rolePage && !searchParams.has('tab') &&
      (method === 'GET' || method === 'HEAD')) {
    send(response, 302, 'text/plain; charset=utf-8', '', method === 'HEAD', { Location: rolePage });
    return;
  }
  const asset = isOperations && !legacyOperations ? operationsHomepage : STATIC_FILES.get(pathname);
  if (asset) {
    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, '不支持该请求方法。');
    const [file, type] = asset;
    try {
      const body = await readFile(join(directory, 'public', file));
      send(response, 200, type, body, method === 'HEAD');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new RequestError(404, '找不到该页面。');
    }
    return;
  }

  if (pathname === '/api/state') {
    if (method !== 'GET') throw new RequestError(405, '不支持该请求方法。');
    sendJSON(response, 200, store.state);
    return;
  }

  if (pathname === '/api/operations') {
    if (method !== 'GET') throw new RequestError(405, '只支持读取工作台。');
    const day = searchParams.get('day');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RequestError(400, '日期格式错误。');
    sendJSON(response, 200, await operationsBoard.status(day));
    return;
  }

  if (pathname === '/api/operations/tasks') {
    if (method !== 'GET') throw new RequestError(405, '只支持读取任务队列。');
    const role = searchParams.get('role');
    if (role !== null && !queueRoles.has(role)) throw new RequestError(400, '岗位参数无效。');
    sendJSON(response, 200, readDailyRoleQueue({ dataDir: queueDirectory, role: role ?? undefined }));
    return;
  }

  if (pathname === '/api/operations/dashboard' || pathname === '/api/operations/activity') {
    if (method !== 'GET') throw new RequestError(405, '只支持读取工作台。');
    const { data, json, etag } = await getDashboard(dashboardDay(searchParams.get('day')));
    if (pathname.endsWith('/activity')) {
      sendJSON(response, 200, legacyActivity(data));
    } else {
      const validators = (request.headers['if-none-match'] ?? '').split(',').map(tag => tag.trim().replace(/^W\//u, ''));
      const unchanged = validators.includes(etag) || validators.includes('*');
      send(response, unchanged ? 304 : 200, 'application/json; charset=utf-8', json, unchanged, { ETag: etag });
    }
    return;
  }

  if (pathname === '/api/operations/dashboard/refresh') {
    if (method !== 'POST') throw new RequestError(405, '刷新请使用 POST。');
    if (origin !== `http://${host}`) throw new RequestError(403, '只支持在本机工作台刷新。');
    const accepted = operationsBoard.refreshSources();
    if (accepted) recentDashboards.delete(dayKey(new Date()));
    sendJSON(response, 202, { accepted });
    return;
  }

  if (isDashboardVideoPath(pathname)) {
    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, '只支持读取视频。');
    const media = await getDashboardVideo(pathname);
    if (!media) throw new RequestError(404, '没有这条已匹配的视频。');
    const head = method === 'HEAD';
    if (media.type !== 'video/mp4') {
      send(response, 200, media.type, media.bytes, head);
      return;
    }
    const size = media.bytes.length;
    const range = mediaRange(request.headers.range, size);
    if (!range) {
      send(response, 416, media.type, null, head, { 'Content-Range': `bytes */${size}` });
      return;
    }
    const { start, end, partial } = range;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="TikTok-${media.id}.mp4"`;
    send(response, partial ? 206 : 200, media.type, media.bytes.subarray(start, end + 1), head, headers);
    return;
  }

  if (isDashboardImagePath(pathname)) {
    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, '只支持读取图片。');
    const image = await getDashboardImage(pathname);
    if (!image) throw new RequestError(404, '没有这张商品图。');
    send(response, 200, image.contentType, image.bytes, method === 'HEAD');
    return;
  }

  const match = pathname.match(/^\/api\/conversations\/([a-z0-9-]+)\/(buyer|reply|handoff|resolve)$/u);
  if (!match) throw new RequestError(404, '找不到该页面。');
  if (method !== 'POST') throw new RequestError(405, '不支持该请求方法。');

  const [, id, action] = match;
  const input = await readBody(request);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if ((action === 'buyer' || action === 'reply') && (!text || text.length > MAX_MESSAGE_LENGTH)) {
    throw new RequestError(400, `消息需在 1 至 ${MAX_MESSAGE_LENGTH} 字符之间。`);
  }

  const key = request.headers['idempotency-key'];
  if (key !== undefined && !/^[a-z0-9_-]{1,80}$/iu.test(key)) {
    throw new RequestError(400, '操作标识无效。');
  }

  sendJSON(response, 200, await updateState(id, action, text, key));
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    if (error instanceof RequestError) {
      sendJSON(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    sendJSON(response, 500, { error: '本地测试服务处理失败。' });
  });
});

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('DESK_PORT must be an integer between 0 and 65535');
}

server.listen(port, '127.0.0.1', () => {
  operationsBoard.start();
  console.log(`Customer Service test workbench: http://127.0.0.1:${server.address().port}/`);
});
