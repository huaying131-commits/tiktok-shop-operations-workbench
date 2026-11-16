import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const tabs = ['wait_submit', 'part_submit', 'wait_process', 'has_process', 'has_problem', 'has_closed'];
const warehouses = ['879', '892'];
const cardSku = 'SKU20251211113951022';
const orderEndpoint = '/customer/order/fetch/search_order_page';
const inventoryEndpoint = '/customer/goods_sku_warehouse/fetch/search_goods_sku_warehouse_list';
const execute = promisify(execFile);
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const saveJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value :
  typeof value === 'string' && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const isCross1 = shop => shop?.id === shopId && shop.name === 'example-shop-my' && shop.region === 'MY';
const exactShop = (row, shop) => row?.platformShopId === shop.id && row.shopName === shop.name && row.site === shop.region;
const sameSku = (item, sku) => item.platformItemId === sku.productId && item.platformSkuId === sku.skuId;
const emptyFlag = value => [null, undefined, '', false, 'false', 'False', 0, '0'].includes(value);

function bindingCandidates(order, history) {
  const result = [];
  for (const warehouseId of warehouses) {
    const items = order.skus.map(sku => {
      const matches = history.filter(row => row.warehouseId === warehouseId && row.productId === sku.productId && row.skuId === sku.skuId);
      const unique = new Map(matches.map(row => [`${row.goodsSkuId}:${row.goodsSkuOuterId}`, row]));
      if (unique.size !== 1) return null;
      const [{ goodsSkuId, goodsSkuOuterId }] = [...unique.values()];
      return isPlatformId(goodsSkuId) && /^[A-Za-z0-9_-]+$/u.test(goodsSkuOuterId ?? '') ? { ...sku, goodsSkuId, goodsSkuOuterId } : null;
    });
    if (items.every(Boolean) && new Set(items.map(row => row.goodsSkuOuterId)).size === items.length) result.push({ warehouseId, items });
  }
  return result;
}

function checkStock(inventory, warehouseId, goodsSkuOuterId, needed) {
  const matches = inventory.filter(row => row.warehouseId === warehouseId && row.goodsSkuOuterId === goodsSkuOuterId);
  const [stock] = matches;
  return matches.length === 1 && stock.exactRows === 1 && Number.isSafeInteger(stock.available) && stock.available >= needed
    ? stock.available : null;
}

export function reviewDomesticPacking({ shop, order, statuses, history, inventory }) {
  const base = { orderId: order.orderId, packageId: order.packages?.[0] ?? null, writes: 0 };
  const hold = state => ({ ...base, state });
  if (!isCross1(shop) || !isPlatformId(order.orderId) || order.packages?.length !== 1 || !isPlatformId(base.packageId) ||
      !order.skus?.length || order.skus.some(sku => !isPlatformId(sku.productId) || !isPlatformId(sku.skuId) ||
        !Number.isSafeInteger(sku.quantity) || sku.quantity < 1) ||
      new Set(order.skus.map(sku => sku.skuId)).size !== order.skus.length) return hold('platform_order_unverified');
  const states = new Map(statuses.map(entry => [entry.tab, entry.rows]));
  if (states.size !== tabs.length || statuses.length !== tabs.length ||
      tabs.some(tab => states.get(tab)?.length !== (tab === 'wait_submit' ? 1 : 0))) return hold('warehouse_status_unverified');
  const [current] = states.get('wait_submit');
  const [pkg] = current.packages ?? [];
  if (!exactShop(current, shop) || current.platformOrderSn !== order.orderId || current.orderStatus !== 'AWAITING_SHIPMENT' ||
      !emptyFlag(current.orderId) || !emptyFlag(current.hasProblem) || !emptyFlag(current.hasClosed) || !emptyFlag(current.stage) ||
      current.packages?.length !== 1 || pkg?.platformPackageId !== base.packageId || !isPlatformId(pkg.platformOrderPackageId) ||
      pkg.platformPackageStatus !== 'TO_FULFILL' || !emptyFlag(pkg.hasProblem) || !emptyFlag(pkg.hasClosed) ||
      pkg.items?.length !== order.skus.length || order.skus.some(sku => {
        const matches = pkg.items.filter(item => sameSku(item, sku));
        return matches.length !== 1 || count(matches[0].quantity) !== sku.quantity || !Array.isArray(matches[0].goodsSkuList) ||
          matches[0].goodsSkuList.length !== 0;
      })) return hold('warehouse_order_identity_unverified');
  const bindings = bindingCandidates(order, history).filter(row => !current.warehouseId || row.warehouseId === current.warehouseId);
  if (!bindings.length) return hold('warehouse_sku_unverified');
  const candidates = bindings.flatMap(({ warehouseId, items }) => {
    const confirmed = items.map(({ productId, skuId, goodsSkuId, goodsSkuOuterId, quantity }) => ({ productId, skuId,
      goodsSkuId, goodsSkuOuterId, quantity, available: checkStock(inventory, warehouseId, goodsSkuOuterId, quantity) }));
    const cardAvailable = checkStock(inventory, warehouseId, cardSku, 1);
    return cardAvailable !== null && confirmed.every(item => item.available !== null) ? [{ warehouseId, items: confirmed,
      card: { goodsSkuOuterId: cardSku, quantity: 1, available: cardAvailable } }] : [];
  });
  if (candidates.length !== 1) return hold(candidates.length ? 'warehouse_choice_unverified' : 'stock_or_card_unverified');
  return { ...base, ...candidates[0], state: 'packing_inputs_verified', warehousePackageId: pkg.platformOrderPackageId,
    assignedDomesticWarehouse: current.warehouseId || null };
}

function completeRows(reply, operation, field) {
  const rows = reply.data?.[field];
  const endpoint = operation === 'orders' ? orderEndpoint : inventoryEndpoint;
  if (reply.operation !== operation || reply.result !== 'success' || reply.source !==
      'https://haohuolai.huoxiaoyi.com/api/open/developer_platform' + endpoint || !Array.isArray(rows) || rows.length > 100 ||
      count(reply.data.total) !== rows.length || count(reply.data.page) !== 1 || !Number.isFinite(Date.parse(reply.observedAt))) {
    throw new Error(`Incomplete HaoHuoLai ${operation} response`);
  }
  return rows;
}

function createWarehouseReader(directory, signal) {
  const sources = [];
  return { sources, async read(operation, label, query) {
    const file = join(directory, `hhl-${label}-${stamp()}.json`);
    const request = file.replace(/\.json$/u, '-request.json');
    await saveJson(request, { page: '1', pageSize: '100', ...query });
    sources.push({ label, request, file });
    const env = { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
    // Keep TikTok's Node proxy settings out of the separate HaoHuoLai transport.
    for (const key of Object.keys(env)) {
      if (/^(?:https?_proxy|all_proxy|node_use_env_proxy)$/iu.test(key)) delete env[key];
    }
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/read-haohuolai-api.ps1'),
      '-Operation', operation, '-PayloadPath', request, '-OutputPath', file], { cwd: root, env, windowsHide: true, timeout: 40_000, signal });
    return { file, request, reply: await readJson(file) };
  } };
}

async function readWarehouseOrder(reader, orderId, tab, shop) {
  const result = await reader.read('orders', `packing-${orderId}-${tab}`, { tab, platformOrderSn: orderId });
  const rows = completeRows(result.reply, 'orders', 'orderList');
  if (rows.some(row => row.platformOrderSn !== orderId || !exactShop(row, shop))) throw new Error('Warehouse order scope changed');
  return { tab, rows, source: result.file, requestSource: result.request, observedAt: result.reply.observedAt };
}

export async function readDomesticWarehouseOrders(orderId, shop, directory) {
  if (!isCross1(shop) || !isPlatformId(orderId)) throw new Error('Exact MY order required');
  const reader = createWarehouseReader(directory);
  const replies = await Promise.allSettled(['wait_process', 'has_process', 'part_submit'].map(tab =>
    readWarehouseOrder(reader, orderId, tab, shop)));
  const available = replies.every(result => result.status === 'fulfilled');
  const reads = replies.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  return { available, reads, sources: reader.sources };
}

export function matchDomesticCollection(order, pkg, shop, warehouse) {
  if (!isCross1(shop) || !isPlatformId(order.orderId) || !isPlatformId(pkg.packageId) ||
      order.packages?.length !== 1 || order.packages[0] !== pkg.packageId || !order.skus?.length ||
      !exactShop(warehouse, shop) || warehouse.platformOrderSn !== order.orderId ||
      warehouse.platformPackageId !== pkg.packageId || !isPlatformId(warehouse.orderId) ||
      !warehouses.includes(warehouse.warehouseId) || !emptyFlag(warehouse.hasProblem) ||
      !emptyFlag(warehouse.hasClosed) || !['wait_pack', 'has_pack'].includes(warehouse.stage) ||
      !Array.isArray(warehouse.items) || warehouse.items.length !== order.skus.length || order.skus.some(sku => {
        const matches = warehouse.items.filter(item => sameSku(item, sku));
        if (matches.length !== 1 || count(matches[0].quantity) !== sku.quantity) return true;
        const goods = matches[0].goodsSkuList;
        return !Array.isArray(goods) || !goods.length ||
          goods.some(item => !isPlatformId(item.goodsSkuId) || !(count(item.quantity) > 0)) ||
          goods.reduce((total, item) => total + count(item.quantity), 0) !== sku.quantity;
      })) return null;
  const cards = Array.isArray(warehouse.giftList) ? warehouse.giftList.filter(item => item.goodsSkuOuterId === cardSku) : [];
  return { orderId: order.orderId, packageId: pkg.packageId, warehouseId: warehouse.warehouseId,
    warehouseOrderId: warehouse.orderId, stage: warehouse.stage, cardVerified: cards.length === 1 && count(cards[0].quantity) === 1,
    warehouseTrackingPresent: typeof warehouse.trackingNo === 'string' && Boolean(warehouse.trackingNo.trim()) };
}

export async function readDomesticCollection({ basis, current, shop, directory }) {
  const byOrder = new Map(basis.map(row => [row.orderId, row]));
  const candidates = current.filter(row => row.exact && !row.packageWarehouseConflict && row.route === 'china_direct' &&
    row.orderStatus === 'AWAITING_COLLECTION' && row.packages?.length === 1 && byOrder.get(row.orderId)?.serviceMatches);
  const signal = AbortSignal.timeout(65_000);
  const reader = createWarehouseReader(directory, signal);
  const rows = [];
  const readOrder = async row => {
    const [pkg] = row.packages;
    if (signal.aborted) return { orderId: row.orderId, packageId: pkg.packageId, state: 'warehouse_read_deferred' };
    try {
      const queries = await Promise.all(['wait_process', 'has_process'].map(tab => readWarehouseOrder(reader, row.orderId, tab, shop)));
      const exact = queries.flatMap(query => query.rows.filter(record => record.platformPackageId === pkg.packageId)
        .map(record => ({ record, source: query.source, observedAt: query.observedAt })));
      if (!exact.length) {
        const queued = await readWarehouseOrder(reader, row.orderId, 'wait_submit', shop);
        const [original] = queued.rows;
        const [queuedPackage] = original?.packages ?? [];
        const expectedSkus = byOrder.get(row.orderId).skus;
        const queuedOriginal = queued.rows.length === 1 && original.orderStatus === 'AWAITING_COLLECTION' &&
          emptyFlag(original.warehouseId) && emptyFlag(original.orderId) && original.packages?.length === 1 &&
          queuedPackage.platformPackageId === pkg.packageId && queuedPackage.platformPackageStatus === pkg.status &&
          queuedPackage.items?.length === expectedSkus.length && expectedSkus.every(sku =>
            queuedPackage.items.filter(item => sameSku(item, sku) && count(item.quantity) === sku.quantity).length === 1);
        return { orderId: row.orderId, packageId: pkg.packageId,
          state: queuedOriginal ? 'platform_package_only_in_warehouse_queue' : 'warehouse_record_not_matched',
          source: queued.source, observedAt: queued.observedAt };
      }
      if (exact.length > 1) return { orderId: row.orderId, packageId: pkg.packageId, state: 'warehouse_conflict' };
      const [match] = exact;
      const verified = matchDomesticCollection(byOrder.get(row.orderId), pkg, shop, match.record);
      return verified ? { ...verified, state: 'verified', source: match.source, observedAt: match.observedAt } :
        { orderId: row.orderId, packageId: pkg.packageId, state: 'warehouse_record_unverified',
          source: match.source, observedAt: match.observedAt };
    } catch {
      return { orderId: row.orderId, packageId: pkg.packageId, state: 'warehouse_read_unavailable' };
    }
  };
  for (let i = 0; i < candidates.length; i += 2) {
    rows.push(...await Promise.all(candidates.slice(i, i + 2).map(readOrder)));
  }
  return { rows, sources: reader.sources };
}

function historicalBindings(historyOrder, platformOrder, current) {
  const [row] = historyOrder.rows;
  if (historyOrder.rows.length !== 1 || !warehouses.includes(row.warehouseId) || !platformOrder.packages.includes(row.platformPackageId) ||
      !Array.isArray(row.items)) return [];
  return current.skus.flatMap(sku => {
    const official = platformOrder.skus.find(item => item.productId === sku.productId && item.skuId === sku.skuId);
    const matches = row.items.filter(item => sameSku(item, sku));
    if (!official || matches.length !== 1 || count(matches[0].quantity) !== official.quantity || matches[0].goodsSkuList?.length !== 1) return [];
    const [goods] = matches[0].goodsSkuList;
    return count(goods.quantity) === official.quantity && isPlatformId(goods.goodsSkuId) ? [{ productId: sku.productId, skuId: sku.skuId,
      warehouseId: row.warehouseId, orderId: platformOrder.orderId, packageId: row.platformPackageId,
      goodsSkuId: goods.goodsSkuId, goodsSkuOuterId: goods.goodsSkuOuterId, source: historyOrder.source }] : [];
  });
}

async function readStock(reader, warehouseId, goodsSkuOuterId) {
  const { file, reply } = await reader.read('inventory', `packing-stock-${warehouseId}-${goodsSkuOuterId}`, { warehouseId, goodsSkuOuterId });
  const rows = completeRows(reply, 'inventory', 'goodsSkuWarehouseList');
  if (rows.some(row => String(row.warehouseId) !== warehouseId || row.goodsSkuOuterId !== goodsSkuOuterId)) {
    throw new Error('Warehouse stock scope changed');
  }
  return { warehouseId, goodsSkuOuterId, exactRows: rows.length, available: rows.length === 1 ? count(rows[0].availableStockNum) : null,
    locked: rows.length === 1 ? count(rows[0].lockedStockNum) : null, source: file };
}

async function readArchivedBindings(files, order, { client, token, shop }) {
  const history = [];
  for (const file of files) {
    const source = resolve(file);
    const rows = completeRows(await readJson(source), 'orders', 'orderList');
    const [row] = rows;
    if (rows.length !== 1 || !exactShop(row, shop) || !isPlatformId(row.platformOrderSn) || row.platformOrderSn === order.orderId ||
        !isPlatformId(row.orderId) || !isPlatformId(row.platformPackageId)) throw new Error('Archived warehouse order identity unverified');
    const [official, ...extra] = await client.operationalOrders(token, shop, [row.platformOrderSn]);
    if (extra.length || official?.id !== row.platformOrderSn || !['IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(official.status) ||
        official.packageIds?.length !== 1 || official.packageIds[0] !== row.platformPackageId ||
        official.warehouseId !== order.warehouseId || official.deliveryOptionName !== order.deliveryOptionName ||
        !official.lines?.length || official.lines.some(line => line.packageId !== row.platformPackageId)) {
      throw new Error('Archived warehouse order did not match the current official record');
    }
    const skus = order.skus.flatMap(sku => {
      const lines = official.lines.filter(line => line.productId === sku.productId && line.skuId === sku.skuId);
      return lines.length ? [{ ...sku, quantity: lines.length }] : [];
    });
    const matches = historicalBindings({ rows, source }, { orderId: official.id, packages: official.packageIds, skus }, order);
    if (!matches.length) throw new Error('Archived warehouse record lacks the exact SKU binding');
    history.push(...matches);
  }
  return history;
}

function sameCurrentOrder(basis, fresh) {
  const expected = new Map(basis.skus.flatMap(sku => sku.lineIds.map(id => [id, sku])));
  return fresh?.status === 'AWAITING_SHIPMENT' && fresh.id === basis.orderId && fresh.warehouseId === basis.warehouseId &&
    fresh.deliveryOptionName === basis.deliveryOptionName && fresh.fulfillmentType === 'FULFILLMENT_BY_SELLER' &&
    fresh.packageIds?.length === 1 && fresh.packageIds[0] === basis.packages[0] && fresh.lines?.length === expected.size &&
    new Set(fresh.lines.map(row => row.id)).size === expected.size && fresh.lines.every(line => line.packageId === basis.packages[0] &&
      expected.get(line.id)?.skuId === line.skuId && expected.get(line.id)?.productId === line.productId);
}

async function readShippingAvailability(client, token, shop, packageId) {
  const [handover, label] = await Promise.allSettled([
    client.packageHandover(token, shop, packageId), client.packageLabelAvailability(token, shop, packageId),
  ]);
  const project = result => result.status === 'fulfilled' ? { available: true, ...result.value } : {
    available: false, requestId: result.reason?.requestId ?? null, code: result.reason?.platformCode ?? null,
    error: publicPlatformError(result.reason, 'Package read unavailable'),
  };
  return { handover: project(handover), label: project(label) };
}

async function main() {
  const { values } = parseArgs({ options: { routing: { type: 'string' }, 'order-id': { type: 'string' },
    history: { type: 'string', multiple: true } } });
  if (!values.routing || !isPlatformId(values['order-id'])) throw new Error('Provide --routing and --order-id for the original order');
  const routingSource = resolve(values.routing);
  const basis = await readJson(routingSource);
  const day = dayKey(new Date());
  if (basis.schema !== 'operations-fulfillment-routing-replay/v1' || basis.day !== day || !isCross1(basis.shop) || basis.summary?.writes !== 0 ||
      !basis.trace?.some(row => row.path === '/order/202507/orders' && row.status === 200 && row.code === 0 && row.requestId)) {
    throw new Error('Verified same-day Malaysia Cross1 routing receipt required');
  }
  const order = basis.rows.find(row => row.orderId === values['order-id']);
  if (order?.route !== 'china_direct' || !order.identityVerified || !order.serviceMatches || !order.packageLineIdentityVerified ||
      order.status !== 'AWAITING_SHIPMENT' || order.packages.length !== 1) throw new Error('Exact single-package China-direct pending shipment required');
  const directory = join(root, 'outputs/operations-fulfillment-routing-replay', day);
  await mkdir(directory, { recursive: true });
  const reader = createWarehouseReader(directory);
  const trace = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    trace.push({ path: url.pathname, method: options.method, status: response.status, code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const deadline = Date.now() + 50_000;
  const [fresh, packageDetail, returns, cancellations] = await Promise.all([client.operationalOrders(token, shop, [order.orderId]),
    client.packageDetail(token, shop, order.packages[0]),
    collectPages(cursor => client.returnsPage(token, shop, [order.orderId], cursor), deadline),
    collectPages(cursor => client.cancellationsPage(token, shop, [order.orderId], cursor), deadline)]);
  if (fresh.length !== 1 || fresh[0].id !== order.orderId || returns.rows.some(row => row.orderId !== order.orderId)) {
    throw new Error('Platform order scope unverified');
  }
  const platform = { order: fresh[0], package: packageDetail, returns: returns.rows.length, returnPages: returns.pages,
    cancellations: cancellations.rows, cancellationPages: cancellations.pages };
  const lineIds = order.skus.flatMap(sku => sku.lineIds);
  const packageMatches = packageDetail.id === order.packages[0] && packageDetail.status === 'TO_FULFILL' &&
    (!packageDetail.warehouseId || packageDetail.warehouseId === order.warehouseId) && packageDetail.orderIds?.length === 1 &&
    packageDetail.orderIds[0] === order.orderId && packageDetail.lineIds?.length === lineIds.length &&
    new Set(packageDetail.lineIds).size === lineIds.length && lineIds.every(id => packageDetail.lineIds.includes(id));
  let state;
  if (!sameCurrentOrder(order, fresh[0]) || !packageMatches) state = 'platform_order_unverified';
  else if (returns.rows.length || cancellations.rows.length) state = 'platform_after_sales_needs_review';
  if (state) {
    await saveReceipt({ order, basis, directory, routingSource, platform, trace, reader,
      packing: { orderId: order.orderId, packageId: order.packages[0], state, writes: 0 } });
    return;
  }
  platform.shipping = await readShippingAvailability(client, token, shop, packageDetail.id);
  const statuses = [];
  for (let i = 0; i < tabs.length; i += 2) statuses.push(...await Promise.all(tabs.slice(i, i + 2).map(tab =>
    readWarehouseOrder(reader, order.orderId, tab, shop))));
  const controls = basis.rows.filter(row => row.route === 'china_direct' && row.serviceMatches && row.packageLineIdentityVerified &&
    ['IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(row.status) && row.packages.length === 1 && row.skus.some(sku =>
      order.skus.some(item => item.skuId === sku.skuId && item.productId === sku.productId))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const history = await readArchivedBindings(values.history ?? [], order, { client, token, shop });
  for (const original of controls) history.push(...historicalBindings(await readWarehouseOrder(reader, original.orderId, 'has_process', shop), original, order));
  const inventory = [];
  const goods = [...new Set(bindingCandidates(order, history).flatMap(row => row.items.map(item => item.goodsSkuOuterId)))];
  for (const warehouseId of warehouses) {
    if (goods.length) for (const goodsSkuOuterId of [...goods, cardSku]) inventory.push(await readStock(reader, warehouseId, goodsSkuOuterId));
  }
  const packing = reviewDomesticPacking({ shop, order, statuses, history, inventory });
  await saveReceipt({ order, basis, directory, routingSource, platform, statuses, history, inventory, packing, trace, reader });
}

async function saveReceipt({ order, basis, directory, routingSource, platform, statuses = [], history = [], inventory = [], packing, trace, reader }) {
  const observedAt = new Date().toISOString();
  if (dayKey(new Date(observedAt)) !== basis.day) throw new Error('Shop day changed during the packing review');
  const source = join(directory, `domestic-packing-${stamp()}-${order.orderId}.json`);
  const receipt = { schema: 'operations-domestic-packing/v1', observedAt, day: basis.day, shop: basis.shop, routingSource, platform,
    statuses: statuses.map(({ rows, ...item }) => ({ ...item, exactRecords: rows.length })), history, inventory, packing, trace, sources: reader.sources,
    warehouseSubmissionVerified: false, writes: 0 };
  await saveJson(source, receipt);
  console.log(JSON.stringify({ source, packing }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(publicPlatformError(error, error.code === 'ETIMEDOUT' ? 'Warehouse query timed out' :
      error.cmd ? 'Warehouse read did not complete' : error.message));
    process.exitCode = 1;
  });
}
