import { isExpiredAccessToken } from './tiktok-shop-read.mjs';

export class SnapshotError extends Error {}

export function createAuthorizationAccess({ serviceId, client, loadAuthorization, saveAuthorization, now, expectedUserType }) {
  let active;
  let queue = Promise.resolve();

  function serialize(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }

  function verifyTokenType(tokens) {
    if (expectedUserType !== undefined && tokens?.user_type !== expectedUserType) {
      throw new Error('Authorization token type does not match this flow');
    }
  }

  function install(tokens) {
    return serialize(async () => {
      verifyTokenType(tokens);
      const record = { serviceId, tokens };
      await saveAuthorization(record);
      active = { record, pendingSave: false };
      return active;
    });
  }

  function restore() {
    return serialize(async () => {
      if (active) return active;
      const record = await loadAuthorization();
      if (record?.serviceId !== serviceId || typeof record.tokens?.access_token !== 'string' ||
          !record.tokens.access_token) throw new Error('Local authorization unavailable');
      verifyTokenType(record.tokens);
      active = { record, pendingSave: false };
      return active;
    });
  }

  function token(authorization, rejectedToken) {
    return serialize(async () => {
      if (authorization !== active) throw new Error('Authorization has changed');
      if (active.pendingSave) {
        await saveAuthorization(active.record);
        active.pendingSave = false;
      }
      const tokens = active.record.tokens;
      const current = Math.floor(now() / 1000);
      const expiring = Number.isSafeInteger(tokens.access_token_expire_in) && tokens.access_token_expire_in <= current + 300;
      if (!expiring && tokens.access_token !== rejectedToken) return tokens.access_token;
      if (!tokens.refresh_token || (Number.isSafeInteger(tokens.refresh_token_expire_in) &&
          tokens.refresh_token_expire_in <= current)) throw new Error('Refresh authorization unavailable');
      const updated = await client.refresh(tokens.refresh_token);
      verifyTokenType(updated);
      active.record = { serviceId, tokens: updated };
      active.pendingSave = true;
      await saveAuthorization(active.record);
      active.pendingSave = false;
      return updated.access_token;
    });
  }

  async function read(authorization, action) {
    const accessToken = await token(authorization);
    try {
      return await action(accessToken);
    } catch (error) {
      if (!isExpiredAccessToken(error)) throw error;
      return action(await token(authorization, accessToken));
    }
  }

  return { install, restore, read };
}

export async function collectPages(fetchPage, deadline) {
  const rows = new Map();
  const cursors = new Set();
  let cursor;
  let totalCount = null;
  for (let pages = 1; pages <= 200; pages += 1) {
    if (Date.now() >= deadline) throw new SnapshotError('同步超时，本次未生成快照。');
    const page = await fetchPage(cursor);
    if (page.totalCount !== null) {
      if (totalCount !== null && totalCount !== page.totalCount) throw new SnapshotError('分页期间平台总数变化，请重新同步。');
      totalCount = page.totalCount;
    }
    for (const row of page.rows) {
      if (!row.id) throw new SnapshotError('平台返回的记录缺少 ID。');
      rows.set(row.id, row);
    }
    if (!page.nextToken) {
      if (totalCount !== null && totalCount !== rows.size) throw new SnapshotError('去重后的记录数与平台报告总数不一致。');
      return { pages, totalCount, rows: [...rows.values()] };
    }
    if (cursors.has(page.nextToken)) throw new SnapshotError('平台返回了重复分页游标。');
    cursors.add(page.nextToken);
    cursor = page.nextToken;
  }
  throw new SnapshotError('同步超过本次分页上限。');
}

const orderDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });

function paymentCents(value) {
  const amount = /^(\d+)(?:\.(\d{1,2})0*)?$/u.exec(value ?? '');
  return amount ? BigInt(amount[1]) * 100n + BigInt((amount[2] ?? '').padEnd(2, '0')) : null;
}

function summarizeOrderActivity({ orders, orderWindow, requestIds, observedAt }) {
  const { startInclusive, endExclusive } = orderWindow;
  const day = orderDay.format(endExclusive * 1000);
  const dayStart = Date.parse(day + 'T00:00:00+08:00') / 1000;
  if (startInclusive > dayStart || endExclusive <= dayStart || orders.totalCount !== orders.rows.length ||
      requestIds.length !== orders.pages || new Set(requestIds).size !== orders.pages || requestIds.some(id => !id) ||
      orders.rows.some(row => !Number.isSafeInteger(row.createdAt) || row.createdAt < startInclusive ||
        row.createdAt >= endExclusive || !Object.hasOwn(row, 'paidAt'))) return null;
  const paid = orders.rows.filter(row => row.paidAt >= dayStart && row.paidAt < endExclusive);
  const paidOrders = paid.filter(row => row.sampleOrder === false);
  const amounts = paidOrders.map(row => row.currency === 'MYR' ? paymentCents(row.buyerPayment) : null);
  const unknownSamplePayments = paid.filter(row => row.sampleOrder === null).length;
  const unknownAmounts = amounts.filter(value => value === null).length;
  const complete = unknownSamplePayments === 0 && unknownAmounts === 0;
  const cents = complete ? amounts.reduce((total, value) => total + value, 0n) : null;
  return { day, currency: 'MYR', paidOrders: paidOrders.length,
    buyerPayment: cents === null ? null : `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
    paymentCoverage: complete ? 'complete_for_order_window' : 'partial',
    unknownSamplePayments, unknownAmounts, observedAt, window: orderWindow, requestIds };
}

export async function readShopPaymentWindow({ client, shop, read, now, deadline = Date.now() + 45_000 }) {
  const endExclusive = Math.floor(now() / 1000);
  const startInclusive = endExclusive - 7 * 24 * 60 * 60;
  const orderWindow = { startInclusive, endExclusive };
  const includePaymentEvidence = shop.region === 'MY';
  const requestIds = [];
  const orders = await collectPages(async cursor => {
    const page = await read(token => client.ordersPage(token, shop, 100, cursor, startInclusive, endExclusive,
      { includePaymentEvidence }));
    requestIds.push(page.requestId);
    return page;
  }, deadline);
  const orderActivity = includePaymentEvidence
    ? summarizeOrderActivity({ orders, orderWindow, requestIds, observedAt: new Date(now()).toISOString() }) : null;
  return { orderActivity, orderWindow, orders: { ...orders, rows: orders.rows.map(({
    paidAt, cashOnDelivery, currency, buyerPayment, ...order
  }) => order) } };
}

export async function syncSkuSnapshot({ client, shop, read, now }) {
  const cutoff = now();
  const deadline = Date.now() + 150_000;
  const products = await collectPages(cursor => read(token => client.productsPage(token, shop, 100, cursor)), deadline);
  const { orders, orderWindow, orderActivity } = await readShopPaymentWindow({ client, shop, read, now: () => cutoff, deadline });
  const skuIndex = new Map();
  for (const product of products.rows) {
    for (const sku of product.skus ?? []) {
      if (!sku.id) continue;
      const knownProduct = skuIndex.get(sku.id);
      skuIndex.set(sku.id, knownProduct === undefined || knownProduct === product.id ? product.id : null);
    }
  }
  let matchedOrderLines = 0;
  let unmatchedOrderLines = 0;
  let ordersWithoutLines = 0;
  for (const order of orders.rows) {
    if (!order.skus?.length) ordersWithoutLines += 1;
    for (const line of order.skus ?? []) {
      const product = skuIndex.get(line.id);
      if (product && (!line.productId || line.productId === product)) matchedOrderLines += 1;
      else unmatchedOrderLines += 1;
    }
  }
  return {
    schemaVersion: 1,
    source: 'TikTok Shop Open API',
    collectedAt: new Date(now()).toISOString(),
    shop: { id: shop.id, name: shop.name ?? null, region: shop.region },
    orderWindow,
    orderActivity,
    products,
    orders,
    skuCoverage: { matchedOrderLines, unmatchedOrderLines, ordersWithoutLines },
  };
}
