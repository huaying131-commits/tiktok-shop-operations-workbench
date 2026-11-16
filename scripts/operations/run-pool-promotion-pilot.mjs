import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError, signTikTokShopUrl } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { shopWriteJournal } from './shop-write-journal.mjs';
import { planFixedPriceActivity, reviewActivity } from './verify-promotion-outcome.mjs';

const shopId = '9000000000000000099';
const sellerSku = 'MY-EXAMPLE-POOL-001';
const root = resolve('outputs/operations-listing-shadow/pool-pilot-2026-11-13');
const directory = join(root, 'promotion');
const title = 'Pool 9pc launch 20261113';
const { read, record, writeOnce } = shopWriteJournal(directory);

async function main() {
  const mode = process.argv[2];
  if (!['--submit', '--check'].includes(mode)) throw new Error('Use --submit or --check');
  if (process.platform === 'win32' && process.env.SystemRoot) {
    process.env.PSModulePath = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  await mkdir(directory, { recursive: true });
  const productReceipt = await shopWriteJournal(join(root, 'live')).read('create.result');
  const productId = productReceipt?.data?.product_id;
  const skuId = productReceipt?.data?.skus?.find(sku => sku.seller_sku === sellerSku)?.id;
  if (productReceipt?.code !== 0 || !isPlatformId(productId) || !isPlatformId(skuId)) throw new Error('Official listing receipt missing');

  const [credentials, { tokens }] = await Promise.all([loadLocalAppCredentials(), loadLocalAuthorization()]);
  if (tokens?.user_type !== 0 || !tokens.granted_scopes?.includes('seller.promotion.write')) throw new Error('Seller promotion-write scope unavailable');
  const token = tokens.access_token;
  const client = createTikTokClient(credentials);
  const shop = (await client.authorizedShops(token)).find(item => item.id === shopId && item.region === 'MY' && item.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia shop not authorized');

  const send = (method, path, fields) => {
    const body = JSON.stringify(fields);
    const url = signTikTokShopUrl({ ...credentials, path, query: { shop_cipher: shop.cipher }, body,
      timestamp: String(Math.floor(Date.now() / 1000)) });
    return fetch(url, { method, body, headers: { 'x-tts-access-token': token, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(20_000) });
  };

  let activityId = (await read('create.result'))?.data?.activity_id;
  let pilot = (await read('create.intent'))?.pilot;
  if (mode === '--submit') {
    const product = await client.productDetail(token, shop, productId);
    const sku = product.skus?.[0];
    if (product.id !== productId || product.status !== 'ACTIVATE' || product.audit?.status !== 'APPROVED' ||
        product.skus?.length !== 1 || sku.id !== skuId || sku.seller_sku !== sellerSku || Number(sku.price?.sale_price) !== 34.9) {
      throw new Error('Exact approved product with RM34.90 regular price is required');
    }

    if (!activityId) {
      if (pilot) throw new Error('Activity create already attempted. Reconcile by exact title.');
      for (const status of ['ONGOING', 'NOT_START']) {
        const page = await client.promotionActivities(token, shop, undefined, status);
        if (!Array.isArray(page.activities) || page.next_page_token) throw new Error('Activity lookup incomplete');
        for (const activity of page.activities) {
          if (activity.title === title) throw new Error('An activity with the pilot title already exists');
          const existing = await client.promotionActivity(token, shop, activity.id ?? activity.activity_id);
          if (existing.product_level === 'SHOP' || existing.products?.some(row => row.id === productId)) {
            throw new Error('An existing activity may cover the pilot SKU');
          }
        }
      }
      const begin = Math.ceil((Date.now() / 1000 + 180) / 60) * 60;
      const end = begin + 72 * 3600;
      pilot = { shopId, market: 'MY', productId, skuId, sellerSku, proposal: { activityType: 'FIXED_PRICE',
        activityPriceMYR: '29.90', totalQuantityLimit: 5, buyerQuantityLimit: 1,
        proposedStart: new Date(begin * 1000).toISOString(), proposedEnd: new Date(end * 1000).toISOString() } };
      const { create } = planFixedPriceActivity(pilot, title);
      const result = await writeOnce('create', { ...create, pilot }, () => send(create.method, create.path, create.body));
      activityId = result.activity_id;
    }
    if (!isPlatformId(activityId)) throw new Error('Activity ID missing');
    if (!pilot || pilot.productId !== productId || pilot.skuId !== skuId || pilot.sellerSku !== sellerSku) throw new Error('Original pilot identity mismatch');
    const { bind } = planFixedPriceActivity(pilot, title, activityId);
    await writeOnce('bind', bind, () => send(bind.method, bind.path, bind.body));
  }

  if (!pilot || !isPlatformId(activityId)) throw new Error('Activity receipt missing');
  const readback = reviewActivity(pilot, activityId, await client.promotionActivity(token, shop, activityId));
  const now = new Date().toISOString();
  await record('readback-' + now.replaceAll(':', '-'), { observedAt: now, pilot, ...readback });
  console.log(JSON.stringify({ ...readback, pilot }));
  if (readback.state === 'configuration_mismatch') process.exitCode = 1;
}

await main().catch(error => {
  console.error(publicPlatformError(error, error.cause?.code ?? error.message));
  process.exitCode = 1;
});
