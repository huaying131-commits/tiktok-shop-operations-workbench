import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { snapshotFilename, verifyCohort } from '../../apps/customer-service/tiktok-shop-finance.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { readDomesticCollection } from './read-domestic-packing.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const runFile = promisify(execFile);
const catalogDirectory = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
const shipped = new Set(['IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
const fulfillmentQueue = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'ON_HOLD']);
const routes = new Map([
  ['CB_DIRECT_SHIPPING_WAREHOUSE', 'china_direct'],
  ['CB_OVERSEA_WAREHOUSE', 'malaysia_overseas'],
]);
const serviceRoutes = new Map([
  ['Global standard shipping', 'china_direct'], ['Global economy shipping', 'china_direct'],
  ['全球标准运输', 'china_direct'], ['全球标准运输服务', 'china_direct'],
  ['全球经济运输', 'china_direct'], ['全球经济运输服务', 'china_direct'],
  ['Standard shipping', 'malaysia_overseas'], ['标准运输', 'malaysia_overseas'],
]);
const pickupReference = 'https://seller-my.tiktok.com/university/essay?default_language=en&knowledge_id=9000000000000005';
const malaysiaWms = [{ system: 'shenniu', warehouseId: '148' }, { system: 'zhanma', warehouseId: '80' }];
const wmsActiveStages = new Set(['wait_process', 'has_pick', 'has_pack', 'has_out_storage']);
const wmsLauncher = '& $env:TIKTOK_WMS_SCRIPT -Warehouse $env:TIKTOK_WMS_SYSTEM -WarehouseId $env:TIKTOK_WMS_ID -Operation orders -OutputPath $env:TIKTOK_WMS_OUTPUT -PlatformOrderSns ($env:TIKTOK_WMS_ORDER_IDS -split ","); exit $LASTEXITCODE';

function nextAction(status, route, serviceMatches, packageVerified) {
  if (status === 'AWAITING_COLLECTION') {
    return packageVerified ? 'check_existing_package_and_carrier' : 'verify_existing_package_identity';
  }
  if (status === 'AWAITING_SHIPMENT') {
    if (!serviceMatches) return 'verify_shipping_service_before_assignment';
    return route === 'china_direct' ? 'verify_domestic_stock_and_prior_intent' : 'verify_both_overseas_warehouses_and_prior_intent';
  }
  return 'historical_or_ineligible_for_new_dispatch';
}

export function replayFulfillmentRouting(catalogRows, details, warehouses, exactWms = []) {
  const detailById = new Map(details.map(row => [row.id, row]));
  const warehouseById = new Map(warehouses.map(row => [row.id, row]));
  const nativeByOrder = new Map(exactWms.map(row => [row.orderId, row]));
  if (detailById.size !== details.length || warehouseById.size !== warehouses.length || nativeByOrder.size !== exactWms.length) {
    throw new Error('Duplicate order or warehouse in the replay sources');
  }
  return catalogRows.map(row => {
    const order = detailById.get(row.id);
    const fromCatalog = new Map((row.skus ?? []).map(line => [line.lineId, line]));
    const lines = order?.lines ?? [];
    const identityVerified = lines.length > 0 && new Set(lines.map(line => line.id)).size === lines.length &&
      lines.length === fromCatalog.size && lines.length === row.skus?.length && lines.every(line => {
        const previous = fromCatalog.get(line.id);
        return isPlatformId(line.id) && isPlatformId(line.skuId) && isPlatformId(line.productId) &&
          previous?.id === line.skuId && previous.productId === line.productId;
      });
    const warehouse = warehouseById.get(order?.warehouseId);
    const route = identityVerified ? routes.get(warehouse?.sub_type) ?? null : null;
    const platformCollection = order?.shippingType === 'TIKTOK' && order.deliveryOptionName === 'Self-collection';
    const serviceRoute = platformCollection ? 'malaysia_overseas' : serviceRoutes.get(order?.deliveryOptionName);
    const serviceMatches = Boolean(route) && serviceRoute === route;
    const packages = [...new Set((order?.packageIds ?? []).filter(isPlatformId))];
    const samePackageScope = packages.length > 0 && lines.every(line => isPlatformId(line.packageId) && packages.includes(line.packageId)) &&
      packages.every(id => lines.some(line => line.packageId === id));
    const native = nativeByOrder.get(row.id);
    const nativeMatches = route === 'malaysia_overseas' && native && order.warehouseId === native.platformWarehouseId &&
      samePackageScope && packages.length === 1 && packages[0] === native.packageId && lines.length === 1 &&
      lines[0].productId === native.productId && lines[0].skuId === native.skuId;
    const skuQuantities = new Map();
    if (identityVerified) for (const line of lines) {
      const sku = skuQuantities.get(line.skuId) ?? { productId: line.productId, skuId: line.skuId, lineIds: [] };
      if (sku.productId !== line.productId) throw new Error('Same SKU maps to different products in one order');
      sku.lineIds.push(line.id);
      skuQuantities.set(line.skuId, sku);
    }
    return { orderId: row.id, createdAt: row.createdAt, catalogStatus: row.status, status: order?.status ?? null,
      identityVerified, route, warehouseId: order?.warehouseId ?? null, platformWarehouseSubtype: warehouse?.sub_type ?? null,
      deliveryOptionName: order?.deliveryOptionName ?? null, shippingType: order?.shippingType ?? null,
      serviceMatches: serviceRoute ? serviceMatches : null, buyerCollectionPoint: platformCollection && serviceMatches,
      fulfillmentType: order?.fulfillmentType ?? null, packages, packageLineIdentityVerified: identityVerified && samePackageScope,
      skus: [...skuQuantities.values()].map(sku => ({ ...sku, quantity: sku.lineIds.length })),
      fulfillmentDeadlines: identityVerified ? order.fulfillmentDeadlines ?? null : null,
      wms: nativeMatches ? { system: native.system, warehouseId: native.warehouseId, stage: native.stage, source: native.source } : null,
      nextAction: route ? nextAction(order.status, route, serviceMatches, samePackageScope) : 'verify_order_identity_or_warehouse' };
  });
}

export async function readLiveRoutingOrders(client, token, shop, endExclusive) {
  if (!Number.isSafeInteger(endExclusive) || endExclusive <= 604_800) throw new Error('Invalid live order cutoff');
  const startInclusive = endExclusive - 604_800;
  const orders = await collectPages(async cursor => {
    const page = await client.ordersPage(token, shop, 100, cursor, startInclusive, endExclusive);
    if (page.rows.some(row => !isPlatformId(row.id) || !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < startInclusive || row.createdAt >= endExclusive)) throw new Error('Order is outside the live routing scope');
    return page;
  }, Date.now() + 60_000);
  if (orders.totalCount !== orders.rows.length) throw new Error('Live routing order total could not be verified');
  return { orders, orderWindow: { startInclusive, endExclusive } };
}

function samePlatformIds(expected, observed) {
  return Array.isArray(observed) && expected.length > 0 && expected.length === observed.length &&
    new Set(expected).size === expected.length && new Set(observed).size === observed.length &&
    expected.every(id => isPlatformId(id) && observed.includes(id));
}

async function readOriginalShippingDocuments(client, token, shop, packageId) {
  const [handover, label] = await Promise.allSettled([
    client.packageHandover(token, shop, packageId), client.packageLabelAvailability(token, shop, packageId),
  ]);
  const handoverRead = handover.status === 'fulfilled' ? handover.value : null;
  const labelRead = label.status === 'fulfilled' ? label.value : null;
  const labelMissing = label.status === 'rejected' && label.reason?.httpStatus === 200 && label.reason?.platformCode === 21042104;
  return { canDropOff: handoverRead?.requestId ? handoverRead.canDropOff : null, handoverRequestId: handoverRead?.requestId ?? null,
    labelAvailable: labelRead?.requestId ? labelRead.labelUrlReturned === true && labelRead.hasTrackingNumber === true : labelMissing ? false : null,
    labelRequestId: labelRead?.requestId ?? label.reason?.requestId ?? null,
    labelCode: labelRead ? 0 : label.reason?.platformCode ?? null };
}

export async function readPendingPackages(client, token, shop, priorRows, cutoff, { readShippingDocuments = false } = {}) {
  const pending = priorRows.filter(row => row.nextAction === 'check_existing_package_and_carrier');
  const orderIds = pending.map(row => row.orderId);
  if (!Number.isSafeInteger(cutoff) || new Set(orderIds).size !== orderIds.length || !orderIds.every(isPlatformId)) {
    throw new Error('Invalid original pending-order cohort');
  }
  const orders = new Map();
  for (let offset = 0; offset < orderIds.length; offset += 50) {
    const batch = orderIds.slice(offset, offset + 50);
    for (const order of await client.operationalOrders(token, shop, batch)) {
      if (!batch.includes(order.id) || orders.has(order.id)) throw new Error('Unexpected order in pending-package readback');
      orders.set(order.id, order);
    }
  }

  const ownersByPackage = new Map();
  for (const prior of pending) {
    for (const id of prior.packages) {
      if (!isPlatformId(id)) throw new Error('Invalid original package ID');
      const owners = ownersByPackage.get(id) ?? [];
      owners.push(prior.orderId);
      ownersByPackage.set(id, owners);
    }
  }
  const packages = new Map();
  for (const [id, owners] of ownersByPackage) {
    const lineIds = owners.flatMap(orderId => orders.get(orderId)?.lines?.filter(line => line.packageId === id)
      .map(line => line.id) ?? []);
    try {
      const detail = await client.packageDetail(token, shop, id);
      const belongsToOriginalOrder = detail.id === id && samePlatformIds(owners, detail.orderIds) &&
        samePlatformIds(lineIds, detail.lineIds);
      packages.set(id, { packageId: id, belongsToOriginalOrder, status: belongsToOriginalOrder ? detail.status : null,
        provider: belongsToOriginalOrder ? detail.provider : null,
        warehouseId: belongsToOriginalOrder && isPlatformId(detail.warehouseId) ? detail.warehouseId : null,
        hasTrackingNumber: belongsToOriginalOrder ? detail.hasTrackingNumber : null });
    } catch (error) {
      packages.set(id, { packageId: id, belongsToOriginalOrder: false, error: publicPlatformError(error, '原包裹回查失败') });
    }
  }

  const rows = [];
  for (const prior of pending) {
    const order = orders.get(prior.orderId);
    const priorLines = new Map(prior.skus.flatMap(sku => sku.lineIds.map(id => [id, sku])));
    const skuLinesMatch = samePlatformIds([...priorLines.keys()], order?.lines?.map(line => line.id)) &&
      order.lines.every(line => {
        const expected = priorLines.get(line.id);
        return line.skuId === expected.skuId && line.productId === expected.productId && prior.packages.includes(line.packageId);
      });
    const warehouseUnchanged = isPlatformId(prior.warehouseId) && order?.warehouseId === prior.warehouseId;
    const packageSetUnchanged = samePlatformIds(prior.packages, order?.packageIds);
    const details = prior.packages.map(id => ({ ...packages.get(id),
      itemQuantity: skuLinesMatch && packages.get(id).belongsToOriginalOrder
        ? order.lines.filter(line => line.packageId === id).length : null }));
    const packageWarehouseConflict = details.some(item => item.warehouseId && item.warehouseId !== order?.warehouseId);
    const exact = Boolean(order?.status) && warehouseUnchanged && skuLinesMatch && packageSetUnchanged &&
      details.every(item => item.belongsToOriginalOrder && item.status);
    if (readShippingDocuments && exact && !packageWarehouseConflict && prior.route === 'china_direct' &&
        order.status === 'AWAITING_SHIPMENT' && details.length === 1 && details[0].status === 'TO_FULFILL' &&
        ownersByPackage.get(details[0].packageId).length === 1) {
      const [detail] = details;
      detail.shipping = await readOriginalShippingDocuments(client, token, shop, detail.packageId);
    }
    let tracking = null;
    if (exact && details.length === 1 && details[0].hasTrackingNumber === true &&
        ownersByPackage.get(details[0].packageId).length === 1) {
      try {
        const events = await client.orderTracking(token, shop, prior.orderId);
        const pickup = events.filter(row => row.code === 30901 && Number.isSafeInteger(row.updatedAtMillis) && row.updatedAtMillis > 0);
        tracking = { available: true, eventCount: events.length, pickupSuccessSeen: pickup.length > 0 };
      } catch (error) {
        tracking = { available: false, error: publicPlatformError(error, '原运单轨迹回查失败') };
      }
    }
    const collectionDueAt = order?.collectionDueAt ?? null;
    rows.push({ orderId: prior.orderId, priorOrderStatus: prior.status, orderStatus: order?.status ?? null,
      warehouseId: order?.warehouseId ?? null, route: prior.route, buyerCollectionPoint: prior.buyerCollectionPoint,
      exact, warehouseUnchanged, skuLinesMatch, packageSetUnchanged, packageWarehouseConflict, packages: details, collectionDueAt, tracking,
      fulfillmentDeadlines: exact ? order.fulfillmentDeadlines ?? null : null,
      collectionDeadlinePassed: exact && order.status === 'AWAITING_COLLECTION' &&
        Number.isSafeInteger(collectionDueAt) && cutoff >= collectionDueAt });
  }
  const confirmed = rows.filter(row => row.exact);
  const day = dayKey(new Date(cutoff * 1000));
  const dayShiftStarts = Date.parse(day + 'T08:00:00+08:00') / 1000;
  const stillAwaiting = confirmed.filter(row => row.orderStatus === 'AWAITING_COLLECTION');
  return { rows, summary: { priorAwaitingCollection: pending.length, originalPackages: packages.size,
    exactCurrent: confirmed.length, stillAwaitingCollection: stillAwaiting.length,
    movedToTransitOrLater: confirmed.filter(row => shipped.has(row.orderStatus)).length,
    cancelled: confirmed.filter(row => row.orderStatus === 'CANCELLED').length,
    passedCollectionDeadline: stillAwaiting.filter(row => row.collectionDeadlinePassed).length,
    dueBeforeEight: stillAwaiting.filter(row => Number.isSafeInteger(row.collectionDueAt) && row.collectionDueAt <= dayShiftStarts).length,
    trackingReads: confirmed.filter(row => row.tracking?.available).length,
    pickupScansVerified: confirmed.filter(row => row.tracking?.pickupSuccessSeen).length,
    packageWarehouseConflicts: confirmed.filter(row => row.packageWarehouseConflict).length,
    unverified: rows.length - confirmed.length, writes: 0 } };
}

export function summarizeWarehouseStages(rows) {
  const packages = rows.flatMap(row => row.packageMatches);
  const countStage = stage => packages.filter(row => !row.conflictingActiveRecords && row.matches?.some(match =>
    match.stage === stage && match.quantityVerified)).length;
  return { waitingWarehousePackages: countStage('wait_process'), pickingWarehousePackages: countStage('has_pick'),
    packedWarehousePackages: countStage('has_pack') };
}

export function previousCollectionCandidates(previous, current) {
  const currentQueue = new Set(current.filter(row => row.nextAction === 'check_existing_package_and_carrier').map(row => row.orderId));
  return previous.filter(row => row.nextAction === 'check_existing_package_and_carrier' && !currentQueue.has(row.orderId));
}

async function findPreviousRouting(source, basis, directory) {
  for (const name of (await readdir(directory)).filter(file => /^official-read-.*\.json$/u.test(file)).sort().reverse()) {
    const file = join(directory, name);
    if (file === source) continue;
    const prior = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
    if (prior.schema === basis.schema && prior.shop?.id === basis.shop.id && prior.shop.name === basis.shop.name &&
        prior.shop.region === basis.shop.region && prior.day === basis.day && prior.summary?.writes === 0 &&
        prior.orderSource === 'live_order_list' && Array.isArray(prior.rows) &&
        Date.parse(prior.observedAt) < Date.parse(basis.observedAt) &&
        prior.trace?.some(call => call.path === '/order/202507/orders' && call.status === 200 && call.code === 0 && call.requestId)) {
      return { file, receipt: prior };
    }
  }
  return null;
}

export function reviewPendingWms(pendingRows, queries) {
  const sourceRows = pendingRows.filter(row => row.exact && !row.packageWarehouseConflict && row.route === 'malaysia_overseas' &&
    ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT'].includes(row.orderStatus));
  if (new Set(sourceRows.map(row => row.orderId)).size !== sourceRows.length) {
    throw new Error('Duplicate pending order for warehouse review');
  }
  const completeQueries = queries.filter(query => query.available);
  const rows = sourceRows.map(row => {
    const expected = new Map(row.packages.map(item => [item.packageId, item.itemQuantity]));
    const exact = [];
    let unresolved = 0;
    for (const query of completeQueries) {
      for (const record of query.records.filter(entry => entry.platformOrderSn === row.orderId)) {
        if (record.shopName !== 'example-shop-my' || !expected.has(record.platformPackageId) ||
            record.warehouseId !== query.warehouseId || !record.orderId || record.platform !== 'tiktok') {
          unresolved++;
          continue;
        }
        const items = Array.isArray(record.items) && record.items.length > 0 &&
          record.items.every(item => Number.isSafeInteger(item.quantity) && item.quantity > 0) ? record.items : null;
        const expectedQuantity = expected.get(record.platformPackageId);
        const quantity = items?.reduce((total, item) => total + item.quantity, 0) ?? null;
        exact.push({ system: query.system, warehouseId: query.warehouseId, packageId: record.platformPackageId,
          wmsOrderId: record.orderId, stage: record.stage, outboundAt: record.gmtOutStorage || null,
          itemQuantity: quantity, quantityVerified: Number.isSafeInteger(expectedQuantity) && quantity === expectedQuantity });
      }
    }
    const packageMatches = [...expected.keys()].map(packageId => {
      const matches = exact.filter(item => item.packageId === packageId);
      const active = matches.filter(item => wmsActiveStages.has(item.stage));
      return { packageId, matches, conflictingActiveRecords: active.length > 1,
        outbound: active.length === 1 && active[0].stage === 'has_out_storage' && !!active[0].outboundAt && active[0].quantityVerified };
    });
    return { orderId: row.orderId, packageMatches, unresolvedRecords: unresolved };
  });
  const packages = rows.flatMap(row => row.packageMatches);
  return { checkedOrders: rows.length, checkedPackages: packages.length, completedWarehouses: completeQueries.length,
    exactMatchedPackages: packages.filter(row => row.matches.length > 0).length,
    outboundPackages: packages.filter(row => row.outbound).length,
    ...summarizeWarehouseStages(rows),
    conflictedPackages: packages.filter(row => row.conflictingActiveRecords).length,
    quantityUnverifiedPackages: packages.filter(row => row.matches.some(match => !match.quantityVerified)).length,
    packagesWithoutExactWarehouseRecord: completeQueries.length === malaysiaWms.length
      ? packages.filter(row => row.matches.length === 0).length : null,
    unresolvedRecords: rows.reduce((total, row) => total + row.unresolvedRecords, 0), rows };
}

async function readPendingWms(pendingRows, directory, prefix = 'pending-wms') {
  const ids = pendingRows.filter(row => row.exact && !row.packageWarehouseConflict && row.route === 'malaysia_overseas' &&
    ['AWAITING_COLLECTION', 'AWAITING_SHIPMENT'].includes(row.orderStatus))
    .map(row => row.orderId);
  if (ids.length === 0) return { ...reviewPendingWms(pendingRows, []), queries: [] };
  const queries = await readOverseasWarehouseOrders(ids, directory, prefix);
  return { ...reviewPendingWms(pendingRows, queries), queries: queries.map(({ records, ...query }) => query) };
}

export async function readOverseasWarehouseOrders(ids, directory, prefix = 'shadow-wms') {
  if (ids.length > 100 || new Set(ids).size !== ids.length || !ids.every(isPlatformId)) throw new Error('Invalid exact warehouse order cohort');
  if (!ids.length) return [];
  return Promise.all(malaysiaWms.map(async ({ system, warehouseId }) => {
    const observedAt = new Date().toISOString().replace(/[:.]/gu, '-');
    const source = join(directory, `${prefix}-${system}-${observedAt}.json`);
    const env = { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      TIKTOK_WMS_SCRIPT: join(root, 'scripts/verify-topwms-api.ps1'), TIKTOK_WMS_SYSTEM: system,
      TIKTOK_WMS_ID: warehouseId, TIKTOK_WMS_OUTPUT: source, TIKTOK_WMS_ORDER_IDS: ids.join(',') };
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wmsLauncher], { cwd: root, env, windowsHide: true, timeout: 40_000 });
      const receipt = JSON.parse(await readFile(source, 'utf8'));
      if (receipt.apiConnected !== true || receipt.warehouseSystem !== system || receipt.warehouseId !== warehouseId ||
          !samePlatformIds(ids, receipt.requestedPlatformOrders) || !Array.isArray(receipt.records) ||
          receipt.records.length > 100 || receipt.records.length !== receipt.totalReported ||
          receipt.records.some(row => !ids.includes(row.platformOrderSn))) {
        return { available: false, system, warehouseId, source, error: 'warehouse_query_scope_unverified' };
      }
      return { available: true, system, warehouseId, source, observedAt: receipt.observedAt, records: receipt.records };
    } catch {
      return { available: false, system, warehouseId, source, error: 'warehouse_query_unavailable' };
    }
  }));
}

async function refreshPendingPackages(source, { readOverseasWms, readDomesticWms }) {
  const basis = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/u, ''));
  const cutoff = Math.floor(Date.now() / 1000);
  const day = dayKey(new Date(cutoff * 1000));
  if (basis.schema !== 'operations-fulfillment-routing-replay/v1' || basis.shop?.id !== shopId ||
      basis.shop.region !== 'MY' || basis.shop.name !== 'example-shop-my' || basis.day !== day ||
      basis.summary?.writes !== 0 || !Array.isArray(basis.rows)) throw new Error('Current MY routing receipt required');
  const trace = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    trace.push({ method: options.method, path: url.pathname, status: response.status, code: envelope?.code ?? null,
      requestId: envelope?.request_id ?? null });
    return response;
  } });
  const result = await readPendingPackages(client, token, shop, basis.rows, cutoff);
  const directory = join(root, 'outputs/operations-fulfillment-routing-replay', day);
  const prior = basis.orderSource === 'live_order_list' ? await findPreviousRouting(source, basis, directory) : null;
  const changed = prior ? previousCollectionCandidates(prior.receipt.rows, basis.rows) : [];
  const awaitingShipment = basis.rows.filter(row => row.status === 'AWAITING_SHIPMENT' && row.serviceMatches && row.packageLineIdentityVerified);
  const shipmentChecks = awaitingShipment.length ? await readPendingPackages(client, token, shop,
    awaitingShipment.map(row => ({ ...row, nextAction: 'check_existing_package_and_carrier' })), cutoff, { readShippingDocuments: true }) : null;
  const collectionRows = result.rows.filter(row => row.orderStatus === 'AWAITING_COLLECTION');
  const [wms, shipmentWms, domesticWms, collectionTransition] = await Promise.all([
    readOverseasWms ? readPendingWms(collectionRows, directory) : null,
    readOverseasWms && shipmentChecks ? readPendingWms(shipmentChecks.rows.filter(row => row.orderStatus === 'AWAITING_SHIPMENT'), directory, 'shipment-wms') : null,
    readDomesticWms ? readDomesticCollection({ basis: basis.rows, current: collectionRows, shop, directory }) : null,
    changed.length ? readPendingPackages(client, token, shop, changed, cutoff)
      .then(result => ({ previousSource: prior.file, ...result }))
      .catch(error => ({ previousSource: prior.file, error: publicPlatformError(error, '前一批原包裹回查未完成') })) : null,
  ]);
  const observedAt = new Date().toISOString();
  if (dayKey(new Date(observedAt)) !== day) throw new Error('Shop day changed during pending package readback');
  const file = join(directory, 'pending-package-followup-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify({ schema: 'operations-pending-package-followup/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, source, ...result, wms, domesticWms,
    shipmentChecks: shipmentChecks?.rows ?? null, shipmentWms, collectionTransition, trace }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, ...result.summary, wms: wms && { completedWarehouses: wms.completedWarehouses,
    exactMatchedPackages: wms.exactMatchedPackages, outboundPackages: wms.outboundPackages,
    waitingWarehousePackages: wms.waitingWarehousePackages, pickingWarehousePackages: wms.pickingWarehousePackages,
    packedWarehousePackages: wms.packedWarehousePackages, conflictedPackages: wms.conflictedPackages },
    collectionTransition: collectionTransition?.summary ?? collectionTransition }));
}

async function readWmsEvidence(source) {
  const receipt = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/u, ''));
  const wms = receipt?.exactWarehouseRead;
  if ((receipt?.shop?.id ?? receipt?.shop?.shopId) !== shopId || receipt.shop.region !== 'MY' || !Array.isArray(wms?.records)) {
    throw new Error('Warehouse receipt does not identify the expected shop and records');
  }
  return wms.records.filter(row => row.exactPackage === true && row.stage === 'has_out_storage' && row.outboundAt)
    .map(row => ({ orderId: row.platformOrderSn, packageId: row.platformPackageId, productId: receipt.productId,
      skuId: receipt.skuId, platformWarehouseId: receipt.platformWarehouseId, system: wms.system, warehouseId: wms.warehouseId,
      stage: row.stage, source }));
}

async function main() {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, 'live-orders': { type: 'boolean' },
    'wms-evidence': { type: 'string', multiple: true },
    'pending-from': { type: 'string' }, 'read-overseas-wms': { type: 'boolean' }, 'read-domestic-wms': { type: 'boolean' } } });
  if (values['pending-from']) return refreshPendingPackages(resolve(values['pending-from']), {
    readOverseasWms: values['read-overseas-wms'], readDomesticWms: values['read-domestic-wms'],
  });
  if (values['read-overseas-wms'] || values['read-domestic-wms']) throw new Error('Warehouse reads require --pending-from');
  if (values.catalog && values['live-orders']) throw new Error('Choose a saved cohort or a fresh live order window');
  const catalogFile = values['live-orders'] ? null : values.catalog ? resolve(values.catalog) : join(catalogDirectory,
    (await readdir(catalogDirectory)).filter(file => snapshotFilename.test(file)).sort().at(-1));
  const trace = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    trace.push({ method: options.method, path: url.pathname, status: response.status, code: envelope?.code ?? null,
      requestId: envelope?.request_id ?? null });
    return response;
  } });
  const cutoff = Math.floor(Date.now() / 1000);
  const [catalog, warehouseData, native] = await Promise.all([
    catalogFile ? readFile(catalogFile, 'utf8').then(JSON.parse) : readLiveRoutingOrders(client, token, shop, cutoff),
    client.listingWarehouses(token, shop),
    Promise.all((values['wms-evidence'] ?? []).map(file => readWmsEvidence(resolve(file))))]);
  const cohort = catalogFile ? verifyCohort(catalog, shop, cutoff) : catalog.orders.rows;
  if (!Array.isArray(warehouseData.warehouses)) throw new Error('Official warehouse list unavailable');
  const details = [];
  for (let start = 0; start < cohort.length; start += 50) {
    const ids = cohort.slice(start, start + 50).map(row => row.id);
    const page = await client.operationalOrders(token, shop, ids);
    if (page.some(row => !ids.includes(row.id))) throw new Error('Order details outside the requested cohort');
    details.push(...page);
  }
  const rows = replayFulfillmentRouting(cohort, details, warehouseData.warehouses, native.flat());
  const cases = rows.filter(row => row.route && shipped.has(row.status));
  const pending = rows.filter(row => fulfillmentQueue.has(row.status) || (!row.status && fulfillmentQueue.has(row.catalogStatus)));
  const byRoute = Object.fromEntries([...routes.values()].map(route => [route, cases.filter(row => row.route === route).length]));
  const summary = { catalogOrders: cohort.length, orderDetails: details.length,
    exactOrderLineMatches: rows.filter(row => row.identityVerified).length, historicalRouteCases: cases.length,
    byRoute, wmsEvidenceSources: native.length, exactWmsOutbound: native.length ? rows.filter(row => row.wms).length : null,
    buyerCollectionPointOrders: rows.filter(row => row.buyerCollectionPoint).length,
    buyerCollectionPointAwaitingCollection: pending.filter(row => row.buyerCollectionPoint && row.status === 'AWAITING_COLLECTION').length,
    unrecognizedShippingService: rows.filter(row => row.route && row.serviceMatches === null).length,
    mismatchedShippingService: rows.filter(row => row.serviceMatches === false).length,
    pendingCollection: pending.filter(row => row.nextAction === 'check_existing_package_and_carrier').length,
    pendingShipment: pending.filter(row => row.status === 'AWAITING_SHIPMENT').length,
    pendingShipmentByRoute: Object.fromEntries([...routes.values()].map(route => [route,
      pending.filter(row => row.status === 'AWAITING_SHIPMENT' && row.route === route && row.serviceMatches).length])),
    partiallyShipping: pending.filter(row => row.status === 'PARTIALLY_SHIPPING').length,
    onHold: pending.filter(row => row.status === 'ON_HOLD').length,
    pendingUnresolved: pending.filter(row => !row.route || ['verify_existing_package_identity',
      'verify_shipping_service_before_assignment'].includes(row.nextAction)).length,
    writes: 0 };
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const directory = join(root, 'outputs/operations-fulfillment-routing-replay', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify({ schema: 'operations-fulfillment-routing-replay/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, catalogFile, orderWindow: catalog.orderWindow,
    orderSource: catalogFile ? 'saved_catalog' : 'live_order_list', orderPages: catalog.orders.pages ?? null,
    summary, pickupReference, rows, trace }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, ...summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
