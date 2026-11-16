import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { readOperationsDashboard } from '../../apps/customer-service/operations-dashboard-data.mjs';
import { dashboardCoverHosts } from '../../apps/customer-service/operations-dashboard-images.mjs';
import { publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { readShopPaymentWindow } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { readShopChannelPerformance } from './run-daily-work.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const maxImageBytes = 12 * 1024 * 1024;
const timestamp = () => new Date().toISOString();
const fileTimestamp = iso => iso.replace(/[:.]/g, '-');

function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function download(image) {
  for (const rawUrl of image.urls ?? []) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || !dashboardCoverHosts.has(url.hostname) || url.username || url.password || url.port) continue;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const contentType = response.headers.get('content-type')?.split(';')[0].trim();
      if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ||
          Number(response.headers.get('content-length')) > maxImageBytes || !response.body) {
        await response.body?.cancel();
        continue;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > maxImageBytes) throw new Error('Product image exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, length);
      if (imageType(bytes) === contentType) return { bytes, contentType, host: url.hostname };
    } catch {
      // The same official image can have an alternate CDN URL.
    }
  }
  return null;
}

async function saveJson(folder, name, value) {
  await mkdir(folder, { recursive: true });
  const pending = join(folder, randomUUID() + '.tmp');
  try {
    await writeFile(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(pending, join(folder, name));
  } finally {
    await unlink(pending).catch(() => {});
  }
}

async function cover(session, productId) {
  const { client, token, shop } = session;
  const { data, requestId } = await client.productDetail(token, shop, productId, { includeRequestId: true });
  if (!requestId || data.id !== productId || data.status !== 'ACTIVATE' || data.audit?.status !== 'APPROVED') {
    return { productId, state: 'product_not_verified_active' };
  }
  const image = data.main_images?.[0];
  if (typeof image?.uri !== 'string' || !image.uri) return { productId, state: 'main_image_missing' };
  const downloaded = await download(image);
  if (!downloaded) return { productId, state: 'main_image_download_unavailable' };
  const observedAt = timestamp();
  const filename = fileTimestamp(observedAt) + '-' + randomUUID() + '.image';
  const folder = join(workspace, 'outputs', 'operations-dashboard-product-covers', productId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, filename), downloaded.bytes, { flag: 'wx' });
  await saveJson(folder, 'latest.json', { schema: 'operations-dashboard-product-cover/v1',
    shop: { id: shop.id, name: shop.name, region: shop.region }, productId, observedAt, requestId,
    image: { position: 0, kind: 'product_main_image', uri: image.uri, filename, host: downloaded.host, contentType: downloaded.contentType,
      size: downloaded.bytes.length, sha256: createHash('sha256').update(downloaded.bytes).digest('hex') }, writes: 0 });
  return { productId, state: 'downloaded', requestId };
}

async function todayStatus(session, day) {
  const { client, token, shop } = session;
  const end = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  try {
    const { data, requestId } = await client.shopPerformance(token, shop, day, end, '1D');
    const intervals = data.performance?.intervals;
    const latestAvailableDate = /^\d{4}-\d{2}-\d{2}$/.test(data.latest_available_date ?? '') ? data.latest_available_date : null;
    if (requestId && latestAvailableDate && latestAvailableDate < day) {
      return { state: 'report_pending', latestAvailableDate, requestId };
    }
    const row = intervals?.[0];
    if (!requestId || !latestAvailableDate || latestAvailableDate < day || !Array.isArray(intervals) || intervals.length !== 1 ||
        row.start_date !== day || row.end_date !== end || row.sales?.gmv?.currency !== 'MYR' ||
        !/^\d+(?:\.\d{1,2})?$/u.test(row.sales.gmv.amount ?? '') ||
        !Number.isSafeInteger(row.sales.orders_count) || row.sales.orders_count < 0) {
      return { state: 'day_not_verified', latestAvailableDate, requestId: requestId ?? null };
    }
    return { state: 'official_same_day_snapshot', latestAvailableDate, requestId, day,
      gmv: row.sales.gmv.amount, orders: row.sales.orders_count };
  } catch (error) {
    return { state: 'day_read_unavailable', error: publicPlatformError(error, '今日店铺分析暂不可读') };
  }
}

const day = dayKey(new Date());
const { values } = parseArgs({ options: { 'covers-only': { type: 'boolean' }, 'sales-only': { type: 'boolean' },
  'orders-only': { type: 'boolean' } } });
if (Object.values(values).filter(Boolean).length > 1) throw new Error('Choose one dashboard source to read');
const session = await openMyShopSession(shopId);
async function saveSalesRead(fields) {
  const observedAt = timestamp();
  const directory = join(workspace, 'outputs', 'operations-dashboard-shop-performance', day);
  const file = 'official-read-' + fileTimestamp(observedAt) + '.json';
  await saveJson(directory, file, { schema: 'operations-dashboard-shop-performance/v1',
    shop: { id: session.shop.id, name: session.shop.name, region: session.shop.region }, day, observedAt, ...fields, writes: 0 });
  return join(directory, file);
}

if (values['orders-only']) {
  const { client, shop, token } = session;
  const { orderActivity, orders } = await readShopPaymentWindow({ client, shop, read: action => action(token), now: Date.now });
  if (!orderActivity || orderActivity.day !== day) throw new Error('Current paid-order evidence could not be verified');
  const orderStatus = {
    observedAt: orderActivity.observedAt,
    pendingShipment: orders.rows.filter(order => order.status === 'AWAITING_SHIPMENT').length,
    awaitingCollection: orders.rows.filter(order => order.status === 'AWAITING_COLLECTION').length,
  };
  console.log(JSON.stringify({ receipt: await saveSalesRead({ orderActivity, orderStatus }), orderActivity, orderStatus }));
} else if (!values['covers-only']) {
  const today = await todayStatus(session, day);
  let analytics = null;
  try {
    analytics = await readShopChannelPerformance(session, day, 14);
  } catch (error) {
    console.error(publicPlatformError(error, '完整店铺分析暂不可读'));
  }
  console.log(JSON.stringify({ receipt: await saveSalesRead({ analytics, today }), analytics: analytics?.window ?? null, today }));
  if (values['sales-only'] && !analytics && today.state !== 'official_same_day_snapshot') process.exitCode = 2;
}
if (!values['sales-only'] && !values['orders-only']) {
  const { productRank } = await readOperationsDashboard({ day });
  const productIds = (productRank?.rows ?? []).slice(0, 6).map(row => row.productId);
  const covers = [];
  for (const productId of productIds) {
    try {
      covers.push(await cover(session, productId));
    } catch (error) {
      covers.push({ productId, state: publicPlatformError(error, '商品主图暂不可读') });
    }
  }
  console.log(JSON.stringify({ covers, writes: 0 }));
  if (!covers.some(row => row.state === 'downloaded')) process.exitCode = 2;
}
