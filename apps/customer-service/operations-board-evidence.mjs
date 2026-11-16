import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isPlatformId } from './tiktok-shop-read.mjs';
import { reviewAircraftCreativeDecisions } from '../../scripts/operations/gmv-max-review.mjs';

export async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
}

export async function listNames(path) {
  return readdir(path).catch(() => []);
}

async function latestReceipt(directory, pattern) {
  const name = (await listNames(directory)).filter(file => pattern.test(file)).sort().at(-1);
  return name ? readJson(join(directory, name)) : null;
}

const roles = [
  ['controller', '原总指挥', ['tiktok'], '每日两条主链 · 经营方法验证', '按两条主链跟进异常与岗位交付，核实结果后汇总。'],
  ['selection', '选品研究', ['my-2'], '每日两条主链 · 选品验证台账', '对照本地需求、准确供货规格和可买价格，形成下一批候选。'],
  ['listing', '商品上架', ['automation-7'], '商品岗位 · 上架回查', '复用验收素材，按店铺真实商品 ID、规格、价格和在售状态回查。'],
  ['production', '视频制作', ['automation-6'], '制作岗位 · 质量与交接台账', '按账号风格整理合格片、商品规格、文案与声音核验。'],
  ['publishing', '视频发布', ['automation-5'], '发布岗位 · 当日成功账本', '按五账号配额、间隔、挂车规格与防重规则执行，平台确认后记账。'],
  ['promotion', '折扣与活动', ['my-3'], '促销岗位 · 活动及 SKU 回查', '先对照有效活动、准确 SKU、价格下限和叠加优惠。'],
  ['fulfillment', '发货与备货', ['12', '16', '23', 'automation-8'], '履约岗位 · 分仓与去重规则', '待发订单先核国内仓和海外仓的归属，同一单只交一个仓。'],
  ['analysis', '经营分析与财务', ['automation-9'], '总指挥 · 订单与结算回查', '对齐订单、结算、采购和物流成本，按同一口径复盘。'],
  ['ads', '广告投流', ['my'], '投流岗位 · 成本与归因规则', '核对内容、归因、结算和预算，再形成投流动作。'],
  ['service', '客服与售后', ['tiktok-2'], '客服岗位 · 会话与人工接续', '读取、分类、核实订单状态后再接真实客服流程。'],
];

async function readSchedule(root, ids) {
  if (!ids.length) return null;
  const states = await Promise.all(ids.map(async id => {
    const raw = await readFile(join(root, id, 'automation.toml'), 'utf8').catch(() => '');
    return raw.match(/^status\s*=\s*"(ACTIVE|PAUSED)"/mu)?.[1];
  }));
  if (states.includes('ACTIVE')) return 'enabled';
  if (states.every(state => state === 'PAUSED')) return 'paused';
  return null;
}

export function dayKey(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(date);
}

export function summarizeLocalVideoReview(receipt, day) {
  const { shop, product, rows, observedAt } = receipt ?? {};
  if (receipt?.schema !== 'operations-local-video-variant-review/v1' || shop?.id !== '9000000000000000099' ||
      shop.region !== 'MY' || shop.name !== 'example-shop-my' || !Number.isFinite(Date.parse(observedAt)) || dayKey(new Date(observedAt)) !== day ||
      !isPlatformId(product?.id) || !isPlatformId(product?.skuId) || product.status !== 'ACTIVATE' || product.audit !== 'APPROVED' ||
      !product.requestId || receipt.uploads !== 0 || receipt.submissions !== 0 || !Array.isArray(rows) || rows.length === 0 ||
      rows.length !== receipt.localFiles || new Set(rows.map(row => row.assetSha256)).size !== rows.length || rows.some(row =>
        !/^[a-f0-9]{64}$/u.test(row.assetSha256 ?? '') || row.publicationReady !== false || row.accountAssigned !== null ||
        !/^(?:hold_|candidate_pending_)[a-z_]+$/u.test(row.state ?? ''))) return null;
  const held = rows.filter(row => row.state.startsWith('hold_')).length;
  return { at: observedAt, checked: rows.length, held, pending: rows.length - held };
}

async function readPromotionDecisions(outputs, day, shopId) {
  const directory = join(outputs, 'operations-promotion-readiness', day);
  const names = (await listNames(directory)).filter(name =>
    /^resumed-promotion-\d+-sku-decision-ledger(?:-[\d.TZ-]+)?\.json$/u.test(name));
  const receipts = await Promise.all(names.map(name => readJson(join(directory, name))));
  return receipts.filter(receipt => {
    const { at, shop, rows, candidateCount, existingPilotVerified, newBusinessWrites } = receipt ?? {};
    if (shop?.id !== shopId || shop.region !== 'MY' || shop.name !== 'example-shop-my' ||
        !Number.isFinite(Date.parse(at)) || dayKey(new Date(at)) !== day ||
        !Array.isArray(rows) || rows.length === 0 || rows.length !== candidateCount ||
        !Number.isSafeInteger(newBusinessWrites) || newBusinessWrites < 0 || rows.some(row =>
          !isPlatformId(row?.productId) || !isPlatformId(row?.skuId) || !/^[a-z0-9_]+$/u.test(row.decision?.state ?? ''))) return false;
    const existing = rows.filter(row => row.decision.state === 'existing_activity_verified');
    return new Set(rows.map(row => `${row.productId}:${row.skuId}`)).size === rows.length &&
      existing.length === existingPilotVerified && existing.every(row => isPlatformId(row.decision.activityId) &&
        Array.isArray(row.merchantActivityMatches) && row.merchantActivityMatches.includes(row.decision.activityId));
  }).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null;
}

async function readCheckoutControl(outputs, day, shopId) {
  const directory = join(outputs, 'operations-order-unit-economics', day);
  const receipts = await Promise.all((await listNames(directory)).filter(isPlatformId).map(skuId =>
    latestReceipt(join(directory, skuId), /^pilot-checkout-settlement-control-[\dTZ-]+\.json$/u)));
  return receipts.flatMap(receipt => {
    const time = Date.parse(receipt?.observedAt);
    if (receipt?.schema !== 'operations-pilot-checkout-settlement-control/v1' || receipt.shop?.id !== shopId ||
        receipt.shop.region !== 'MY' || receipt.shop.name !== 'example-shop-my' || receipt.writes !== 0 ||
        !Number.isFinite(time) || dayKey(new Date(time)) !== day || !isPlatformId(receipt.productId) ||
        !isPlatformId(receipt.skuId) || receipt.orderEconomics?.length !== 1 || receipt.statementPayments?.state !== 'index_read' ||
        receipt.statementPayments.orders?.length !== 1) return [];
    const [order] = receipt.orderEconomics;
    const [payment] = receipt.statementPayments.orders;
    const money = /^-?\d+(?:\.\d{1,2})?$/u;
    if (!isPlatformId(order.orderId) || order.checkoutState !== 'exact_buyer_price' || order.settlementState !== 'statement_reference' ||
        order.orderLineIds?.length !== 1 || !isPlatformId(order.orderLineIds[0]) || order.checkout?.lines?.length !== 1 ||
        order.checkout.lines[0].id !== order.orderLineIds[0] || order.checkout.currency !== 'MYR' ||
        !money.test(order.checkout.orderPayment ?? '') || order.settlement?.currency !== 'MYR' ||
        order.settlement.skuId !== receipt.skuId || !isPlatformId(order.settlement.statementId) ||
        !money.test(order.settlement.settlementAmount ?? '') || payment.orderId !== order.orderId ||
        payment.statementId !== order.settlement.statementId || payment.paymentStatus !== 'PAID' || !isPlatformId(payment.paymentId) ||
        !['/order/202507/orders', `/order/202407/orders/${order.orderId}/price_detail`,
          `/finance/202501/orders/${order.orderId}/statement_transactions`, '/finance/202309/statements'].every(path =>
          receipt.trace?.some(call => call.path === path && call.method === 'GET' && call.status === 200 && call.code === 0 && call.requestId))) return [];
    return [{ skuId: receipt.skuId, at: receipt.observedAt, buyerPayment: order.checkout.orderPayment,
      settlement: order.settlement.settlementAmount }];
  }).sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null;
}

function summarizeActivePromotionCheckout(receipt, day, shopId) {
  const { observedAt, shop, trace, results } = receipt ?? {};
  if (receipt?.schema !== 'operations-active-promotion-checkout-controls/v1' || shop?.id !== shopId ||
      shop.region !== 'MY' || shop.name !== 'example-shop-my' || receipt.writes !== 0 ||
      !Number.isFinite(Date.parse(observedAt)) || dayKey(new Date(observedAt)) !== day ||
      !Array.isArray(trace) || !Array.isArray(results)) return null;
  const read = path => trace.some(call => call.path === path && call.method === 'GET' && call.status === 200 && call.code === 0 && call.requestId);
  const isAmount = amount => typeof amount === 'string' && /^\d+(?:\.\d{1,2})?$/u.test(amount);
  const paymentIndex = receipt.statementPayments;
  const hasPaymentIndex = paymentIndex?.state === 'index_read' && Array.isArray(paymentIndex.orders) && read('/finance/202309/statements');
  const rows = results.flatMap(({ productId, skuId, activity, details }) => {
    if (!isPlatformId(productId) || !isPlatformId(skuId) || activity?.applies !== true || !isPlatformId(activity.id) ||
        !Array.isArray(details) || !read(`/promotion/202309/activities/${activity.id}`) ||
        !read(`/product/202309/products/${productId}`) || !read('/order/202507/orders')) return [];
    return details.flatMap(order => {
      if (!isPlatformId(order.orderId) || order.checkoutState !== 'exact_buyer_price' ||
          order.checkout?.currency !== 'MYR' || !read(`/order/202407/orders/${order.orderId}/price_detail`) ||
          !Array.isArray(order.orderLineIds) || !Array.isArray(order.checkout.lines)) return [];
      const statement = order.settlement;
      const hasSettlement = order.settlementState === 'statement_reference' && statement?.skuId === skuId &&
        statement.currency === 'MYR' && isPlatformId(statement.statementId) &&
        Number(statement.quantity) === order.orderLineIds.length && new Set(order.orderLineIds).size === order.orderLineIds.length &&
        typeof statement.settlementAmount === 'string' && /^-?\d+(?:\.\d{1,2})?$/u.test(statement.settlementAmount) &&
        read(`/finance/202501/orders/${order.orderId}/statement_transactions`);
      const payments = hasSettlement && hasPaymentIndex ? paymentIndex.orders.filter(payment =>
        payment.orderId === order.orderId && payment.statementId === statement.statementId) : [];
      const paid = payments.length === 1 && payments[0].paymentStatus === 'PAID' && isPlatformId(payments[0].paymentId);
      return order.checkout.lines.filter(line => line.currency === 'MYR' && isPlatformId(line.id) &&
        order.orderLineIds.includes(line.id) && isAmount(line.buyerProduct) && isAmount(line.sellerDiscount) && Number(line.sellerDiscount) > 0)
        .map(line => ({ key: `${order.orderId}:${line.id}`, price: line.buyerProduct, discount: line.sellerDiscount,
          skuKey: `${order.orderId}:${skuId}`, settlement: hasSettlement ? statement.settlementAmount : null,
          singleLine: order.orderLineIds.length === 1, paid,
          attributed: order.promotionAttribution?.activityId === activity.id &&
            order.promotionAttribution.lines?.some(entry => entry.orderLineId === line.id) === true }));
    });
  });
  const attributed = new Set(rows.filter(row => row.attributed).map(row => row.key));
  const unlinked = [...new Map(rows.filter(row => !attributed.has(row.key)).map(row => [row.key, row])).values()];
  const settled = [...new Map(rows.filter(row => row.settlement !== null).map(row => [row.skuKey, row])).values()];
  return unlinked.length || settled.length ? { observedAt, unlinked, settled } : null;
}

async function publication(root, day) {
  const path = join(root, 'outputs', 'video-publishing-' + day);
  const ledger = await readFile(join(path, '发布记录.jsonl'), 'utf8').catch(() => '');
  const audit = await readJson(join(path, 'user-local-ledger-direct-authority-and-tm470-audit.json'));
  const rows = ledger.split(/\r?\n/u).flatMap(line => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const unique = new Map();
  for (const row of rows) {
    const time = row.published_at ?? row.at;
    if (row.published !== true || typeof row.platform_video_id !== 'string' || !row.platform_video_id ||
        !Number.isFinite(Date.parse(time)) || dayKey(new Date(time)) !== day) continue;
    unique.set(row.platform_video_id, time);
  }
  const sources = (await listNames(path)).filter(name => /^current-reopened-owned-dropdown-\d{4}$/u.test(name)).sort();
  const latest = sources.at(-1);
  const menu = latest && await readJson(join(path, latest, '003-verify-dropdown-status-result.json'));
  return {
    confirmed: unique.size || (audit?.actual_date === day && Number.isSafeInteger(audit.today_local_successes)
      ? audit.today_local_successes : null),
    latest: [...unique.values()].sort().at(-1) ?? audit?.at ?? null,
    entryChecked: menu?.status === 'succeeded',
    entryCheckTime: menu?.status === 'succeeded' ? latest.slice(-4).replace(/^(\d\d)(\d\d)$/u, '$1:$2') : null,
  };
}

export async function collectBoardEvidence({ root, scheduleDirectory, day, metrics, finance, promotion, trackedPilot, sync, runs = {} }) {
  const productRoot = join(root, 'operations', 'product-operations', 'daily');
  const outputs = join(root, 'outputs');
  const shopId = '9000000000000000099';
  const priorDay = dayKey(new Date(Date.parse(day + 'T12:00:00Z') - 86_400_000));
  const [draft, verified, recentCandidates, publish, productionDates, roleSchedules, shadow,
    daily, gmvMax, support, policy, productionReview, checkoutControl, standaloneAfterSales, promotionDecisions, promotionCheckout,
    fulfillmentComparison] = await Promise.all([
    readJson(join(productRoot, day, 'a28-private-draft-manual-submission-handoff-actual.json')),
    readJson(join(productRoot, day, 'two-original-trials-independently-live-five-and-bilingual-actual.json')),
    readJson(join(productRoot, priorDay, 'six-remaining-accepted-skus-current-readback-and-source-updates.json')),
    publication(root, day),
    listNames(join(outputs, 'video-production')),
    Promise.all(roles.map(([, , ids]) => readSchedule(scheduleDirectory, ids))),
    readJson(join(root, 'scripts', 'publisher', 'config.json')),
    latestReceipt(join(outputs, 'operations-daily-work', day), /^review-.*\.json$/u),
    latestReceipt(join(outputs, 'ads-monitoring', day, 'live-read-validation'), /^official-gmv-max-\d{4}-\d{2}-\d{2}T.*\.json$/u),
    latestReceipt(join(outputs, 'operations-service-fulfillment', day), /^official-read-.*\.json$/u),
    readJson(join(root, 'operations', 'module-execution-policy.json')),
    latestReceipt(join(outputs, 'video-production', day, 'kj600-existing-variants-quality'), /^review-[\dTZ-]+\.json$/u),
    readCheckoutControl(outputs, day, shopId),
    latestReceipt(join(outputs, 'operations-service-fulfillment', day), /^open-aftersales-.*\.json$/u),
    readPromotionDecisions(outputs, day, shopId),
    latestReceipt(join(outputs, 'operations-promotion-outcome', day), /^active-promotion-checkout-controls-[\dTZ-]+\.json$/u)
      .then(receipt => summarizeActivePromotionCheckout(receipt, day, shopId)),
    latestReceipt(join(outputs, 'operations-fulfillment-routing-replay', day), /^shadow-comparison-[\dTZ-]+\.json$/u),
  ]);
  const listing = daily?.day === day && daily.pilot?.available && daily.pilot.result?.listing;
  const activeListing = listing?.shopId === shopId && listing.result?.status === 'LIVE_VERIFIED' ? listing : null;
  const currentDaily = daily?.day === day && daily.defaults?.shopId === shopId ? daily : null;
  const pricing = currentDaily?.pricing?.result;
  const repricing = currentDaily?.repricing?.result;
  const handoff = currentDaily?.selection?.handoff?.result;
  const selectionSummary = handoff?.summary;
  const originalDraft = handoff?.candidates?.find(row => row.sku === 'MY-CAR-PROJECTION-733047859765-CUSTOM-KIT' &&
    row.result?.lookup === 'known_product_id' &&
    row.result.products?.length === 1 && row.result.products[0].productId === '9000000000000000054' &&
    row.result.products[0].skuId === '9000000000000000055' && row.result.products[0].state === 'DRAFT');
  const a28Draft = originalDraft?.result.products[0];
  const production = currentDaily?.production?.handoff;
  const videoReview = summarizeLocalVideoReview(productionReview, day);
  const pilot = activeListing && currentDaily?.livePilotOutcome?.available ? currentDaily.livePilotOutcome.result : null;
  const pilotListing = pilot?.listing;
  const pilotBuyerUrl = pilotListing?.productId === activeListing?.productId && pilotListing?.skuId === activeListing?.skuId &&
    pilotListing?.sellerSku === activeListing?.sellerSku && pilotListing?.buyerUrlRequestId ? pilotListing.buyerUrl : null;
  const latestPilot = trackedPilot && (!pilot || Date.parse(trackedPilot.observedAt) >= Date.parse(pilot.observedAt)) ? trackedPilot :
    pilot && { state: pilot.activity.state, price: pilot.activity.configuredActivityPrice, sellerSku: activeListing.sellerSku,
      observedAt: pilot.observedAt, orderLines: pilot.orders?.exactOrderRows?.length,
      listedQuantity: pilot.listing?.listedQuantity ?? null, limitUsage: pilot.activity.limitUsage,
      checkoutOrders: pilot.orderEconomics?.filter(row => row.checkout).length,
      statementReferences: pilot.orderEconomics?.filter(row => row.settlement).length,
      paidStatementOrders: pilot.statementPayments?.state === 'index_read'
        ? pilot.statementPayments.orders.filter(row => row.paymentStatus === 'PAID').length : null };
  const pilotPrice = latestPilot?.price;
  const pilotMatches = latestPilot?.orderLines;
  const pilotLimits = latestPilot?.limitUsage;
  const pilotQuantity = [
    Number.isSafeInteger(latestPilot?.listedQuantity) ? `挂牌 ${latestPilot.listedQuantity} 件` : null,
    Number.isSafeInteger(pilotLimits?.total) && Number.isSafeInteger(pilotLimits?.perBuyer)
      ? `活动限 ${pilotLimits.total} 件、每人 ${pilotLimits.perBuyer} 件` : null,
    Number.isSafeInteger(pilotLimits?.used) ? `活动已用 ${pilotLimits.used} 件` : null,
  ].filter(Boolean).join('，');
  const shopVideos = currentDaily?.publishing?.shopVideos?.result;
  const videoOverview = currentDaily?.publishing?.videoOverview?.result;
  const todayVideoTraffic = currentDaily?.publishing?.videoOverview?.available === true && videoOverview?.shopId === shopId &&
    videoOverview.day === day && videoOverview.currency === 'MYR' && Array.isArray(videoOverview.rows) &&
    videoOverview.rows.find(row => row.accountType === 'ALL' && row.requestId);
  const apiPreflight = currentDaily?.publishing?.apiPreflight?.result;
  const creatorGrantPending = apiPreflight?.conclusion === 'creator_authorization_unavailable' &&
    apiPreflight.seller?.exact_sku_verified && apiPreflight.seller.status === 'ACTIVATE' && apiPreflight.seller.audit === 'APPROVED';
  const settlement = currentDaily?.operatingReview?.result;
  const unverifiedPayment = settlement?.paymentChecks?.find(row => row.statement?.status === 'SETTLED' && row.bankReceiptVerified === false);
  const paidBreakdown = settlement?.paymentBreakdown;
  const paidWindow = settlement?.paidWindowComparison?.result;
  const paidTransition = settlement?.paidStatementTransitions?.[0];
  const statementCoverage = paidTransition?.coverage;
  const paymentText = paidBreakdown
    ? `平台账单标记已付款 ${paidBreakdown.platformPaid.orderCount} 笔 RM${paidBreakdown.platformPaid.net ?? '—'}，已结算待付款核证 ${paidBreakdown.settledAwaitingPaymentProof.orderCount} 笔 RM${paidBreakdown.settledAwaitingPaymentProof.net ?? '—'}。`
    : `账单标记已付款 ${settlement?.paidOrders} 笔 RM${settlement?.paidNet}，另核结算 ${settlement?.deliveredDetailCount} 笔 RM${settlement?.deliveredDetailAmount ?? '—'}${settlement?.indexedPaidOrderCount > 0 ? `，其中 ${settlement.indexedPaidOrderCount} 笔补核账单已付款` : ''}${settlement?.paymentStatusUnknownCount > 0 ? `，${settlement.paymentStatusUnknownCount} 笔账单付款状态待核` : ''}。`;
  const productFinance = currentDaily?.productFinance?.result;
  const shopChannel = currentDaily?.shopChannelPerformance?.result;
  const shopChannelOrders = currentDaily?.shopChannelOrders?.result;
  const channelText = shopChannel ? ` 官方店铺报表至 ${shopChannel.window.latestAvailableDate}，本窗口 ${shopChannel.window.days} 个完整日 GMV RM${shopChannel.summary.gmvMyr}，${shopChannel.summary.orders} 笔订单。${
    [ ['视频', shopChannel.summary.videoAttributedMyr], ['商品卡', shopChannel.summary.productCardAttributedMyr],
      ['直播', shopChannel.summary.liveAttributedMyr] ].filter(([, amount]) => amount !== null)
      .map(([channel, amount]) => `${channel}归因 RM${amount}。`).join('')}${shopChannelOrders
        ? ` 同期按创建时间核到 ${shopChannelOrders.summary.createdOrders} 笔订单，其中取消 ${shopChannelOrders.summary.cancelled} 笔、样品 ${shopChannelOrders.summary.sampleOrders} 笔。` : ''}` : '';
  const sampleFollowup = productFinance?.followups?.find(row => row.orderTypes?.sampleOrders > 0 &&
    typeof row.orderTypes.sampleSettlementNetMyr === 'string' && Number.isFinite(Number(row.orderTypes.sampleSettlementNetMyr)));
  const sampleNet = sampleFollowup && Number(sampleFollowup.orderTypes.sampleSettlementNetMyr);
  const listingCandidates = currentDaily?.listing?.candidates?.result;
  const listingPlatformCheck = currentDaily?.listing?.platformCheck?.result;
  const fieldLabels = { brandId: '品牌 ID', packageDimensions: '发货外箱尺寸', packageWeight: '发货重量',
    salePrice: '挂牌价', images: '商品图' };
  const candidateNotes = listingCandidates?.rows.filter(row => row.official?.matches === 0).map(row => {
    const nonT1 = row.brandEvidence?.availability === 'selectable_without_brand_display';
    const draft = row.validatedDraft?.result;
    const pending = [...(row.local?.fields ?? []).map(field => field === 'brandId' && draft?.brand ? '英文版实物品牌确认' :
      nonT1 && field === 'brandId' ? '实物品牌映射' : fieldLabels[field] ?? field),
      ...(row.sourceNotes ?? []).map(note => note.replace(/待核$/u, ''))];
    const price = row.prepared && row.salePrice ? `，拟价稿 RM${row.salePrice}${row.baseSalePrice === null ? '，正式输入待填价' : ''}` : '';
    const brand = nonT1 ? `，${row.brandEvidence.name} 非 T1，建品可选且买家页品牌字段不展示` : '';
    const packing = draft ? `。本地拟案 RM${draft.salePrice}、挂牌 ${draft.quantity} 件、${draft.mediaCount} 图已复验${draft.brand ? `，品牌候选 ${draft.brand.name}` : ''}，外包估计 ${draft.estimatedParcel.dimensionsCm.join(' × ')} cm、${draft.estimatedParcel.weightG} g` : '';
    const category = row.category?.result;
    const categoryChecked = category && !category.requiredCertificates.length && !category.missingRequiredAttributes.length &&
      !category.unverifiedSuppliedAttributes.length ? '。已对照官方类目属性及证书字段' : '';
    const shadow = row.shadow?.state === 'SHADOW_VERIFIED' ? '。提审请求通过影子验收，平台待提交' :
      row.shadow?.state === 'SHADOW_INCOMPLETE' ? '。官方通道已核，提审资料待补齐' : '';
    const carriage = row.carriage?.result?.publishedBatteryFreeOption === false ? '。原供货页未列英文版去电池选项' : '';
    return `${row.sku} 官方查无匹配${price}${brand}${packing}${pending.length ? `，待核 ${pending.join('、')}` : ''}${categoryChecked}${shadow}${carriage}。`;
  }) ?? [];
  const fulfillmentRouting = currentDaily?.fulfillment?.routing?.result;
  const liveFulfillment = fulfillmentRouting?.orderSource === 'live_order_list' && fulfillmentRouting.summary?.pendingShipmentByRoute;
  const packageFollowup = fulfillmentRouting?.packageFollowup;
  const packageWms = packageFollowup?.wms;
  const shipmentWms = packageFollowup?.shipmentWms;
  const costCase = settlement?.unitEconomics?.find(entry => entry.summary?.deliveredOrders > 0 && entry.offer?.status === 'ONGOING');
  const costBreakdown = costCase?.deliveredSettlementBreakdown;
  const costComponents = costBreakdown?.componentsMyr;
  const exactCostBreakdown = costBreakdown && costBreakdown.reconciledOrderCount === costCase.summary.deliveredOrders &&
    [costComponents?.fees, costComponents?.shipping].every(value => typeof value === 'string' && /^-?\d+\.\d{2}$/u.test(value));
  const currentAds = gmvMax?.schema === 'operations-gmv-max-read/v1' && gmvMax.shop?.id === shopId &&
    gmvMax.shop.region === 'MY' && gmvMax.shop.advertiserId === gmvMax.account?.advertiser_id &&
    gmvMax.inProgressDay?.day === day && gmvMax.inProgressDay.report?.code === 0 ? gmvMax : null;
  const adTotals = currentAds?.completeDays?.accountByDay?.data?.total_metrics;
  const adsToday = currentAds?.inProgressDay.report.data?.total_metrics;
  const reviewedAds = currentDaily?.ads?.productReview?.result;
  let aircraftDecisions = null;
  try {
    aircraftDecisions = reviewAircraftCreativeDecisions(currentAds);
  } catch {
    // Other board evidence remains available when the creative report is inconsistent.
  }
  const affiliateCreative = reviewedAds?.affiliateCreativeMatches;
  const currentSupport = support?.schema === 'operations-service-fulfillment-read/v1' && support.shop?.id === shopId &&
    support.shop.region === 'MY' && support.day === day ? support : null;
  const conversations = currentSupport?.conversations?.available ? currentSupport.conversations.data : null;
  const customerCases = currentSupport?.caseLinkage?.available ? currentSupport.caseLinkage.data : null;
  const packageCount = currentSupport?.packages?.available ? currentSupport.packages.data?.processingPackages : null;
  const collection = currentSupport?.packageOrderLinkage?.available ? currentSupport.packageOrderLinkage.data?.collection : null;
  const returnWindow = currentSupport?.returns?.available ? currentSupport.returns.data : null;
  const openAfterSales = [
    currentSupport?.openAfterSales?.available ? { ...currentSupport, openAfterSales: currentSupport.openAfterSales.data } : null,
    standaloneAfterSales?.schema === 'operations-open-aftersales-read/v1' && standaloneAfterSales.writes === 0 ? standaloneAfterSales : null,
  ].filter(receipt => receipt?.shop?.id === shopId && receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' &&
    receipt.day === day && Number.isFinite(Date.parse(receipt.observedAt)) && dayKey(new Date(receipt.observedAt)) === day)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .find(receipt => ['pending_return_or_refund', 'in_arbitration'].every(key => receipt.openAfterSales?.lists?.some(list =>
      list.key === key && Number.isSafeInteger(list.count) && list.count >= 0 && Number.isSafeInteger(list.pages) && list.pages > 0 &&
      list.requestIds?.length === list.pages && list.requestIds.every(id => receipt.requests?.some(request => request.requestId === id &&
        request.path === '/return_refund/202602/returns/search' && request.method === 'POST' && request.status === 200 && request.code === 0)))));
  const supportTriage = currentDaily?.service?.triage?.result;
  const completedRefund = currentDaily?.service?.returnQuality?.result?.find(row => row.settlement?.currency === 'MYR' &&
    typeof row.buyerRefund === 'string' && Number.isFinite(Number(row.buyerRefund)) &&
    typeof row.settlement.net === 'string' && Number.isFinite(Number(row.settlement.net)));
  const refundNet = completedRefund && Number(completedRefund.settlement.net);
  const returnMediaCounts = [
    completedRefund?.eventRecords?.buyerImageCount > 0 ? `${completedRefund.eventRecords.buyerImageCount} 张图` : null,
    completedRefund?.eventRecords?.buyerVideoCount > 0 ? `${completedRefund.eventRecords.buyerVideoCount} 段视频` : null,
  ].filter(Boolean).join('、');
  const refundOutbound = completedRefund?.logistics?.originalOutbound;
  const refundReturn = completedRefund?.logistics?.returnLogistics;
  const warehouseFee = refundOutbound?.outboundMatchesLedger === true && refundOutbound.wmsFeeCurrency === 'CNY' &&
    typeof refundOutbound.wmsFee === 'string' && /^\d+(?:\.\d+)?$/u.test(refundOutbound.wmsFee) ? refundOutbound.wmsFee : null;
  const publishingTarget = policy?.publishing_target?.daily_total_target;
  const productionLatest = productionDates.filter(name => /^\d{4}-\d{2}-\d{2}$/u.test(name) && name <= day).sort().at(-1);
  const findings = {
    controller: { result: '两条主链和各岗位结果已纳入工作台。' },
    selection: selectionSummary
      ? { result: `已核 ${selectionSummary.total} 份交接，官方在售 ${selectionSummary.live} 款、草稿 ${selectionSummary.draft} 款、查无匹配 ${selectionSummary.noMatch} 款、待核 ${selectionSummary.unresolved} 款。`, at: handoff.observedAt }
      : recentCandidates?.checked > 0 && recentCandidates.liveConfirmed === 0
      ? { result: `上一批 ${recentCandidates.checked} 个已交接候选已做商品查重与资料复核，当前这批在售结果待核。`, at: recentCandidates.lastNativeCheckAt }
      : { result: '今日合格交接回执待核。' },
    listing: activeListing
      ? { result: `官方 API 已确认 ${activeListing.sellerSku} 在售，商品 ID ${activeListing.productId}。`, at: activeListing.observedAt }
      : verified?.verifiedNewListingsFromBatch > 0
      ? { result: `原岗位已回查 ${verified.verifiedNewListingsFromBatch} 款在售。`, at: verified.observedUTC }
      : draft?.state === '草稿' && !a28Draft ? { result: 'A28 投影灯保留在原草稿，已保存两张图，准确售价待核。', at: draft.at }
        : { result: '今日在售回执待核。' },
    production: { result: `${production?.available && production.result?.intakeAccepted > 0 ? '原成片和文案已通过发布器接收检查。' :
      productionLatest === day ? '今日有制作工作目录，合格交付回执待核。' :
      productionLatest ? `最近的制作记录日期为 ${productionLatest}，今日合格交付待核。` : '今日合格交付回执待核。'}${videoReview
      ? ` 已复核 ${videoReview.checked} 条现有成片，${videoReview.held} 条商品说法或画面待纠正，${videoReview.pending} 条候选待复核。` : ''}`,
      at: videoReview?.at },
    publishing: { result: `${publish.confirmed === null ? '今日成功数待核。' : `本机账本确认 ${publish.confirmed} 条${Number.isSafeInteger(publishingTarget) ? `，目标 ${publishingTarget} 条` : ''}。`}${
      publish.entryChecked ? ` ${publish.entryCheckTime} 有原岗位入口复核记录。` : ''}${
      shadow?.live_enabled === false ? ' 新脚本处于影子运行阶段。' : ''}${
      creatorGrantPending ? ' 官方预检已核原商品在售，发布账号的挂车授权待接入。' : ''}${
      Number.isSafeInteger(shopVideos?.summary?.linkedHistoricalVideoIds)
        ? ` 官方分析数据截至 ${shopVideos.query.latestAvailableDate}，已关联 ${shopVideos.summary.linkedHistoricalVideoIds} 条历史视频 ID。` : ''
    }${Number.isSafeInteger(shopVideos?.summary?.productPerformanceConfirmed)
      ? ` 其中 ${shopVideos.summary.productPerformanceConfirmed} 条另由视频商品分析接口读到同一商品。${
        Number.isSafeInteger(shopVideos.summary.productPerformanceWithClicks) && shopVideos.summary.productPerformanceWithClicks > 0
          ? ` ${shopVideos.summary.productPerformanceWithClicks} 条有目标商品点击记录。` : ''}` : ''
    }${Number.isSafeInteger(todayVideoTraffic?.productClicks) && Number.isSafeInteger(todayVideoTraffic.attributedSkuOrders)
      ? ` 当日视频带来的商品点击 ${todayVideoTraffic.productClicks} 次，视频归因 SKU 订单 ${todayVideoTraffic.attributedSkuOrders} 笔。` : ''
    }`, at: [publish.latest, apiPreflight?.observed_at, shopVideos?.observedAt, todayVideoTraffic && videoOverview.observedAt]
      .filter(value => Number.isFinite(Date.parse(value))).sort().at(-1) },
    promotion: ['active_configuration_verified', 'expired_configuration_verified'].includes(latestPilot?.state) && ['MYR', 'RM'].includes(pilotPrice?.currency)
      ? { result: `试点 ${latestPilot.sellerSku} 的固定价 RM${pilotPrice.amount}${latestPilot.state === 'active_configuration_verified' ? ' 已生效' : ' 已到期'}。${pilotQuantity ? pilotQuantity + '。' : ''}${
        Number.isSafeInteger(pilotMatches) ? `已查当前活动窗口，匹配 ${pilotMatches} 条订单明细。` : ''}${
        pilotMatches === 0 && latestPilot.state === 'active_configuration_verified' ? '首单结账及结算待出单。' : ''}${
        pilotMatches > 0 && Number.isSafeInteger(latestPilot.checkoutOrders) ? `已核 ${latestPilot.checkoutOrders} 笔结账、${latestPilot.statementReferences} 笔账单明细。` : ''}${
        Number.isSafeInteger(latestPilot.paidStatementOrders) ? `账单标记已付款 ${latestPilot.paidStatementOrders} 笔。` : ''}${
        sync.pilotError ? ` ${sync.pilotError}` : ''}`, at: latestPilot.observedAt }
      : promotion?.state === 'verified'
      ? { result: `进行中的商家折扣或秒杀覆盖 ${promotion.coveredProducts} 款，其中 ${promotion.partialProducts} 款仅覆盖部分 SKU。${promotion.uncoveredProducts} 款未匹配。`, at: promotion.checkedAt }
      : { result: sync.promotionError ?? '商家折扣与秒杀关系待核。', at: promotion?.checkedAt },
    fulfillment: { result: `${liveFulfillment ? '' : metrics ? `近 7 天订单中 ${metrics.awaitingShipment} 笔待发货，${metrics.awaitingCollection} 笔待揽收。` : '最新待发货数量待核。'}${
      !packageFollowup && Number.isSafeInteger(packageCount)
        ? `官方包裹接口读到近 7 天创建且待揽收的包裹 ${packageCount} 件。` : ''}${
      collection && !packageFollowup ? `逐件核验运单 ${collection.packagesWithTrackingNumber} 件、承运轨迹 ${collection.exactTrackingReadbacks} 件，揽收成功扫描 ${collection.packagesWithPickupSuccess} 件。超出揽收期限待查 ${collection.needsCarrierCheck} 件。` : ''}${
      fulfillmentRouting ? ` 历史 ${fulfillmentRouting.summary.historicalRouteCases} 笔订单已核平台分仓${
        Number.isSafeInteger(fulfillmentRouting.summary.exactWmsOutbound)
          ? `，其中 ${fulfillmentRouting.summary.exactWmsOutbound} 笔有准确仓库出库回执` : ''}。${
        fulfillmentRouting.summary.buyerCollectionPointOrders > 0
          ? ` 平台自提点订单 ${fulfillmentRouting.summary.buyerCollectionPointOrders} 笔，${fulfillmentRouting.summary.buyerCollectionPointAwaitingCollection} 笔沿用原包裹待揽收。` : ''}${
        fulfillmentRouting.refreshError ? '本轮分仓刷新失败，显示上次已核回执。' : ''}` : ''}${
      packageFollowup ? ` 原 ${packageFollowup.priorAwaitingCollection} 笔待揽收订单已逐件回查，仍待揽收 ${packageFollowup.stillAwaitingCollection} 笔，已进入运输或后续阶段 ${packageFollowup.movedToTransitOrLater} 笔。已核 ${packageFollowup.knownCollectionDeadlines} 个揽收期限，其中逾期 ${packageFollowup.passedCollectionDeadline} 笔。${Number.isSafeInteger(packageFollowup.trackingReads) ? ` 原运单轨迹 ${packageFollowup.trackingReads} 笔，确认揽收扫描 ${packageFollowup.pickupScansVerified} 笔。` : ''}${packageFollowup.unverified ? ` 待核 ${packageFollowup.unverified} 笔。` : ''}` : ''}${fulfillmentRouting?.packageRefreshError ? ' 本轮原包裹刷新失败。' : ''}`,
      at: packageFollowup?.observedAt ?? fulfillmentRouting?.observedAt ?? (Number.isSafeInteger(packageCount) ? currentSupport.observedAt : metrics?.collectedAt) },
    analysis: settlement?.currency === 'MYR'
      ? { result: `近 7 天复盘 ${settlement.orderCount} 笔。${paymentText}平台预估 ${settlement.estimatedOrders} 笔 RM${settlement.estimatedNet}。${
        paidWindow?.agedOut.count > 0 ? ` 与前一订单窗口逐笔对齐，${paidWindow.agedOut.count} 笔已付款订单（RM${paidWindow.agedOut.net}）移出七日范围。${paidWindow.overlap.changes === 0 ? '重叠范围的已付款订单和金额一致。' : ''}` : ''}${
        settlement.estimateTransition?.count > 0 ? ` ${settlement.estimateTransition.count} 笔由预估转入账单，净结算 RM${settlement.estimateTransition.actualNet}，与原预估合计差 RM${settlement.estimateTransition.totalVariance}。` : ''}${
        settlement.estimateRevision?.changed > 0 ? ` ${settlement.estimateRevision.changed} 笔原交易仍未结算，平台预估较上次合计变动 RM${settlement.estimateRevision.netChange}。` : ''}${
        costCase?.offer.price?.currency === 'MYR' ? ` ${costCase.name} 活动价 RM${Number(costCase.offer.price.amount).toFixed(2)}，已核 ${costCase.summary.deliveredOrders} 笔净结算 RM${costCase.summary.deliveredNetMyr}，实际成本待核。${
          exactCostBreakdown ? ` 平台费用和净运费分别为 RM${costComponents.fees}、RM${costComponents.shipping}。` : ''}${
          costCase.warehouse?.verifiedSystem === 'zhanma' ? ` 战马马来仓回读 ${costCase.warehouse.exactOutbound} 件原包裹已出库，实际扣费待账单。` : ''}` : ''
      }${productFinance ? ` 商品与财务对齐 ${productFinance.window.days} 个完整自然日，准确订单 ${productFinance.summary.exactPlatformOrders} 笔，${productFinance.summary.orderCountDisagreementProducts} 款商品有订单口径差异。` : ''}${
        sampleFollowup ? ` 商品 ${sampleFollowup.productId} 的 ${sampleFollowup.orderTypes.orders} 笔订单中，免费样品 ${sampleFollowup.orderTypes.sampleOrders} 笔，样品平台净结算 ${sampleNet < 0 ? '−' : ''}RM${Math.abs(sampleNet).toFixed(2)}。${
          sampleFollowup.sampleDelivery?.applicationStatus === 'CONTENT_PENDING' ? ' 样品申请显示待交内容。' : ''}` : ''
      }${
        paidTransition ? ` 原账单 ${paidTransition.statementId} 的 ${paidTransition.orderCount} 笔 RM${paidTransition.orderNet} 已获平台付款号，银行到账待核。${
          statementCoverage ? ` 整张账单 ${statementCoverage.statementOrderCount} 笔订单净额 RM${statementCoverage.statementOrderNet}，含复盘窗口外 ${statementCoverage.outsideOrderCount} 笔 RM${statementCoverage.outsideOrderNet}。` : ''}` :
          unverifiedPayment ? ` 账单 ${unverifiedPayment.statement.id} 已结算，银行到账待核。` : ''}${channelText}`,
        at: [sampleFollowup?.sampleDelivery?.observedAt, sampleFollowup?.observedAt, productFinance?.observedAt,
          costCase?.warehouse?.observedAt, costCase?.observedAt, paidTransition?.wallet?.observedAt, paidTransition?.observedAt,
          statementCoverage?.observedAt, settlement.observedAt, shopChannel?.observedAt, shopChannelOrders?.observedAt,
          ...settlement.paymentChecks?.map(row => row.observedAt) ?? []]
          .filter(at => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] }
      : { result: `${metrics ? `官方 API 已汇总近 7 天 ${metrics.orders7d} 笔订单${finance?.settledLines != null ? `，财务回查覆盖 ${finance.settledLines} 条结算明细` : ''}。` : '店铺数据待核。'}${channelText}`,
        at: shopChannelOrders?.observedAt ?? shopChannel?.observedAt ?? metrics?.collectedAt },
    ads: adTotals ? { result: `GMV Max 近 7 个完整日花费 ${currentAds.account.currency} ${adTotals.cost}，${
      typeof adTotals.net_cost === 'string' && /^\d+(?:\.\d{1,2})?$/u.test(adTotals.net_cost)
        ? `报表净花费 ${currentAds.account.currency} ${adTotals.net_cost}，` : ''}${adTotals.orders} 笔归因 SKU 单，ROI ${adTotals.roi}。${
      adsToday ? ` 当日截至报表读取花费 ${currentAds.account.currency} ${adsToday.cost}${typeof adsToday.net_cost === 'string' ? `，净花费 ${currentAds.account.currency} ${adsToday.net_cost}` : ''}，归因 SKU 单 ${adsToday.orders} 笔。` : ''}${
      reviewedAds?.rows.length ? ` 已核 ${reviewedAds.rows.length} 个计划商品的逐日数据或素材报表。` : ''}${
      reviewedAds?.rows.filter(row => row.sameWindow?.daily?.length).map(row =>
        ` 商品 ${row.productId} 的 ${row.sameWindow.daily.length} 日对照显示，GMV Max 归因 ${row.sameWindow.ads.skuOrders} 笔 SKU 单，店铺 ${row.sameWindow.shop.exactOrders} 笔订单、${row.sameWindow.shop.orderSkuPairs} 个订单与 SKU 组合${
          Number.isSafeInteger(row.sameWindow.shop.exactLineItems) ? `、${row.sameWindow.shop.exactLineItems} 条订单明细` : ''}。${
          row.sameWindow.shop.platformPaidNetMyr ? ` 同期店铺已核平台付款 ${row.sameWindow.shop.platformPaidSkuRows} 条 SKU，净结算 RM${row.sameWindow.shop.platformPaidNetMyr}。` : ''}`).join('') ?? ''}${
      affiliateCreative?.matchedOrders > 0 ? ` ${affiliateCreative.matchedOrders} 笔已结算联盟订单的来源视频匹配 ${affiliateCreative.distinctMatchedVideos} 条计划素材，结算佣金 RM${affiliateCreative.matchedCommissionMyr}。` : ''}${
      reviewedAds?.reportContract?.orderIdDimensionAvailable === false ? ' 当前 GMV Max 报表没有订单 ID，逐单归因待证。' : ''}`,
      at: currentAds.observedAt } : { result: '今日投流结果待核。' },
    service: conversations ? { result: `官方接口读取客服${conversations.coverage === 'all_cursor_pages'
      ? ` ${conversations.pages} 页共` : '首屏'} ${conversations.count} 个会话${Number.isSafeInteger(conversations.unreadConversations)
      ? `，其中 ${conversations.unreadConversations} 个有未读消息` : ''}。${
      Number.isSafeInteger(customerCases?.unreadWithVerifiedOrder)
        ? ` 已核 ${customerCases.unreadChecked} 个未读会话的近期消息，${customerCases.unreadWithVerifiedOrder} 个关联到真实订单。` : ''
    }${
      returnWindow ? `近 7 天更新的售后 ${returnWindow.records} 笔，匹配到准确订单及 SKU ${returnWindow.exactOrderAndSkuMatches} 笔，待卖家审核 ${returnWindow.pendingSellerReview} 笔。` : ''
    }${Number.isSafeInteger(supportTriage?.pendingCancellationOrders)
      ? ` 已关联的会话订单中，${supportTriage.ordersWithCancellationRecords} 笔有取消申请记录，${supportTriage.pendingCancellationOrders} 笔待处理。${
        supportTriage.cancellationOrdersNeedingStatusReview > 0 ? ` ${supportTriage.cancellationOrdersNeedingStatusReview} 笔需核取消终态。` : ''}` : ''
    }${supportTriage?.conversationsReviewed > 0 ? ` 已用原快照回放 ${supportTriage.conversationsReviewed} 个会话的分流。` : ''}${
      completedRefund ? ` ${completedRefund.variation ?? completedRefund.skuId} 已退款 RM${Number(completedRefund.buyerRefund).toFixed(2)}，该单净结算 ${refundNet < 0 ? '−' : ''}RM${Math.abs(refundNet).toFixed(2)}。${
        warehouseFee ? ` ${refundOutbound.wmsWarehouseName}另扣出库费 ¥${Number(warehouseFee).toFixed(2)}。` : ''
      }${refundReturn?.hasTrackingNumber && refundReturn.providerName ? ` ${refundReturn.providerName} 退件运单已生成。` : ''}${
        completedRefund.warehouseReturn?.signedAt ? ` 神牛仓库签收时间 ${completedRefund.warehouseReturn.signedAt}。` :
          completedRefund.warehouseReturn?.complete && completedRefund.warehouseReturn.matched === 0 ? ' 神牛查询窗口内未匹配原退货单，退仓签收待核。' :
            refundReturn?.warehouseReceiptVerified === false ? ' 退仓签收待核。' : ''
      }${completedRefund.eventRecords?.platformReviewTimeoutAt ? ' 平台另记有超时未复核。' : ''}${
        returnMediaCounts ? ` 买家附件 ${returnMediaCounts}。` : ''
      }${completedRefund.buyerEvidenceReview ? ` ${completedRefund.buyerEvidenceReview.observedSymptom}` : ''}${
        completedRefund.physicalCauseVerified ? '' : ' 故障原因待实物核实。'}` : ''
    }`, at: [completedRefund?.warehouseReturn?.observedAt, completedRefund?.buyerEvidenceReview?.observedAt, completedRefund?.eventRecords?.observedAt, completedRefund?.statusReadback?.observedAt,
      completedRefund?.logistics?.observedAt, completedRefund?.observedAt, currentSupport.observedAt]
      .filter(at => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] }
      : { result: '今日真实客服会话结果待核。' },
  };
  if (openAfterSales) {
    const pending = openAfterSales.openAfterSales.lists.find(list => list.key === 'pending_return_or_refund').count;
    const arbitration = openAfterSales.openAfterSales.lists.find(list => list.key === 'in_arbitration').count;
    findings.service.result += ` 官方按当前状态另外查询到待审退货退款 ${pending} 笔、仲裁中 ${arbitration} 笔。`;
    if (Date.parse(openAfterSales.observedAt) > (Date.parse(findings.service.at) || 0)) findings.service.at = openAfterSales.observedAt;
  }
  const adsRead = currentDaily?.ads?.officialRead;
  const productCard = aircraftDecisions?.productCard;
  if (productCard) {
    const { start, end } = aircraftDecisions.window;
    const videos = productCard.videoComparison;
    findings.analysis.result += ` 飞机计划 ${start} 至 ${end} 的商品卡归因 ${productCard.skuOrders} 个 SKU 订单，花费 ${aircraftDecisions.currency} ${productCard.spend}，ROI ${productCard.reportedRoi ?? '待核'}。${
      videos ? `同窗视频素材归因 ${videos.skuOrders} 个 SKU 订单，按显示金额复算 ROI ${videos.roiFromDisplayedAmounts ?? '待核'}。` : ''}`;
  }
  if (aircraftDecisions?.video?.deliveryStatus === 'EXCLUDED') {
    findings.analysis.result += ` 原观察视频 ${aircraftDecisions.video.itemId} 已读到投放排除状态，排除时间和前后各 7 天店铺订单变化待核。`;
  }
  if ((productCard || aircraftDecisions?.video?.deliveryStatus === 'EXCLUDED') &&
      Date.parse(aircraftDecisions.observedAt) > (Date.parse(findings.analysis.at) || 0)) findings.analysis.at = aircraftDecisions.observedAt;
  if (currentAds && (adsRead?.result?.refreshError || adsRead?.error)) {
    findings.ads.result += ` ${adsRead.result?.refreshError ?? 'GMV Max 本轮读取未完成'}，以上沿用上次成功回执。`;
  }
  const growth = currentDaily?.growth?.result;
  if (growth?.creativeReviews?.length) {
    const best = growth.creativeReviews[0];
    findings.ads.result += ` 已生成 ${growth.creativeReviews.length} 条待制作复看的素材候选。${best.sellerSku ?? best.skuId} 原视频 ${best.id} 在同窗有 ${best.ads.skuOrders} 笔 GMV Max 归因 SKU 单和 ${best.productEngagement.clicks} 次商品点击。`;
  }
  if (growth?.checkoutReviews?.length) {
    const best = growth.checkoutReviews[0];
    findings.analysis.result += ` 有 ${growth.checkoutReviews.length} 款商品达到成交排查条件。商品 ${best.productId} 有 ${best.clicks} 次点击，商品分析和店铺订单明细均为 0 单。`;
  }
  const serviceRead = currentDaily?.service?.officialRead;
  if (conversations && (serviceRead?.result?.refreshError || serviceRead?.error)) {
    findings.service.result += ` ${serviceRead.result?.refreshError ?? '客服全量读取未完成'}，会话数沿用上次成功回执。`;
  }
  if (candidateNotes.length) {
    findings.listing.result += ' ' + candidateNotes.join(' ');
    findings.listing.at = listingCandidates.observedAt;
  }
  const liveCandidates = listingCandidates?.rows.flatMap(row =>
    row.official?.matches === 1 ? row.official.products.filter(item => item.state === 'ACTIVATE' &&
      item.audit === 'APPROVED' && isPlatformId(item.productId) && isPlatformId(item.skuId))
      .map(item => ({ ...item, sellerSku: row.sku })) : []) ?? [];
  if (liveCandidates.length) {
    findings.listing.result += ' ' + liveCandidates.map(item =>
      `${item.sellerSku} 已审核通过并在售，商品 ID ${item.productId}。`).join(' ');
    findings.listing.at = listingCandidates.observedAt;
  }
  const opportunities = currentDaily?.selection?.opportunities?.result;
  if (opportunities?.state === 'research_leads') {
    findings.selection.result += ` 官方 ${opportunities.categories.length} 个子类目另读到 ${opportunities.products} 条商品线索、${opportunities.keywords} 条关键词线索，进入选品筛查。`;
    findings.selection.at = opportunities.observedAt;
  }
  const selectionHandoffs = currentDaily?.selection?.dailyHandoffs?.result;
  if (selectionHandoffs?.rows?.length) {
    const intakeNotes = await Promise.all(selectionHandoffs.rows.map(async row => {
      const delivered = `${row.sku} 已交原上架岗${row.official?.matches === 0 ? '，官方查无同 SKU' : ''}。`;
      if (row.status !== 'delivered_to_listing' || row.official?.matches !== 0 || typeof row.dispatchSource !== 'string') return { delivered };
      const folder = basename(dirname(row.dispatchSource));
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(folder)) return { delivered };
      const intake = await readJson(join(productRoot, day, folder, 'actual-official-intake-and-MY-eligibility.json'));
      const { outcome, recordedAt, shop } = intake ?? {};
      if (intake?.schema !== 'product-role-single-sku-listing-intake/v1' || intake.handoffId !== row.handoffId ||
          intake.sellerSku !== row.sku || shop?.id !== shopId || shop.name !== 'example-shop-my' || shop.region !== 'MY' ||
          !Number.isFinite(Date.parse(recordedAt)) || dayKey(new Date(recordedAt)) !== day ||
          outcome?.stage !== 'HELD_BEFORE_CREATE' || outcome.verifiedLive !== false || outcome.shopWrites !== 0 ||
          outcome.productId !== null || intake.currentPlatformBasis?.exactItemEligibility !== 'NO_CONFIRMED_MY_PERMISSION' ||
          !intake.category?.categoryLookupRequestId || typeof intake.currentPlatformBasis.malaysiaGuidelineDecision !== 'string') {
        return { delivered };
      }
      return { delivered: `${row.sku} 已交上架岗，准入核验后停在建品前。`, recordedAt,
        listing: `${row.sku} 停在建品前。${intake.currentPlatformBasis.malaysiaGuidelineDecision}` };
    }));
    findings.selection.result += ' ' + intakeNotes.map(note => note.delivered).join(' ');
    findings.selection.at = selectionHandoffs.observedAt;
    for (const { listing, recordedAt } of intakeNotes) {
      if (!listing) continue;
      findings.listing.result += ' ' + listing;
      for (const role of [findings.listing, findings.selection]) {
        if (Date.parse(recordedAt) > (Date.parse(role.at) || 0)) role.at = recordedAt;
      }
    }
  }
  if (packageWms?.checkedOrders > 0) {
    findings.fulfillment.result += ` 原 ${packageWms.checkedOrders} 笔马来海外仓订单已查两仓出库记录，${packageWms.completedWarehouses}/2 仓返回完整结果。${
      packageWms.completedWarehouses > 0 ? ` 返回结果匹配 ${packageWms.exactMatchedPackages} 件包裹，确认出库 ${packageWms.outboundPackages} 件${
        Number.isSafeInteger(packageWms.waitingWarehousePackages) ? `，仓库待处理 ${packageWms.waitingWarehousePackages} 件` : ''}${
        Number.isSafeInteger(packageWms.pickingWarehousePackages) ? `，拣货 ${packageWms.pickingWarehousePackages} 件` : ''}${
        Number.isSafeInteger(packageWms.packedWarehousePackages) ? `，已打包 ${packageWms.packedWarehousePackages} 件` : ''}，发现重复处理 ${packageWms.conflictedPackages} 件。` : ''}`;
  }
  const domesticCollection = packageFollowup?.domesticCollection;
  if (fulfillmentComparison?.schema === 'operations-fulfillment-shadow-comparison/v1' &&
      fulfillmentComparison.shop?.id === shopId && fulfillmentComparison.shop.region === 'MY' &&
      fulfillmentComparison.shop.name === 'example-shop-my' && fulfillmentComparison.writes === 0 &&
      Number.isFinite(Date.parse(fulfillmentComparison.observedAt)) && dayKey(new Date(fulfillmentComparison.observedAt)) === day &&
      Array.isArray(fulfillmentComparison.rows) && fulfillmentComparison.rows.length > 0 &&
      fulfillmentComparison.rows.length === fulfillmentComparison.orderCount &&
      fulfillmentComparison.matched === fulfillmentComparison.rows.filter(row => row.state === 'matched').length) {
    findings.fulfillment.result += ` 发货前方案与之后实际仓库及平台回执逐单对照，${fulfillmentComparison.matched}/${fulfillmentComparison.orderCount} 笔一致。实付运费及操作者未纳入本轮验收。`;
    if (Date.parse(fulfillmentComparison.observedAt) > (Date.parse(findings.fulfillment.at) || 0)) {
      findings.fulfillment.at = fulfillmentComparison.observedAt;
    }
  }
  const collectionTransition = packageFollowup?.collectionTransition;
  if (collectionTransition?.checked > 0) {
    findings.fulfillment.result += collectionTransition.error ? ' 前一批待揽收名单有变化，原包裹回查未完成。' :
      ` 前一批名单移出的 ${collectionTransition.checked} 笔已回查原包裹，${collectionTransition.advanced} 笔进入运输或后续阶段，其中 ${collectionTransition.withPickup} 笔有揽收成功扫描。`;
  }
  if (domesticCollection?.checked > 0) {
    findings.fulfillment.result += ` 中国直发待揽收原包裹查好货来 ${domesticCollection.checked} 件，仓库待打包 ${domesticCollection.waitingPack} 件、已打包 ${domesticCollection.packed} 件，核到售后卡 ${domesticCollection.withCard} 件${domesticCollection.platformOnly ? `，仅在仓库待提交队列见平台原包裹 ${domesticCollection.platformOnly} 件` : ''}${domesticCollection.unverified ? `，其余待核 ${domesticCollection.unverified} 件` : ''}。`;
  }
  if (liveFulfillment) {
    const { pendingShipment, pendingShipmentByRoute, pendingUnresolved } = fulfillmentRouting.summary;
    findings.fulfillment.result += ` 本轮官方订单分页发现 ${pendingShipment} 笔待发货，分仓匹配海外仓 ${pendingShipmentByRoute.malaysia_overseas} 笔、中国直发 ${pendingShipmentByRoute.china_direct} 笔。${
      pendingUnresolved ? ` 待核订单 ${pendingUnresolved} 笔。` : ''}`;
  }
  if (shipmentWms?.expectedOrders > 0) {
    findings.fulfillment.result += ` ${shipmentWms.expectedOrders} 笔海外仓待发货订单中，已按原包裹核 ${shipmentWms.checkedOrders} 笔，${
      shipmentWms.completedWarehouses}/2 仓返回结果。${shipmentWms.completedWarehouses === 2
        ? ` ${shipmentWms.packagesWithoutExactWarehouseRecord} 件原包裹未匹配仓库出库单。` : ''}`;
  }
  if (packageFollowup?.shipmentDeadlines?.length) {
    const first = packageFollowup.shipmentDeadlines[0];
    const route = first.route === 'china_direct' ? '中国直发' : '马来海外仓';
    const deadline = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Kuala_Lumpur', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(first.readyToShipSlaAt * 1000);
    findings.fulfillment.result += ` 已核 ${packageFollowup.shipmentDeadlines.length} 笔待发货单的备货时限，最早为${route} ${deadline}（马来时间）。`;
  }
  if (packageFollowup?.shipmentWarehouseConflicts > 0) {
    findings.fulfillment.result += ` ${packageFollowup.shipmentWarehouseConflicts} 笔待发订单与包裹仓不一致，需核实际履约仓。`;
  }
  const domesticControl = fulfillmentRouting?.domesticFulfillmentControl;
  if (domesticControl?.packedInTransit > 0) {
    findings.fulfillment.result += ` ${domesticControl.packedInTransit} 笔历史中国直发原订单对上仓库打包及售后卡，平台运输中。原轨迹确认揽收扫描 ${domesticControl.pickupScansVerified} 笔。`;
    if (Date.parse(domesticControl.observedAt) > (Date.parse(findings.fulfillment.at) || 0)) findings.fulfillment.at = domesticControl.observedAt;
  }
  for (const row of fulfillmentRouting?.domesticShipmentReadbacks ?? []) {
    findings.fulfillment.result += ` 中国直发 ${row.variation} × ${row.quantity} 已在好货来查到待提交打包${
      row.assignedDomesticWarehouse === null && row.matchedWarehouseGoods === false ? '，原单尚未保存仓库及货品配对' : ''}。`;
    if (Date.parse(row.observedAt) > (Date.parse(findings.fulfillment.at) || 0)) findings.fulfillment.at = row.observedAt;
  }
  const warehouseLabels = { 148: '神牛马来仓', 80: '战马马来仓', 879: '好货来东莞仓', 892: '好货来义乌仓' };
  for (const row of fulfillmentRouting?.domesticPacking ?? []) {
    const label = fulfillmentRouting.domesticShipmentReadbacks?.find(item => item.orderId === row.orderId)?.variation ?? row.orderId;
    if (row.state === 'platform_after_sales_needs_review') {
      findings.fulfillment.result += ` ${label} 有平台取消或退货退款记录，备货待核。`;
    } else if (row.state === 'packing_inputs_verified' && row.submitted === false && warehouseLabels[row.warehouseId]) {
      findings.fulfillment.result += ` ${label} 已核${warehouseLabels[row.warehouseId]}货品和全部国家版售后卡，备货方案待提交。`;
      if (row.priorWarehouseEvidence) {
        const checkedAt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })
          .format(new Date(row.observedAt));
        findings.fulfillment.result += ` 仓库库存沿用 ${checkedAt} 的读取（马来时间）。`;
      }
      if (row.hasTrackingNumber === false) findings.fulfillment.result += ' 平台原包裹暂无运单号。';
      if (row.canDropOff === true) findings.fulfillment.result += ' 平台返回可投递。';
      if (row.labelAvailable === false) findings.fulfillment.result += ' 面单尚未读到。';
    } else continue;
    if (Date.parse(row.observedAt) > (Date.parse(findings.fulfillment.at) || 0)) findings.fulfillment.at = row.observedAt;
  }
  const shippingOnly = (packageFollowup?.domesticShippingDocuments ?? []).filter(row =>
    !fulfillmentRouting.domesticPacking?.some(plan => plan.orderId === row.orderId && plan.state === 'packing_inputs_verified'));
  if (shippingOnly.length) {
    const dropOff = shippingOnly.filter(row => row.canDropOff === true).length;
    const labels = shippingOnly.filter(row => row.labelAvailable === true).length;
    const missing = shippingOnly.filter(row => row.labelAvailable === false).length;
    findings.fulfillment.result += ` 中国直发待发货原包裹 ${shippingOnly.length} 件，平台确认可投递 ${dropOff} 件，已取得面单 ${labels} 件，面单尚未读到 ${missing} 件。`;
    const unknown = shippingOnly.length - labels - missing;
    if (unknown) findings.fulfillment.result += ` 另有 ${unknown} 件面单状态待核。`;
  }
  const stockGroups = new Map();
  for (const row of fulfillmentRouting?.shipmentStock ?? []) {
    const warehouse = row.warehouses.find(item => item.warehouseId === row.eligibleWarehouseCandidate);
    const key = [row.source, row.skuId, warehouse.warehouseId, warehouse.goodsSkuId].join(':');
    const group = stockGroups.get(key) ?? { label: row.label, warehouse, orders: 0, quantity: 0 };
    group.orders++;
    group.quantity += row.quantity;
    stockGroups.set(key, group);
    if (Date.parse(row.observedAt) > (Date.parse(findings.fulfillment.at) || 0)) findings.fulfillment.at = row.observedAt;
  }
  for (const { label, warehouse, orders, quantity } of stockGroups.values()) {
    findings.fulfillment.result += ` ${orders > 1 ? `${orders} 笔订单合计 ` : ''}${label} × ${quantity} 已按原订单 SKU 核到${warehouseLabels[warehouse.warehouseId] ?? warehouse.warehouseId}库存，可用 ${warehouse.available} 件${
      Number.isSafeInteger(warehouse.card?.available) ? `，售后卡可用 ${warehouse.card.available} 张` : ''}，待提交。`;
  }
  if (pricing?.models?.length && pricing.productId === activeListing?.productId && pricing.skuId === activeListing?.skuId) {
    const options = pricing.models.map(model => `${model.label} 挂牌 RM${model.regularPrice}、减 43% RM${model.firstStagePrice}、五折 RM${model.secondStagePrice}`).join('。');
    findings.listing.result += ` 泳池九件套核价待确认。${options}。`;
    const market = currentDaily?.marketComparison?.result;
    if (market?.combinedPrice && market.exactMarketBundlePrice === null) {
      findings.listing.result += ` 马来零售近规格五支棒加四环 RM${market.combinedPrice}（运费另计），两套挂牌测算的市场依据待核。`;
    }
  }
  if (repricing?.state === 'awaiting_price_approval' && repricing.productId === activeListing?.productId &&
      repricing.skuId === activeListing?.skuId && repricing.platformWrites === 0 && repricing.currentActivityBlocksRegularPrice) {
    findings.listing.result += ' 两版调价请求已做影子核对。进行中的固定价活动锁定挂牌价，需等活动结束并重新回查。';
    if (Date.parse(repricing.observedAt) > (Date.parse(findings.listing.at) || 0)) findings.listing.at = repricing.observedAt;
  }
  if (listingPlatformCheck?.state === 'PASS' && listingPlatformCheck.productId === activeListing?.productId &&
      listingPlatformCheck.skuId === activeListing?.skuId) {
    findings.listing.result += ' 官方上架验品已通过原提交版本复核。';
    if (Date.parse(listingPlatformCheck.observedAt) > (Date.parse(findings.listing.at) || 0)) findings.listing.at = listingPlatformCheck.observedAt;
  }
  if (a28Draft && Number.isSafeInteger(a28Draft.imageCount)) {
    findings.listing.result += ` A28 仍为原草稿，已保存 ${a28Draft.imageCount} 张图。${a28Draft.draftVersionRequested && a28Draft.requestId &&
      Number(a28Draft.price?.sale_price) === 0 && a28Draft.listedQuantity === 0 && a28Draft.descriptionPresent === false &&
      ['length', 'width', 'height'].every(axis => a28Draft.packageDimensions?.[axis] === '0')
      ? ' 平台草稿接口的售价、库存和外箱三边为 0，描述为空。' : ''}`;
    if (typeof originalDraft.originalGap === 'string' && originalDraft.originalGap.trim()) {
      findings.listing.result += ` ${originalDraft.originalGap}`;
    }
    if (Date.parse(handoff.observedAt) > (Date.parse(findings.listing.at) || 0)) findings.listing.at = handoff.observedAt;
  }
  if (pilotBuyerUrl) findings.listing.link = { title: '泳池九件套 TikTok 商品链接', url: pilotBuyerUrl };
  if (promotionDecisions) {
    const { at, candidateCount, existingPilotVerified, newBusinessWrites, rows } = promotionDecisions;
    const pendingCostOrFulfillment = rows.filter(row => row.decision.state === 'exact_fulfillment_or_cost_not_verified').length;
    findings.promotion.result += ` 促销岗本轮核对 ${candidateCount} 个规格，${existingPilotVerified} 个复核已有活动，业务写入 ${newBusinessWrites} 次。`;
    if (pendingCostOrFulfillment) findings.promotion.result += ` 其中 ${pendingCostOrFulfillment} 个规格待核成本或履约。`;
    if (Date.parse(at) > (Date.parse(findings.promotion.at) || 0)) findings.promotion.at = at;
  }
  if (checkoutControl && checkoutControl.skuId !== (activeListing?.skuId ?? trackedPilot?.skuId)) {
    findings.promotion.result += ` 同店历史订单已实跑结账和结算回查，买家实付 RM${checkoutControl.buyerPayment}，SKU 净结算 RM${checkoutControl.settlement}，账单标记已付款。`;
  }
  if (promotionCheckout) {
    const { observedAt, unlinked, settled } = promotionCheckout;
    if (unlinked.length) {
      const [example] = unlinked;
      findings.promotion.result += ` 同店另核 ${unlinked.length} 条订单明细有商家让利，其中一条买家商品额 RM${example.price}、商家让利 RM${example.discount}。这些让利的活动归属待平台明细确认。`;
    }
    if (settled.length) {
      const paid = settled.filter(row => row.paid).length;
      const example = settled.find(row => row.paid && row.singleLine) ?? settled.find(row => row.singleLine);
      findings.promotion.result += ` ${settled.length} 笔订单 SKU 已对齐净结算，${paid} 笔的账单付款已回读。`;
      if (example) findings.promotion.result += ` 其中一笔商品额 RM${example.price}、商家让利 RM${example.discount}、SKU 净结算 RM${example.settlement}。`;
    }
    if (Date.parse(observedAt) > (Date.parse(findings.promotion.at) || 0)) findings.promotion.at = observedAt;
  }
  const promotionCandidates = currentDaily?.promotion?.candidates?.result?.filter(row => row.state === 'pending_verification' &&
    row.trial?.currency === 'MYR' && Array.isArray(row.pending) && row.pending.length > 0) ?? [];
  if (promotionCandidates.length) {
    const salesHistory = currentDaily?.promotion?.salesHistory?.result ?? [];
    findings.promotion.result += ' ' + promotionCandidates.map(row => `${row.label ?? row.sellerSku}拟 RM${row.trial.price}、${row.trial.hours} 小时、限 ${row.trial.totalLimit} 件，待处理 ${row.pending.join('、')}。${
      row.salesQualification?.withinSixtyDays === true && row.salesQualification.productSalesToAnalyticsEnd === 0 &&
      row.salesQualification.exactSkuOrderLinesInRecentWindow === 0 ? '建品在 60 天内，销售分析与后续订单未见该款销量。' : ''}${
      row.routes?.merchantFixedPriceShadow?.validatedLocally === true && row.routes.requestedTool?.formReadbackVerified === false
        ? '商家固定价请求已做本地验收，新品折扣专用表单待实店复核。' : ''}`).join(' ');
    for (const candidate of promotionCandidates) {
      if (Date.parse(candidate.observedAt) > (Date.parse(findings.promotion.at) || 0)) findings.promotion.at = candidate.observedAt;
      const history = salesHistory.find(row => row.shop?.id === shopId && row.productId === candidate.productId && row.skuId === candidate.skuId);
      if (history && Number.isSafeInteger(history.shopOrders) && history.matchingProductOrders === 0 && history.matchingSkuOrders === 0) {
        findings.promotion.result += ` ${candidate.label ?? candidate.sellerSku}从建品起官方分页核 ${history.shopOrders} 笔店铺订单，该商品和规格均为 0 单。`;
        if (Date.parse(history.observedAt) > (Date.parse(findings.promotion.at) || 0)) findings.promotion.at = history.observedAt;
      }
    }
  }
  const promotionInventory = currentDaily?.promotion?.inventory?.result;
  if (promotionInventory?.shopId === shopId && promotionInventory.requestId) {
    const subjects = [...promotionCandidates, ...(activeListing ? [{ ...activeListing, label: '泳池九件套' }] : [])];
    const notes = subjects.flatMap(subject => {
      const row = promotionInventory.rows?.find(entry => entry.state === 'sku_verified' && entry.productId === subject.productId &&
        entry.skuId === subject.skuId && entry.sellerSku === subject.sellerSku);
      return Number.isSafeInteger(row?.platformAvailable) && row.platformAvailable >= 0
        ? [`${subject.label ?? subject.sellerSku}平台可售 ${row.platformAvailable} 件${Number.isSafeInteger(row.platformCommitted)
          ? `，订单占用 ${row.platformCommitted} 件` : ''}。`] : [];
    });
    if (notes.length) {
      findings.promotion.result += ' ' + notes.join(' ');
      if (Date.parse(promotionInventory.observedAt) > (Date.parse(findings.promotion.at) || 0)) {
        findings.promotion.at = promotionInventory.observedAt;
      }
    }
  }
  const promotionCoverage = currentDaily?.promotion?.toolCoverage?.result;
  if (promotionCoverage?.newArrival?.readState === 'activity_type_unsupported' && promotionCoverage.fixedPrice?.readState === 'verified') {
    findings.promotion.result += ' 同店固定价活动经官方 API 读通。已有新品折扣返回活动类型不支持，继续走 Seller Center。';
    if (Date.parse(promotionCoverage.observedAt) > (Date.parse(findings.promotion.at) || 0)) {
      findings.promotion.at = promotionCoverage.observedAt;
    }
  }
  const merchantChecks = currentDaily?.promotion?.merchantPreflight?.result ?? [];
  for (const row of merchantChecks) {
    const candidate = promotionCandidates.find(entry => entry.productId === row.productId && entry.skuId === row.skuId &&
      entry.sellerSku === row.product.sellerSku);
    const isPilot = row.productId === activeListing?.productId && row.skuId === activeListing?.skuId &&
      row.product.sellerSku === activeListing?.sellerSku;
    if (row.shop?.id !== shopId || row.shop.region !== 'MY' || !row.productRequestId || (!candidate && !isPilot)) continue;
    const checks = [row.activities?.ONGOING, row.activities?.NOT_START];
    const activities = checks.every(check => check?.complete && check.requestIds?.length &&
      check.result.every(item => typeof item.applies === 'boolean')) ? checks.flatMap(check => check.result) : null;
    const coupons = row.couponCheck?.complete && row.couponCheck.requestIds?.length &&
      row.couponCheck.result.every(item => typeof item.productIncluded === 'boolean') ? row.couponCheck.result : null;
    const label = candidate?.label ?? (isPilot ? '泳池九件套' : row.product.sellerSku);
    findings.promotion.result += ` ${label}官方商家预检${activities && coupons
      ? `匹配 ${activities.filter(item => item.applies).length} 项进行中或待开始活动、${coupons.filter(item => item.productIncluded).length} 张商品适用券`
      : '仍有活动或券范围待核'}。`;
    if (Date.parse(row.checkedAt) > (Date.parse(findings.promotion.at) || 0)) findings.promotion.at = row.checkedAt;
  }
  return [
    { id: 'sync', name: '店铺取数', schedule: sync.scheduled ? 'board' : null, source: 'TikTok Shop Open API',
      next: '更新商品、订单与每日记录。', result: sync.running ? '正在读取店铺数据。' : sync.error ||
        (metrics ? `最近已读到 ${metrics.activeProducts} 款在售商品。` : '等待首次读取。'), at: metrics?.collectedAt },
    ...roles.map(([id, name, , source, next], index) => ({ id, name, schedule: roleSchedules[index], source, next,
      ...findings[id], run: runs[id] ?? null })),
  ];
}
