import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { reportDay } from './read-gmv-max.mjs';

function moneyCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(value)) throw new Error('Invalid GMV Max monetary metric');
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error('GMV Max monetary metric is outside range');
  return cents;
}

export function summarizeAdsMetrics(rows) {
  let spend = 0, gross = 0, orders = 0;
  for (const { metrics } of rows) {
    if (typeof metrics?.orders !== 'string' || !/^\d+$/u.test(metrics.orders) || !Number.isSafeInteger(Number(metrics.orders))) {
      throw new Error('Invalid GMV Max SKU order count');
    }
    spend += moneyCents(metrics.cost);
    gross += moneyCents(metrics.gross_revenue);
    orders += Number(metrics.orders);
  }
  return { spend: (spend / 100).toFixed(2), grossRevenue: (gross / 100).toFixed(2), skuOrders: orders,
    roiFromDisplayedAmounts: spend > 0 ? Number((gross / spend).toFixed(2)) : null };
}

function sameShop(evidence, shop) {
  return evidence?.shop?.id === shop.id && evidence?.shop?.region === shop.region && evidence?.shop?.name === shop.name;
}

function creativeReportForProduct(ads, { campaignId, productId }) {
  const campaigns = ads.campaignDetails?.filter(row => row.id === campaignId);
  if (campaigns?.length !== 1 || campaigns[0].status !== 'ENABLE' || campaigns[0].type !== 'PRODUCT' ||
      !campaigns[0].productIds?.includes(productId)) return null;
  const reports = ads.completeDays?.productReports?.filter(row => row.campaignId === campaignId);
  if (reports?.length !== 1) return null;
  const creatives = reports[0].creatives?.filter(row => row.productId === productId);
  return creatives?.length === 1 ? creatives[0].result ?? null : null;
}

export function reviewAffiliateCreativeMatches(receipt, ads, finance) {
  const { shop, completeDays } = ads;
  if (receipt?.schema !== 'operations-gmv-max-affiliate-content-join/v1' || !sameShop(receipt, shop) ||
      receipt.shop.advertiserId !== shop.advertiserId || receipt.platformWrites !== 0 ||
      receipt.exactGmvMaxOrderAttribution !== null || ads.reportContract?.orderIdDimensionAvailable !== false ||
      finance?.schema !== 'exact-sku-fee-reconciliation/v1' || !sameShop(finance, shop) || finance.affiliate?.complete !== true ||
      receipt.affiliateRows !== finance.affiliate.reportedSkuCount || !receipt.affiliateRequests?.length ||
      finance.productId !== receipt.productId || finance.skuId !== receipt.skuId ||
      receipt.affiliateWindow?.startInclusive !== finance.orderWindow?.startInclusive ||
      receipt.affiliateWindow?.endExclusive !== finance.orderWindow?.endExclusive ||
      receipt.adsWindow?.start !== completeDays.start || receipt.adsWindow?.end !== completeDays.end ||
      !Array.isArray(receipt.rows) || !receipt.rows.length || receipt.rows.length !== receipt.matchedOrders) return null;
  const report = creativeReportForProduct(ads, receipt);
  if (!report?.requestIds?.length || JSON.stringify(receipt.adsRequests) !== JSON.stringify(report.requestIds)) return null;
  const byVideo = new Map(report.rows.filter(row => row.metrics.shop_content_type === 'VIDEO')
    .map(row => [row.dimensions.item_id, row.metrics]));
  const byOrder = new Map(finance.rows.map(row => [row.orderId, row]));
  if (byOrder.size !== finance.rows.length || new Set(receipt.rows.map(row => row.orderId)).size !== receipt.rows.length) return null;
  const matchedVideos = new Set();
  let matchedOrders = 0;
  let commissionCents = 0;
  for (const row of receipt.rows) {
    const order = byOrder.get(row.orderId);
    const commission = order?.affiliate?.actualShopAdsCommission;
    const inside = /^\d{4}-\d{2}-\d{2}$/u.test(row.creationDay ?? '') && row.creationDay >= completeDays.start && row.creationDay <= completeDays.end;
    const metrics = inside ? byVideo.get(row.videoId) : null;
    if (!isPlatformId(row.videoId) || !isPlatformId(row.orderId) || row.skuId !== receipt.skuId ||
        !isPlatformId(row.statementId) || row.statementId !== order?.statementId || order.orderStatus !== 'DELIVERED' ||
        order.affiliate?.status !== 'SETTLED' || order.affiliate.contentType !== 'VIDEO' ||
        commission?.currency !== 'MYR' || commission.amount !== row.commissionMyr ||
        !/^\d+\.\d{2}$/u.test(row.commissionMyr) || Number(row.commissionMyr) <= 0 ||
        Number(row.commissionMyr) !== -Number(order.feeBreakdown?.affiliate_ads_commission_amount) ||
        row.insideAdsWindow !== inside || row.matchedCreative !== Boolean(metrics)) return null;
    if (!metrics) continue;
    if (row.creativeReport?.costUsd !== metrics.cost || row.creativeReport?.roi !== metrics.roi ||
        row.creativeReport?.orders !== metrics.orders || row.creativeReport?.grossRevenueUsd !== metrics.gross_revenue) return null;
    matchedOrders++;
    matchedVideos.add(row.videoId);
    commissionCents += moneyCents(row.commissionMyr);
  }
  if (matchedOrders !== receipt.matchedCreativeOrders) return null;
  return { observedAt: receipt.observedAt, productId: receipt.productId, skuId: receipt.skuId,
    matchedOrders, distinctMatchedVideos: matchedVideos.size, matchedCommissionMyr: (commissionCents / 100).toFixed(2),
    exactGmvMaxOrderAttribution: null };
}

export function refreshAffiliateCreativeMatches(receipt, originalAds, currentAds, finance) {
  if (!reviewAffiliateCreativeMatches(receipt, originalAds, finance) || currentAds.schema !== 'operations-gmv-max-read/v1' ||
      !sameShop(receipt, currentAds.shop) || receipt.shop.advertiserId !== currentAds.shop.advertiserId ||
      receipt.adsWindow.start !== currentAds.completeDays?.start || receipt.adsWindow.end !== currentAds.completeDays?.end) return null;
  const report = creativeReportForProduct(currentAds, receipt);
  if (!report?.requestIds?.length || !Array.isArray(report.rows)) return null;
  const videos = report.rows.filter(row => row.metrics?.shop_content_type === 'VIDEO');
  const byVideo = new Map(videos.map(row => [row.dimensions?.item_id, row.metrics]));
  if (byVideo.size !== videos.length) return null;
  const rows = receipt.rows.map(row => {
    const metrics = row.insideAdsWindow ? byVideo.get(row.videoId) : null;
    return { ...row, matchedCreative: Boolean(metrics), creativeReport: metrics ? { costUsd: metrics.cost, roi: metrics.roi,
      orders: metrics.orders, grossRevenueUsd: metrics.gross_revenue } : null };
  });
  const refreshed = reviewAffiliateCreativeMatches({ ...receipt, rows, adsRequests: report.requestIds,
    matchedCreativeOrders: rows.filter(row => row.matchedCreative).length }, currentAds, finance);
  return refreshed ? { ...refreshed, creativeObservedAt: currentAds.observedAt, creativeRequestIds: report.requestIds } : null;
}

function shopSettlement(row) {
  const paid = row.paidSkuRows ?? 0;
  const direct = row.directSettlementSkuRows ?? 0;
  const amounts = [paid > 0 ? row.paidNetMyr : null, direct > 0 ? row.directSettlementNetMyr : null];
  const count = paid + direct;
  if (!Number.isSafeInteger(paid) || paid < 0 || !Number.isSafeInteger(direct) || direct < 0 ||
      amounts.filter(value => typeof value === 'string' && /^-?\d+\.\d{2}$/u.test(value)).length !== Number(paid > 0) + Number(direct > 0)) {
    throw new Error('Invalid shop settlement totals in the GMV Max window');
  }
  const net = amounts.reduce((total, value) => total + Math.round(Number(value) * 100), 0);
  return { settledSkuRows: count, settledNetMyr: count > 0 ? (net / 100).toFixed(2) : null,
    platformPaidSkuRows: paid, platformPaidNetMyr: paid > 0 ? row.paidNetMyr : null,
    paymentUnverifiedSkuRows: row.directSettlementPaymentUnverified ?? null };
}

function summarizeCreatives(result, productId, videos) {
  const ids = new Set();
  const content = new Map();
  const matches = [];
  for (const row of result.rows) {
    const id = row.dimensions.item_id;
    const type = row.metrics.shop_content_type;
    if (ids.has(id) || (type === 'VIDEO' && !isPlatformId(id))) throw new Error('Duplicate or invalid creative ID');
    ids.add(id);
    const group = content.get(type) ?? [];
    group.push(row);
    content.set(type, group);
    const video = type === 'VIDEO' && videos.get(id);
    if (!video || video.productId !== productId) continue;
    const reportedAccount = row.metrics.tt_account_name;
    if (reportedAccount && !['0', '-'].includes(reportedAccount) && reportedAccount.replace(/^@/u, '') !== video.account) continue;
    matches.push({ platformVideoId: id, account: video.account, jobId: video.jobId, productId,
      successSource: video.originalSuccess.source, deliveryStatus: row.metrics.creative_delivery_status ?? null,
      reportedRoi: row.metrics.roi ?? null, ...summarizeAdsMetrics([row]) });
  }
  const byContent = Object.fromEntries([...content].map(([type, rows]) => [type, { rows: rows.length, ...summarizeAdsMetrics(rows) }]));
  const metrics = summarizeAdsMetrics(result.rows);
  const officialTotal = result.totals ? { ...summarizeAdsMetrics([{ metrics: result.totals }]), reportedRoi: result.totals.roi ?? null } : null;
  return { rows: result.rows.length, byContent, metrics, officialTotal,
    grossTotalDifference: officialTotal ? (Number(officialTotal.grossRevenue) - Number(metrics.grossRevenue)).toFixed(2) : null,
    spendTotalDifference: officialTotal ? (Number(officialTotal.spend) - Number(metrics.spend)).toFixed(2) : null,
    matchedOriginalVideos: matches.length,
    mostOrderedOriginalVideos: matches.filter(row => row.skuOrders > 0).sort((a, b) => b.skuOrders - a.skuOrders).slice(0, 5),
    requestIds: result.requestIds };
}

const aircraftDecisionScope = {
  shopId: '9000000000000000099',
  advertiserId: '9000000000000000096',
  campaignId: '9000000000000004',
  productId: '9000000000000000016',
  videoId: '9000000000000000123',
};

export function reviewAircraftCreativeDecisions(ads) {
  const { shopId, advertiserId, campaignId, productId, videoId } = aircraftDecisionScope;
  const { shop, account, completeDays, inProgressDay, observedAt, requestIds } = ads ?? {};
  if (ads?.schema !== 'operations-gmv-max-read/v1' || shop?.id !== shopId || shop.name !== 'example-shop-my' ||
      shop.region !== 'MY' || shop.advertiserId !== advertiserId || account?.advertiser_id !== advertiserId ||
      account.currency !== 'USD' || account.timezone !== 'Asia/Kuala_Lumpur' ||
      !requestIds?.account || !requestIds.shop || !Number.isFinite(Date.parse(observedAt))) return null;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: account.timezone, dateStyle: 'short' }).format(new Date(observedAt));
  const start = Date.parse(completeDays?.start);
  const end = Date.parse(completeDays?.end);
  if (inProgressDay?.day !== today || !/^\d{4}-\d{2}-\d{2}$/u.test(completeDays?.start ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(completeDays?.end ?? '') ||
      end - start !== 6 * 86_400_000 || Date.parse(today) - end !== 86_400_000) return null;

  const report = creativeReportForProduct(ads, { campaignId, productId });
  if (report?.dimensions?.length !== 1 || report.dimensions[0] !== 'item_id' || !report.requestIds?.length ||
      report.requestIds.some(id => typeof id !== 'string' || !id.trim()) || !Array.isArray(report.rows)) return null;
  const card = report.rows.find(row => row.dimensions?.item_id === '-1');
  const video = report.rows.find(row => row.dimensions?.item_id === videoId);
  const byContent = summarizeCreatives(report, productId, new Map()).byContent;
  const productCard = card?.metrics?.shop_content_type === 'PRODUCT_CARD' ? {
    decisionId: 'D-004', state: 'classification_verified', itemId: '-1', contentType: card.metrics.shop_content_type,
    deliveryStatus: card.metrics.creative_delivery_status ?? null, reportedRoi: card.metrics.roi ?? null,
    ...summarizeAdsMetrics([card]), videoComparison: byContent.VIDEO ?? null,
  } : null;
  const observedVideo = video?.metrics?.shop_content_type === 'VIDEO' ? {
    decisionId: 'D-002', itemId: videoId, deliveryStatus: video.metrics.creative_delivery_status ?? null,
    reportedRoi: video.metrics.roi ?? null, ...summarizeAdsMetrics([video]),
    outcome: { state: 'pending_exclusion_event_and_comparable_order_windows', exclusionAt: null,
      beforeExactOrders: null, afterExactOrders: null, changePercent: null },
  } : null;
  return { shopId, advertiserId, campaignId, productId, observedAt, currency: account.currency,
    window: { start: completeDays.start, end: completeDays.end }, requestIds: report.requestIds, productCard, video: observedVideo };
}

export function reviewGmvMaxProducts(ads, finance, shopVideo) {
  const { shop, account, completeDays } = ads;
  if (ads.schema !== 'operations-gmv-max-read/v1' || shop?.region !== 'MY' || shop?.name !== 'example-shop-my' ||
      shop.advertiserId !== account?.advertiser_id || account.timezone !== 'Asia/Kuala_Lumpur' ||
      !/^[A-Z]{3}$/u.test(account.currency ?? '') || !Array.isArray(completeDays?.productReports)) {
    throw new Error('Exact MY GMV Max product report required');
  }
  const productFinance = sameShop(finance, shop) && finance.schema === 'operations-product-finance-review/v1' ? finance : null;
  const videos = new Map();
  if (sameShop(shopVideo, shop) && shopVideo.schema === 'operations-shop-video-reconciliation/v1') {
    for (const row of shopVideo.linkedHistoricalVideos ?? []) {
      if (!isPlatformId(row.platformVideoId) || !row.originalSuccess?.source) continue;
      if (videos.has(row.platformVideoId)) throw new Error('Conflicting shop video evidence');
      videos.set(row.platformVideoId, row);
    }
  }
  const rows = [];
  for (const campaign of completeDays.productReports) {
    const configured = ads.campaignDetails?.find(row => row.id === campaign.campaignId && row.status === 'ENABLE' && row.type === 'PRODUCT');
    if (!configured) throw new Error('GMV Max report is outside the active campaign');
    for (const productId of new Set(configured.productIds ?? [])) {
      const byDay = campaign.byDay.result?.rows?.filter(row => row.dimensions.item_group_id === productId) ?? [];
      const creative = campaign.creatives.find(row => row.productId === productId);
      const window = productFinance?.window;
      const financeRow = productFinance?.rows.find(row => row.productId === productId);
      const common = byDay.filter(row => {
        const day = reportDay(row.dimensions.stat_time_day);
        return day && window && day >= window.startDate && day < window.endDateExclusive;
      });
      const dayCount = new Set(common.map(row => reportDay(row.dimensions.stat_time_day))).size;
      const financeWindowMatch = Boolean(financeRow) && dayCount > 0 && dayCount === window?.days && common.length === dayCount;
      let daily = null;
      if (financeWindowMatch && Array.isArray(financeRow.orderDays)) {
        const orderDays = new Map(financeRow.orderDays.map(row => [row.day, row]));
        if (orderDays.size !== financeRow.orderDays.length ||
            financeRow.orderDays.some(row => row.day < window.startDate || row.day >= window.endDateExclusive ||
              !Number.isSafeInteger(row.exactOrders) || row.exactOrders < 1 ||
              !Number.isSafeInteger(row.orderSkuPairs) || row.orderSkuPairs < 0 ||
              (row.exactLineItems !== undefined && (!Number.isSafeInteger(row.exactLineItems) || row.exactLineItems < row.orderSkuPairs))) ||
            financeRow.orderDays.reduce((sum, row) => sum + row.exactOrders, 0) !== financeRow.orderDetailOrders) {
          throw new Error('Shop order day totals do not match the product cohort');
        }
        daily = common.map(row => {
          const day = reportDay(row.dimensions.stat_time_day);
          const shopDay = orderDays.get(day);
          return { day, ads: summarizeAdsMetrics([row]),
            shop: { exactOrders: shopDay?.exactOrders ?? 0, orderSkuPairs: shopDay?.orderSkuPairs ?? 0,
              exactLineItems: shopDay ? shopDay.exactLineItems ?? null : 0 } };
        }).sort((a, b) => a.day.localeCompare(b.day));
      }
      rows.push({ campaignId: campaign.campaignId, productId, campaignName: configured.name, targetRoi: configured.targetRoi,
        reportWindow: { start: completeDays.start, end: completeDays.end },
        ads: byDay.length ? { days: byDay.length, ...summarizeAdsMetrics(byDay) } : null,
        productReadError: campaign.byDay.error ?? null,
        creative: creative?.available ? summarizeCreatives(creative.result, productId, videos) : null,
        creativeReadError: creative?.error ?? null,
        sameWindow: financeWindowMatch ? { window, ads: summarizeAdsMetrics(common),
          shop: { exactOrders: financeRow.orderDetailOrders, analyticsOrders: financeRow.analyticsOrders,
            orderSkuPairs: daily ? daily.reduce((sum, row) => sum + row.shop.orderSkuPairs, 0) : null,
            exactLineItems: daily?.every(row => Number.isSafeInteger(row.shop.exactLineItems))
              ? daily.reduce((sum, row) => sum + row.shop.exactLineItems, 0) : null,
            ...shopSettlement(financeRow) },
          daily, attributedOrderLink: null, actualNetProfitMyr: null } : null });
    }
  }
  return { observedAt: ads.observedAt, currency: account.currency, reportContract: ads.reportContract ?? null, rows };
}

export function proposeCreativeReviews(ads, shopVideo) {
  const { shop, account, completeDays } = ads;
  if (ads.schema !== 'operations-gmv-max-read/v1' || shop?.name !== 'example-shop-my' || shop.region !== 'MY' ||
      account?.advertiser_id !== shop.advertiserId || account.timezone !== 'Asia/Kuala_Lumpur' || account.currency !== 'USD' ||
      !ads.requestIds?.account || !ads.requestIds?.shop || !sameShop(shopVideo, shop) ||
      shopVideo.schema !== 'operations-shop-video-reconciliation/v1' || !shopVideo.coverage?.completeForPerformanceList) return [];
  const window = { start: completeDays?.start, end: completeDays?.end };
  const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
  if (!dayPattern.test(window.start ?? '') || !dayPattern.test(window.end ?? '') ||
      Date.parse(window.end) - Date.parse(window.start) !== 6 * 86_400_000) return [];
  const endExclusive = new Date(Date.parse(window.end) + 86_400_000).toISOString().slice(0, 10);
  const videos = new Map(shopVideo.linkedHistoricalVideos?.map(row => [row.platformVideoId, row]));
  const engagement = new Map(shopVideo.productPerformance?.map(row => [row.platformVideoId, row]));
  if (videos.size !== shopVideo.linkedHistoricalVideos?.length || engagement.size !== shopVideo.productPerformance?.length) return [];
  const candidates = [];
  for (const campaign of ads.campaignDetails ?? []) {
    if (campaign.status !== 'ENABLE' || campaign.type !== 'PRODUCT') continue;
    for (const productId of new Set(campaign.productIds)) {
      const report = creativeReportForProduct(ads, { campaignId: campaign.id, productId });
      if (!report?.requestIds?.length || report.requestIds.some(id => !id) || report.dimensions?.length !== 1 ||
          report.dimensions[0] !== 'item_id' || !Array.isArray(report.rows) ||
          new Set(report.rows.map(row => row.dimensions?.item_id)).size !== report.rows.length) continue;
      for (const row of report.rows) {
        const id = row.dimensions?.item_id;
        const { metrics } = row;
        const video = videos.get(id);
        const stats = engagement.get(id);
        const reportedAccount = metrics?.tt_account_name;
        if (metrics?.shop_content_type !== 'VIDEO' || metrics.creative_delivery_status === 'EXCLUDED' ||
            !isPlatformId(id) || video?.productId !== productId || !video.account || !video.originalSuccess?.source ||
            !/^[a-f0-9]{64}$/u.test(video.originalSuccess.sha256 ?? '') ||
            (reportedAccount && !['0', '-'].includes(reportedAccount) && reportedAccount.replace(/^@/u, '') !== video.account) ||
            stats?.state !== 'product_analytics_confirmed' || stats.expectedProductId !== productId ||
            !stats.productIds?.includes(productId) || !stats.requestIds?.length ||
            !dayPattern.test(stats.latestAvailableDate ?? '') || stats.latestAvailableDate < window.end ||
            stats.engagement?.startInclusive !== window.start || stats.engagement.endExclusive !== endExclusive ||
            !Number.isSafeInteger(stats.engagement.clicks) || stats.engagement.clicks < 1 ||
            !Number.isSafeInteger(stats.engagement.unitsSold) || stats.engagement.unitsSold < 1) continue;
        const result = summarizeAdsMetrics([row]);
        if (result.skuOrders < 3 || Number(result.spend) <= 0) continue;
        candidates.push({ id, campaignId: campaign.id, productId, account: video.account, jobId: video.jobId,
          originalSuccess: video.originalSuccess, deliveryStatus: metrics.creative_delivery_status ?? null,
          ads: { ...result, reportedRoi: metrics.roi ?? null, attribution: 'platform_report_includes_organic' },
          productEngagement: stats.engagement, adsRequestIds: report.requestIds, shopRequestIds: stats.requestIds, window });
      }
    }
  }
  return candidates.sort((a, b) => b.ads.skuOrders - a.ads.skuOrders || b.productEngagement.clicks - a.productEngagement.clicks);
}
