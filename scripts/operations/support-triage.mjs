import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';

const activeReturns = new Set(['RETURN_OR_REFUND_REQUEST_PENDING', 'REPLACEMENT_REQUEST_PENDING', 'EXCHANGE_REQUEST_PENDING']);
const terminalCancellations = new Set(['CANCELLATION_REQUEST_COMPLETE', 'CANCELLATION_REQUEST_CANCELLED', 'CANCELLATION_REQUEST_CANCEL']);
const movingOrders = new Set(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'IN_TRANSIT']);
const deliveredOrders = new Set(['DELIVERED', 'COMPLETED']);

function conversationRoute(row, pendingCancellationOrderIds, unverifiedCancellationOrderIds) {
  if (!row.available) return 'conversation_context_unavailable';
  if (row.canSend !== true) return row.canSend === false ? 'platform_reply_disabled' : 'reply_permission_unverified';
  if (row.latestRole === 'SHOP') return 'recheck_latest_shop_reply';
  if (row.orders.length > 1) return 'choose_exact_order';
  if (pendingCancellationOrderIds.has(row.orders[0]?.id)) return 'check_pending_cancellation';
  if (unverifiedCancellationOrderIds.has(row.orders[0]?.id)) return 'check_cancellation_status';
  const status = row.orders[0]?.status;
  if (movingOrders.has(status)) return 'check_logistics_context';
  if (deliveredOrders.has(status)) return 'check_post_delivery_context';
  if (status) return 'check_order_context';
  return 'check_buyer_question_and_order';
}

function refundRoute(row) {
  if (row.matchedLines !== true) return 'verify_return_order_and_sku';
  if (row.arbitrationStatus === 'IN_PROGRESS') return 'review_platform_dispute';
  if (activeReturns.has(row.status)) return 'check_seller_review_deadline';
  if (row.status === 'BUYER_SHIPPED_ITEM') return 'check_warehouse_return_receipt';
  if (row.status === 'RETURN_OR_REFUND_REQUEST_COMPLETE') return 'reconcile_completed_refund';
  return 'check_platform_return_state';
}

function countByRoute(rows) {
  const counts = {};
  for (const row of rows) counts[row.route] = (counts[row.route] ?? 0) + 1;
  return counts;
}

export function reviewSupportTriage(receipt) {
  if (receipt.schema !== 'operations-service-fulfillment-read/v1' || receipt.shop?.id !== '9000000000000000099' ||
      receipt.shop.region !== 'MY' || receipt.shop.name !== 'example-shop-my') throw new Error('Exact MY Cross1 support receipt required');
  const inbox = receipt.conversations?.available ? receipt.conversations.data : null;
  const cases = receipt.caseLinkage?.available ? receipt.caseLinkage.data?.cases : null;
  const afterSales = receipt.caseLinkage?.data?.afterSales;
  const cancellations = afterSales?.available ? afterSales.data.cancellationRecords : null;
  if (cancellations != null && (!Array.isArray(cancellations) || cancellations.some(row => !isPlatformId(row.id) ||
      !isPlatformId(row.orderId) || typeof row.status !== 'string'))) throw new Error('Cancellation case identity incomplete');
  const pendingCancellationOrderIds = new Set(cancellations?.filter(row => row.status === 'CANCELLATION_REQUEST_PENDING')
    .map(row => row.orderId));
  const unverifiedCancellationOrderIds = new Set(cancellations?.filter(row => row.status !== 'CANCELLATION_REQUEST_PENDING' &&
    !terminalCancellations.has(row.status)).map(row => row.orderId));
  const returns = receipt.returns?.available ? receipt.returns.data : null;
  const conversations = cases?.filter(row => row.unread === true).map(row => {
    if (!isPlatformId(row.conversationId) || !Array.isArray(row.orders) || row.orders.some(order => !isPlatformId(order.id))) {
      throw new Error('Support case identity incomplete');
    }
    return { conversationId: row.conversationId, route: conversationRoute(row, pendingCancellationOrderIds, unverifiedCancellationOrderIds),
      platformCanSend: row.canSend ?? null,
      latestRole: row.latestRole ?? null, orderIds: row.orders.map(order => order.id), buyerIntentVerified: false };
  }) ?? null;
  const refundCases = returns?.rows?.map(row => {
    if (!isPlatformId(row.returnId) || !isPlatformId(row.orderId)) throw new Error('Return case identity incomplete');
    return { returnId: row.returnId, orderId: row.orderId, status: row.status, route: refundRoute(row),
      refundAmount: row.amount ?? null, currency: row.currency ?? null, sellerDeadline: row.sellerDeadline ?? null,
      availablePlatformDecisions: row.decisionEligibility?.available ? row.decisionEligibility.data.decisions
        .filter(decision => decision.eligible).map(decision => decision.decision) : null };
  }) ?? null;
  if ((conversations && new Set(conversations.map(row => row.conversationId)).size !== conversations.length) ||
      (refundCases && new Set(refundCases.map(row => row.returnId)).size !== refundCases.length)) throw new Error('Duplicate support case');
  return { state: 'historical_triage', observedAt: receipt.observedAt, inboxCoverage: inbox?.coverage ?? null,
    unreadInSnapshot: inbox?.unreadConversations ?? null, conversationsReviewed: conversations?.length ?? null,
    routes: conversations && countByRoute(conversations), conversations,
    ordersWithCancellationRecords: cancellations == null ? null : new Set(cancellations.map(row => row.orderId)).size,
    pendingCancellationOrders: cancellations == null ? null : pendingCancellationOrderIds.size,
    cancellationOrdersNeedingStatusReview: cancellations == null ? null : unverifiedCancellationOrderIds.size,
    returnWindow: returns ? { startInclusive: returns.startInclusive, endExclusive: returns.endExclusive } : null,
    returnRoutes: refundCases && countByRoute(refundCases), refundCases,
    customerMessagesSent: 0, markedRead: 0, refundsWritten: 0 };
}
