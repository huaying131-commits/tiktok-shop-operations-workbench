import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalAppCredentials, loadLocalAuthorization } from './tiktok-auth.mjs';
import { createTikTokClient, publicPlatformError } from './tiktok-shop-read.mjs';
import { snapshotFilename } from './tiktok-shop-finance.mjs';
import { listNames, readJson } from './operations-board-evidence.mjs';

const shopId = '9000000000000000099';
const discountTypes = new Set(['FIXED_PRICE', 'DIRECT_DISCOUNT', 'FLASHSALE']);
const dataDirectory = fileURLToPath(new URL('./data/', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function ongoingDiscounts(client, token, shop) {
  const ids = new Map();
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const data = await client.promotionActivities(token, shop, cursor);
    if (!Array.isArray(data.activities)) throw new Error('活动列表格式待核。');
    for (const row of data.activities) {
      if (!row.id || typeof row.activity_type !== 'string' || row.status !== 'ONGOING') {
        throw new Error('活动状态或 ID 待核。');
      }
      if (discountTypes.has(row.activity_type)) ids.set(row.id, row.activity_type);
    }
    const next = data.next_page_token;
    if (!next) return ids;
    if (typeof next !== 'string' || seenCursors.has(next)) throw new Error('活动分页结果待核。');
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error('活动读取超过本次分页范围。');
}

export function summarizeCoverage(catalog, activities) {
  const active = catalog.products.rows.filter(product => product.status === 'ACTIVATE');
  const wholeProducts = new Set();
  const variations = new Map();
  const latestEndsAt = new Map();
  for (const activity of activities) {
    if (!Array.isArray(activity.products) || !['PRODUCT', 'VARIATION'].includes(activity.product_level)) {
      throw new Error('活动商品关系待核。');
    }
    for (const item of activity.products) {
      if (typeof item.id !== 'string' || !item.id) throw new Error('活动商品 ID 待核。');
      if (activity.product_level === 'PRODUCT') wholeProducts.add(item.id);
      else {
        if (!Array.isArray(item.skus)) throw new Error('活动 SKU 关系待核。');
        const current = variations.get(item.id) ?? new Set();
        for (const sku of item.skus) {
          if (typeof sku.id !== 'string' || !sku.id) throw new Error('活动 SKU ID 待核。');
          current.add(sku.id);
        }
        variations.set(item.id, current);
      }
      const ends = activity.end_time > 1e12 ? activity.end_time : activity.end_time * 1000;
      if (Number.isFinite(ends) && ends > (latestEndsAt.get(item.id) ?? 0)) latestEndsAt.set(item.id, ends);
    }
  }
  return active.map(product => {
    const skus = product.skus ?? [];
    const wholeProduct = wholeProducts.has(product.id);
    const activitySkus = variations.get(product.id);
    const coveredSkus = wholeProduct ? skus.length : skus.filter(sku => activitySkus?.has(sku.id)).length;
    const coverage = wholeProduct || (skus.length && coveredSkus === skus.length) ? 'all' :
      coveredSkus ? 'some' : activitySkus?.size ? 'needsSkuCheck' : 'none';
    return { id: product.id, title: product.title, skuCount: skus.length, coveredSkus, coverage,
      latestEndsAt: latestEndsAt.has(product.id) ? new Date(latestEndsAt.get(product.id)).toISOString() : null };
  });
}

function addCostCoverage(rows, catalog, registry) {
  const priceIds = new Map();
  const confirmed = new Set((registry?.confirmed_records ?? []).filter(entry =>
    entry.market === 'MY' && Number.isFinite(Number(entry.cost_cny)) && Number(entry.cost_cny) > 0)
    .map(entry => entry.price_id));
  for (const match of registry?.shop_matches ?? []) {
    if (match.market !== 'MY' || !match.product_id || !match.sku_id) continue;
    const key = match.product_id + ':' + match.sku_id;
    const ids = priceIds.get(key) ?? new Set();
    ids.add(match.price_id);
    priceIds.set(key, ids);
  }
  const products = new Map(catalog.products.rows.map(product => [product.id, product]));
  return rows.map(row => ({ ...row, costMatchedSkus: (products.get(row.id)?.skus ?? []).filter(sku => {
    const ids = priceIds.get(row.id + ':' + sku.id);
    return ids?.size === 1 && confirmed.has(ids.values().next().value);
  }).length }));
}

async function recentCatalog(directory) {
  const catalogDirectory = join(directory, 'tiktok-shop', shopId);
  const filename = (await listNames(catalogDirectory)).filter(name => snapshotFilename.test(name)).sort().at(-1);
  if (!filename) throw new Error('需要本店铺近期商品快照。');
  return readJson(join(catalogDirectory, filename));
}

export async function auditShopPromotions({ catalog, directory = dataDirectory, root = projectRoot } = {}) {
  const [shopCatalog, credentials, authorization, followthrough, registry] = await Promise.all([
    catalog ?? recentCatalog(directory),
    loadLocalAppCredentials(join(directory, 'tiktok-auth')), loadLocalAuthorization(join(directory, 'tiktok-auth')),
    readJson(join(root, 'operations', 'product-operations', 'followthrough-summary.json')),
    readJson(join(root, 'pricing', 'price-registry.json')),
  ]);
  if (shopCatalog?.shop?.id !== shopId || shopCatalog.shop.region !== 'MY' || !Array.isArray(shopCatalog.products?.rows) ||
      !Number.isFinite(Date.parse(shopCatalog.collectedAt)) || Date.now() - Date.parse(shopCatalog.collectedAt) > 60 * 60_000) {
    throw new Error('需要本店铺一小时内的商品快照。');
  }
  const tokens = authorization.tokens;
  const scope = tokens?.granted_scopes;
  if (credentials.serviceId !== authorization.serviceId || !tokens?.access_token ||
      (Array.isArray(scope) && !scope.includes('seller.promotion.info'))) throw new Error('本店铺促销读取授权待核。');
  if (tokens.access_token_expire_in <= Math.floor(Date.now() / 1000) + 300) {
    throw new Error('请先通过现有授权服务同步店铺，再读取促销。');
  }
  const client = createTikTokClient(credentials);
  const token = tokens.access_token;
  const shop = (await client.authorizedShops(token)).find(entry => entry.id === shopId && entry.region === 'MY');
  if (!shop) throw new Error('授权店铺与 MY 跨一不一致。');
  const matches = await ongoingDiscounts(client, token, shop);
  const details = [];
  for (const [id, type] of matches) {
    const activity = await client.promotionActivity(token, shop, id);
    if (activity.status !== 'ONGOING' || activity.activity_type !== type) throw new Error('读取期间活动状态改变。');
    details.push(activity);
  }
  const rows = addCostCoverage(summarizeCoverage(shopCatalog, details), shopCatalog, registry);
  const covered = rows.filter(row => row.coverage === 'all' || row.coverage === 'some');
  const uncovered = rows.filter(row => row.coverage === 'none');
  const recent = followthrough?.latest_20261111_kite_classroom_two_verified_live_five_and_copy_actual;
  const priorityLabels = new Map([[recent?.kite?.productId, '新品风筝'], [recent?.classroom?.productId, '课堂实验套件']]);
  const priority = rows.filter(row => priorityLabels.has(row.id) && row.coverage !== 'all')
    .map(row => ({ label: priorityLabels.get(row.id), ...row }));
  const result = {
    state: 'verified', checkedAt: new Date().toISOString(), catalogAt: shopCatalog.collectedAt, shop: shopCatalog.shop.name,
    source: 'TikTok Shop Open API · 进行中的商家商品折扣和秒杀关系', ongoingActivities: details.length,
    activeProducts: rows.length, coveredProducts: covered.length, uncoveredProducts: uncovered.length,
    partialProducts: rows.filter(row => row.coverage === 'some').length,
    unknownProducts: rows.filter(row => row.coverage === 'needsSkuCheck').length,
    uncoveredWithCosts: registry ? uncovered.filter(row => row.costMatchedSkus > 0).length : null,
    priority, rows,
  };
  const outputDirectory = join(directory, 'operations-board');
  await mkdir(outputDirectory, { recursive: true });
  const temporary = join(outputDirectory, randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(result) + '\n', { flag: 'wx' });
    await rename(temporary, join(outputDirectory, 'promotion.json'));
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  auditShopPromotions().then(({ rows, priority, ...result }) => {
    console.log(JSON.stringify({ ...result, priority: priority.map(({ label, coverage }) => ({ label, coverage })) }));
  }).catch(error => {
    console.error(publicPlatformError(error, error instanceof TypeError ? '活动接口响应待核。' : error.message));
    process.exitCode = 1;
  });
}
