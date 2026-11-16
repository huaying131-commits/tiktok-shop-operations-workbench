import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { replayFulfillmentRouting } from './run-fulfillment-routing-replay.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const shopId = '9000000000000000099';
const warehouses = new Map([['879', '东莞'], ['892', '义乌']]);
const daySeconds = 86_400;
const run = promisify(execFile);
const origin = 'https://haohuolai.huoxiaoyi.com/api/open/developer_platform';
const endpoints = {
  inventory: ['/customer/goods_sku_warehouse/fetch/search_goods_sku_warehouse_list', 'goodsSkuWarehouseList'],
  orders: ['/customer/order/fetch/search_order_page', 'orderList'],
};
const salesStatuses = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
const archivedBindingFiles = [
  ...Array.from({ length: 7 }, (_, index) => `outputs/replenishment-review-2026-10-17/processed-${index + 1}.json`),
  'outputs/procurement-2026-11-08/f15-and-shortages/has_process.json',
];
const supplierPlan = 'outputs/procurement-2026-11-08/f15-and-shortages/stocking/stocking-plan.json';
const supplierReceipt = 'outputs/procurement-2026-11-08/f15-and-shortages/stocking/purchase-live-2.json';
const keyFor = (productId, skuId) => `${productId}:${skuId}`;
const stockKey = (warehouseId, sku) => `${warehouseId}:${sku}`;
const validSku = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value);
const count = value => {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const noFlag = value => [null, undefined, '', false, 'false', 0, '0'].includes(value);
const exactShop = row => row.platformShopId === shopId && row.shopName === 'example-shop-my' && row.site === 'MY' && row.platform === 'tiktok';
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''),
  (key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && /^\d{16,}$/u.test(context?.source ?? '')
    ? context.source : value);

function warehousePage(reply, operation, page) {
  const [endpoint, field] = endpoints[operation];
  const rows = reply.data?.[field];
  const total = count(reply.data?.total);
  if (reply.operation !== operation || reply.result !== 'success' || reply.source !== origin + endpoint ||
      !Number.isFinite(Date.parse(reply.observedAt)) || !Array.isArray(rows) || total === null || count(reply.data.page) !== page ||
      count(reply.data.pageSize) !== 100 || rows.length !== Math.min(100, Math.max(0, total - ((page - 1) * 100)))) {
    throw new Error(`好货来${operation === 'inventory' ? '库存' : '订单'}第${page}页回读不完整。`);
  }
  return { rows, total, observedAt: reply.observedAt };
}

async function readWarehousePages(root, scratch, operation, scope, label, signal, { firstPage = false } = {}) {
  const env = { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
  for (const key of Object.keys(env)) {
    if (/^(?:https?_proxy|all_proxy|node_use_env_proxy)$/iu.test(key)) delete env[key];
  }
  const rows = [];
  let observedAt;
  let total;
  for (let page = 1; page <= 25; page += 1) {
    const request = join(scratch, `${label}-${page}-request.json`);
    const output = join(scratch, `${label}-${page}.json`);
    await writeFile(request, JSON.stringify({ ...scope, page: String(page), pageSize: '100' }));
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/read-haohuolai-api.ps1'),
        '-Operation', operation, '-PayloadPath', request, '-OutputPath', output],
      { cwd: root, env, windowsHide: true, timeout: 40_000, signal });
    } catch (error) {
      const diagnostic = await readJson(`${output}.diagnostic.json`).catch(() => null);
      const status = count(diagnostic?.httpStatus);
      const transport = status ? `，HTTP ${status}` : error.killed || signal.aborted ? '，请求超时' : '';
      throw new Error(`好货来${label}第${page}页读取失败${transport}。`);
    }
    const reply = warehousePage(await readJson(output), operation, page);
    if (page > 1 && total !== reply.total) throw new Error(`好货来${label}分页期间总数变化。`);
    total = reply.total;
    observedAt = reply.observedAt;
    rows.push(...reply.rows);
    if (rows.length === total || firstPage) return { rows, observedAt, pages: page, total };
  }
  throw new Error(`好货来${label}超过本轮分页范围。`);
}

function inventoryRows(warehouseId, read) {
  const seen = new Set();
  return read.rows.map(row => {
    const sku = row.goodsSkuOuterId;
    if (String(row.warehouseId) !== warehouseId || !validSku(sku) || seen.has(sku) ||
        String(row.customerId) !== '178352' || String(row.accountId) !== '100632' || !isPlatformId(row.goodsSkuId)) {
      throw new Error(`好货来${warehouses.get(warehouseId)}库存出现范围冲突、缺失编号或重复行。`);
    }
    seen.add(sku);
    return { warehouseId, sku, goodsSkuId: row.goodsSkuId, name: row.goodsSkuSubName || sku,
      available: count(row.availableStockNum), locked: count(row.lockedStockNum), reportedInTransit: count(row.onWayNum) };
  });
}

async function readOrders(endExclusive) {
  const trace = [];
  const startInclusive = endExclusive - 14 * daySeconds;
  const deadline = Date.now() + 180_000;
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    trace.push({ path: url.pathname, httpStatus: response.status, code: Number.isSafeInteger(envelope?.code) ? envelope.code : null,
      requestId: /^[a-zA-Z0-9_-]{1,100}$/u.test(envelope?.request_id ?? '') ? envelope.request_id : null });
    return response;
  } });
  const seen = new Set();
  const [orders, officialWarehouses] = await Promise.all([
    collectPages(async cursor => {
      const page = await client.ordersPage(token, shop, 100, cursor, startInclusive, endExclusive, { includePaymentEvidence: true });
      for (const order of page.rows) {
        if (!isPlatformId(order.id) || seen.has(order.id) || !Number.isSafeInteger(order.createdAt) ||
            order.createdAt < startInclusive || order.createdAt >= endExclusive) {
          throw new Error('TikTok 订单分页存在重复记录或记录超出请求时间窗。');
        }
        seen.add(order.id);
      }
      return page;
    }, deadline),
    client.listingWarehouses(token, shop),
  ]);
  if (orders.totalCount !== orders.rows.length || !Array.isArray(officialWarehouses.warehouses) ||
      !officialWarehouses.warehouses.some(row => row.sub_type === 'CB_DIRECT_SHIPPING_WAREHOUSE')) {
    throw new Error('TikTok 订单总数或中国直发仓身份无法核验。');
  }
  const paidOrPending = orders.rows.filter(order => order.sampleOrder !== true && salesStatuses.has(order.status));
  const details = [];
  for (let offset = 0; offset < paidOrPending.length; offset += 50) {
    if (Date.now() >= deadline) throw new Error('TikTok 订单详情读取超时。');
    const ids = paidOrPending.slice(offset, offset + 50).map(order => order.id);
    const page = await client.operationalOrders(token, shop, ids);
    if (page.length !== ids.length || new Set(page.map(row => row.id)).size !== ids.length || page.some(row => !ids.includes(row.id))) {
      throw new Error('TikTok 订单详情缺失、重复或超出请求订单。');
    }
    details.push(...page);
  }
  const detailMap = new Map(details.map(order => [order.id, order]));
  const paymentMap = new Map(paidOrPending.map(order => [order.id, order.paidAt]));
  const routed = replayFulfillmentRouting(paidOrPending, details, officialWarehouses.warehouses);
  const relevant = routed.filter(order => salesStatuses.has(order.status) && detailMap.get(order.orderId)?.sampleOrder !== true);
  const rows = relevant.filter(order => order.route === 'china_direct' && order.serviceMatches).map(order => ({
    ...order, paidAt: paymentMap.get(order.orderId) ?? null,
  }));
  return { rows, trace, pages: orders.pages, orderCount: orders.rows.length, observedAt: new Date().toISOString(),
    unresolvedRoutes: relevant.filter(row => !row.route || !row.serviceMatches).length,
    overseasOrders: relevant.filter(row => row.route === 'malaysia_overseas' && row.serviceMatches).length,
    orderWindow: { startInclusive, endExclusive } };
}

export function indexProcessedBindings(archives) {
  const bindings = new Map();
  for (const { source, rows } of archives) {
    for (const order of rows) {
      if (!exactShop(order) || !warehouses.has(order.warehouseId) || !isPlatformId(order.orderId) ||
          !isPlatformId(order.platformOrderSn) || !isPlatformId(order.platformPackageId) ||
          order.tab !== 'has_process' || order.stage !== 'has_pack' || !noFlag(order.hasProblem) || !noFlag(order.hasClosed) ||
          !['finished', 'wait_receiver_confirm'].includes(order.orderStatus)) continue;
      for (const item of order.items ?? []) {
        const { platformItemId, platformSkuId, goodsSkuList } = item;
        const goods = goodsSkuList?.[0];
        if (!isPlatformId(platformItemId) || !isPlatformId(platformSkuId) || goodsSkuList?.length !== 1 ||
            !isPlatformId(goods?.goodsSkuId) || !validSku(goods?.goodsSkuOuterId) || !(count(item.quantity) > 0) ||
            count(item.quantity) !== count(goods.quantity)) continue;
        const key = keyFor(platformItemId, platformSkuId);
        const candidates = bindings.get(key) ?? new Map();
        const warehouseKey = stockKey(order.warehouseId, goods.goodsSkuOuterId);
        const id = `${warehouseKey}:${goods.goodsSkuId}`;
        if (!candidates.has(id)) candidates.set(id, { warehouseKey, goodsSkuId: goods.goodsSkuId, source,
          platformOrderId: order.platformOrderSn, platformPackageId: order.platformPackageId, warehouseOrderId: order.orderId });
        bindings.set(key, candidates);
      }
    }
  }
  return bindings;
}

async function readBindings(root) {
  return await Promise.all(archivedBindingFiles.map(async source => {
    const reply = await readJson(join(root, source));
    const page = count(reply.data?.page);
    if (!(page > 0)) throw new Error('历史仓库订单页码无效。');
    return { source, rows: warehousePage(reply, 'orders', page).rows };
  }));
}

async function readSupplierBindings(root) {
  const [plan, receipt] = await Promise.all([readJson(join(root, supplierPlan)), readJson(join(root, supplierReceipt))]);
  if (!plan.destinationVerified || !plan.packageContentsVerified || !plan.warehouseSubmitted ||
      !warehouses.has(plan.warehouseId) || receipt.primaryIdentityVerified !== true) return new Map();
  const models = receipt.purchases.filter(purchase => purchase.id === plan.orderId).flatMap(purchase => purchase.responses)
    .map(response => response.model).filter(model => model?.id === plan.orderId &&
      /^b2b-\w+$/u.test(model.sellerMemberId ?? '') && model.sellerCompanyName && Array.isArray(model.orderEntries));
  const result = new Map();
  for (const item of plan.items) {
    const matches = models.filter(model => model.orderEntries.some(entry => entry.id === item.entryId && entry.skuId === item.supplierSku));
    const sellers = new Set(matches.map(model => model.sellerMemberId));
    if (sellers.size !== 1 || item.visualMatch !== 'reviewed' || !validSku(item.goodsSkuOuterId)) continue;
    result.set(stockKey(plan.warehouseId, item.goodsSkuOuterId), { id: matches[0].sellerMemberId,
      name: matches[0].sellerCompanyName, supplierSku: item.supplierSku, spec: item.spec, source: supplierReceipt });
  }
  return result;
}

function earliestDeadline(order) {
  const values = Object.values(order.fulfillmentDeadlines ?? {}).filter(value => Number.isSafeInteger(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}

function unallocatedOrder(order, reply) {
  const [record] = reply.rows;
  if (reply.rows.length !== 1 || !exactShop(record) || record.platformOrderSn !== order.orderId ||
      record.orderStatus !== 'AWAITING_SHIPMENT' || !noFlag(record.orderId) || !noFlag(record.warehouseId) ||
      !noFlag(record.hasProblem) || !noFlag(record.hasClosed) || !noFlag(record.stage) || !order.packageLineIdentityVerified ||
      record.packages?.length !== order.packages.length) return false;
  const seenPackages = new Set(record.packages.map(row => row.platformPackageId));
  if (seenPackages.size !== order.packages.length || !order.packages.every(id => seenPackages.has(id))) return false;
  const quantities = new Map();
  for (const pkg of record.packages) {
    if (pkg.platformPackageStatus !== 'TO_FULFILL' || !noFlag(pkg.hasProblem) || !noFlag(pkg.hasClosed) || !pkg.items?.length) return false;
    for (const item of pkg.items) {
      const key = keyFor(item.platformItemId, item.platformSkuId);
      if (!(count(item.quantity) > 0) || item.goodsSkuList?.length !== 0) return false;
      quantities.set(key, (quantities.get(key) ?? 0) + count(item.quantity));
    }
  }
  return quantities.size === order.skus.length && order.skus.every(sku => quantities.get(keyFor(sku.productId, sku.skuId)) === sku.quantity);
}

async function verifyPendingOrders(root, scratch, orders) {
  const pending = orders.filter(order => order.status === 'AWAITING_SHIPMENT' && order.sampleOrder !== true)
    .sort((a, b) => (earliestDeadline(a) ?? Infinity) - (earliestDeadline(b) ?? Infinity));
  const states = new Map();
  const signal = AbortSignal.timeout(100_000);
  const candidates = pending.slice(0, 18);
  for (let offset = 0; offset < candidates.length && !signal.aborted; offset += 3) {
    await Promise.all(candidates.slice(offset, offset + 3).map(async order => {
      try {
        const scope = { platformOrderSn: order.orderId };
        const reply = await readWarehousePages(root, scratch, 'orders', { ...scope, tab: 'wait_submit' },
          `待提交流转-${order.orderId}`, signal);
        if (!unallocatedOrder(order, reply)) {
          states.set(order.orderId, { state: 'allocation_unknown', observedAt: reply.observedAt });
          return;
        }
        const other = await Promise.allSettled(['part_submit', 'wait_process', 'has_process', 'has_problem'].map(tab =>
          readWarehousePages(root, scratch, 'orders', { ...scope, tab }, `${tab}-${order.orderId}`, signal, { firstPage: true })));
        const allEmpty = other.every(result => result.status === 'fulfilled' && result.value.total === 0);
        states.set(order.orderId, { state: allEmpty ? 'unallocated_confirmed' : 'allocation_unknown',
          observedAt: reply.observedAt });
      } catch {
        states.set(order.orderId, { state: 'read_unavailable', observedAt: null });
      }
    }));
  }
  return states;
}

function metrics(lines) {
  return { units: lines.reduce((sum, line) => sum + line.quantity, 0), orders: new Set(lines.map(line => line.orderId)).size,
    sellingDays: new Set(lines.map(line => dayKey(new Date(line.createdAt * 1000)))).size };
}

function newDemand() {
  return { sales: [], pending: [], platformSkus: new Map(), bindings: new Map() };
}

function addDemand(demand, order, sku, pendingState, binding) {
  const { orderId, createdAt } = order;
  const { productId, skuId, quantity } = sku;
  const key = keyFor(productId, skuId);
  demand.platformSkus.set(key, { productId, skuId });
  if (binding) demand.bindings.set(key, { productId, skuId, ...binding });
  if (Number.isSafeInteger(order.paidAt) && order.paidAt > 0) demand.sales.push({ orderId, createdAt, quantity });
  if (order.status === 'AWAITING_SHIPMENT') demand.pending.push({ orderId, quantity, dueAt: earliestDeadline(order),
    allocation: pendingState?.state ?? 'allocation_unknown', observedAt: pendingState?.observedAt ?? null });
}

function buildRecommendation(stock, demand, supplier, endExclusive) {
  const sevenDay = metrics(demand.sales.filter(line => line.createdAt >= endExclusive - 7 * daySeconds));
  const fourteenDay = metrics(demand.sales);
  const habitual = (sevenDay.orders >= 3 && sevenDay.sellingDays >= 2) ||
    (fourteenDay.orders >= 4 && fourteenDay.sellingDays >= 3);
  const confirmedPending = demand.pending.filter(row => row.allocation === 'unallocated_confirmed');
  const unallocated = confirmedPending.reduce((sum, row) => sum + row.quantity, 0);
  const unverifiedPending = demand.pending.filter(row => row.allocation !== 'unallocated_confirmed');
  const unknownAllocationUnits = unverifiedPending.reduce((sum, row) => sum + row.quantity, 0);
  const pendingShortfall = stock?.available == null ? null : Math.max(0, unallocated - stock.available);
  const targetDays = [3, 5];
  const demandPerDay = Math.max(sevenDay.units / 7, fourteenDay.units / 14);
  const targets = habitual ? targetDays.map(days => Math.ceil(demandPerDay * days)) : [0, 0];
  const grossGap = stock?.available == null ? [null, null] : targets.map(quantity => Math.max(0, quantity + unallocated - stock.available));
  const deadline = demand.pending.map(row => row.dueAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  const approaching = deadline !== null && deadline <= endExclusive + daySeconds;
  const priority = demand.pending.length && (pendingShortfall > 0 || approaching &&
    (stock?.available == null || stock.available < unallocated + unknownAllocationUnits)) ? 'urgent' : 'normal';
  let state = 'observe';
  if (stock?.available == null) state = 'stock_unknown';
  else if (pendingShortfall > 0) state = 'order_shortfall';
  else if (stock.available < unallocated + unknownAllocationUnits) state = 'allocation_check';
  else if (habitual && grossGap[1] > 0) state = 'replenishment_review';
  const mappings = [...demand.bindings.values()];
  return { warehouseId: stock?.warehouseId ?? null, sku: stock?.sku ?? null, goodsSkuId: stock?.goodsSkuId ?? null,
    name: stock?.name ?? null, available: stock?.available ?? null, locked: stock?.locked ?? null,
    reportedInTransit: stock?.reportedInTransit ?? null, eligibleTransitUnits: null, mappings,
    sevenDay, fourteenDay, habitual, targetDays, pending: demand.pending, unallocatedUnits: unallocated,
    pendingShortfall, unknownAllocationUnits, grossGap, priority, state, supplier: supplier ?? null, deadline,
    platformSkus: [...demand.platformSkus.values()], procurement: { minOrderQty: null, unitPriceCny: null, shippingCny: null,
      mergedTotalCny: null, separateTotalCny: null, estimatedSavingsCny: null, estimatedArrivalAt: null } };
}

export function planReplenishment({ orders, inventory, bindings, suppliers = new Map(), pendingStates = new Map(), endExclusive, sourceRef }) {
  const stock = new Map(inventory.map(row => [stockKey(row.warehouseId, row.sku), row]));
  const byStock = new Map();
  const unresolved = new Map();
  for (const order of orders) {
    if (!(order.paidAt > 0) && order.status !== 'AWAITING_SHIPMENT') continue;
    for (const sku of order.skus) {
      const platformKey = keyFor(sku.productId, sku.skuId);
      const candidates = [...(bindings.get(platformKey)?.values() ?? [])];
      const binding = candidates.length === 1 ? candidates[0] : null;
      const inventoryRow = stock.get(binding?.warehouseKey);
      if (!binding || !inventoryRow || inventoryRow.goodsSkuId !== binding.goodsSkuId) {
        const issue = unresolved.get(platformKey) ?? { ...newDemand(), platformKey,
          reason: !candidates.length ? '缺少已处理仓单绑定' : !binding ? '历史仓单绑定存在多个候选仓或规格' : '本次库存无法核对同仓同编码和货品 ID',
          candidates };
        addDemand(issue, order, sku, pendingStates.get(order.orderId));
        unresolved.set(platformKey, issue);
        continue;
      }
      const demand = byStock.get(binding.warehouseKey) ?? newDemand();
      addDemand(demand, order, sku, pendingStates.get(order.orderId), binding);
      byStock.set(binding.warehouseKey, demand);
    }
  }
  const recommendations = [...byStock].map(([key, demand]) =>
    buildRecommendation(stock.get(key), demand, suppliers.get(key), endExclusive));
  const unmapped = [...unresolved.values()].map(row => ({
    ...buildRecommendation(null, row, null, endExclusive), platformKey: row.platformKey, candidates: row.candidates, reason: row.reason,
  }));
  const shown = recommendations.filter(row => row.state !== 'observe');
  const task = (key, title, detail, priority, state = 'approval') => ({
    key: `replenishment:${key}`, role: 'procurement', title, detail, priority, state, sourceRef,
  });
  const groups = new Map();
  const tasks = [];
  const detailFor = row => {
    const due = row.deadline ? new Date(row.deadline * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' 上海时间' : '未知';
    const pending = row.pending.length ? `待发 ${row.pending.slice(0, 4).map(item => item.orderId).join('、')}，最早时限 ${due}。` : '';
    const quantity = row.grossGap[0] === null ? '先核库存。' : `毛缺口 ${row.grossGap.join('–')} 件，先查两采购账号和可及时到仓的未占用在途。`;
    return `近7天 ${row.sevenDay.units} 件／${row.sevenDay.orders} 单／${row.sevenDay.sellingDays} 日，` +
      `近14天 ${row.fourteenDay.units} 件／${row.fourteenDay.orders} 单／${row.fourteenDay.sellingDays} 日。` +
      `实物可用 ${row.available ?? '未知'}，锁定 ${row.locked ?? '未知'}，仓报在途 ${row.reportedInTransit ?? '未知'}。` +
      `已核未占用待发 ${row.unallocatedUnits} 件、占用待核 ${row.unknownAllocationUnits} 件。${pending}${quantity}`;
  };
  for (const row of shown) {
    if (row.supplier && row.state === 'replenishment_review' && row.unknownAllocationUnits === 0) {
      const key = `${row.supplier.id}:${row.warehouseId}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    } else {
      const action = { stock_unknown: '复查库存', order_shortfall: '待发缺货核查', allocation_check: '核对待发占用', replenishment_review: '复核备货草案' }[row.state];
      const supplier = row.supplier ? `历史实购供应商 ${row.supplier.name}，当前报价待核。` : '当前供应商、报价和到仓时间待核。';
      tasks.push(task(`${row.warehouseId}:${row.sku}`, `${action} · ${warehouses.get(row.warehouseId)} ${row.name}`,
        `${row.sku}。${detailFor(row)}${supplier}`, row.priority, row.state === 'replenishment_review' ? 'approval' : 'queued'));
    }
  }
  for (const [key, rows] of groups) {
    const [first] = rows;
    if (rows.length === 1) {
      tasks.push(task(`${first.warehouseId}:${first.sku}`, `复核备货草案 · ${warehouses.get(first.warehouseId)} ${first.name}`,
        `${first.sku}。${detailFor(first)}历史实购供应商 ${first.supplier.name}，当前报价待核。`, first.priority));
      continue;
    }
    const details = rows.map(row => `${row.name} ${row.sku}（${row.supplier.spec}） ${row.grossGap.join('–')} 件`).join('、');
    tasks.push(task(`supplier:${key}`, `复核同供应商备货草案 · ${warehouses.get(first.warehouseId)} ${first.supplier.name}`,
      `${details}。核当批可发规格、到仓批次、起订量、单价及合并/分开发货运费。有待发时限时先判能否分开处理。`, 'normal'));
  }
  // A SKU with no proven warehouse binding gets an evidence task when demand or an open order makes it actionable.
  for (const row of unmapped.filter(row => row.habitual || row.pending.length)) {
    const { productId, skuId } = row.platformSkus[0];
    tasks.push(task(`unmapped:${row.platformKey}`, `核对仓库 SKU · ${skuId}`,
      `平台商品 ${productId}，SKU ${skuId}。${row.reason}。${detailFor(row)}`, row.priority, 'queued'));
  }
  tasks.sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || a.key.localeCompare(b.key));
  return { recommendations, unmapped, tasks: tasks.slice(0, 200), totalTasks: tasks.length };
}

export async function collectReplenishmentTasks({ day, root }) {
  const end = Date.now();
  if (day !== dayKey(new Date(end))) throw new Error('备货任务只读取当前上海自然日的实时窗口。');
  const directory = join(root, 'outputs/operations-stock-planning', day);
  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(join(directory, '.source-'));
  const receipt = join(directory, `daily-replenishment-${randomUUID()}.json`);
  const sourceRef = relative(root, receipt).replace(/\\/gu, '/');
  try {
    const signal = AbortSignal.timeout(150_000);
    const stockRead = async ([id, name]) => {
      const result = await readWarehousePages(root, scratch, 'inventory', { warehouseId: id }, name, signal);
      const rows = inventoryRows(id, result);
      return { id, name, pages: result.pages, observedAt: result.observedAt, skuCount: rows.length,
        zeroAvailable: rows.filter(row => row.available === 0).length, availabilityUnknown: rows.filter(row => row.available === null).length, rows };
    };
    const jobs = await Promise.allSettled([
      readOrders(Math.floor(end / 1000)),
      Promise.allSettled([...warehouses].map(stockRead)),
      readBindings(root),
      readSupplierBindings(root),
      readWarehousePages(root, scratch, 'orders', { tab: 'has_process' }, '已处理仓单', signal, { firstPage: true }),
    ]);
    if (jobs[0].status === 'rejected') throw new Error(publicPlatformError(jobs[0].reason,
      'TikTok Shop 近14天订单或中国直发路由读取未完成。'));
    const [orders, stocks, bindingResults, supplierResults, liveProcessed] = jobs.map(job => job.value);
    const stockFailure = stocks?.find(result => result.status === 'rejected');
    if (stockFailure) throw stockFailure.reason;
    if (!bindingResults) throw new Error('仓库历史 SKU 绑定证据无法完整读取。');
    // Wait for both feeds and recheck the exact unallocated queue before adding units to the gross inventory gap.
    const pendingStates = await verifyPendingOrders(root, scratch, orders.rows);
    const allStock = stocks.map(result => result.value);
    const bindings = indexProcessedBindings([...(liveProcessed ? [{ source: sourceRef, rows: liveProcessed.rows }] : []), ...bindingResults]);
    const { tasks, totalTasks, recommendations, unmapped } = planReplenishment({ orders: orders.rows,
      inventory: allStock.flatMap(stock => stock.rows), bindings, suppliers: supplierResults,
      pendingStates, endExclusive: orders.orderWindow.endExclusive, sourceRef });
    const suppliers = supplierResults?.size ? [supplierPlan, supplierReceipt] : [];
    const sources = [sourceRef, ...archivedBindingFiles, ...suppliers];
    const observedAt = new Date().toISOString();
    const summary = { day, shopId, observedAt, orderWindow: orders.orderWindow, orderPages: orders.pages,
      ordersRead: orders.orderCount, domesticPaidOrders: orders.rows.filter(row => row.paidAt !== null).length,
      domesticPaymentUnknown: orders.rows.filter(row => row.paidAt === null).length, unresolvedRoutes: orders.unresolvedRoutes,
      overseasOrders: orders.overseasOrders, warehouses: allStock.map(({ rows, ...item }) => item),
      mappedSkuCount: recommendations.length, unmappedSkuCount: unmapped.length,
      recommendationCount: recommendations.filter(row => row.state !== 'observe').length,
      urgentCount: tasks.filter(row => row.priority === 'urgent').length, tasksOmitted: totalTasks - tasks.length,
      recentWarehouseBindingsRead: Boolean(liveProcessed),
      supplierBindings: supplierResults?.size ?? null, writes: 0, receipt: sourceRef };
    await writeFile(receipt, JSON.stringify({ schema: 'daily-replenishment/v1', summary, sources,
      assumptions: ['滚动7/14天以订单创建时间统计，样品与取消单排除，销量有付款时间证据。',
        '好货来近3–5天覆盖用较高的7/14天日均需求；可用库存已扣锁定。',
        '仓报在途的准确占用、当前采购未到批次、可售天数与供应商时效待核；毛缺口是审批前测算。'],
      tiktok: { observedAt: orders.observedAt, trace: orders.trace },
      liveProcessed: liveProcessed ? { observedAt: liveProcessed.observedAt, sampleRows: liveProcessed.rows.length, reportedTotal: liveProcessed.total } : null,
      recommendations, unmapped }, null, 2) + '\n', { flag: 'wx' });
    return { tasks, summary, sources };
  } finally {
    await Promise.all((await readdir(scratch)).map(file => unlink(join(scratch, file))));
    await rmdir(scratch);
  }
}
