import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { createTikTokClient, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { planListing, replayListing, verifyListing } from './listing-shadow.mjs';

const sourcePath = 'operations/product-operations/daily/2026-11-11/classroom-independent-confirmed-live-media-copy-and-price/outcome.json';
const draftPath = 'operations/product-operations/daily/2026-11-12/a28-private-draft-manual-submission-handoff-actual.json';
const candidateSku = 'MY-EXAMPLE-POOL-001';
const shopId = '9000000000000000099';
const output = resolve(process.argv[2] ?? `outputs/operations-listing-shadow/listing-${new Date().toISOString().replaceAll(':', '-')}.json`);
const receipt = { checkedAt: new Date().toISOString(), shopId, mode: 'shadow', shopWrites: 0, officialRequests: [] };

const allowedReads = [
  /^\/authorization\/202309\/shops$/u,
  /^\/logistics\/202309\/warehouses$/u,
  /^\/product\/(?:202507\/global_listing_rules|202312\/prerequisites)$/u,
  /^\/product\/202309\/(?:categories(?:\/\d+\/(?:rules|attributes))?|products\/\d+)$/u,
];
const allowedQueries = new Set(['/product/202502/products/search', '/product/202309/products/listing_check']);
async function readOnlyFetch(url, options) {
  const method = options.method;
  const path = url.pathname;
  const allowed = method === 'GET' ? allowedReads.some(pattern => pattern.test(path)) : method === 'POST' && allowedQueries.has(path);
  if (url.origin !== 'https://open-api.tiktokglobalshop.com' || !allowed) throw new Error('Shadow transport refused non-read request');
  const response = await fetch(url, options);
  const envelope = await response.clone().json().catch(() => null);
  receipt.officialRequests.push({ method, path, httpStatus: response.status, code: envelope?.code, requestId: envelope?.request_id });
  return response;
}

async function loadJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
}

async function searchExact(client, token, shop, sellerSku) {
  const result = await collectPages(async cursor => {
    const page = await client.searchListingSku(token, shop, sellerSku, cursor);
    if (!Array.isArray(page.products) || !Number.isSafeInteger(page.total_count)) throw new Error('SKU lookup incomplete');
    return { rows: page.products, totalCount: page.total_count, nextToken: page.next_page_token };
  }, Date.now() + 60_000);
  const exact = result.rows.filter(product => product.skus?.some(sku => sku.seller_sku === sellerSku));
  if (exact.length !== result.rows.length) throw new Error('Exact SKU lookup returned unverified products');
  return { sellerSku, pages: result.pages, totalCount: result.totalCount, exact: exact.map(({ id, status }) => ({ id, status })) };
}

async function capture(work) {
  try {
    return { result: await work() };
  } catch (error) {
    return { error: publicPlatformError(error, error.message === 'SKU lookup incomplete' ? error.message : error.cause?.code ?? error.name) };
  }
}

if (process.platform === 'win32' && process.env.SystemRoot) {
  process.env.PSModulePath = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
}

try {
  const [source, draftSource, credentials, authorization] = await Promise.all([
    loadJson(sourcePath), loadJson(draftPath), loadLocalAppCredentials(), loadLocalAuthorization(),
  ]);
  const token = authorization.tokens?.access_token;
  if (authorization.tokens?.user_type !== 0 || !token || !authorization.tokens.granted_scopes?.includes('seller.product.write')) {
    throw new Error('Seller product authorization unavailable');
  }
  const client = createTikTokClient({ ...credentials, fetchApi: readOnlyFetch });
  const shop = (await client.authorizedShops(token)).find(item => item.id === shopId && item.name === 'example-shop-my' && item.region === 'MY');
  if (!shop) throw new Error('Exact MY shop missing');
  receipt.shopVerified = true;

  const [listing, prerequisites, warehouses, live, draft] = await Promise.all([
    client.globalListingRules(token, shop), client.listingPrerequisites(token, shop), client.listingWarehouses(token, shop),
    client.productDetail(token, shop, source.product), client.productDetail(token, shop, draftSource.product),
  ]);
  if (live.id !== source.product || live.skus?.length !== 1 || live.skus[0].seller_sku !== source.sku || live.skus[0].id !== source.actual.platformSku) {
    throw new Error('Historical live product identity changed');
  }
  if (draft.id !== draftSource.product || draft.skus?.length !== 1 || draft.skus[0].seller_sku !== draftSource.sku || draft.skus[0].id !== draftSource.nativeSku) {
    throw new Error('Historical draft identity changed');
  }
  const sku = live.skus[0];
  const warehouseId = sku.inventory?.find(item => item.quantity === Number(source.actual.qty))?.warehouse_id;
  const warehouse = warehouses.warehouses?.find(item => item.id === warehouseId && item.type === 'SALES_WAREHOUSE');
  if (!warehouse || !listing.inventory_rules?.some(item => item.local_warehouse_id === warehouse.id && item.allocation_mode === 'MANUAL')) {
    throw new Error('Sample sales warehouse is not an eligible manual allocation warehouse');
  }
  const category = live.category_chains?.at(-1);
  const historicalImages = source.actual.images.map(uri => uri.replace(/^\//u, ''));
  const originalCategoryId = new URL(source.actual.identity.url).searchParams.get('category_id');
  const [categories, rules, attributes, liveSearch, draftSearch, pilotSearch] = await Promise.all([
    capture(async () => (await client.listingCategories(token, shop)).categories?.find(item => item.id === category.id) ?? null),
    capture(() => client.listingCategoryRules(token, shop, category.id)),
    capture(async () => (await client.listingCategoryAttributes(token, shop, category.id)).attributes?.map(item => ({
      id: item.id, name: item.name, required: item.is_required ?? item.is_requried,
    }))),
    searchExact(client, token, shop, source.sku), searchExact(client, token, shop, draftSource.sku),
    searchExact(client, token, shop, candidateSku),
  ]);
  receipt.preflight = { listing, prerequisites, warehouse: { id: warehouse.id, subType: warehouse.sub_type },
    category: { id: category.id, label: category.local_name, categories, rules, attributes } };
  receipt.exactSearches = { live: liveSearch, draft: draftSearch, pilot: pilotSearch };

  const plan = planListing({
    shopId, listingMethods: listing.listing_methods, categoryId: category.id, categoryVersion: 'v2',
    brandId: live.brand?.id, warehouseId, sellerSku: source.sku, salePrice: source.actual.price,
    title: live.title, description: live.description, imageUris: historicalImages,
    packageWeight: live.package_weight, packageDimensions: live.package_dimensions, productAttributes: live.product_attributes,
  });
  receipt.officialListingCheck = await capture(() => client.checkProductListing(token, shop, plan.check.body));

  receipt.existingLiveReadback = { source: sourcePath, productId: live.id, skuId: sku.id, state: live.status,
    audit: live.audit?.status, currency: sku.price?.currency, price: sku.price?.sale_price, brandId: live.brand?.id,
    imageCount: live.main_images?.length, inventory: sku.inventory, verification: verifyListing(plan, live.id, sku.id, live) };
  const draftSku = draft.skus[0];
  receipt.existingDraftReadback = { source: draftPath, productId: draft.id, skuId: draftSku.id, state: draft.status,
    audit: draft.audit?.status, currency: draftSku.price?.currency, price: draftSku.price?.sale_price,
    imageCount: draft.main_images?.length, inventory: draftSku.inventory };
  receipt.duplicateGuards = { live: replayListing(plan, { existing: liveSearch.exact }),
    draft: replayListing({ sellerSku: draftSource.sku }, { existing: draftSearch.exact }) };

  const productId = '9000000000000000138';
  const skuId = '9000000000000000139';
  const replayLive = { ...live, id: productId, skus: [{ ...sku, id: skuId }] };
  const fixture = { created: { product_id: productId, skus: [{ id: skuId, seller_sku: source.sku }] },
    draft: { ...replayLive, status: 'DRAFT', audit: { status: 'NONE' } },
    submitted: { product_id: productId, audit: { status: 'AUDITING' } },
    observed: [{ ...replayLive, status: 'PENDING', audit: { status: 'AUDITING' } }, replayLive] };
  receipt.localReplay = { successful: replayListing(plan, fixture),
    createUnknown: replayListing(plan, { ...fixture, created: null }).result,
    submitUnknown: replayListing(plan, { ...fixture, submitted: null }).result,
    rejected: replayListing(plan, { ...fixture, observed: [{ ...replayLive, status: 'FAILED', audit: { status: 'FAILED' } }] }).result };
  const prerequisiteChecks = prerequisites.check_results;
  receipt.gates = {
    listingPrerequisites: Array.isArray(prerequisiteChecks) && prerequisiteChecks.length > 0 && prerequisiteChecks.every(item => item.is_failed === false),
    categoryAvailable: originalCategoryId === category.id && categories.result?.is_leaf === true &&
      categories.result.permission_statuses?.includes('AVAILABLE') === true && Boolean(rules.result) && Array.isArray(attributes.result),
    officialListingCheck: receipt.officialListingCheck.result?.check_result === 'PASS',
    liveReadback: receipt.existingLiveReadback.verification.status === 'LIVE_VERIFIED',
    localReplay: receipt.localReplay.successful.result === 'LIVE_VERIFIED',
    duplicateGuards: Object.values(receipt.duplicateGuards).every(result => result.result === 'EXISTING_PRODUCT'),
  };
  receipt.shadowPassed = Object.values(receipt.gates).every(Boolean);
  if (!receipt.shadowPassed) process.exitCode = 1;
} catch (error) {
  receipt.error = publicPlatformError(error, error.cause?.code ?? error.message);
  process.exitCode = 1;
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, shopWrites: receipt.shopWrites, shadowPassed: receipt.shadowPassed,
  gates: receipt.gates, listingCheck: receipt.officialListingCheck, error: receipt.error }));
