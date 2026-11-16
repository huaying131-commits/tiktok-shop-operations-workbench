import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';
import { readDomesticWarehouseOrders } from './read-domestic-packing.mjs';
import { readOverseasWarehouseOrders, readPendingPackages } from './run-fulfillment-routing-replay.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routingDirectory = join(root, 'outputs/operations-fulfillment-routing-replay');
const legacyDirectory = join(root, 'operations/controller/2026-11-12/automation-handoff-revalidation');
const run = promisify(execFile);
const shopId = '9000000000000000099';
const warehouseSystems = new Map([['148', 'shenniu'], ['80', 'zhanma']]);
const dispatched = new Set(['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'PARTIALLY_SHIPPING']);
const overseasActive = new Set(['wait_process', 'has_pick', 'has_pack', 'has_out_storage']);
const overseasInactive = new Set(['wait_submit', 'has_cancel', 'cancel', 'cancelled', 'has_closed']);
const cardSku = 'SKU20251211113951022';
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const exactShop = shop => shop?.id === shopId && shop.name === 'example-shop-my' && shop.region === 'MY';
const time = value => Date.parse(value);
const validScope = row => isPlatformId(row.orderId) && row.identityVerified && row.serviceMatches &&
  row.packageLineIdentityVerified && row.packages.length === 1 && isPlatformId(row.packages[0]);
const skuKey = (productId, skuId, warehouseId) => `${productId}/${skuId}/${warehouseId}`;

async function archivedReceipts(directory, minimumDay) {
  const days = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() &&
    /^\d{4}-\d{2}-\d{2}$/u.test(entry.name) && entry.name >= minimumDay);
  const files = (await Promise.all(days.map(async entry => {
    const path = join(directory, entry.name);
    return (await readdir(path)).filter(file => /^(official-read|domestic-packing|shipment-stock-readback|shadow-overseas-plan)-/u.test(file) &&
      file.endsWith('.json')).map(file => join(path, file));
  }))).flat();
  const receipts = await Promise.all(files.map(async file => ({ file, data: await readJson(file) })));
  return receipts.filter(({ data }) => exactShop(data.shop) && Number.isFinite(time(data.observedAt)))
    .sort((a, b) => time(a.data.observedAt) - time(b.data.observedAt));
}

function trackRouting(receipts) {
  const tracked = new Map();
  for (const { file, data } of receipts) {
    if (data.schema !== 'operations-fulfillment-routing-replay/v1' || data.orderSource !== 'live_order_list' ||
        data.summary?.writes !== 0 || !data.trace?.some(row => row.path === '/order/202507/orders' &&
          row.status === 200 && row.code === 0 && row.requestId)) continue;
    for (const row of data.rows) {
      if (row.status === 'AWAITING_SHIPMENT' && validScope(row) && !tracked.has(row.orderId)) {
        tracked.set(row.orderId, { row, observedAt: data.observedAt, source: file });
      }
      const prior = tracked.get(row.orderId);
      if (prior && !prior.firstAfter && dispatched.has(row.status)) prior.firstAfter = data.observedAt;
    }
  }
  return tracked;
}

async function addHistoricalRouteOnly(tracked, current, minimumDay) {
  if (minimumDay > '2026-11-12') return;
  const source = join(legacyDirectory, 'fulfillment-pending-shadow.json');
  const legacy = await readJson(source);
  if (legacy.schema !== 'operations-pending-fulfillment-shadow/v1' || !exactShop(legacy.shop) ||
      !Number.isFinite(time(legacy.at)) || !legacy.requestIds?.length) throw new Error('Original November 12 routing snapshot could not be verified');
  for (const prior of legacy.rows) {
    if (tracked.has(prior.orderId) || prior.status !== 'AWAITING_SHIPMENT') continue;
    const currentRow = current.rows.find(row => row.orderId === prior.orderId);
    if (!currentRow || !validScope(currentRow) || prior.skus.length !== currentRow.skus.flatMap(sku => sku.lineIds).length ||
        !prior.skus.every(line => currentRow.skus.some(sku => sku.skuId === line.skuId && sku.productId === line.productId &&
          sku.lineIds.includes(line.orderLineId)))) continue;
    const route = prior.route === 'CB_DIRECT_SHIPPING_WAREHOUSE' ? 'china_direct' :
      prior.route === 'CB_OVERSEA_WAREHOUSE' ? 'malaysia_overseas' : null;
    if (!route || !isPlatformId(prior.warehouseId)) continue;
    tracked.set(prior.orderId, { row: { ...currentRow, warehouseId: prior.warehouseId, route, status: prior.status },
      observedAt: legacy.at, source, packageFromLaterRead: true, firstAfter: current.observedAt });
  }
}

function stockBindings(receipts) {
  const bindings = new Map();
  for (const { data } of receipts) {
    if (data.schema !== 'operations-shipment-stock-readback/v1' || data.writes !== 0) continue;
    for (const row of data.rows.filter(row => row.route === 'malaysia_overseas')) for (const warehouse of row.warehouses) {
      if (!warehouseSystems.has(warehouse.warehouseId) || !isPlatformId(warehouse.goodsSkuId) || !warehouse.goodsSkuOuterId) continue;
      const key = skuKey(row.productId, row.skuId, warehouse.warehouseId);
      const previous = bindings.get(key);
      bindings.set(key, previous === null || (previous && (previous.goodsSkuId !== warehouse.goodsSkuId ||
        previous.goodsSkuOuterId !== warehouse.goodsSkuOuterId)) ? null : warehouse);
    }
  }
  return bindings;
}

async function readOverseasInventory(directory, warehouseId, system) {
  const sources = [];
  const rows = new Map();
  const cursors = new Set();
  let cursor = '';
  let total;
  for (let page = 1; page <= 10; page++) {
    const source = join(directory, `shadow-inventory-${system}-${stamp()}-p${page}.json`);
    const args = ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/verify-topwms-api.ps1'),
      '-Warehouse', system, '-WarehouseId', warehouseId, '-Operation', 'inventory', '-OutputPath', source];
    if (cursor) args.push('-Cursor', cursor);
    try {
      await run('powershell.exe', args, { cwd: root, windowsHide: true, timeout: 40_000 });
      const data = await readJson(source);
      sources.push(source);
      if (!data.apiConnected || data.operation !== 'inventory' || data.warehouseSystem !== system || data.warehouseId !== warehouseId ||
          (data.requestCursor || '') !== cursor || !Array.isArray(data.records) || data.records.length > 100 ||
          !Number.isSafeInteger(Number(data.totalReported)) || Number(data.totalReported) < 0) break;
      total ??= Number(data.totalReported);
      for (const row of data.records) {
        if (row.warehouseId !== warehouseId || !isPlatformId(row.goodsSkuId) || rows.has(row.goodsSkuId)) {
          return { warehouseId, sources, rows: null };
        }
        rows.set(row.goodsSkuId, row);
      }
      if (rows.size > total) break;
      if (!data.cursor) return { warehouseId, sources, rows: rows.size === total ? rows : null };
      if (cursors.has(data.cursor)) break;
      cursor = data.cursor;
      cursors.add(cursor);
    } catch {
      break;
    }
  }
  return { warehouseId, sources, rows: null };
}

function warehouseActivity(row, overseas, domestic) {
  const overseasRows = overseas.flatMap(query => (query.records ?? []).filter(item => item.platformOrderSn === row.orderId));
  const unknownOverseas = overseasRows.some(item => item.shopName !== 'example-shop-my' || !isPlatformId(item.orderId) ||
    item.platformPackageId !== row.packages[0] || (!overseasActive.has(item.stage) && !overseasInactive.has(item.stage)));
  const activeOverseas = overseasRows.filter(item => item.shopName === 'example-shop-my' && item.platformPackageId === row.packages[0] &&
    isPlatformId(item.orderId) && overseasActive.has(item.stage));
  const domesticRows = domestic.reads.flatMap(({ rows }) => rows);
  const activeDomestic = [...new Map(domesticRows.filter(item => item.platformPackageId === row.packages[0] &&
    isPlatformId(item.orderId)).map(item => [item.orderId, item])).values()];
  const unknownDomestic = domesticRows.some(item => item.platformPackageId !== row.packages[0] || !isPlatformId(item.orderId));
  return { activeOverseas, activeDomestic, complete: overseas.length === 2 && overseas.every(query => query.available) &&
    domestic.available && !unknownOverseas && !unknownDomestic };
}

export function planOverseas(row, activity, inventories, bindings, unavailable = new Map()) {
  const warehouses = inventories.map(({ warehouseId, sources, rows }) => {
    const goods = row.skus.map(sku => {
      const key = skuKey(sku.productId, sku.skuId, warehouseId);
      const binding = bindings.get(key);
      const record = binding && rows?.get(binding.goodsSkuId);
      const apiAvailable = record?.goodsSkuOuterId === binding?.goodsSkuOuterId &&
        Number.isSafeInteger(record?.availableStockNum) ? record.availableStockNum : null;
      const stockConfirmation = unavailable.get(key);
      return { ...sku, goodsSkuId: binding?.goodsSkuId ?? null, goodsSkuOuterId: binding?.goodsSkuOuterId ?? null,
        available: stockConfirmation ? 0 : apiAvailable, ...(stockConfirmation ? { apiAvailable, stockConfirmation } : {}) };
    });
    const eligible = goods.some(item => item.available === null) ? null : goods.every(item => item.available >= item.quantity);
    return { warehouseId, sources, eligible, goods };
  });
  const primary = warehouses.find(item => item.warehouseId === '148');
  const secondary = warehouses.find(item => item.warehouseId === '80');
  const duplicate = activity.activeOverseas.length + activity.activeDomestic.length > 0;
  return { orderId: row.orderId, packageId: row.packages[0], warehouses, warehouseReadComplete: activity.complete,
    existingWarehouseOrders: [...activity.activeOverseas, ...activity.activeDomestic].map(item => ({
      warehouseId: item.warehouseId, warehouseOrderId: item.orderId, stage: item.stage ?? item.tab ?? null })),
    duplicate,
    bothEligible: primary.eligible === null || secondary.eligible === null ? null : primary.eligible && secondary.eligible,
    warehouseId: !activity.complete || duplicate ? null : primary.eligible === true ? '148' :
      primary.eligible === false && secondary.eligible === true ? '80' : null };
}

export function readPlan(receipts, prior, currentRoutingSource) {
  const deadline = time(prior.firstAfter ?? new Date().toISOString());
  if (prior.packageFromLaterRead) return null;
  const candidates = prior.row.route === 'malaysia_overseas' ? receipts.toReversed() : receipts;
  for (const { file, data } of candidates) {
    if (time(data.observedAt) < time(prior.observedAt) || time(data.observedAt) >= deadline || data.writes !== 0) continue;
    const row = prior.row;
    const [packageId] = row.packages;
    if (row.route === 'china_direct' && data.schema === 'operations-domestic-packing/v1') {
      const plan = data.packing;
      if (plan?.orderId === row.orderId && plan.packageId === packageId && plan.state === 'packing_inputs_verified' &&
          plan.warehouseId && plan.items?.length === row.skus.length && row.skus.every(sku => plan.items.some(item =>
            item.productId === sku.productId && item.skuId === sku.skuId && item.quantity === sku.quantity))) {
        return { source: file, observedAt: data.observedAt, warehouseId: plan.warehouseId, goods: plan.items, card: plan.card };
      }
    }
    if (row.route !== 'malaysia_overseas') continue;
    if (data.schema === 'operations-shadow-overseas-plan/v1') {
      if (currentRoutingSource && data.routingSource !== currentRoutingSource) continue;
      const plan = data.rows.find(item => item.orderId === row.orderId && item.packageId === packageId);
      if (plan) {
        return { source: file, observedAt: data.observedAt, ...plan,
          goods: plan.warehouses.find(item => item.warehouseId === plan.warehouseId)?.goods };
      }
    }
    if (currentRoutingSource || data.schema !== 'operations-shipment-stock-readback/v1' || row.skus.length !== 1) continue;
    const [sku] = row.skus;
    const plan = data.rows.find(item => item.orderId === row.orderId && item.packageId === packageId &&
      item.productId === sku.productId && item.skuId === sku.skuId && item.quantity === sku.quantity);
    if (!plan) continue;
    const primary = plan.warehouses.find(item => item.warehouseId === '148');
    const secondary = plan.warehouses.find(item => item.warehouseId === '80');
    if (primary?.existingOutboundRecords !== 0 || secondary?.existingOutboundRecords !== 0) continue;
    const primaryKnown = Number.isSafeInteger(primary.available);
    const secondaryKnown = Number.isSafeInteger(secondary.available);
    const selected = primaryKnown && primary.available >= sku.quantity ? primary : primaryKnown && secondaryKnown &&
      secondary.available >= sku.quantity ? secondary : null;
    return { source: file, observedAt: data.observedAt, warehouseId: selected?.warehouseId ?? null,
      provisionalWarehouseId: !selected ? plan.eligibleWarehouseCandidate : null, warehouses: plan.warehouses,
      bothEligible: primaryKnown && secondaryKnown ? primary.available >= sku.quantity && secondary.available >= sku.quantity : null,
      goods: selected ? [{ ...sku, goodsSkuId: selected.goodsSkuId, goodsSkuOuterId: selected.goodsSkuOuterId }] : null };
  }
  return null;
}

async function readShippingCost(client, token, shop, row, trace) {
  try {
    const result = await client.orderSettlement(token, shop, row.orderId);
    if (result.currency !== 'MYR' || !result.skuTransactions.length || !result.skuTransactions.every(item =>
      row.skus.some(sku => sku.skuId === item.skuId) && isPlatformId(item.statementId))) {
      return { state: 'statement_not_verified', warehouseShippingPaid: null };
    }
    const requestId = trace.findLast(item => item.path === `/finance/202501/orders/${row.orderId}/statement_transactions` &&
      item.code === 0 && item.status === 200)?.requestId ?? null;
    if (!requestId) return { state: 'statement_not_verified', warehouseShippingPaid: null };
    return { state: 'platform_statement_read', requestId, currency: result.currency, platformNetShipping: result.shippingCostAmount,
      warehouseShippingPaid: null, lines: result.skuTransactions.map(item => ({ skuId: item.skuId, statementId: item.statementId,
        actualCarrierFee: item.shippingBreakdown?.actual_shipping_fee_amount ?? null,
        internationalLegFee: item.shippingBreakdown?.international_leg_logistics_amount ?? null })) };
  } catch (error) {
    return { state: 'statement_unavailable', warehouseShippingPaid: null, error: publicPlatformError(error, '结算运费暂不可用') };
  }
}

function compare(row, plan, actual, activity) {
  const overseas = row.route === 'malaysia_overseas';
  const records = overseas ? activity.activeOverseas : activity.activeDomestic;
  const otherRouteRecords = overseas ? activity.activeDomestic.length : activity.activeOverseas.length;
  const record = records.length === 1 ? records[0] : null;
  const duplicateCount = activity.activeOverseas.length + activity.activeDomestic.length;
  const expectedGoods = plan?.goods;
  const goods = record && overseas ? record.items : record?.items?.flatMap(item =>
    (item.goodsSkuList ?? []).map(goods => ({ ...goods, productId: item.platformItemId, skuId: item.platformSkuId })));
  const reportsOnlyPlatformSku = overseas && goods?.length && goods.some(item => row.skus.some(sku =>
    item.goodsSkuId === sku.skuId && item.goodsSkuOuterId === sku.skuId));
  const goodsMatch = expectedGoods?.length && goods?.length && !reportsOnlyPlatformSku ? expectedGoods.length === goods.length && expectedGoods.every(item =>
    goods.filter(candidate => candidate.goodsSkuId === item.goodsSkuId && candidate.goodsSkuOuterId === item.goodsSkuOuterId &&
      candidate.quantity === item.quantity && (overseas || (candidate.productId === item.productId && candidate.skuId === item.skuId))).length === 1) : null;
  const cards = record && !overseas && Array.isArray(record.giftList) ? record.giftList.filter(item => item.goodsSkuOuterId === cardSku) : null;
  const plannedCardVerified = plan?.card?.goodsSkuOuterId === cardSku && plan.card.quantity === 1;
  const platformRouteMatch = actual?.orderStatus ? actual.warehouseUnchanged && actual.skuLinesMatch &&
    !actual.packageWarehouseConflict : null;
  return { platformRouteMatch, originalPackageMatch: actual?.exact ?? null, observedWarehouse: record?.warehouseId ?? null,
    warehouseMatch: record && plan?.warehouseId ? record.warehouseId === plan.warehouseId : null,
    goodsMatch, goodsEvidence: reportsOnlyPlatformSku ? 'platform_sku_alias_in_warehouse_order' : null,
    cardObserved: cards?.reduce((sum, card) => sum + card.quantity, 0) ?? null,
    cardMatch: plannedCardVerified && cards ? cards.length === 1 && cards[0].quantity === 1 : null,
    crossRouteDuplicate: activity.activeOverseas.length && activity.activeDomestic.length ? true : activity.complete ? false : null,
    duplicateAcrossWarehouses: duplicateCount > 1 ? true : activity.complete ? false : null,
    warehouseReadComplete: activity.complete, expectedRouteRecords: records.length, otherRouteRecords,
    warehouseOnWrongRoute: otherRouteRecords > 0 ? true : activity.complete ? false : null };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('This runner only accepts the scheduled read-only workflow');
  const confirmations = await readJson(join(root, 'config/fulfillment-shadow-stock-confirmations.json'));
  if (confirmations.shopId !== shopId || !Array.isArray(confirmations.unavailable) ||
      confirmations.unavailable.some(item => !isPlatformId(item.productId) || !isPlatformId(item.skuId) ||
        !warehouseSystems.has(item.warehouseId) || !Number.isFinite(time(item.confirmedAt)) ||
        item.source !== 'user_confirmed_out_of_stock')) throw new Error('Invalid shadow stock confirmations');
  const unavailable = new Map(confirmations.unavailable.map(({ productId, skuId, warehouseId, confirmedAt, source }) =>
    [skuKey(productId, skuId, warehouseId), { confirmedAt, source }]));
  const day = dayKey(new Date());
  const minimumDay = dayKey(new Date(Date.now() - 7 * 86_400_000));
  const nodeArgs = [...process.execArgv, join(root, 'scripts/operations/run-fulfillment-routing-replay.mjs'), '--live-orders'];
  const { stdout } = await run(process.execPath, nodeArgs, { cwd: root, windowsHide: true, timeout: 75_000 });
  const routingSource = JSON.parse(stdout.trim()).file;
  const current = await readJson(routingSource);
  const directory = join(routingDirectory, day);
  await mkdir(directory, { recursive: true });
  const archived = await archivedReceipts(routingDirectory, minimumDay);
  const tracked = trackRouting(archived);
  await addHistoricalRouteOnly(tracked, current, minimumDay);
  const rows = [...tracked.values()];
  const trace = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const payload = await response.clone().json().catch(() => null);
    trace.push({ method: options.method, path: url.pathname, status: response.status, code: payload?.code ?? null,
      requestId: payload?.request_id ?? null });
    return response;
  } });
  const ids = rows.map(({ row }) => row.orderId);
  const pending = rows.filter(({ row }) => current.rows.some(entry => entry.orderId === row.orderId && entry.status === 'AWAITING_SHIPMENT'));
  const domesticPlans = pending.filter(({ row }) => row.route === 'china_direct');
  const overseasPlans = pending.filter(({ row }) => row.route === 'malaysia_overseas');
  const [actual, overseas, inventories] = await Promise.all([
    readPendingPackages(client, token, shop, rows.map(({ row }) => ({ ...row, nextAction: 'check_existing_package_and_carrier' })),
      Math.floor(Date.now() / 1000)),
    Promise.all(Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
      readOverseasWarehouseOrders(ids.slice(index * 50, index * 50 + 50), directory))).then(results => results.flat()),
    overseasPlans.length ? Promise.all([...warehouseSystems].map(([warehouseId, system]) =>
      readOverseasInventory(directory, warehouseId, system))) : [],
  ]);
  const domestic = new Map();
  for (let index = 0; index < ids.length; index += 3) {
    await Promise.all(ids.slice(index, index + 3).map(async id => domestic.set(id, await readDomesticWarehouseOrders(id, shop, directory))));
  }
  const queriesFor = id => overseas.slice(Math.floor(ids.indexOf(id) / 50) * 2, Math.floor(ids.indexOf(id) / 50) * 2 + 2);
  const actualById = new Map(actual.rows.map(row => [row.orderId, row]));
  const plans = [];
  const bindings = stockBindings(archived);
  for (const { row } of overseasPlans) {
    const verified = actualById.get(row.orderId);
    if (verified?.orderStatus === 'AWAITING_SHIPMENT' && verified.exact && !verified.packageWarehouseConflict) {
      const activity = warehouseActivity(row, queriesFor(row.orderId), domestic.get(row.orderId));
      plans.push(planOverseas(row, activity, inventories, bindings, unavailable));
    }
  }
  const planErrors = [];
  if (plans.length) {
    const afterInventory = await client.operationalOrders(token, shop, plans.map(row => row.orderId));
    const valid = plans.filter(plan => afterInventory.some(order => order.id === plan.orderId && order.status === 'AWAITING_SHIPMENT' &&
      order.packageIds?.length === 1 && order.packageIds[0] === plan.packageId));
    const file = join(directory, `shadow-overseas-plan-${stamp()}.json`);
    const data = { schema: 'operations-shadow-overseas-plan/v1', observedAt: new Date().toISOString(),
      shop: current.shop, routingSource, rows: valid, writes: 0 };
    await save(file, data);
    archived.push({ file, data });
  }
  for (const { row } of domesticPlans) {
    try {
      const { stdout } = await run(process.execPath, [...process.execArgv, join(root, 'scripts/operations/read-domestic-packing.mjs'),
        '--routing', routingSource, '--order-id', row.orderId], { cwd: root, windowsHide: true, timeout: 135_000 });
      const file = JSON.parse(stdout.trim()).source;
      archived.push({ file, data: await readJson(file) });
    } catch {
      planErrors.push({ orderId: row.orderId, state: 'domestic_plan_unavailable' });
    }
  }
  const result = [];
  for (const prior of rows) {
    const { row } = prior;
    const observed = actualById.get(row.orderId);
    const outcome = dispatched.has(observed?.orderStatus);
    const comparedPrior = outcome && !prior.firstAfter ? { ...prior, firstAfter: current.observedAt } : prior;
    const plan = readPlan(archived, comparedPrior, observed?.orderStatus === 'AWAITING_SHIPMENT' ? routingSource : undefined);
    const domesticEvidence = domestic.get(row.orderId);
    const overseasEvidence = queriesFor(row.orderId);
    const activity = warehouseActivity(row, overseasEvidence, domesticEvidence);
    const shipping = outcome ? await readShippingCost(client, token, shop, row, trace) : null;
    result.push({ orderId: row.orderId, packageId: row.packages[0], route: row.route, skus: row.skus, priorAt: prior.observedAt,
      priorSource: prior.source, packageFromLaterRead: prior.packageFromLaterRead === true, plan,
      currentStatus: observed?.orderStatus ?? null, trackingPresent: observed?.packages?.[0]?.hasTrackingNumber ?? null,
      comparison: outcome ? compare(row, plan, observed, activity) : null, shipping,
      sources: [...overseasEvidence.map(item => item.source), ...domesticEvidence.sources.map(item => item.file)] });
  }
  const summary = { observedOrders: result.length, pendingAtRun: pending.length,
    dispatched: result.filter(row => dispatched.has(row.currentStatus)).length,
    routeMatched: result.filter(row => row.comparison?.platformRouteMatch).length,
    warehouseAndGoodsMatched: result.filter(row => row.comparison?.warehouseMatch && row.comparison.goodsMatch).length,
    domesticCardsMatched: result.filter(row => row.comparison?.cardMatch).length,
    bothWarehousesEligible: result.filter(row => row.plan?.bothEligible === true).length,
    duplicateClear: result.filter(row => row.comparison?.duplicateAcrossWarehouses === false).length,
    duplicateFound: result.filter(row => row.comparison?.duplicateAcrossWarehouses === true).length,
    wrongRouteWarehouseRecords: result.filter(row => row.comparison?.warehouseOnWrongRoute === true).length,
    platformStatements: result.filter(row => row.shipping?.state === 'platform_statement_read').length,
    routeMatchedWithoutOriginalPackage: result.filter(row => row.packageFromLaterRead && row.comparison?.platformRouteMatch).length,
    pendingOutsideSinglePackageScope: current.rows.filter(row => row.status === 'AWAITING_SHIPMENT' && !validScope(row)).length,
    externalShippingPaidVerified: 0, manualActorVerified: false, writes: 0 };
  const file = join(directory, `shadow-run-${stamp()}.json`);
  await save(file, { schema: 'operations-fulfillment-shadow-run/v1', observedAt: new Date().toISOString(), shop: current.shop,
    routingSource, summary, planErrors, rows: result, trace });
  console.log(JSON.stringify({ file, ...summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(publicPlatformError(error, '发货影子运行失败'));
    process.exitCode = 1;
  });
}
