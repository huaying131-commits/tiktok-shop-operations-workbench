import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { toCents } from '../../skills/dalei-tiktok-shop-ops/scripts/check-listing.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';

function latestReadback(directory) {
  const name = readdirSync(directory).filter(file => /^readback-.*\.json$/u.test(file)).sort().at(-1);
  if (!name) throw new Error('No official pilot readback in ' + directory);
  const source = join(directory, name);
  return { source, ...JSON.parse(readFileSync(source, 'utf8')) };
}

export function readPilotChain(directory, shopId) {
  const product = latestReadback(join(directory, 'live'));
  const created = JSON.parse(readFileSync(join(directory, 'live', 'create.result.json'), 'utf8'));
  if (product.shopId !== shopId || created.code !== 0 || created.data?.product_id !== product.productId ||
      !created.data.skus?.some(sku => sku.id === product.skuId && sku.seller_sku === product.sellerSku)) {
    throw new Error('Official listing receipt does not match the pilot');
  }
  const promotion = latestReadback(join(directory, 'promotion'));
  const saved = JSON.parse(readFileSync(join(directory, 'promotion', 'create.result.json'), 'utf8'));
  if (saved.code !== 0 || saved.data?.activity_id !== promotion.activityId || promotion.pilot?.shopId !== shopId ||
      promotion.pilot.market !== 'MY' || promotion.pilot.productId !== product.productId || promotion.pilot.skuId !== product.skuId) {
    throw new Error('Official promotion receipt does not match the pilot');
  }
  return { listing: product, promotion };
}

export async function openMyShopSession(shopId, { fetchApi } = {}) {
  const [credentials, authorization] = await Promise.all([loadLocalAppCredentials(), loadLocalAuthorization()]);
  if (credentials.serviceId !== authorization.serviceId || authorization.tokens?.user_type !== 0) {
    throw new Error('Existing seller authorization mismatch');
  }
  const token = authorization.tokens?.access_token;
  if (!token) throw new Error('Existing authorization is unavailable');
  const client = createTikTokClient({ ...credentials, fetchApi });
  const shop = (await client.authorizedShops(token)).find(row => row.id === shopId && row.region === 'MY' && row.name === 'example-shop-my');
  if (!shop) throw new Error('Expected MY Cross1 shop not found');
  return { client, token, shop };
}

export async function readPromotionInventory(items, { client, token, shop }) {
  if (!items.length) return null;
  const { data, requestId } = await client.inventoryBySku(token, shop, items.map(item => item.skuId));
  if (!requestId || !Array.isArray(data.inventory) || data.inventory.some(product => !Array.isArray(product?.skus))) {
    throw new Error('Incomplete official inventory response');
  }
  const skuRows = data.inventory.flatMap(product => product.skus.map(sku => ({ productId: product.product_id, sku })));
  const quantity = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const rows = items.map(({ productId, skuId, sellerSku }) => {
    const identity = { productId, skuId, sellerSku };
    const matches = skuRows.filter(({ sku }) => sku?.id === skuId);
    if (!matches.length) return { ...identity, state: 'sku_missing' };
    const [{ productId: reportedProduct, sku }] = matches;
    if (matches.length !== 1 || productId !== reportedProduct || sellerSku !== sku.seller_sku) {
      return { ...identity, state: 'sku_identity_mismatch' };
    }
    const distribution = sku.total_available_inventory_distribution;
    return { ...identity, state: 'sku_verified',
      platformAvailable: quantity(sku.total_available_quantity), platformCommitted: quantity(sku.total_committed_quantity),
      inShop: quantity(distribution?.in_shop_inventory?.quantity),
      campaignAllocations: Array.isArray(distribution?.campaign_inventory) ? distribution.campaign_inventory.map(row => ({
        name: typeof row?.campaign_name === 'string' ? row.campaign_name : null, quantity: quantity(row?.quantity),
      })) : null,
      creatorAllocations: Array.isArray(distribution?.creator_inventory) ? distribution.creator_inventory.map(row => quantity(row?.quantity)) : null,
      warehouses: Array.isArray(sku.warehouse_inventory) ? sku.warehouse_inventory.map(row => ({
        id: isPlatformId(row?.warehouse_id) ? row.warehouse_id : null,
        available: quantity(row?.available_quantity), committed: quantity(row?.committed_quantity),
      })) : null };
  });
  return { observedAt: new Date().toISOString(), shopId: shop.id, requestId, rows };
}

function pilotWindow(pilot) {
  const start = Date.parse(pilot.proposal.proposedStart) / 1000;
  const end = Date.parse(pilot.proposal.proposedEnd) / 1000;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw new Error('Invalid pilot period');
  return { startInclusive: start, endExclusive: end };
}

export function planFixedPriceActivity(pilot, title, activityId) {
  const { market, shopId, productId, skuId, sellerSku, proposal } = pilot;
  if (market !== 'MY' || !isPlatformId(shopId) || !isPlatformId(productId) || !isPlatformId(skuId) ||
      typeof sellerSku !== 'string' || !sellerSku.trim() || typeof title !== 'string' || !title.trim() ||
      proposal?.activityType !== 'FIXED_PRICE') throw new Error('Exact MY merchant fixed-price activity required');
  if (activityId !== undefined && !isPlatformId(activityId)) throw new Error('Invalid merchant activity ID');
  const { activityPriceMYR, totalQuantityLimit, buyerQuantityLimit } = proposal;
  if (typeof activityPriceMYR !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(activityPriceMYR) ||
      !Number.isFinite(Number(activityPriceMYR)) || Number(activityPriceMYR) <= 0) throw new Error('Invalid MYR activity price');
  if (![totalQuantityLimit, buyerQuantityLimit].every(value => value === -1 || (Number.isInteger(value) && value >= 1 && value <= 99)) ||
      (totalQuantityLimit > 0 && buyerQuantityLimit > totalQuantityLimit)) throw new Error('Invalid activity purchase limits');
  const { startInclusive, endExclusive } = pilotWindow(pilot);
  const path = '/promotion/202309/activities';
  const id = activityId ?? '<activity_id>';
  return { type: 'merchant_fixed_price_discount', create: { method: 'POST', path,
    body: { title, activity_type: 'FIXED_PRICE', product_level: 'VARIATION', duration_type: 'NORMAL',
      begin_time: startInclusive, end_time: endExclusive } },
  bind: { method: 'PUT', path: `${path}/${id}/products`,
    body: { activity_id: id, products: [{ id: productId, quantity_limit: -1, quantity_per_user: -1,
      skus: [{ id: skuId, activity_price_amount: activityPriceMYR, quantity_limit: totalQuantityLimit, quantity_per_user: buyerQuantityLimit }] }] } } };
}

export function comparePilotMarketPrice(benchmark, models, currentRegularPrice) {
  const { components } = benchmark;
  const price = toCents(currentRegularPrice);
  if (benchmark.currency !== 'MYR' || benchmark.scope !== 'near_spec_components' ||
      (currentRegularPrice != null && price === null) ||
      components?.length !== 2 || ![['sticks', 5], ['rings', 4]].every(([type, count]) => components.some(row =>
        row.type === type && row.count === count && row.listedInStock === true && (toCents(row.amount) ?? 0n) > 0n))) {
    throw new Error('Missing verified near-spec price comparison');
  }
  const combined = components.reduce((total, row) => total + toCents(row.amount), 0n);
  const money = value => `${value < 0n ? '-' : ''}${(Number(value < 0n ? -value : value) / 100).toFixed(2)}`;
  return { combinedPrice: money(combined), currentRegularAboveComparison: price === null ? null : money(price - combined),
    exactMarketBundlePrice: null,
    models: models.map(row => ({ id: row.id, regularDifference: money(toCents(row.regularPrice) - combined),
      firstStageDifference: money(toCents(row.firstStagePrice) - combined),
      secondStageDifference: money(toCents(row.secondStagePrice) - combined) })) };
}

export function planPilotRepricing(pricing, pilot, outcome) {
  const { listing, activity } = outcome;
  if (pricing.market !== 'MY' || pricing.currency !== 'MYR' || pilot.market !== 'MY' || pricing.shopId !== pilot.shopId ||
      pricing.decision !== 'awaiting_user_review' || !isPlatformId(pilot.productId) || !isPlatformId(pilot.skuId) ||
      listing?.status !== 'ACTIVATE' || listing.auditStatus !== 'APPROVED' || listing.isNotForSale !== false ||
      listing.currency !== 'MYR' || toCents(listing.regularPrice) === null || !isPlatformId(activity?.activityId) ||
      !['active_configuration_verified', 'expired_configuration_verified'].includes(activity.state) ||
      ['productId', 'skuId', 'sellerSku'].some(key => pricing[key] !== listing[key] || listing[key] !== pilot[key])) {
    throw new Error('Verified live pricing and original fixed-price activity required');
  }
  const { totalQuantityLimit, buyerQuantityLimit } = pilot.proposal;
  const { endExclusive } = pilotWindow(pilot);
  const planned = pricing.models.map(model => {
    const regular = toCents(model.regularPrice);
    const first = toCents(model.firstStagePrice);
    const second = toCents(model.secondStagePrice);
    if (regular === null || second === null || first !== (regular * 57n + 50n) / 100n || second !== (regular * 50n + 50n) / 100n ||
        !(second > 0n && second < first && first < regular)) throw new Error('Pricing stages do not match the original calculation');
    const fixedPriceSku = amount => ({ id: pilot.skuId, activity_price_amount: amount,
      quantity_limit: totalQuantityLimit, quantity_per_user: buyerQuantityLimit });
    return { modelId: model.id, label: model.label,
      regularPriceRequest: { method: 'POST', path: `/product/202309/products/${pilot.productId}/prices/update`,
        body: { skus: [{ id: pilot.skuId, price: { currency: 'MYR', sale_price: model.regularPrice } }] } },
      firstStage: { percentOff: 43, sku: fixedPriceSku(model.firstStagePrice) },
      secondStage: { percentOff: 50, sku: fixedPriceSku(model.secondStagePrice), afterVolumeReview: true } };
  });
  return { state: 'awaiting_price_approval', observedAt: outcome.observedAt, shopId: pilot.shopId,
    productId: pilot.productId, skuId: pilot.skuId, sellerSku: pilot.sellerSku,
    regularPrice: listing.regularPrice, fixedPrice: activity.configuredActivityPrice,
    activityId: activity.activityId, currentActivityStatus: activity.platformStatus, currentActivityEndsAt: new Date(endExclusive * 1000).toISOString(),
    currentActivityBlocksRegularPrice: activity.state === 'active_configuration_verified',
    followupActivity: { type: 'FIXED_PRICE', productLevel: 'VARIATION', schedule: null, approved: false },
    orderRows: outcome.orders?.exactOrderRows?.length ?? null, planned, platformWrites: 0 };
}

export function reviewActivity(pilot, activityId, activity) {
  const { startInclusive, endExclusive } = pilotWindow(pilot);
  const proposal = pilot.proposal;
  const product = activity.products?.find(row => row.id === pilot.productId);
  const sku = product?.skus?.find(row => row.id === pilot.skuId);
  const checks = {
    activity: (activity.activity_id ?? activity.id) === activityId,
    type: activity.activity_type === proposal.activityType && activity.product_level === 'VARIATION',
    exactSkuOnly: Boolean(sku) && product.skus.length === 1 && activity.products.length === 1,
    price: ['MYR', 'RM'].includes(sku?.activity_price?.currency) &&
      Number(sku.activity_price.amount) === Number(proposal.activityPriceMYR) && Number(proposal.activityPriceMYR) > 0,
    totalLimit: sku?.quantity_limit === proposal.totalQuantityLimit,
    buyerLimit: sku?.quantity_per_user === proposal.buyerQuantityLimit,
    period: activity.begin_time === startInclusive && activity.end_time === endExclusive,
  };
  const verified = Object.values(checks).every(Boolean);
  const states = { ONGOING: 'active_configuration_verified', NOT_START: 'scheduled_configuration_verified',
    EXPIRED: 'expired_configuration_verified' };
  const used = sku?.used_quantity;
  return { activityId, platformStatus: activity.status ?? null, checks,
    state: verified ? (states[activity.status] ?? 'configuration_verified_status_pending') : 'configuration_mismatch',
    configuredActivityPrice: sku?.activity_price ?? null,
    limitUsage: verified ? { total: sku.quantity_limit, perBuyer: sku.quantity_per_user,
      used: Number.isSafeInteger(used) && used >= 0 ? used : null } : null,
    buyerCheckoutPrice: null };
}

export function reviewPilotOrders(pilot, catalog, financeReview) {
  const { startInclusive, endExclusive } = pilotWindow(pilot);
  const observed = catalog.orderWindow;
  const orderTimes = new Map(catalog.orders.rows.map(row => [row.id, row.createdAt]));
  const orders = financeReview.rows.filter(row => {
    const time = orderTimes.get(row.orderId);
    return row.productId === pilot.productId && row.skuId === pilot.skuId &&
      Number.isInteger(time) && time >= startInclusive && time < endExclusive;
  }).map(row => ({ ...row, createdAt: orderTimes.get(row.orderId), promotionAttribution: null }));
  return { pilotWindow: { startInclusive, endExclusive }, snapshotWindow: observed,
    windowCovered: observed.startInclusive <= startInclusive && observed.endExclusive >= endExclusive,
    statementsStatus: financeReview.statementsStatus, refundsStatus: financeReview.refundsStatus, orders,
    paidRows: orders.filter(row => row.settlement.state === 'paid_statement').length };
}

export async function readPilotOrderWindow(pilot, fetchPage, now = Date.now()) {
  const { startInclusive, endExclusive: pilotEnd } = pilotWindow(pilot);
  const endExclusive = Math.min(pilotEnd, Math.floor(now / 1000));
  if (endExclusive <= startInclusive) return null;
  const requestIds = [];
  const orders = await collectPages(async cursor => {
    const page = await fetchPage(cursor, startInclusive, endExclusive);
    if (page.requestId) requestIds.push(page.requestId);
    return page;
  }, Date.now() + 150_000);
  const matches = [];
  for (const order of orders.rows) {
    if (!Number.isSafeInteger(order.createdAt) || order.createdAt < startInclusive || order.createdAt >= endExclusive) {
      throw new Error('Pilot order is outside the requested window');
    }
    if (!Array.isArray(order.skus) || !order.skus.length || order.skus.some(line => !line.productId || !line.id)) {
      throw new Error('Pilot order window has missing product or SKU data');
    }
    for (const line of order.skus) {
      if (line.id === pilot.skuId && line.productId !== pilot.productId) throw new Error('Pilot order product and SKU identity conflict');
      if (line.productId === pilot.productId && line.id === pilot.skuId) {
        if (!line.lineId) throw new Error('Pilot order line is missing its platform identifier');
        matches.push({ orderId: order.id, orderLineId: line.lineId, orderStatus: order.status });
      }
    }
  }
  return { startInclusive, endExclusive, wholePilotCovered: endExclusive === pilotEnd, pages: orders.pages, requestIds,
    checkedOrderCount: orders.rows.length, platformOrderCount: orders.totalCount, exactOrderRows: matches };
}

export function canCloseEmptyPilot(receipt) {
  return receipt?.state === 'expired_configuration_verified' && receipt.windowCovered === true &&
    receipt.ordersCountVerified === true && receipt.orderLines === 0 && receipt.limitUsage?.used === 0;
}

export async function readPilotOrderEconomics(pilot, orderRows, { client, token, shop }, activityId) {
  const groups = new Map();
  for (const row of orderRows) {
    if (!isPlatformId(row.orderId) || !isPlatformId(row.orderLineId)) throw new Error('Invalid pilot order identity');
    const group = groups.get(row.orderId) ?? new Set();
    if (group.has(row.orderLineId)) throw new Error('Duplicated pilot order line');
    group.add(row.orderLineId);
    groups.set(row.orderId, group);
  }
  if (!groups.size) return [];
  const expectedOrderIds = [...groups.keys()];
  const details = new Map();
  for (let start = 0; start < expectedOrderIds.length; start += 50) {
    const ids = expectedOrderIds.slice(start, start + 50);
    const orders = await client.operationalOrders(token, shop, ids);
    for (const order of orders) {
      if (!ids.includes(order.id) || details.has(order.id)) throw new Error('Unexpected pilot order details');
      details.set(order.id, order);
    }
  }
  const rows = [];
  for (const [orderId, expected] of groups) {
    const orderLineIds = [...expected];
    const order = details.get(orderId);
    const exact = order?.lines?.filter(row => row.skuId === pilot.skuId) ?? [];
    if (exact.length !== expected.size || new Set(exact.map(line => line.id)).size !== expected.size ||
        exact.some(line => line.productId !== pilot.productId || !expected.has(line.id))) {
      rows.push({ orderId, orderLineIds, state: 'order_identity_unverified' });
      continue;
    }
    const [checkout, settlement] = await Promise.allSettled([
      client.orderPriceDetails(token, shop, orderId), client.orderSettlement(token, shop, orderId),
    ]);
    const price = checkout.status === 'fulfilled' ? checkout.value : null;
    const priceLines = price?.lines.filter(line => expected.has(line.id)) ?? [];
    const checkoutVerified = price?.currency === 'MYR' && priceLines.length === expected.size &&
      new Set(priceLines.map(line => line.id)).size === expected.size &&
      priceLines.every(line => line.currency === 'MYR' && typeof line.buyerProduct === 'string');
    const finance = settlement.status === 'fulfilled' ? settlement.value : null;
    const transactions = finance?.skuTransactions.filter(line => line.skuId === pilot.skuId) ?? [];
    const [transaction] = transactions;
    const settlementVerified = finance?.currency === 'MYR' && transactions.length === 1 &&
      isPlatformId(transaction.statementId) && typeof transaction.settlementAmount === 'string' &&
      Number(transaction.quantity) === expected.size;
    const exactPromotionLines = checkoutVerified && isPlatformId(activityId) ? priceLines.flatMap(line => {
      const promotions = line.sellerProductPromotions?.filter(item => item.activityId === activityId && item.type === 'ACTIVITY') ?? [];
      return promotions.length === 1 && Number(promotions[0].amount) > 0 ? [{ orderLineId: line.id, amount: promotions[0].amount }] : [];
    }) : [];
    rows.push({ orderId, orderLineIds, orderStatus: order.status, state: 'order_identity_verified',
      checkout: checkoutVerified ? { currency: price.currency, orderPayment: price.payment, lines: priceLines } : null,
      checkoutState: checkoutVerified ? 'exact_buyer_price' : checkout.status === 'rejected' ? 'unavailable' : 'exact_line_price_unverified',
      settlement: settlementVerified ? { currency: finance.currency, ...transaction } : null,
      settlementState: settlementVerified ? 'statement_reference' : settlement.status === 'rejected' ? 'unavailable' : 'exact_sku_settlement_unverified',
      actualNetProfit: null, promotionAttribution: exactPromotionLines.length
        ? { activityId, source: 'seller_funded_product_promotions', lines: exactPromotionLines } : null });
  }
  return rows;
}

export async function readLivePilotOutcome(pilot, activityId, session, { includeBuyerUrl = false } = {}) {
  const { client, token, shop } = session;
  const [activity, orders, listing] = await Promise.all([
    client.promotionActivity(token, shop, activityId, { includeRequestId: true }).then(({ data, requestId }) =>
      ({ ...reviewActivity(pilot, activityId, data), requestId: requestId ?? null })),
    readPilotOrderWindow(pilot, (cursor, start, end) => client.ordersPage(token, shop, 100, cursor, start, end, { includeRequestId: true })),
    client.productDetail(token, shop, pilot.productId, { includeBuyerUrl, includeRequestId: true }).then(({ data: product, requestId }) => {
      const matches = product.skus?.filter(row => row.id === pilot.skuId) ?? [];
      const [sku] = matches;
      if (product.id !== pilot.productId || matches.length !== 1 || (pilot.sellerSku && sku.seller_sku !== pilot.sellerSku) ||
          sku.price?.currency !== 'MYR') throw new Error('Pilot listing price identity mismatch');
      const listedQuantity = Array.isArray(sku.inventory) && sku.inventory.length &&
        sku.inventory.every(row => Number.isSafeInteger(row.quantity) && row.quantity >= 0)
        ? sku.inventory.reduce((sum, row) => sum + row.quantity, 0) : null;
      let buyerUrl = null;
      if (includeBuyerUrl && requestId && typeof product.product_detail_url === 'string' &&
          product.status === 'ACTIVATE' && product.audit?.status === 'APPROVED' && product.is_not_for_sale === false) {
        const url = URL.parse(product.product_detail_url);
        if (url?.protocol === 'https:' && ['www.tiktok.com', 'shop.tiktok.com', 'vt.tiktok.com'].includes(url.host) &&
            !url.username && !url.password) buyerUrl = url.href;
      }
      return { productId: product.id, skuId: sku.id, sellerSku: sku.seller_sku, status: product.status ?? null, requestId: requestId ?? null,
        auditStatus: product.audit?.status ?? null, currency: sku.price.currency,
        regularPrice: sku.price.sale_price ?? null, taxExclusivePrice: sku.price.tax_exclusive_price ?? null,
        isNotForSale: typeof product.is_not_for_sale === 'boolean' ? product.is_not_for_sale : null, listedQuantity,
        ...(includeBuyerUrl ? { buyerUrl, buyerUrlRequestId: requestId ?? null } : {}) };
    }).catch(() => null),
  ]);
  let orderEconomics = null;
  let orderEconomicsError = null;
  if (orders) {
    try {
      orderEconomics = await readPilotOrderEconomics(pilot, orders.exactOrderRows, session, activityId);
    } catch (error) {
      orderEconomicsError = publicPlatformError(error, 'Order detail or identity verification failed');
    }
  }
  const statementPayments = orderEconomics ? await readPilotStatementPayments(orderEconomics, session, orders.startInclusive) : null;
  return { observedAt: new Date().toISOString(), listing, activity, orders, orderEconomics, orderEconomicsError, statementPayments };
}

export async function readPilotStatementPayments(orderEconomics, { client, token, shop }, startInclusive) {
  const referenced = orderEconomics.filter(row => row.settlement);
  if (!referenced.length) return { state: 'no_statement_references', orders: [] };
  try {
    const end = Math.floor(Date.now() / 1000);
    const index = await collectPages(cursor => client.statementsPage(token, shop, startInclusive, end, cursor), Date.now() + 60_000);
    const byId = new Map(index.rows.map(row => [row.id, row]));
    return { state: 'index_read', window: { startInclusive, endExclusive: end }, orders: referenced.map(row => {
      const indexEntry = byId.get(row.settlement.statementId);
      const exact = indexEntry?.currency === row.settlement.currency ? indexEntry : null;
      return { orderId: row.orderId, statementId: row.settlement.statementId,
        paymentStatus: exact?.paymentStatus ?? null, paymentId: exact?.paymentId ?? null, paymentTime: exact?.paymentTime ?? null };
    }) };
  } catch (error) {
    return { state: 'index_unavailable', orders: [], error: publicPlatformError(error, 'Statement index read failed') };
  }
}

export function linkPilotStatementPayments(orderEconomics, snapshot) {
  if (!Array.isArray(orderEconomics)) return null;
  const priorOrders = snapshot?.orders ?? [];
  const finance = new Map(priorOrders.map(row => [row.orderId, row]));
  if (finance.size !== priorOrders.length) throw new Error('Duplicated pilot order in the finance snapshot');
  return orderEconomics.map(row => {
    const ledger = finance.get(row.orderId);
    const live = row.settlement;
    const prior = ledger?.settlement;
    const matching = live && prior && live.skuId === ledger.skuId && live.statementId === prior.statementId &&
      live.currency === prior.currency && Number(live.settlementAmount) === Number(prior.amount) &&
      Number.isSafeInteger(Number(live.quantity)) && Number(live.quantity) > 0 && Number(live.quantity) === Number(prior.quantity) &&
      Array.isArray(ledger.orderLineIds) &&
      ledger.orderLineIds.length === row.orderLineIds.length && row.orderLineIds.every(id => ledger.orderLineIds.includes(id));
    return { orderId: row.orderId, statementId: live?.statementId ?? null, paidStatementVerified: matching &&
      prior.state === 'paid_statement' ? true : null, ledgerState: matching ? prior.state : null };
  });
}

async function main() {
  const [pilotPath, activityId, financePath, ...extra] = process.argv.slice(2);
  if (!pilotPath || !/^\d{8,30}$/u.test(activityId ?? '') || extra.length) {
    throw new Error('Usage: node scripts/operations/verify-promotion-outcome.mjs <pilot.json> <activity-id> [finance snapshot path]');
  }
  const pilot = JSON.parse(readFileSync(pilotPath, 'utf8'));
  if (pilot.shopId !== '9000000000000000099' || pilot.market !== 'MY') throw new Error('Expected MY Cross1 pilot');
  const session = await openMyShopSession(pilot.shopId);
  const { listing, activity, orders: liveOrderWindow, orderEconomics, orderEconomicsError, statementPayments } =
    await readLivePilotOutcome(pilot, activityId, session);
  let settlement = null;
  if (financePath && activity.state !== 'configuration_mismatch') {
    const review = reviewFinanceSnapshot(financePath);
    const catalogFile = join(dirname(dirname(resolve(financePath))), review.catalogFile);
    settlement = reviewPilotOrders(pilot, JSON.parse(readFileSync(catalogFile, 'utf8')), review);
  }
  console.log(JSON.stringify({ schema: 'operations-promotion-outcome/v1', checkedAt: new Date().toISOString(),
    productId: pilot.productId, skuId: pilot.skuId, listing, activity, liveOrderWindow, orderEconomics, orderEconomicsError,
    statementPayments, settlement,
    paymentReconciliation: linkPilotStatementPayments(orderEconomics, settlement) }, null, 2));
  if (activity.state === 'configuration_mismatch') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
