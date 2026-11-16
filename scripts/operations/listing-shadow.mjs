import { createHash } from 'node:crypto';
import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { toCents } from '../../skills/dalei-tiktok-shop-ops/scripts/check-listing.mjs';
import trialDefaults from '../../config/operations-trial-defaults.json' with { type: 'json' };

const { shopId } = trialDefaults;
const { currency, regularListingQuantity } = trialDefaults.newListing;
const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function listingBrandAvailability(brand) {
  if (!isPlatformId(brand?.id)) return 'unverified';
  if (brand.authorization === 'AUTHORIZED' && brand.categoryStatus === 'AVAILABLE') return 'selectable_and_displayed';
  if (['UNAUTHORIEZD', 'UNAUTHORIZED'].includes(brand.authorization)) {
    if (brand.isT1 === false) return 'selectable_without_brand_display';
    if (brand.isT1 === true) return 'authorization_required';
  }
  return 'unverified';
}

export function listingInputIssues(input) {
  const issues = [];
  const require = (valid, field, message) => { if (!valid) issues.push({ field, message }); };
  const positive = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0;
  const route = 'Expected the authorized MY shop and LOCAL_REPLICATION';
  const identity = 'Verified category, brand and sales warehouse required';
  const content = 'Missing listing content or invalid MYR price';
  const parcel = 'Valid package weight and dimensions required';
  require(input.shopId === shopId, 'shopId', route);
  require(input.listingMethods?.includes('LOCAL_REPLICATION'), 'listingMethods', route);
  require(input.categoryVersion === 'v2', 'categoryVersion', identity);
  require(/^\d{6,30}$/u.test(input.categoryId), 'categoryId', identity);
  require(isPlatformId(input.brandId), 'brandId', identity);
  require(isPlatformId(input.warehouseId), 'warehouseId', identity);
  require(/^\S{1,50}$/u.test(input.sellerSku ?? ''), 'sellerSku', content);
  require(typeof input.title === 'string' && input.title.trim(), 'title', content);
  require(typeof input.description === 'string' && input.description.trim(), 'description', content);
  require(toCents(input.salePrice) !== null, 'salePrice', content);
  require(Array.isArray(input.imageUris) && input.imageUris.length >= 5 && input.imageUris.length <= 9 &&
    new Set(input.imageUris).size === input.imageUris.length && input.imageUris.every(uri => /^tos-[\w/-]+$/u.test(uri)),
    'images', 'Five to nine distinct TikTok Shop image URIs required');
  const { packageWeight, packageDimensions } = input;
  require(packageWeight?.unit === 'KILOGRAM' && positive(packageWeight.value), 'packageWeight', parcel);
  require(packageDimensions?.unit === 'CENTIMETER' && ['length', 'width', 'height'].every(axis => positive(packageDimensions[axis])),
    'packageDimensions', parcel);
  return issues;
}

export function planListing(input) {
  const issues = listingInputIssues(input);
  if (issues.length) {
    const error = new Error(issues[0].message);
    error.fields = issues.map(issue => issue.field);
    throw error;
  }
  const { packageWeight, packageDimensions } = input;

  const fields = {
    category_id: input.categoryId,
    brand_id: input.brandId,
    title: input.title,
    description: input.description,
    main_images: input.imageUris.map(uri => ({ uri })),
    package_weight: packageWeight,
    package_dimensions: packageDimensions,
    ...(input.productAttributes?.length ? { product_attributes: input.productAttributes } : {}),
    skus: [{
      seller_sku: input.sellerSku,
      price: { currency, sale_price: input.salePrice },
      inventory: [{ warehouse_id: input.warehouseId, quantity: regularListingQuantity }],
    }],
  };
  const body = { ...fields, category_version: input.categoryVersion, save_mode: 'AS_DRAFT' };
  return {
    shopId,
    sellerSku: input.sellerSku,
    payloadHash: contentHash(body),
    check: { method: 'POST', path: '/product/202309/products/listing_check', body: fields },
    create: {
      method: 'POST', path: '/product/202309/products',
      body: { ...body, idempotency_key: contentHash([shopId, body]) },
    },
  };
}

export function listingSubmission(plan) {
  const draft = plan.create.body;
  const idempotencyKey = createHash('sha256').update('LISTING:' + draft.idempotency_key).digest('hex');
  return { ...draft, save_mode: 'LISTING', idempotency_key: idempotencyKey };
}

function exactSku(product, sellerSku, skuId) {
  const skus = product?.skus;
  return skus?.length === 1 && skus[0].seller_sku === sellerSku && skus[0].id === skuId;
}

export function verifyListing(plan, productId, skuId, product) {
  if (product?.id !== productId || !exactSku(product, plan.sellerSku, skuId)) return { status: 'LIVE_MISMATCH', fields: ['identity'] };
  const audit = product.audit?.status;
  if (product.status === 'FAILED' || audit === 'FAILED') return { status: 'REVIEW_FAILED' };
  if (product.status === 'PENDING' || ['AUDITING', 'PRE_APPROVED'].includes(audit)) return { status: 'REVIEW_PENDING' };
  if (product.status !== 'ACTIVATE' || audit !== 'APPROVED') return { status: 'NOT_LIVE', productStatus: product.status, audit };

  const expected = plan.create.body;
  const expectedSku = expected.skus[0];
  const sku = product.skus[0];
  const inventory = sku.inventory;
  const matches = {
    title: product.title === expected.title,
    description: product.description === expected.description,
    brand: product.brand?.id === expected.brand_id,
    images: JSON.stringify(product.main_images?.map(image => image.uri)) === JSON.stringify(expected.main_images.map(image => image.uri)),
    price: sku.price?.currency === currency && toCents(sku.price.sale_price) === toCents(expectedSku.price.sale_price),
    inventory: inventory?.length === 1 && inventory[0].warehouse_id === expectedSku.inventory[0].warehouse_id &&
      inventory[0].quantity === expectedSku.inventory[0].quantity,
  };
  const fields = Object.keys(matches).filter(field => !matches[field]);
  return fields.length ? { status: 'LIVE_MISMATCH', fields } : { status: 'LIVE_VERIFIED' };
}

export function replayListing(plan, fixture) {
  const receipt = { mode: 'local_replay', shopWrites: 0, simulated: {}, sellerSku: plan.sellerSku };
  const finish = (result, fields = {}) => ({ ...receipt, result, ...fields });
  if (fixture.existing?.length) return finish('EXISTING_PRODUCT', { existing: fixture.existing });

  receipt.simulated.create = plan.create;
  const productId = fixture.created?.product_id;
  const skuId = fixture.created?.skus?.[0]?.id;
  if (!isPlatformId(productId) || !isPlatformId(skuId) || !exactSku(fixture.created, plan.sellerSku, skuId)) {
    return finish('CREATE_UNKNOWN', { reconcileBy: { sellerSku: plan.sellerSku, idempotencyKey: plan.create.body.idempotency_key } });
  }
  if (fixture.draft?.id !== productId || fixture.draft.status !== 'DRAFT' || fixture.draft.audit?.status !== 'NONE' ||
      !exactSku(fixture.draft, plan.sellerSku, skuId)) return finish('DRAFT_MISMATCH', { productId, skuId });

  const { idempotency_key, ...body } = plan.create.body;
  receipt.simulated.submit = {
    method: 'PUT', path: `/product/202509/products/${productId}`,
    body: { ...body, save_mode: 'LISTING', skus: [{ ...body.skus[0], id: skuId }] },
  };
  if (fixture.submitted?.product_id !== productId || !['AUDITING', 'APPROVED'].includes(fixture.submitted.audit?.status)) {
    return finish('SUBMIT_UNKNOWN', { reconcileBy: { productId, skuId } });
  }

  receipt.observations = (fixture.observed ?? []).map(product => verifyListing(plan, productId, skuId, product));
  return finish(receipt.observations.at(-1)?.status ?? 'READBACK_MISSING', { productId, skuId });
}
