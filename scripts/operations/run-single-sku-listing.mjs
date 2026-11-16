import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError, signTikTokShopUrl } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { listingSubmission, planListing, verifyListing } from './listing-shadow.mjs';
import { shopWriteJournal } from './shop-write-journal.mjs';

const shopId = '9000000000000000099';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const validSku = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/u;
const imageType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const localImageUri = (_, index) => 'tos-local-validation-' + (index + 1);
const planLocal = (input, imageUris, listingMethods = ['LOCAL_REPLICATION']) =>
  planListing({ ...input, shopId, listingMethods, categoryVersion: 'v2', imageUris });

function productIdentity(product, sellerSku) {
  const sku = product.skus?.[0];
  if (product.skus?.length !== 1 || sku.seller_sku !== sellerSku || !isPlatformId(sku.id)) {
    throw new Error('Exact single SKU missing from the platform response');
  }
  return { productId: product.product_id ?? product.id, skuId: sku.id };
}

async function validateLocalListing(input, media) {
  const { images } = input;
  if (!Array.isArray(images) || images.length < 5 || images.length > 9 ||
      new Set(images).size !== images.length || images.some(file => typeof file !== 'string' || !imageType[extname(file).toLowerCase()])) {
    throw new Error('Supply five to nine distinct local JPEG or PNG images');
  }
  // Check the complete local payload before the first upload. Only the actual uploaded URIs are submitted.
  planLocal(input, images.map(localImageUri));
  const mediaFiles = await Promise.all(images.map(file => readFile(resolve(media, file))));
  const hashes = mediaFiles.map(sha);
  if (mediaFiles.some(file => file.length === 0) || new Set(hashes).size !== hashes.length) {
    throw new Error('Empty or duplicate image contents');
  }
  return { mediaFiles, hashes };
}

async function readCreateReadiness(client, token, shop, { sellerSku, warehouseId, categoryId }) {
  const [search, listing, rules] = await Promise.all([
    client.searchListingSku(token, shop, sellerSku),
    client.globalListingRules(token, shop),
    client.listingCategoryRules(token, shop, categoryId),
  ]);
  const checks = {
    skuAbsent: search.total_count === 0 && search.products?.length === 0 && !search.next_page_token,
    listingMethod: listing.listing_methods?.includes('LOCAL_REPLICATION') === true,
    warehouse: listing.inventory_rules?.some(item => item.local_warehouse_id === warehouseId && item.allocation_mode === 'MANUAL') === true,
    certificateFields: Array.isArray(rules.product_certifications) && rules.product_certifications.every(item => item.is_required === false),
  };
  return { checks, listingMethods: listing.listing_methods, existingCount: search.total_count ?? null };
}

export async function runSingleSkuListing({ mode, input, output, media, log = true }) {
  if (!['--submit', '--check', '--preflight', '--validate', '--check-platform', '--recommend-properties', '--shadow'].includes(mode)) {
    throw new Error('Use --submit, --check, --preflight, --validate, --check-platform, --recommend-properties or --shadow');
  }
  if (mode === '--submit' && (input.shadowBasis?.usage === 'LOCAL_VALIDATION_ONLY' ||
      input.shadowBasis?.platformSubmissionAuthorized === false)) {
    throw new Error('This listing manifest is marked for local validation only');
  }
  const { sellerSku, categoryId, images, packageBasis } = input;
  if (!validSku.test(sellerSku ?? '')) throw new Error('Invalid seller SKU');
  if (mode === '--validate') {
    const { hashes } = await validateLocalListing(input, media);
    const receipt = { observedAt: now(), shopId, sellerSku, validated: true, mediaHashes: hashes, writes: 0 };
    if (log) console.log(JSON.stringify(receipt));
    return receipt;
  }
  const { read: readJournal, record, writeOnce } = shopWriteJournal(output);
  const [credentials, authorization] = await Promise.all([loadLocalAppCredentials(), loadLocalAuthorization()]);
  if (credentials.serviceId !== authorization.serviceId) throw new Error('Existing authorization mismatch');
  const { tokens } = authorization;
  const scope = mode === '--recommend-properties' ? 'seller.product.basic' : 'seller.product.write';
  if (tokens?.user_type !== 0 || !tokens.granted_scopes?.includes(scope)) throw new Error('Seller product authorization unavailable');
  const token = tokens.access_token;
  let detailRequest;
  const shadowRequests = [];
  const client = createTikTokClient({ ...credentials, fetchApi: async (url, options) => {
    const response = await fetch(url, options);
    const productDetailRead = options.method === 'GET' && /^\/product\/202309\/products\/\d+$/u.test(url.pathname);
    if (productDetailRead || mode === '--shadow') {
      const envelope = await response.clone().json().catch(() => null);
      const request = { httpStatus: response.status, code: envelope?.code ?? null, requestId: envelope?.request_id ?? null };
      if (productDetailRead) detailRequest = request;
      if (mode === '--shadow') shadowRequests.push({ method: options.method, path: url.pathname, ...request });
    }
    return response;
  } });
  const shop = (await client.authorizedShops(token)).find(item => item.id === shopId && item.region === 'MY' && item.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia shop not authorized');

  if (mode === '--recommend-properties') {
    const receipt = { schema: 'operations-listing-property-recommendations/v1', observedAt: now(), shopId, sellerSku, categoryId,
      inputHash: sha(Buffer.from(JSON.stringify(input))),
      shopWrites: 0, mediaUploads: 0 };
    try {
      const { data, requestId } = await client.recommendListingProperties(token, shop,
        { categoryId, title: input.title, description: input.description });
      if (!requestId || !Array.isArray(data.recommended_properties) || data.recommended_properties.some(row =>
        typeof row?.id !== 'string' || typeof row.is_required !== 'boolean' || !Array.isArray(row.values))) {
        throw new Error('Official property recommendations are incomplete');
      }
      receipt.required = data.recommended_properties.filter(row => row.is_required).map(row => ({ id: row.id,
        name: row.name ?? null, type: row.type ?? null, values: row.values.map(value => ({ id: value.id, name: value.name })) }));
      receipt.recommendations = data.recommended_properties.length;
      receipt.request = { httpStatus: 200, code: 0, requestId };
    } catch (error) {
      receipt.error = publicPlatformError(error, 'Official property recommendations unavailable');
      receipt.request = { httpStatus: error.httpStatus ?? null, code: error.platformCode ?? null, requestId: error.requestId ?? null };
      if (log) process.exitCode = 20;
    }
    await mkdir(output, { recursive: true });
    await record('property-recommendations-' + receipt.observedAt.replace(/[:.]/gu, '-'), receipt);
    if (log) console.log(JSON.stringify(receipt));
    return receipt;
  }

  const send = (path, query, body, multipart = false) => fetch(signTikTokShopUrl({ ...credentials, path, query,
    timestamp: String(Math.floor(Date.now() / 1000)), body: multipart ? '' : body }), {
    method: 'POST', body, headers: { 'x-tts-access-token': token, ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });

  if (mode === '--preflight') {
    const search = await client.searchListingSku(token, shop, sellerSku);
    if (!Number.isSafeInteger(search.total_count) || !Array.isArray(search.products)) throw new Error('Exact SKU lookup incomplete');
    const found = search.products.filter(product => product.skus?.some(sku => sku.seller_sku === sellerSku));
    if (found.length !== search.products.length) throw new Error('Exact SKU lookup returned unverified products');
    console.log(JSON.stringify({ observedAt: now(), shopId, sellerSku, totalCount: search.total_count,
      nextPageTokenPresent: Boolean(search.next_page_token), existing: found.map(product => ({ id: product.id, status: product.status })),
      writes: 0 }));
    return;
  }

  if (mode === '--shadow') {
    const [official, local] = await Promise.allSettled([
      readCreateReadiness(client, token, shop, input), validateLocalListing(input, media),
    ]);
    const readiness = official.status === 'fulfilled' ? official.value : null;
    const plan = readiness?.checks.listingMethod && local.status === 'fulfilled'
      ? planLocal(input, images.map(localImageUri), readiness.listingMethods) : null;
    const body = plan && listingSubmission(plan);
    const receipt = { schema: 'operations-listing-submit-shadow/v1', observedAt: now(), shopId, sellerSku, categoryId,
      state: body && Object.values(readiness.checks).every(Boolean) ? 'SHADOW_VERIFIED' : 'SHADOW_INCOMPLETE',
      inputHash: sha(Buffer.from(JSON.stringify(input))), official: readiness?.checks ?? null,
      existingCount: readiness?.existingCount ?? null,
      officialError: official.status === 'rejected' ? publicPlatformError(official.reason, 'Official listing reads unavailable') : null,
      missingLocalFields: local.status === 'rejected' ? local.reason.fields ?? [] : [],
      localError: local.status === 'rejected' ? local.reason.message : null,
      mediaHashes: local.status === 'fulfilled' ? local.value.hashes : null,
      submission: body ? { method: plan.create.method, path: plan.create.path, saveMode: body.save_mode,
        sellerSku: body.skus[0].seller_sku, price: body.skus[0].price, quantity: body.skus[0].inventory[0].quantity,
        payloadHash: sha(Buffer.from(JSON.stringify(body))), imageUrisArePlaceholders: true } : null,
      shopWrites: 0, mediaUploads: 0, requests: shadowRequests };
    await mkdir(output, { recursive: true });
    await record('submit-shadow-' + receipt.observedAt.replace(/[:.]/gu, '-'), receipt);
    if (log) console.log(JSON.stringify(receipt));
    return receipt;
  }

  const intent = await readJournal('create.intent');
  const createResult = await readJournal('create.result');
  let create = createResult?.data;
  let plan = intent?.plan;
  if (mode === '--check-platform') {
    if (intent?.shopId !== shopId || intent.sellerSku !== sellerSku || createResult?.code !== 0 || !createResult.requestId || !plan?.check?.body) {
      throw new Error('Official preflight requires the original uploaded media and create receipt');
    }
    const { productId, skuId } = productIdentity(create, sellerSku);
    if (!isPlatformId(productId)) throw new Error('Original product ID missing');
    const detail = await client.productDetail(token, shop, productId);
    const listing = verifyListing(plan, productId, skuId, detail);
    const check = plan.check.body;
    if (listing.status !== 'LIVE_VERIFIED' || !detailRequest?.requestId ||
        check.skus?.length !== 1 || check.skus[0].seller_sku !== sellerSku ||
        JSON.stringify(check.main_images) !== JSON.stringify(plan.create.body.main_images)) {
      throw new Error('Original product and check payload no longer match verified live listing');
    }
    const { data, requestId } = await client.checkProductListing(token, shop, check, { includeRequestId: true });
    if (!requestId || !['PASS', 'FAILED'].includes(data.check_result)) throw new Error('Official preflight response is incomplete');
    const receipt = { schema: 'operations-live-listing-platform-check/v1', observedAt: now(), shopId, sellerSku, productId, skuId,
      listing, productRequestId: detailRequest.requestId, requestId, state: data.check_result, originalPayloadHash: plan.payloadHash,
      checkPayloadHash: sha(Buffer.from(JSON.stringify(check))), originalCreateRequestId: createResult.requestId,
      failures: data.fail_reasons ?? [], warnings: data.warnings ?? [], shopWrites: 0, mediaUploads: 0 };
    await record('platform-check-' + receipt.observedAt.replace(/[:.]/gu, '-'), receipt);
    if (log) console.log(JSON.stringify(receipt));
    return receipt;
  }
  await mkdir(output, { recursive: true });
  if (!create && !intent && mode === '--submit') {
    const { mediaFiles, hashes } = await validateLocalListing(input, media);
    const { checks, listingMethods } = await readCreateReadiness(client, token, shop, input);
    if (!checks.skuAbsent) throw new Error('Exact SKU lookup must be empty before creating');
    if (!checks.listingMethod || !checks.warehouse || !checks.certificateFields) {
      throw new Error('Shop route, warehouse or platform certificate fields changed');
    }

    const imageUris = [];
    for (const [index, file] of images.entries()) {
      const imageStep = `image-${index + 1}`;
      const body = new FormData();
      body.append('data', new Blob([mediaFiles[index]], { type: imageType[extname(file).toLowerCase()] }), basename(file));
      body.append('use_case', 'MAIN_IMAGE');
      const info = await writeOnce(imageStep, { file, sha256: hashes[index], useCase: 'MAIN_IMAGE' },
        () => send('/product/202309/images/upload', {}, body, true));
      if (!info.uri) throw new Error('Upload response missing the image URI');
      imageUris.push(info.uri);
    }

    plan = planLocal(input, imageUris, listingMethods);
    const body = listingSubmission(plan);
    create = await writeOnce('create', { shopId, sellerSku, method: 'POST', path: plan.create.path, plan,
      packageBasis, body },
    () => send(plan.create.path, { shop_cipher: shop.cipher }, JSON.stringify(body)));
  }

  if (!create && plan) {
    const found = await client.searchListingSku(token, shop, sellerSku);
    if (found.total_count === 1 && found.products?.length === 1) {
      const product = found.products[0];
      const identity = productIdentity(product, sellerSku);
      if (!isPlatformId(identity.productId)) throw new Error('Original product ID missing');
      create = { ...product, product_id: identity.productId };
    }
  }
  if (!create || !plan) throw new Error('No definitive create result to check');
  const { productId, skuId } = productIdentity(create, sellerSku);
  if (!isPlatformId(productId)) throw new Error('Create response missing the product ID');
  console.log(JSON.stringify({ step: 'created', productId, skuId, mode }));

  const rounds = mode === '--submit' ? 5 : 1;
  for (let i = 0; i < rounds; i += 1) {
    const detail = await client.productDetail(token, shop, productId);
    const result = verifyListing(plan, productId, skuId, detail);
    const observed = { observedAt: now(), shopId, sellerSku, productId, skuId, result, request: detailRequest,
      platformState: detail.status, auditState: detail.audit?.status, auditReasons: detail.audit_failed_reasons,
      price: detail.skus?.[0]?.price, inventory: detail.skus?.[0]?.inventory, imageCount: detail.main_images?.length };
    await record('readback-' + observed.observedAt.replaceAll(':', '-'), observed);
    console.log(JSON.stringify(observed));
    const pending = ['REVIEW_PENDING', 'NOT_LIVE'].includes(result.status);
    if (!pending || i + 1 === rounds) {
      if (result.status !== 'LIVE_VERIFIED') process.exitCode = pending ? 10 : 1;
      break;
    }
    await delay(5000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, manifest, ...extra] = process.argv.slice(2);
    if (!manifest || extra.length) throw new Error('Usage: run-single-sku-listing.mjs <mode> <listing.json>');
    const file = resolve(manifest);
    const input = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
    if (!validSku.test(input.sellerSku ?? '')) throw new Error('Invalid seller SKU');
    const output = resolve('outputs/operations-listings/MY', input.sellerSku);
    await runSingleSkuListing({ mode, input, output, media: dirname(file) });
  } catch (error) {
    console.error(publicPlatformError(error, error.cause?.code ?? error.message));
    if (process.argv[2] === '--validate' && error.fields?.length) {
      console.error(JSON.stringify({ validated: false, fields: error.fields, writes: 0 }));
    }
    process.exitCode = 1;
  }
}
