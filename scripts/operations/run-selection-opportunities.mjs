import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import defaults from '../../config/operations-trial-defaults.json' with { type: 'json' };
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const toyCategories = ['862472', '868360', '868744', '951688', '952328'];

function project(row) {
  return { id: row.id, title: row.title, type: row.opportunity_type,
    categoryId: row.category_id_level_3, category: row.category_name_level_3,
    queryWords: row.query_words ?? null, brand: row.brand_name ?? null,
    createdAt: row.create_time ?? null, expiresAt: row.expire_time ?? null, tagCodes: row.tag_codes ?? null,
    searchVolume: row.search_volume ?? null, estimatedMarketSales: row.est_market_sales_volume ?? null,
    estimatedMarketGmv: row.est_market_gmv ?? null, competitors: row.competitor_product_count ?? null };
}

async function opportunityGroup({ client, token, shop }, type, categoryIds) {
  const result = await collectPages(cursor => client.productOpportunityPage(token, shop, { type, categoryIds, cursor }), Date.now() + 50_000);
  if (result.rows.some(row => !categoryIds.includes(row.category_id_level_3))) throw new Error('Opportunity outside selected leaf categories');
  return { pages: result.pages, platformCount: result.totalCount, rows: result.rows.map(project) };
}

async function main() {
  const { values } = parseArgs({ options: { 'category-id': { type: 'string', multiple: true },
    'opportunity-id': { type: 'string', multiple: true } } });
  const categoryIds = [...new Set(values['category-id'] ?? toyCategories)];
  const opportunityIds = [...new Set(values['opportunity-id'] ?? [])];
  if (!categoryIds.every(id => /^\d{6,30}$/u.test(id)) || !opportunityIds.every(isPlatformId)) {
    throw new Error('Use exact leaf category and opportunity IDs');
  }
  const requests = [];
  const session = await openMyShopSession(defaults.shopId, { fetchApi: async (url, options) => {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ method: options.method, path: url.pathname, httpStatus: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const { client, token, shop } = session;
  const [product, keyword] = await Promise.all(['PRODUCT', 'KEYWORD'].map(type => opportunityGroup(session, type, categoryIds)));
  const byId = new Map([...product.rows, ...keyword.rows].map(row => [row.id, row]));
  const details = [];
  for (const id of opportunityIds) {
    const source = byId.get(id);
    if (!source) throw new Error('Requested detail is outside the current opportunity list');
    const detail = await client.productOpportunityDetail(token, shop, id);
    if (detail.basic_info.opportunity_type !== source.type || detail.basic_info.category_id_level_3 !== source.categoryId) {
      throw new Error('Detail category or opportunity type changed');
    }
    details.push({ id, type: source.type, title: source.title, action: detail.action_type ?? null,
      platformStatus: detail.basic_info.status ?? null, referencePrice: detail.basic_info.reference_price ?? null,
      listingCriteria: detail.listing_criteria ?? null, marketData: detail.market_data ?? null, contentData: detail.content_data ?? null });
  }
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const categories = categoryIds.map(id => ({ id, category: [...byId.values()].find(row => row.categoryId === id)?.category ?? null,
    products: product.rows.filter(row => row.categoryId === id).length,
    keywords: keyword.rows.filter(row => row.categoryId === id).length,
    keywordLeads: keyword.rows.filter(row => row.categoryId === id && /^\d+$/u.test(row.searchVolume ?? '') && Number(row.searchVolume) > 0)
      .sort((a, b) => Number(b.searchVolume) - Number(a.searchVolume)).slice(0, 3) }));
  const receipt = { schema: 'operations-selection-opportunities/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, coverage: 'selected_leaf_categories_platform_total',
    product, keyword, categories, details, state: 'research_leads', shopWrites: 0, requests };
  const directory = join(root, 'outputs/operations-selection-opportunities', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, observedAt, products: product.platformCount, keywords: keyword.platformCount,
    productPages: product.pages, keywordPages: keyword.pages, categories, details }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  }
}
