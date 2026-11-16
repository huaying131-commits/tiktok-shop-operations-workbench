import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';

const shopId = '9000000000000000099';
const downstream = new Set(['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
const exactShop = row => row?.shop?.id === shopId && row.shop.name === 'example-shop-my' && row.shop.region === 'MY';
const time = row => Date.parse(row.observedAt);
const read = async path => ({ source: resolve(path), data: JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')) });
const request = (receipt, path) => receipt.trace?.some(row => row.path === path && row.status === 200 && row.code === 0 && row.requestId);

export function compareFulfillmentShadow({ routing, transition, overseasPlan, overseasOutcome, labels, domestic }) {
  const before = routing.data;
  const after = transition.data;
  if (![routing, transition, overseasPlan, overseasOutcome, labels].every(({ data }) => exactShop(data) && Number.isFinite(time(data))) ||
      before.schema !== 'operations-fulfillment-routing-replay/v1' || before.orderSource !== 'live_order_list' || before.summary?.writes !== 0 ||
      !request(before, '/order/202507/orders') || after.schema !== 'operations-shipment-status-transition/v1' || after.writes !== 0 ||
      !request(after, '/order/202507/orders') || resolve(after.source) !== routing.source || time(after) <= time(before) ||
      overseasPlan.data.schema !== 'operations-shipment-stock-readback/v1' || overseasPlan.data.writes !== 0 ||
      overseasOutcome.data.schema !== 'operations-pending-package-followup/v1' || overseasOutcome.data.summary?.writes !== 0 ||
      labels.data.schema !== 'operations-package-label-transition/v1' || labels.data.writes !== 0 ||
      resolve(labels.data.source) !== transition.source || time(labels.data) < time(after) || time(overseasOutcome.data) < time(after)) {
    throw new Error('Original shadow and later readback receipts did not match');
  }
  const orders = before.rows.filter(row => row.status === 'AWAITING_SHIPMENT');
  if (!orders.length || new Set(orders.map(row => row.orderId)).size !== orders.length ||
      new Set(after.rows.map(row => row.orderId)).size !== after.rows.length) throw new Error('Invalid shadow order cohort');
  const rows = orders.map(plan => {
    const { orderId, route, buyerCollectionPoint } = plan;
    const [sku] = plan.skus ?? [];
    const [packageId] = plan.packages ?? [];
    const actual = after.rows.find(row => row.orderId === orderId);
    const base = { orderId, packageId, skuId: sku?.skuId ?? null, route, buyerCollectionPoint,
      plannedWarehouse: null, observedWarehouse: null, fulfillmentMethod: null, platformStatus: actual?.orderStatus ?? null,
      trackingNumberPresent: null, labelVerified: null, cardVerified: null, state: 'pending_platform_match', sources: [] };
    if (!isPlatformId(orderId) || !isPlatformId(packageId) || plan.packages.length !== 1 || plan.skus?.length !== 1 ||
        !isPlatformId(sku.skuId) || !Number.isSafeInteger(sku.quantity) || sku.quantity < 1 || !plan.identityVerified ||
        !plan.packageLineIdentityVerified || !plan.serviceMatches || actual?.exact !== true || actual.warehouseUnchanged !== true ||
        actual.skuLinesMatch !== true || actual.packageSetUnchanged !== true || actual.packageWarehouseConflict !== false ||
        actual.route !== route || !downstream.has(actual.orderStatus) || actual.packages?.length !== 1) return base;
    const [pack] = actual.packages;
    if (pack.packageId !== packageId || pack.belongsToOriginalOrder !== true || pack.itemQuantity !== sku.quantity ||
        !request(after, `/fulfillment/202309/packages/${packageId}`)) return base;
    base.trackingNumberPresent = pack.hasTrackingNumber === true;
    base.state = 'pending_warehouse_match';
    if (route === 'china_direct') {
      const pairs = domestic.filter(pair => pair.plan.data.packing?.orderId === orderId);
      if (pairs.length !== 1) return base;
      const [{ plan: packingFile, outcome: outcomeFile }] = pairs;
      const receipt = packingFile.data;
      const planned = receipt.packing;
      const observed = outcomeFile.data;
      const matched = observed.data?.orderList?.filter(row => row.platformOrderSn === orderId &&
        row.platformPackageId === packageId && row.platformShopId === shopId && row.site === 'MY') ?? [];
      if (receipt.schema !== 'operations-domestic-packing/v1' || !exactShop(receipt) || receipt.writes !== 0 || planned.writes !== 0 ||
          planned.state !== 'packing_inputs_verified' || planned.packageId !== packageId || planned.items?.length !== 1 ||
          planned.items[0].productId !== sku.productId || planned.items[0].skuId !== sku.skuId || planned.items[0].quantity !== sku.quantity ||
          !(time(receipt) < time(after)) || observed.operation !== 'orders' || observed.result !== 'success' ||
          observed.code !== 'success' || !(time(observed) >= time(after)) || matched.length !== 1) return base;
      const [row] = matched;
      const items = row.items?.filter(item => item.platformItemId === sku.productId && item.platformSkuId === sku.skuId &&
        item.quantity === sku.quantity && item.goodsSkuList?.length === 1 && item.goodsSkuList[0].goodsSkuId === planned.items[0].goodsSkuId &&
        item.goodsSkuList[0].goodsSkuOuterId === planned.items[0].goodsSkuOuterId && item.goodsSkuList[0].quantity === sku.quantity) ?? [];
      const card = row.giftList?.filter(item => item.goodsSkuOuterId === planned.card?.goodsSkuOuterId && item.quantity === 1) ?? [];
      base.plannedWarehouse = planned.warehouseId;
      base.observedWarehouse = row.warehouseId;
      base.fulfillmentMethod = 'domestic_warehouse_stock';
      base.cardVerified = planned.card?.quantity === 1 && card.length === 1;
      base.labelVerified = labels.data.rows.some(row => row.orderId === orderId && row.packageId === packageId &&
        row.labelUrlReturned === true && row.hasTrackingNumber === true && row.requestId);
      base.sources = [packingFile.source, outcomeFile.source, labels.source];
      base.state = planned.warehouseId === row.warehouseId && items.length === 1 && base.cardVerified && base.labelVerified &&
        base.trackingNumberPresent && Boolean(row.trackingNo) ? 'matched' : 'mismatch_or_missing_evidence';
    } else if (route === 'malaysia_overseas') {
      const planned = overseasPlan.data.rows.find(row => row.orderId === orderId && row.packageId === packageId &&
        row.productId === sku.productId && row.skuId === sku.skuId && row.quantity === sku.quantity);
      const observed = overseasOutcome.data.wms?.rows?.find(row => row.orderId === orderId)?.packageMatches?.find(row => row.packageId === packageId);
      const matches = observed?.matches ?? [];
      if (!planned || !['80', '148'].includes(planned.eligibleWarehouseCandidate) ||
          !(time(overseasPlan.data) < time(after)) || observed?.conflictingActiveRecords !== false || matches.length !== 1) return base;
      const eligible = planned.warehouses?.filter(warehouse => Number.isSafeInteger(warehouse.available) &&
        warehouse.available >= sku.quantity && warehouse.existingOutboundRecords === 0);
      if (eligible?.length !== 1 || eligible[0].warehouseId !== planned.eligibleWarehouseCandidate) return base;
      const [warehouse] = matches;
      base.plannedWarehouse = planned.eligibleWarehouseCandidate;
      base.observedWarehouse = warehouse.warehouseId;
      base.fulfillmentMethod = 'overseas_warehouse_stock';
      base.sources = [overseasPlan.source, overseasOutcome.source];
      base.state = base.plannedWarehouse === base.observedWarehouse && warehouse.system === eligible[0].system &&
        isPlatformId(warehouse.wmsOrderId) && warehouse.quantityVerified === true &&
        warehouse.itemQuantity === sku.quantity && base.trackingNumberPresent ? 'matched' : 'mismatch_or_missing_evidence';
    }
    return base;
  });
  return { rows, matched: rows.filter(row => row.state === 'matched').length, orderCount: rows.length,
    writes: 0, operatorIdentityVerified: false, actualShippingCostsVerified: false };
}

async function main() {
  const [output, routingPath, transitionPath, overseasPlanPath, overseasOutcomePath, labelsPath, ...domesticPaths] = process.argv.slice(2);
  if (!labelsPath || domesticPaths.length % 2) throw new Error('Provide output, routing, transition, overseas plan and outcome, labels, and domestic plan/outcome pairs');
  const [routing, transition, overseasPlan, overseasOutcome, labels, ...files] = await Promise.all(
    [routingPath, transitionPath, overseasPlanPath, overseasOutcomePath, labelsPath, ...domesticPaths].map(read));
  const domestic = files.flatMap((file, index) => index % 2 ? [] : [{ plan: file, outcome: files[index + 1] }]);
  const result = compareFulfillmentShadow({ routing, transition, overseasPlan, overseasOutcome, labels, domestic });
  const receipt = { schema: 'operations-fulfillment-shadow-comparison/v1', observedAt: new Date().toISOString(), shop: routing.data.shop,
    planObservedAt: routing.data.observedAt, platformObservedAt: transition.data.observedAt,
    planSource: routing.source, platformSource: transition.source, ...result };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, matched: result.matched, orderCount: result.orderCount, writes: result.writes }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
