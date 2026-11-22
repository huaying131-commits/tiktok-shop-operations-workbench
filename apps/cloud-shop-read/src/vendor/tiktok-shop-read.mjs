import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const pageSize = 10;

class PlatformError extends Error {
  constructor(httpStatus, code, retryAfter, requestId) {
    const safeCode = Number.isSafeInteger(code) ? '，平台错误码 ' + code : '';
    super('平台接口未成功（HTTP ' + httpStatus + safeCode + '）');
    this.platformCode = code;
    this.httpStatus = httpStatus;
    this.requestId = typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(requestId) ? requestId : null;
    this.rateLimited = httpStatus === 429 || code === 36009002;
    this.retryAfter = retryAfter;
  }
}

export function isExpiredAccessToken(error) {
  return error instanceof PlatformError && error.platformCode === 105002;
}

export function publicPlatformError(error, fallback) {
  return error instanceof PlatformError ? error.message : fallback;
}

export function signTikTokShopUrl({ appKey, appSecret, timestamp, path, query = {}, body = '' }) {
  const parameters = { ...query, app_key: appKey, timestamp };
  const joined = Object.keys(parameters).sort().map(key => key + parameters[key]).join('');
  const message = appSecret + path + joined + body + appSecret;
  const sign = createHmac('sha256', appSecret).update(message).digest('hex');
  const url = new URL(path, 'https://open-api.tiktokglobalshop.com');
  url.search = new URLSearchParams({ ...parameters, sign }).toString();
  return url;
}

export function createTikTokClient({ appKey, appSecret, fetchApi = fetch, now = Date.now, wait = delay }) {
  async function call(url, headers, body, includeRequestId = false) {
    const response = await fetchApi(url, {
      method: body === undefined ? 'GET' : 'POST', headers, body,
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.code !== 0 || !envelope?.data) {
      throw new PlatformError(response.status, envelope?.code, response.headers.get('retry-after'), envelope?.request_id);
    }
    return includeRequestId ? { data: envelope.data, requestId: stringOrNull(envelope.request_id) } : envelope.data;
  }

  async function signedRead(path, accessToken, query = {}, payload, includeRequestId = false) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken };
    for (let attempt = 0; ; attempt += 1) {
      const timestamp = String(Math.floor(now() / 1000));
      const url = signTikTokShopUrl({ appKey, appSecret, timestamp, path, query, body });
      try {
        return await call(url, headers, body, includeRequestId);
      } catch (error) {
        if (!(error instanceof PlatformError) || !error.rateLimited || attempt >= 2) throw error;
        const hint = error.retryAfter;
        const requestedDelay = hint && /^\d+$/.test(hint) ? Number(hint) * 1000 : hint ? Date.parse(hint) - now() : 0;
        const retryDelay = Math.max(1000 * (2 ** attempt), Number.isNaN(requestedDelay) ? 0 : requestedDelay);
        if (retryDelay > 15000) throw error;
        await wait(retryDelay);
      }
    }
  }

  function shopCipher(shop) {
    if (shop?.region !== 'MY' || typeof shop.cipher !== 'string' || !shop.cipher) {
      throw new Error('A verified Malaysia shop is required');
    }
    return { shop_cipher: shop.cipher };
  }

  function shopQuery(shop, size = pageSize, cursor) {
    return { ...shopCipher(shop), page_size: String(size), ...(cursor ? { page_token: cursor } : {}) };
  }

  const unixTime = value => Number.isSafeInteger(value) && value > 0 ? value : null;

  async function getTokens(endpoint, params) {
    const url = new URL('/api/v2/token/' + endpoint, 'https://auth.tiktok-shops.com');
    url.search = new URLSearchParams({ app_key: appKey, app_secret: appSecret, ...params }).toString();
    const tokens = await call(url);
    if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
        typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
      throw new Error('Token response incomplete');
    }
    return tokens;
  }

  async function productsPage(accessToken, shop, size, cursor) {
    const data = await signedRead('/product/202309/products/search', accessToken, shopQuery(shop, size, cursor), {});
    return samplePage(data, 'products', product => ({
      id: stringOrNull(product.id), title: stringOrNull(product.title), status: stringOrNull(product.status),
      skus: Array.isArray(product.skus) ? product.skus.map(sku => ({
        id: stringOrNull(sku?.id), sellerSku: stringOrNull(sku?.seller_sku),
      })) : null,
    }));
  }

  async function ordersPage(accessToken, shop, size, cursor, start, end, { includePaymentEvidence = false, includeRequestId = false } = {}) {
    const withRequest = includePaymentEvidence || includeRequestId;
    const response = await signedRead('/order/202309/orders/search', accessToken,
      shopQuery(shop, size, cursor), { create_time_ge: start, create_time_lt: end }, withRequest);
    const page = samplePage(withRequest ? response.data : response, 'orders', order => ({
      id: stringOrNull(order.id), status: stringOrNull(order.status),
      createdAt: Number.isSafeInteger(order.create_time) ? order.create_time : null,
      sampleOrder: typeof order.is_sample_order === 'boolean' ? order.is_sample_order : null,
      orderType: stringOrNull(order.order_type),
      ...(includePaymentEvidence ? {
        paidAt: Number.isSafeInteger(order.paid_time) && order.paid_time > 0 ? order.paid_time : null,
        cashOnDelivery: typeof order.is_cod === 'boolean' ? order.is_cod : null,
        currency: currency(order.payment?.currency), buyerPayment: money(order.payment?.total_amount),
      } : {}),
      skus: Array.isArray(order.line_items) ? order.line_items.map(line => ({
        lineId: stringOrNull(line?.id), productId: stringOrNull(line?.product_id),
        id: stringOrNull(line?.sku_id), sellerSku: stringOrNull(line?.seller_sku),
      })) : null,
    }));
    return withRequest ? { ...page, requestId: response.requestId } : page;
  }

  function returnPage(data, cursor, includeTrackingDigest = false) {
    const terminal = cursor && !data.next_page_token && data.return_orders === undefined
      ? { ...data, return_orders: [] } : data;
    return samplePage(terminal, 'return_orders', entry => ({
      id: stringOrNull(entry.return_id), orderId: stringOrNull(entry.order_id),
      type: stringOrNull(entry.return_type), status: stringOrNull(entry.return_status),
      updatedAt: Number.isSafeInteger(entry.update_time) ? entry.update_time : null,
      arbitrationStatus: stringOrNull(entry.arbitration_status), reasonCode: stringOrNull(entry.return_reason),
      amount: money(entry.refund_amount?.refund_total), currency: currency(entry.refund_amount?.currency),
      shipmentType: stringOrNull(entry.shipment_type), handoverMethod: stringOrNull(entry.handover_method),
      providerName: stringOrNull(entry.return_provider_name), hasTrackingNumber: Boolean(entry.return_tracking_number),
      ...(includeTrackingDigest ? { trackingSha256: typeof entry.return_tracking_number === 'string' && entry.return_tracking_number
        ? createHash('sha256').update(entry.return_tracking_number).digest('hex') : null } : {}),
      lines: Array.isArray(entry.return_line_items) ? entry.return_line_items.map(line => ({
        id: stringOrNull(line?.return_line_item_id), orderLineId: stringOrNull(line?.order_line_item_id),
        skuId: stringOrNull(line?.sku_id), amount: money(line?.refund_amount?.refund_total),
        currency: currency(line?.refund_amount?.currency),
      })) : null,
    }));
  }

  return {
    exchange: code => getTokens('get', { auth_code: code, grant_type: 'authorized_code' }),
    refresh: token => getTokens('refresh', { refresh_token: token, grant_type: 'refresh_token' }),
    creatorProfile: accessToken => signedRead('/affiliate_creator/202508/profiles', accessToken),
    creatorShopProducts(accessToken, cursor) {
      return signedRead('/affiliate_creator/202509/shop_products', accessToken,
        { page_size: '20', ...(cursor ? { page_token: cursor } : {}) });
    },
    creatorShowcaseProducts(accessToken, cursor) {
      return signedRead('/affiliate_creator/202405/showcases/products', accessToken,
        { origin: 'SHOWCASE', page_size: '20', ...(cursor ? { page_token: cursor } : {}) });
    },
    creatorVideoStatus(accessToken, videoId) {
      if (!isPlatformId(videoId)) throw new Error('Invalid platform video ID');
      return signedRead(`/affiliate_creator/202509/videos/${videoId}/status`, accessToken, {}, undefined, true);
    },
    creatorVideoPrecheckStatus(accessToken, taskId) {
      if (!isPlatformId(taskId)) throw new Error('Invalid platform precheck ID');
      return signedRead(`/affiliate_creator/202601/videos/precheck_tasks/${taskId}`, accessToken, {}, undefined, true);
    },
    async authorizedShops(accessToken) {
      const data = await signedRead('/authorization/202309/shops', accessToken);
      if (!Array.isArray(data.shops)) throw new Error('Shop list response incomplete');
      return data.shops;
    },
    globalProductPermissions: accessToken => signedRead('/seller/202309/permissions', accessToken),
    globalListingRules: (accessToken, shop) => signedRead('/product/202507/global_listing_rules', accessToken, shopCipher(shop)),
    listingPrerequisites: (accessToken, shop) => signedRead('/product/202312/prerequisites', accessToken, shopCipher(shop)),
    listingWarehouses: (accessToken, shop) => signedRead('/logistics/202309/warehouses', accessToken, shopCipher(shop)),
    customerServiceConversations: (accessToken, shop, cursor) => signedRead('/customer_service/202309/conversations',
      accessToken, shopQuery(shop, 20, cursor)),
    customerServiceMessages(accessToken, shop, conversationId) {
      if (!isPlatformId(conversationId)) throw new Error('Invalid conversation ID');
      return signedRead('/customer_service/202309/conversations/' + conversationId + '/messages', accessToken,
        shopQuery(shop, 10));
    },
    customerServicePerformance: (accessToken, shop, start, end) => signedRead('/customer_service/202407/performance',
      accessToken, { ...shopCipher(shop), support_date_ge: start, support_date_lt: end }),
    processingPackages: (accessToken, shop, start, end, cursor) => signedRead('/fulfillment/202309/packages/search',
      accessToken, shopQuery(shop, 50, cursor), { create_time_ge: start, create_time_lt: end, package_status: 'PROCESSING' }),
    async packageDetail(accessToken, shop, packageId) {
      if (!isPlatformId(packageId)) throw new Error('Invalid package ID');
      const data = await signedRead('/fulfillment/202309/packages/' + packageId, accessToken, shopCipher(shop));
      return { id: stringOrNull(data.package_id), status: stringOrNull(data.package_status),
        subStatus: stringOrNull(data.package_sub_status), handoverMethod: stringOrNull(data.handover_method),
        provider: stringOrNull(data.shipping_provider_name), hasTrackingNumber: Boolean(data.tracking_number),
        warehouseId: stringOrNull(data.warehouse_id),
        orderIds: Array.isArray(data.orders) ? data.orders.map(row => stringOrNull(row?.id)) : null,
        lineIds: Array.isArray(data.order_line_item_ids) ? data.order_line_item_ids : null };
    },
    async packageHandover(accessToken, shop, packageId) {
      if (!isPlatformId(packageId)) throw new Error('Invalid package ID');
      const { data, requestId } = await signedRead(`/fulfillment/202309/packages/${packageId}/handover_time_slots`,
        accessToken, shopCipher(shop), undefined, true);
      const flag = value => typeof value === 'boolean' ? value : null;
      return { requestId, canDropOff: flag(data.can_drop_off), canPickup: flag(data.can_pickup),
        canVanCollection: flag(data.can_van_collection), pickupSlotCount: Array.isArray(data.pickup_slots) ? data.pickup_slots.length : null };
    },
    async packageLabelAvailability(accessToken, shop, packageId) {
      if (!isPlatformId(packageId)) throw new Error('Invalid package ID');
      const { data, requestId } = await signedRead(`/fulfillment/202309/packages/${packageId}/shipping_documents`,
        accessToken, { ...shopCipher(shop), document_type: 'SHIPPING_LABEL' }, undefined, true);
      const label = typeof data.doc_url === 'string' ? URL.parse(data.doc_url) : null;
      return { requestId, labelUrlReturned: label?.protocol === 'https:' && !label.username && !label.password,
        hasTrackingNumber: typeof data.tracking_number === 'string' && Boolean(data.tracking_number.trim()) };
    },
    async orderTracking(accessToken, shop, orderId) {
      if (!isPlatformId(orderId)) throw new Error('Invalid tracking order ID');
      const data = await signedRead('/fulfillment/202309/orders/' + orderId + '/tracking', accessToken, shopCipher(shop));
      if (!Array.isArray(data.tracking)) throw new Error('Tracking events are unavailable');
      return data.tracking.map(row => ({ code: Number.isSafeInteger(row.action_code) ? row.action_code : null,
        updatedAtMillis: Number.isSafeInteger(row.update_time_millis) ? row.update_time_millis : null }));
    },
    listingCategories: (accessToken, shop) => signedRead('/product/202309/categories', accessToken, {
      ...shopCipher(shop), category_version: 'v2',
    }),
    listingCategoryRules(accessToken, shop, categoryId) {
      if (!isPlatformId(categoryId) && !/^\d{6,12}$/u.test(categoryId)) throw new Error('Invalid category ID');
      return signedRead('/product/202309/categories/' + categoryId + '/rules', accessToken, {
        ...shopCipher(shop), category_version: 'v2',
      });
    },
    listingCategoryAttributes(accessToken, shop, categoryId) {
      if (!isPlatformId(categoryId) && !/^\d{6,12}$/u.test(categoryId)) throw new Error('Invalid category ID');
      return signedRead('/product/202309/categories/' + categoryId + '/attributes', accessToken, {
        ...shopCipher(shop), category_version: 'v2',
      });
    },
    async listingBrandsPage(accessToken, shop, { categoryId, name, cursor }) {
      if (!/^\d{6,30}$/u.test(categoryId) || typeof name !== 'string' || !name.trim()) {
        throw new Error('A leaf category and brand search term are required');
      }
      const data = await signedRead('/product/202309/brands', accessToken, {
        ...shopQuery(shop, 100, cursor), category_id: categoryId, category_version: 'v2', brand_name: name,
      });
      return samplePage(data, 'brands', row => ({
        id: stringOrNull(row.id), name: stringOrNull(row.name), authorization: stringOrNull(row.authorized_status),
        categoryStatus: stringOrNull(row.brand_status), isT1: typeof row.is_t1_brand === 'boolean' ? row.is_t1_brand : null,
      }));
    },
    searchListingSku: (accessToken, shop, sellerSku, cursor) => signedRead('/product/202502/products/search', accessToken,
      shopQuery(shop, 50, cursor), { seller_skus: [sellerSku] }),
    checkProductListing: (accessToken, shop, fields, { includeRequestId = false } = {}) =>
      signedRead('/product/202309/products/listing_check', accessToken, shopCipher(shop), fields, includeRequestId),
    async recommendListingProperties(accessToken, shop, { categoryId, title, description }) {
      if (!/^\d{6,30}$/u.test(categoryId ?? '') || typeof title !== 'string' || !title.trim() ||
          (description !== undefined && typeof description !== 'string')) throw new Error('Exact listing category and title required');
      return signedRead('/product/202609/products/properties/recommend', accessToken, shopCipher(shop),
        { category_id: categoryId, product_title: title, ...(description ? { description } : {}) }, true);
    },
    productsPage,
    ordersPage,
    async operationalOrders(accessToken, shop, orderIds) {
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 50 || !orderIds.every(isPlatformId)) {
        throw new Error('Invalid order detail cohort');
      }
      const data = await signedRead('/order/202507/orders', accessToken,
        { ...shopCipher(shop), ids: orderIds.join(',') });
      if (!Array.isArray(data.orders)) throw new Error('Order detail response incomplete');
      return data.orders.map(order => ({
        id: stringOrNull(order.id), status: stringOrNull(order.status), warehouseId: stringOrNull(order.warehouse_id),
        createdAt: Number.isSafeInteger(order.create_time) ? order.create_time : null,
        sampleOrder: typeof order.is_sample_order === 'boolean' ? order.is_sample_order : null,
        orderType: stringOrNull(order.order_type),
        deliveryOptionName: stringOrNull(order.delivery_option_name), shippingType: stringOrNull(order.shipping_type),
        fulfillmentType: stringOrNull(order.fulfillment_type),
        collectionDueAt: unixTime(order.tts_sla_time),
        fulfillmentDeadlines: { readyToShipSlaAt: unixTime(order.rts_sla_time), collectionSlaAt: unixTime(order.tts_sla_time),
          shippingDueAt: unixTime(order.shipping_due_time), collectionDueAt: unixTime(order.collection_due_time),
          pickupCutoffAt: unixTime(order.pick_up_cut_off_time), autoCancelAt: unixTime(order.cancel_order_sla_time) },
        packageIds: Array.isArray(order.packages) ? order.packages.map(row => stringOrNull(row?.id)) : null,
        lines: Array.isArray(order.line_items) ? order.line_items.map(row => ({
          id: stringOrNull(row?.id), packageId: stringOrNull(row?.package_id),
          skuId: stringOrNull(row?.sku_id), productId: stringOrNull(row?.product_id),
        })) : null,
      }));
    },
    async orderPriceDetails(accessToken, shop, orderId) {
      if (!isPlatformId(orderId)) throw new Error('Invalid order price ID');
      const data = await signedRead('/order/202407/orders/' + orderId + '/price_detail', accessToken, shopCipher(shop));
      if (!Array.isArray(data.line_items)) throw new Error('Order price details incomplete');
      return { currency: currency(data.currency), payment: money(data.payment),
        lines: data.line_items.map(row => ({
          id: stringOrNull(row.id), currency: currency(row.currency), list: money(row.sku_list_price),
          buyerProduct: money(row.sku_sale_price), sellerDiscount: money(row.subtotal_deduction_seller),
          platformDiscount: money(row.subtotal_deduction_platform), sellerVoucher: money(row.voucher_deduction_seller),
          platformVoucher: money(row.voucher_deduction_platform), buyerShipping: money(row.shipping_sale_price),
          linePayment: money(row.payment), productTax: money(row.subtotal_tax_amount),
          shippingList: money(row.shipping_list_price), sellerShippingDiscount: money(row.shipping_fee_deduction_seller),
          platformShippingDiscount: money(row.shipping_fee_deduction_platform),
          platformShippingVoucher: money(row.shipping_fee_deduction_platform_voucher),
          sellerProductPromotions: orderPromotions(row.seller_funded_product_promotions),
        })) };
    },
    async productDetail(accessToken, shop, productId, { includeRequestId = false, draft = false, includeBuyerUrl = false } = {}) {
      if (!isPlatformId(productId)) throw new Error('Invalid product ID');
      return signedRead('/product/202309/products/' + productId, accessToken, {
        ...shopCipher(shop), ...(draft ? { return_draft_version: 'true' } : {}),
        ...(includeBuyerUrl ? { query_options: JSON.stringify(['GET_PRODUCT_DETAIL_URL']) } : {}),
      }, undefined, includeRequestId);
    },
    async inventoryBySku(accessToken, shop, skuIds) {
      if (!Array.isArray(skuIds) || skuIds.length < 1 || skuIds.length > 600 ||
          !skuIds.every(isPlatformId) || new Set(skuIds).size !== skuIds.length) throw new Error('Invalid inventory SKU list');
      return signedRead('/product/202309/inventory/search', accessToken, shopCipher(shop), { sku_ids: skuIds }, true);
    },
    async promotionActivities(accessToken, shop, cursor, status = 'ONGOING', { includeRequestId = false } = {}) {
      if (!['ONGOING', 'NOT_START'].includes(status)) throw new Error('Invalid promotion status');
      return signedRead('/promotion/202309/activities/search', accessToken, shopCipher(shop), {
        status, page_size: 100, ...(cursor ? { page_token: cursor } : {}),
      }, includeRequestId);
    },
    async promotionActivity(accessToken, shop, activityId, { includeRequestId = false } = {}) {
      if (!isPlatformId(activityId)) throw new Error('Invalid promotion ID');
      return signedRead('/promotion/202309/activities/' + activityId, accessToken, shopCipher(shop), undefined, includeRequestId);
    },
    async promotionCoupons(accessToken, shop, cursor, { includeRequestId = false } = {}) {
      return signedRead('/promotion/202406/coupons/search', accessToken, shopQuery(shop, 20, cursor), {
        status: ['ONGOING', 'NOT_START'],
      }, includeRequestId);
    },
    async promotionCoupon(accessToken, shop, couponId, { includeRequestId = false } = {}) {
      if (!isPlatformId(couponId)) throw new Error('Invalid coupon ID');
      return signedRead('/promotion/202406/coupons/' + couponId, accessToken, shopCipher(shop), undefined, includeRequestId);
    },
    async openAffiliateProducts(accessToken, shop, productId, cursor, { includeRequestId = false } = {}) {
      if (!isPlatformId(productId)) throw new Error('Invalid product ID');
      return signedRead('/affiliate_seller/202412/open_collaborations/search', accessToken, shopQuery(shop, 50, cursor), {
        keyword_type: 'PRODUCT_ID', keyword: productId,
      }, includeRequestId);
    },
    async sampleApplicationsByOrder(accessToken, shop, orderId, productId, cursor) {
      if (!isPlatformId(orderId) || !isPlatformId(productId)) throw new Error('Invalid sample order or product ID');
      return signedRead('/affiliate_seller/202508/sample_applications/search', accessToken, shopQuery(shop, 20, cursor), {
        order_id: orderId, product_id: productId,
      });
    },
    async sampleApplicationFulfillments(accessToken, shop, applicationId) {
      if (!isPlatformId(applicationId)) throw new Error('Invalid sample application ID');
      return signedRead(`/affiliate_seller/202409/sample_applications/${applicationId}/fulfillments/search`, accessToken, shopCipher(shop), {});
    },
    async productPerformancePage(accessToken, shop, startDate, endDate, cursor) {
      if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) || startDate >= endDate) {
        throw new Error('Invalid product performance dates');
      }
      return signedRead('/analytics/202605/shop_products/performance', accessToken, {
        ...shopQuery(shop, 100, cursor), start_date_ge: startDate, end_date_lt: endDate,
        currency: 'LOCAL', product_status_filter: 'LIVE',
      });
    },
    async shopPerformance(accessToken, shop, startDate, endDate, granularity) {
      if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) || startDate >= endDate ||
          !['ALL', '1D'].includes(granularity)) throw new Error('Invalid shop performance interval');
      return signedRead('/analytics/202609/shop/performance', accessToken, {
        ...shopCipher(shop), start_date_ge: startDate, end_date_lt: endDate, currency: 'LOCAL', granularity,
      }, undefined, true);
    },
    async todayVideoOverview(accessToken, shop, startDate, endDate, accountType) {
      if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) || startDate >= endDate ||
          !['ALL', 'OFFICIAL_ACCOUNTS', 'MARKETING_ACCOUNTS', 'AFFILIATE_ACCOUNTS'].includes(accountType)) {
        throw new Error('Invalid current video overview request');
      }
      return signedRead('/analytics/202609/shop_videos/overview_performance', accessToken, {
        ...shopCipher(shop), start_date_ge: startDate, end_date_lt: endDate, currency: 'LOCAL',
        granularity: 'ALL', today: 'true', account_type: accountType,
      }, undefined, true);
    },
    async videoPerformancePage(accessToken, shop, startDate, endDate, accountType, cursor) {
      if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) || startDate >= endDate) {
        throw new Error('Invalid video performance dates');
      }
      if (!['OFFICIAL_ACCOUNTS', 'MARKETING_ACCOUNTS'].includes(accountType)) {
        throw new Error('Invalid shop video account type');
      }
      return signedRead('/analytics/202605/shop_videos/performance', accessToken, {
        ...shopQuery(shop, 100, cursor), start_date_ge: startDate, end_date_lt: endDate,
        currency: 'LOCAL', account_type: accountType,
      });
    },
    async batchVideoPerformance(accessToken, shop, startDate, endDate, videoIds, { includeRequestId = false } = {}) {
      if (![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) || startDate >= endDate) {
        throw new Error('Invalid video performance dates');
      }
      if (!videoIds.length || videoIds.length > 500 || !videoIds.every(isPlatformId)) {
        throw new Error('Invalid video performance IDs');
      }
      return signedRead('/analytics/202609/shop_videos/batch_performance', accessToken, {
        ...shopCipher(shop), start_date_ge: startDate, end_date_lt: endDate,
        currency: 'LOCAL', granularity: 'ALL', video_ids: '[' + videoIds.join(',') + ']',
      }, undefined, includeRequestId);
    },
    async videoProductPerformancePage(accessToken, shop, startDate, endDate, videoId, cursor) {
      if (!isPlatformId(videoId) || ![startDate, endDate].every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) ||
          startDate >= endDate) throw new Error('Exact video ID and performance dates are required');
      return signedRead(`/analytics/202509/shop_videos/${videoId}/products/performance`, accessToken, {
        ...shopQuery(shop, 100, cursor), start_date_ge: startDate, end_date_lt: endDate, currency: 'LOCAL',
      }, undefined, true);
    },
    async productOpportunitySample(accessToken, shop) {
      return signedRead('/product/202604/opportunities/query', accessToken, shopQuery(shop, 20), {
        opportunity_type: 'PRODUCT',
      });
    },
    async productOpportunityPage(accessToken, shop, { type, categoryIds = [], cursor }) {
      if (!['PRODUCT', 'KEYWORD', 'CATEGORY'].includes(type) || !Array.isArray(categoryIds) ||
          !categoryIds.every(id => typeof id === 'string' && /^\d{6,30}$/u.test(id)) ||
          (cursor !== undefined && (typeof cursor !== 'string' || !cursor))) throw new Error('Invalid opportunity search');
      const response = await signedRead('/product/202604/opportunities/query', accessToken, shopQuery(shop, 100, cursor), {
        opportunity_type: type, ...(categoryIds.length ? { category_ids: categoryIds } : {}),
      });
      const data = response.data ?? response;
      const nextToken = data.next_page_token ?? '';
      if (typeof nextToken !== 'string' || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
          !Array.isArray(data.opportunities) || data.opportunities.some(row =>
            !isPlatformId(row?.id) || row.opportunity_type !== type || typeof row.title !== 'string' || !row.title.trim())) {
        throw new Error('Opportunity page identity or pagination incomplete');
      }
      return { rows: data.opportunities, totalCount: data.total_count, nextToken };
    },
    async productOpportunityDetail(accessToken, shop, id) {
      if (!isPlatformId(id)) throw new Error('Invalid opportunity ID');
      const response = await signedRead('/product/202604/opportunities/' + id, accessToken, shopCipher(shop));
      const opportunity = response.opportunity ?? response.data?.opportunity;
      if (opportunity?.id !== id || !opportunity.basic_info) throw new Error('Opportunity detail identity mismatch');
      return opportunity;
    },
    async returnsPage(accessToken, shop, orderIds, cursor) {
      if (!orderIds.length || orderIds.length > 20 || !orderIds.every(isPlatformId)) throw new Error('Invalid return cohort');
      const data = await signedRead('/return_refund/202602/returns/search', accessToken,
        shopQuery(shop, 50, cursor), { order_ids: orderIds });
      return returnPage(data, cursor);
    },
    async cancellationsPage(accessToken, shop, orderIds, cursor) {
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 20 ||
          !orderIds.every(isPlatformId) || new Set(orderIds).size !== orderIds.length) throw new Error('Invalid cancellation cohort');
      const data = await signedRead('/return_refund/202309/cancellations/search', accessToken,
        shopQuery(shop, 50, cursor), { order_ids: orderIds });
      return samplePage(data, 'cancellations', entry => {
        if (!isPlatformId(entry.cancel_id) || !orderIds.includes(entry.order_id) ||
            typeof entry.cancel_status !== 'string' || !entry.cancel_status.trim()) throw new Error('Cancellation scope or status unverified');
        return { id: entry.cancel_id, orderId: entry.order_id, status: entry.cancel_status };
      });
    },
    async returnsUpdatedPage(accessToken, shop, start, end, cursor) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
        throw new Error('Invalid return update range');
      }
      const data = await signedRead('/return_refund/202602/returns/search', accessToken,
        { ...shopQuery(shop, 50, cursor), sort_field: 'update_time', sort_order: 'DESC' },
        { update_time_ge: start, update_time_lt: end });
      return returnPage(data, cursor);
    },
    async openReturnsPage(accessToken, shop, filter, cursor) {
      const filters = {
        pending_return_or_refund: { return_status: ['RETURN_OR_REFUND_REQUEST_PENDING'] },
        in_arbitration: { arbitration_status: ['IN_PROGRESS'] },
      };
      if (!Object.hasOwn(filters, filter)) throw new Error('Invalid open aftersales filter');
      const { data, requestId } = await signedRead('/return_refund/202602/returns/search', accessToken,
        { ...shopQuery(shop, 50, cursor), sort_field: 'update_time', sort_order: 'DESC' }, filters[filter], true);
      if (!requestId) throw new Error('Missing open aftersales request ID');
      return { ...returnPage(data, cursor), requestId };
    },
    async exactReturnPage(accessToken, shop, returnId, orderId, cursor, { includeTrackingDigest = false } = {}) {
      if (!isPlatformId(returnId) || !isPlatformId(orderId)) throw new Error('Exact return and order IDs are required');
      const data = await signedRead('/return_refund/202602/returns/search', accessToken,
        shopQuery(shop, 50, cursor), { return_ids: [returnId], order_ids: [orderId] });
      return returnPage(data, cursor, includeTrackingDigest);
    },
    async returnRecords(accessToken, shop, returnId) {
      if (!isPlatformId(returnId)) throw new Error('Exact return ID is required');
      const data = await signedRead('/return_refund/202309/returns/' + returnId + '/records', accessToken, shopCipher(shop));
      if (!Array.isArray(data.records)) throw new Error('Return records response incomplete');
      return data.records.map(row => ({
        event: stringOrNull(row.event), role: stringOrNull(row.role)?.toUpperCase() ?? null,
        at: Number.isSafeInteger(row.create_time) ? row.create_time : null,
        description: stringOrNull(row.description), reasonText: stringOrNull(row.reason_text), hasNote: Boolean(row.note),
        images: Array.isArray(row.images) ? row.images.length : null,
        videos: Array.isArray(row.videos) ? row.videos.length : null,
      }));
    },
    async returnDecisionEligibility(accessToken, shop, returnId) {
      if (!isPlatformId(returnId)) throw new Error('Exact return ID is required');
      const { data, requestId } = await signedRead('/return_refund/202601/decision_eligibility', accessToken,
        { ...shopCipher(shop), return_or_cancel_id: returnId }, undefined, true);
      if (!requestId || !Array.isArray(data.decisions) || data.decisions.some(row =>
        typeof row?.decision !== 'string' || !/^[A-Z_]{2,64}$/u.test(row.decision) || typeof row.eligible !== 'boolean') ||
        new Set(data.decisions.map(row => row.decision)).size !== data.decisions.length) {
        throw new Error('Decision eligibility response incomplete');
      }
      return { requestId, decisions: data.decisions.map(row => ({ decision: row.decision, eligible: row.eligible,
        code: !row.eligible && Number.isSafeInteger(row.ineligible_code) ? row.ineligible_code : null })) };
    },
    async statementsPage(accessToken, shop, start, end, cursor) {
      const data = await signedRead('/finance/202309/statements', accessToken, {
        ...shopQuery(shop, 50, cursor), statement_time_ge: start, statement_time_lt: end, sort_field: 'statement_time',
      });
      return samplePage(data, 'statements', entry => ({
        id: stringOrNull(entry.id), createdAt: Number.isSafeInteger(entry.statement_time) ? entry.statement_time : null,
        currency: currency(entry.currency), paymentStatus: stringOrNull(entry.payment_status),
        paymentId: stringOrNull(entry.payment_id), paymentTime: Number.isSafeInteger(entry.payment_time) ? entry.payment_time : null,
      }));
    },
    async paymentsPage(accessToken, shop, start, end, cursor) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
        throw new Error('Valid payment creation interval required');
      }
      const data = await signedRead('/finance/202605/payments', accessToken, {
        ...shopQuery(shop, 20, cursor), create_time_ge: start, create_time_lt: end,
        sort_field: 'create_time', sort_order: 'ASC',
      });
      return samplePage(data, 'payments', entry => {
        if (!isPlatformId(entry.id)) throw new Error('Payment ID missing');
        return { id: entry.id, status: stringOrNull(entry.status), createdAt: unixTime(entry.create_time),
          paidAt: unixTime(entry.paid_time) };
      });
    },
    async statementTransactionsPage(accessToken, shop, statementId, cursor) {
      if (!isPlatformId(statementId)) throw new Error('Invalid statement ID');
      const data = await signedRead('/finance/202501/statements/' + statementId + '/statement_transactions', accessToken,
        { ...shopQuery(shop, 50, cursor), sort_field: 'order_create_time' });
      const page = samplePage(data, 'transactions', entry => ({
        id: stringOrNull(entry.id), orderId: stringOrNull(entry.order_id), adjustmentOrderId: stringOrNull(entry.adjustment_order_id),
        type: stringOrNull(entry.type), amount: money(entry.settlement_amount), adjustmentAmount: money(entry.adjustment_amount),
      }));
      return { ...page, statement: { id: stringOrNull(data.id), status: stringOrNull(data.status),
        currency: currency(data.currency), createdAt: Number.isSafeInteger(data.create_time) ? data.create_time : null,
        payable: money(data.payable_amount), reserve: money(data.total_reserve_amount), settlement: money(data.total_settlement_amount) } };
    },
    async sellerFundsTransactionsPage(accessToken, shop, start, end, cursor) {
      const data = await signedRead('/finance/202309/withdrawals', accessToken, {
        ...shopQuery(shop, 100, cursor), create_time_ge: start, create_time_lt: end, types: 'WITHDRAW,SETTLE',
      });
      return samplePage(data, 'withdrawals', entry => ({
        id: stringOrNull(entry.id), type: stringOrNull(entry.type), status: stringOrNull(entry.status),
        currency: currency(entry.currency), amount: money(entry.amount),
        createdAt: Number.isSafeInteger(entry.create_time) ? entry.create_time : null,
      }));
    },
    async unsettledTransactionsPage(accessToken, shop, start, end, cursor) {
      const data = await signedRead('/finance/202507/orders/unsettled', accessToken, {
        ...shopQuery(shop, 100, cursor), search_time_ge: start, search_time_lt: end,
        sort_field: 'order_create_time', sort_order: 'ASC',
      });
      return samplePage(data, 'transactions', row => ({
        id: stringOrNull(row.id), orderId: stringOrNull(row.order_id), adjustmentOrderId: stringOrNull(row.adjustment_order_id),
        type: stringOrNull(row.type), status: stringOrNull(row.status), currency: currency(row.currency),
        amount: money(row.est_settlement_amount), revenue: money(row.est_revenue_amount),
        feesAndTax: money(row.est_fee_tax_amount), shipping: money(row.est_shipping_cost_amount),
      }));
    },
    async orderSettlement(accessToken, shop, orderId) {
      if (!isPlatformId(orderId)) throw new Error('Invalid order ID');
      const data = await signedRead('/finance/202501/orders/' + orderId + '/statement_transactions', accessToken, shopCipher(shop));
      if (data.order_id !== orderId || !Array.isArray(data.sku_transactions)) throw new Error('Order settlement response mismatch');
      return {
        currency: currency(data.currency), settlementAmount: money(data.settlement_amount), revenueAmount: money(data.revenue_amount),
        feeAndTaxAmount: money(data.fee_and_tax_amount), shippingCostAmount: money(data.shipping_cost_amount),
        skuTransactions: data.sku_transactions.map(sku => ({
          skuId: stringOrNull(sku?.sku_id), statementId: stringOrNull(sku?.statement_id), quantity: money(sku?.quantity),
          settlementAmount: money(sku?.settlement_amount), revenueAmount: money(sku?.revenue_amount),
          refundSubtotalBeforeDiscount: money(sku?.revenue_breakdown?.refund_subtotal_before_discount_amount),
          feeBreakdown: monetaryBreakdown(sku?.fee_tax_breakdown?.fee),
          taxBreakdown: monetaryBreakdown(sku?.fee_tax_breakdown?.tax),
          shippingBreakdown: monetaryBreakdown(sku?.shipping_cost_breakdown),
        })),
      };
    },
    async sampleProducts(accessToken, shop) {
      return sampleResult(await productsPage(accessToken, shop));
    },
    async sampleOrders(accessToken, shop) {
      const end = Math.floor(now() / 1000);
      const start = end - 7 * 24 * 60 * 60;
      const page = await ordersPage(accessToken, shop, undefined, undefined, start, end);
      // Keep the browser sample's existing minimal shape.
      page.rows = page.rows.map(order => ({ ...order,
        skus: order.skus?.map(({ id, sellerSku }) => ({ id, sellerSku })) ?? null }));
      return sampleResult(page);
    },
  };
}

function orderPromotions(value) {
  if (!Array.isArray(value)) return null;
  const rows = value.map(row => ({ activityId: stringOrNull(row?.activity_id), type: stringOrNull(row?.discount_type),
    amount: money(row?.discount_amount) }));
  return rows.every(row => isPlatformId(row.activityId) && row.type && row.amount !== null) ? rows : null;
}

function monetaryBreakdown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([, amount]) => money(amount) !== null));
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

export function isPlatformId(value) {
  return typeof value === 'string' && /^\d{8,30}$/.test(value);
}

function money(value) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

function currency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function samplePage(data, field, project) {
  const nextToken = data.next_page_token ?? '';
  if (typeof nextToken !== 'string') throw new Error('Invalid page token');
  const entries = data[field] ?? (data.total_count === 0 && !nextToken ? [] : null);
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object')) {
    throw new Error('Sample response incomplete');
  }
  return {
    rows: entries.map(project),
    totalCount: Number.isSafeInteger(data.total_count) ? data.total_count : null,
    nextToken,
  };
}

function sampleResult({ rows, totalCount, nextToken }) {
  return { rows, totalCount, hasNextPage: Boolean(nextToken) };
}
