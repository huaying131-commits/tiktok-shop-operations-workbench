import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';

const shopId = '9000000000000000099';
const output = fileURLToPath(new URL('../../outputs/operations-service-fulfillment/', import.meta.url));
const orderCardTypes = new Set(['ORDER_CARD', 'BUYER_ENTER_FROM_ORDER', 'LOGISTICS_CARD', 'RETURN_REFUND_CARD']);

export function linkedOrderIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (message.is_visible === false || !orderCardTypes.has(message.type) || typeof message.content !== 'string') continue;
    try {
      const orderId = JSON.parse(message.content)?.order_id;
      if (isPlatformId(orderId)) ids.add(orderId);
    } catch {
      continue;
    }
  }
  return [...ids];
}

export function reconcilePackageOrders(packages, details) {
  const orders = new Map(details.map(order => [order.id, order]));
  const findings = packages.map(row => {
    const linked = Array.isArray(row.orders) ? row.orders.map(order => orders.get(order.id)) : [];
    if (!linked.length || linked.some(order => !order?.packageIds?.includes(row.id))) return 'order_package_unverified';
    const lines = linked.flatMap(order => order.lines?.filter(line => line.packageId === row.id).map(line => line.id) ?? []);
    if (!Array.isArray(row.order_line_item_ids) || !row.order_line_item_ids.length || new Set(lines).size !== lines.length ||
        new Set(row.order_line_item_ids).size !== row.order_line_item_ids.length || lines.length !== row.order_line_item_ids.length ||
        !row.order_line_item_ids.every(id => lines.includes(id))) return 'order_lines_unverified';
    return linked.every(order => order.status === 'AWAITING_COLLECTION') ? 'matched_awaiting_collection' : 'matched_other_order_status';
  });
  return {
    scannedPackages: packages.length,
    orderDetailsConfirmed: orders.size,
    distinctWarehouseIds: [...new Set(details.map(order => order.warehouseId).filter(isPlatformId))],
    confirmedAwaitingCollection: findings.filter(state => state === 'matched_awaiting_collection').length,
    matchedOtherOrderStatus: findings.filter(state => state === 'matched_other_order_status').length,
    unverifiedOrderPackage: findings.filter(state => state === 'order_package_unverified').length,
    unverifiedLines: findings.filter(state => state === 'order_lines_unverified').length,
    packageLinks: packages.map((row, index) => ({ packageId: row.id, state: findings[index] })),
  };
}

async function readOrders(client, token, shop, ids) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const cohort = ids.slice(offset, offset + 50);
    const details = await client.operationalOrders(token, shop, cohort);
    if (details.some(row => !cohort.includes(row.id)) || new Set(details.map(row => row.id)).size !== details.length) {
      throw new Error('Order detail did not match the requested IDs');
    }
    rows.push(...details);
  }
  return rows;
}

function sameIds(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length > 0 && left.length === right.length &&
    left.every(isPlatformId) && new Set(left).size === left.length && new Set(right).size === right.length &&
    right.every(id => left.includes(id));
}

async function verifyCollectionDetails(client, token, shop, packages, orderDetails, linkage, cutoff) {
  const links = new Map(linkage.packageLinks.map(row => [row.packageId, row.state]));
  const orders = new Map(orderDetails.map(row => [row.id, row]));
  const rows = [];
  for (const item of packages) {
    if (links.get(item.id) !== 'matched_awaiting_collection') continue;
    const orderIds = item.orders.map(order => order.id);
    const linked = orderIds.map(id => orders.get(id));
    const due = linked.map(order => order.collectionDueAt);
    const collectionDueAt = due.every(Number.isSafeInteger) ? Math.min(...due) : null;
    const result = await inspect(async () => {
      const detail = await client.packageDetail(token, shop, item.id);
      if (detail.id !== item.id || !sameIds(detail.orderIds, orderIds) || !sameIds(detail.lineIds, item.order_line_item_ids)) {
        throw new Error('Package detail does not match the exact orders and lines');
      }
      return { status: detail.status, subStatus: detail.subStatus, handoverMethod: detail.handoverMethod,
        provider: detail.provider, hasTrackingNumber: detail.hasTrackingNumber };
    });
    const singleOrderSinglePackage = linked.length === 1 && sameIds(linked[0].packageIds, [item.id]);
    const tracking = result.available && singleOrderSinglePackage ? await inspect(async () => {
      const events = await client.orderTracking(token, shop, linked[0].id);
      const pickup = events.filter(event => event.code === 30901 && Number.isSafeInteger(event.updatedAtMillis));
      return { events: events.length, eventCodes: [...new Set(events.map(event => event.code).filter(Number.isSafeInteger))],
        pickupSuccessSeen: pickup.length > 0 };
    }) : null;
    const needsCarrierCheck = result.data?.status === 'PROCESSING' && tracking?.data?.pickupSuccessSeen !== true &&
      collectionDueAt !== null && cutoff >= collectionDueAt;
    rows.push({ packageId: item.id, orderIds, warehouseIds: [...new Set(linked.map(order => order.warehouseId))],
      collectionDueAt, needsCarrierCheck, detail: result, tracking });
  }
  return { packageDetailsConfirmed: rows.filter(row => row.detail.available).length,
    processingReconfirmed: rows.filter(row => row.detail.data?.status === 'PROCESSING').length,
    packagesWithTrackingNumber: rows.filter(row => row.detail.data?.hasTrackingNumber === true).length,
    exactTrackingReadbacks: rows.filter(row => row.tracking?.available).length,
    packagesWithPickupSuccess: rows.filter(row => row.tracking?.data?.pickupSuccessSeen === true).length,
    collectionDeadlineUnknown: rows.filter(row => row.collectionDueAt === null).length,
    needsCarrierCheck: rows.filter(row => row.needsCarrierCheck).length, rows };
}

const reviewStatuses = new Set(['RETURN_OR_REFUND_REQUEST_PENDING', 'REPLACEMENT_REQUEST_PENDING', 'EXCHANGE_REQUEST_PENDING']);

async function reviewReturnWindow(client, token, shop, start, end) {
  const returns = await collectPages(cursor => client.returnsUpdatedPage(token, shop, start, end, cursor), Date.now() + 60_000);
  if (returns.rows.some(row => !isPlatformId(row.id) || !isPlatformId(row.orderId) ||
      !Number.isSafeInteger(row.updatedAt) || row.updatedAt < start || row.updatedAt >= end || !row.status)) {
    throw new Error('Return data does not match the update window');
  }
  const orders = new Map((await readOrders(client, token, shop, [...new Set(returns.rows.map(row => row.orderId))]))
    .map(row => [row.id, row]));
  const byStatus = {};
  const rows = [];
  for (const row of returns.rows) {
    const order = orders.get(row.orderId);
    const orderLines = new Map(order?.lines?.map(line => [line.id, line.skuId]) ?? []);
    const matchedLines = Boolean(row.lines?.length && row.lines.every(line => isPlatformId(line.orderLineId) &&
      isPlatformId(line.skuId) && orderLines.get(line.orderLineId) === line.skuId));
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const decisionEligibility = matchedLines && (reviewStatuses.has(row.status) || row.arbitrationStatus === 'IN_PROGRESS' ||
      row.status === 'BUYER_SHIPPED_ITEM') ? await inspect(() => client.returnDecisionEligibility(token, shop, row.id)) : null;
    rows.push({ returnId: row.id, orderId: row.orderId, updatedAt: row.updatedAt, status: row.status,
      type: row.type, reasonCode: row.reasonCode, arbitrationStatus: row.arbitrationStatus,
      amount: row.amount, currency: row.currency, orderStatus: order?.status ?? null, matchedLines, decisionEligibility });
  }
  return { startInclusive: start, endExclusive: end, pages: returns.pages, records: rows.length, byStatus,
    pendingSellerReview: rows.filter(row => reviewStatuses.has(row.status)).length,
    platformArbitrationInProgress: rows.filter(row => row.arbitrationStatus === 'IN_PROGRESS').length,
    exactOrderAndSkuMatches: rows.filter(row => row.matchedLines).length, rows };
}

export async function readOpenAfterSales(client, token, shop) {
  const filters = [
    { key: 'pending_return_or_refund', matches: row => row.status === 'RETURN_OR_REFUND_REQUEST_PENDING' },
    { key: 'in_arbitration', matches: row => row.arbitrationStatus === 'IN_PROGRESS' },
  ];
  const lists = await Promise.all(filters.map(async ({ key, matches }) => {
    const requestIds = [];
    const page = await collectPages(async cursor => {
      const data = await client.openReturnsPage(token, shop, key, cursor);
      if (!data.requestId || data.rows.some(row => !isPlatformId(row.id) || !isPlatformId(row.orderId) || !matches(row))) {
        throw new Error('Open aftersales response does not match the requested state');
      }
      requestIds.push(data.requestId);
      return data;
    }, Date.now() + 60_000);
    if (page.totalCount !== page.rows.length) throw new Error('Incomplete open aftersales list');
    return { key, requestIds, count: page.rows.length, pages: page.pages, rows: page.rows };
  }));
  const cases = new Map();
  for (const list of lists) {
    for (const row of list.rows) {
      const existing = cases.get(row.id);
      if (existing && (existing.orderId !== row.orderId || existing.updatedAt !== row.updatedAt ||
          existing.status !== row.status || existing.arbitrationStatus !== row.arbitrationStatus)) {
        throw new Error('Open aftersales case changed during the read');
      }
      cases.set(row.id, row);
    }
  }
  const orders = new Map((await readOrders(client, token, shop, [...new Set([...cases.values()].map(row => row.orderId))]))
    .map(row => [row.id, row]));
  const rows = [];
  for (const row of cases.values()) {
    const order = orders.get(row.orderId);
    const lines = new Map(order?.lines?.map(line => [line.id, line.skuId]) ?? []);
    const exact = Boolean(row.lines?.length && row.lines.every(line => isPlatformId(line.orderLineId) &&
      isPlatformId(line.skuId) && lines.get(line.orderLineId) === line.skuId));
    rows.push({ returnId: row.id, orderId: row.orderId, updatedAt: row.updatedAt, status: row.status,
      arbitrationStatus: row.arbitrationStatus, amount: row.amount, currency: row.currency, exact,
      decisionEligibility: exact ? await inspect(() => client.returnDecisionEligibility(token, shop, row.id)) : null });
  }
  return { lists: lists.map(({ rows: _, ...list }) => list), distinctCases: rows.length,
    replacementAndExchangeCoverage: 'recent_update_window_only',
    exactMatches: rows.filter(row => row.exact).length, rows };
}

export async function readCustomerInbox(client, token, shop) {
  const seen = new Set();
  let firstPage;
  const projectPage = data => {
    if (!Array.isArray(data.conversations) || data.conversations.some(row => !isPlatformId(row.id)) ||
        (data.next_page_token != null && typeof data.next_page_token !== 'string')) {
      throw new Error('Conversation page incomplete');
    }
    return data.conversations.map(row => ({
      id: row.id, unreadCount: Number.isSafeInteger(row.unread_count) && row.unread_count >= 0 ? row.unread_count : null,
      canSend: typeof row.can_send_message === 'boolean' ? row.can_send_message : null,
      latestMessageId: isPlatformId(row.latest_message?.id) ? row.latest_message.id : null,
      latestAt: Number.isSafeInteger(row.latest_message?.create_time) ? row.latest_message.create_time : null,
      latestRole: row.latest_message?.sender?.role ?? null,
    }));
  };
  const inbox = await collectPages(async cursor => {
    const data = await client.customerServiceConversations(token, shop, cursor);
    const rows = projectPage(data);
    if (!cursor) firstPage = rows;
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error('Conversation list changed during paging');
      seen.add(row.id);
    }
    return { rows, totalCount: null, nextToken: data.next_page_token ?? '' };
  }, Date.now() + 180_000);
  const rechecked = projectPage(await client.customerServiceConversations(token, shop));
  if (JSON.stringify(firstPage) !== JSON.stringify(rechecked)) throw new Error('Conversation list changed during readback');
  const rows = inbox.rows;
  const unreadKnown = rows.every(row => row.unreadCount !== null);
  return { rows, summary: { coverage: 'all_cursor_pages', count: rows.length, pages: inbox.pages, morePages: false,
    unreadConversations: unreadKnown ? rows.filter(row => row.unreadCount > 0).length : null,
    unreadMessages: unreadKnown ? rows.reduce((count, row) => count + row.unreadCount, 0) : null,
    unreadReplyable: unreadKnown && rows.every(row => row.canSend !== null)
      ? rows.filter(row => row.unreadCount > 0 && row.canSend).length : null,
    replyableConversations: rows.every(row => row.canSend !== null) ? rows.filter(row => row.canSend).length : null } };
}

async function reviewCustomerCases(client, token, shop, rows) {
  const unread = rows.filter(row => row.unreadCount > 0).sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0));
  const samples = unread.slice(0, 50);
  if (samples.length < 4) samples.push(...rows.filter(row => row.unreadCount === 0).slice(0, 4 - samples.length));
  const cases = [];
  for (const row of samples) {
    const result = await inspect(async () => {
      const data = await client.customerServiceMessages(token, shop, row.id);
      if (!Array.isArray(data.messages)) throw new Error('Conversation message page incomplete');
      return { messagesScanned: data.messages.length, moreMessages: Boolean(data.next_page_token), orderIds: linkedOrderIds(data.messages) };
    });
    cases.push({ conversationId: row.id, unread: row.unreadCount > 0, unreadCount: row.unreadCount,
      canSend: row.canSend, latestRole: row.latestRole, available: result.available, error: result.error ?? null,
      messagesScanned: result.data?.messagesScanned ?? null, moreMessages: result.data?.moreMessages ?? null,
      orderIds: result.data?.orderIds ?? [] });
  }
  const ids = [...new Set(cases.flatMap(row => row.orderIds))];
  const details = await readOrders(client, token, shop, ids);
  const orders = new Map(details.map(row => [row.id, row]));
  let returnedOrders = 0;
  const afterSales = await inspect(async () => {
    const cancellations = new Map();
    for (let offset = 0; offset < details.length; offset += 20) {
      const cohort = details.slice(offset, offset + 20).map(row => row.id);
      const deadline = Date.now() + 60_000;
      const [result, cancellationPage] = await Promise.all([
        collectPages(cursor => client.returnsPage(token, shop, cohort, cursor), deadline),
        collectPages(cursor => client.cancellationsPage(token, shop, cohort, cursor), deadline),
      ]);
      if (result.rows.some(row => !cohort.includes(row.orderId))) throw new Error('Return record did not match the requested orders');
      returnedOrders += new Set(result.rows.map(row => row.orderId)).size;
      for (const row of cancellationPage.rows) {
        if (cancellations.has(row.id)) throw new Error('Duplicate cancellation record');
        cancellations.set(row.id, row);
      }
    }
    const cancellationRecords = [...cancellations.values()];
    return { ordersChecked: details.length, ordersWithReturnRecords: returnedOrders,
      ordersWithCancellationRecords: new Set(cancellationRecords.map(row => row.orderId)).size, cancellationRecords };
  });
  const unreadChecked = cases.filter(row => row.unread && row.available).length;
  return { conversationsChecked: cases.filter(row => row.available).length, unreadChecked, unreadNotChecked: unread.length - unreadChecked,
    unreadWithVerifiedOrder: cases.filter(row => row.unread && row.orderIds.some(id => orders.has(id))).length,
    linkedOrderCards: cases.filter(row => row.orderIds.length).length, distinctOrderIds: ids.length,
    orderDetailsConfirmed: orders.size, afterSales,
    cases: cases.map(({ orderIds, ...row }) => ({ ...row, orderCardCount: orderIds.length,
      orders: orderIds.map(id => ({ id, status: orders.get(id)?.status ?? null })) })) };
}

async function inspect(read) {
  try {
    return { available: true, data: await read() };
  } catch (error) {
    return { available: false, error: publicPlatformError(error, error.message), code: error.platformCode ?? null };
  }
}

async function main({ openOnly = false } = {}) {
  const [credentials, authorization] = await Promise.all([loadLocalAppCredentials(), loadLocalAuthorization()]);
  const { tokens } = authorization;
  if (credentials.serviceId !== authorization.serviceId || tokens?.user_type !== 0 || !tokens.access_token) {
    throw new Error('Matching TikTok Shop seller authorization is required');
  }
  const requests = [];
  const client = createTikTokClient({ ...credentials, async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    const path = url.pathname.replace(/\/conversations\/\d+\/messages$/u, '/conversations/{conversation_id}/messages');
    requests.push({ method: options.method, path, status: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const token = tokens.access_token;
  const shop = (await client.authorizedShops(token)).find(row => row.id === shopId && row.region === 'MY' && row.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia Cross1 shop is required');
  const now = new Date();
  const day = dayKey(now);
  if (openOnly) {
    const openAfterSales = await readOpenAfterSales(client, token, shop);
    const observedAt = new Date().toISOString();
    const directory = join(output, day);
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'open-aftersales-' + observedAt.replace(/[:.]/gu, '-') + '.json');
    const receipt = { schema: 'operations-open-aftersales-read/v1', day, observedAt,
      shop: { id: shop.id, name: shop.name, region: shop.region }, openAfterSales, requests, writes: 0 };
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ file, ...receipt }));
    return;
  }
  const priorDay = new Date(Date.parse(day + 'T00:00:00Z') - 7 * 86_400_000).toISOString().slice(0, 10);
  const end = Math.floor(now.getTime() / 1000);
  const start = end - 7 * 86_400;
  const [inbox, performance, queue, returns, openAfterSales] = await Promise.all([
    inspect(() => readCustomerInbox(client, token, shop)),
    inspect(async () => {
      const data = await client.customerServicePerformance(token, shop, priorDay, day);
      if (!data.performance || typeof data.performance !== 'object') throw new Error('Customer service performance incomplete');
      return { startInclusive: priorDay, endExclusive: day, performance: data.performance };
    }),
    inspect(async () => {
      const result = await collectPages(async cursor => {
        const data = await client.processingPackages(token, shop, start, end, cursor);
        if (!Array.isArray(data.packages) || data.packages.some(row => row.status !== 'PROCESSING' || !isPlatformId(row.id))) {
          throw new Error('Processing package page incomplete or inconsistent');
        }
        return { rows: data.packages, totalCount: data.total_count, nextToken: data.next_page_token };
      }, Date.now() + 60_000);
      if (result.totalCount !== result.rows.length || new Set(result.rows.map(row => row.id)).size !== result.rows.length) {
        throw new Error('Processing package count does not match the complete result');
      }
      return { rows: result.rows, summary: { startInclusive: start, endExclusive: end, processingPackages: result.rows.length, pages: result.pages } };
    }),
    inspect(() => reviewReturnWindow(client, token, shop, start, end)),
    inspect(() => readOpenAfterSales(client, token, shop)),
  ]);
  const [caseLinkage, packageOrderLinkage] = await Promise.all([
    inbox.available ? inspect(() => reviewCustomerCases(client, token, shop, inbox.data.rows)) : null,
    queue.available ? inspect(async () => {
      const ids = [...new Set(queue.data.rows.flatMap(row => row.orders?.map(order => order.id) ?? []))];
      if (!ids.every(isPlatformId)) throw new Error('Processing packages contain invalid order references');
      const details = await readOrders(client, token, shop, ids);
      const linkage = reconcilePackageOrders(queue.data.rows, details);
      const warehouses = await inspect(async () => {
        if (!linkage.distinctWarehouseIds.length) return [];
        const data = await client.listingWarehouses(token, shop);
        if (!Array.isArray(data.warehouses)) throw new Error('Warehouse list incomplete');
        return linkage.distinctWarehouseIds.map(id => {
          const warehouse = data.warehouses.find(row => row.id === id);
          return { id, type: warehouse?.type ?? null, subtype: warehouse?.sub_type ?? null,
            linkedOrders: details.filter(order => order.warehouseId === id).length };
        });
      });
      const collection = await verifyCollectionDetails(client, token, shop, queue.data.rows, details, linkage, end);
      return { ...linkage, warehouses, collection };
    }) : null,
  ]);
  const conversations = inbox.available ? { available: true, data: inbox.data.summary } : inbox;
  const packages = queue.available ? { available: true, data: queue.data.summary } : queue;
  const observedAt = new Date().toISOString();
  const receipt = { schema: 'operations-service-fulfillment-read/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, conversations, performance, packages,
    caseLinkage, packageOrderLinkage, returns, openAfterSales, requests };
  const directory = join(output, day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, ...receipt }, null, 2));
  if ([conversations, performance, packages, caseLinkage, packageOrderLinkage, returns].some(row => !row?.available) ||
      caseLinkage?.data?.afterSales?.available === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main({ openOnly: process.argv.slice(2).includes('--open-aftersales') }).catch(error => {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  });
}
