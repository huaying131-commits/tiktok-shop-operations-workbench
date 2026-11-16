import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTikTokClient } from '../apps/customer-service/tiktok-shop-read.mjs';
import { listingBrandAvailability, listingSubmission, planListing, replayListing, verifyListing } from '../scripts/operations/listing-shadow.mjs';
import { runSingleSkuListing } from '../scripts/operations/run-single-sku-listing.mjs';
import { matchesEstimatedListingInput, reviewListingCarriage } from '../scripts/operations/run-handoff-reconciliation.mjs';

const productId = '9000000000000000050';
const skuId = '9000000000000000052';
const warehouseId = '9000000000000000094';
const sku = 'MY-MINI-CLASSROOM-986950431-YELLOW-6PCS';
const sample = {
  shopId: '9000000000000000099', listingMethods: ['LOCAL_REPLICATION'], categoryId: '861704',
  categoryVersion: 'v2', brandId: '9000000000000000102', warehouseId, sellerSku: sku, salePrice: '37.90',
  title: 'Yellow Classroom Miniature Set, 6 Pieces', description: '<p>Two desks, two chairs and two bags.</p>',
  imageUris: Array.from({ length: 5 }, (_, i) => `tos-example/${i}`),
  packageWeight: { value: '0.26', unit: 'KILOGRAM' },
  packageDimensions: { length: '16', width: '9', height: '7', unit: 'CENTIMETER' },
};

test('carriage evidence is limited to the same supplier option and planned price', () => {
  const shop = { id: sample.shopId, name: 'example-shop-my', region: 'MY' };
  const original = { sellerSku: 'MY-TC27-EN-DIY-BOOKNOOK', supplier: { exactOfferId: '843899164352',
    supplierSku: '5885705966388', exactOption: 'TC27中华美食录+英文' } };
  const receipt = { schema: 'tc27-exact-english-option-carriage-and-cost-followup/v1', shop: { ...shop, market: 'MY' },
    sellerSku: original.sellerSku, supplier: { offerId: original.supplier.exactOfferId,
      englishSupplierSkuFromOriginalHandoff: original.supplier.supplierSku, exactOption: original.supplier.exactOption,
      publishedBatteryRemovalOptionFound: false }, carrier: { exactEnglishKitCarriageVerified: false },
    pricing: { amountMyr: '79.90' }, currentDecision: { shopWrites: 0, mediaUploads: 0, submissions: 0,
      readyToSubmit: false, actualParcelVerified: false } };
  const review = { shop, original, price: '79.90' };
  assert.deepEqual(reviewListingCarriage(receipt, review), { carriageVerified: false, parcelVerified: false, publishedBatteryFreeOption: false });
  assert.equal(reviewListingCarriage({ ...receipt, supplier: { ...receipt.supplier, exactOption: 'TC27中华美食录+中文' } }, review), null);
  assert.equal(reviewListingCarriage(receipt, { ...review, price: '69.90' }), null);
  assert.equal(reviewListingCarriage({ ...receipt, currentDecision: { ...receipt.currentDecision, readyToSubmit: true } }, review), null);
});

test('a source-backed listing shadow may fill brand and parcel estimates only', () => {
  const basis = { ...sample, brandId: null, packageDimensions: { unit: 'CENTIMETER' } };
  const proposed = { ...sample, packageDimensions: { length: '27', width: '25', height: '10', unit: 'CENTIMETER' },
    packageBasis: 'Outer carton estimate', shadowBasis: { usage: 'LOCAL_VALIDATION_ONLY', platformSubmissionAuthorized: false,
      packageDimensionsAreEstimate: true } };
  const brand = { id: sample.brandId, name: 'T-YU', authorization: 'UNAUTHORIEZD', categoryStatus: 'AVAILABLE', isT1: false };
  const packaging = { outerDimensions: proposed.packageDimensions, source: { length: 24.4, width: 22.6, height: 7 },
    estimatedWeightKg: 0.26, measured: false };
  assert.equal(matchesEstimatedListingInput(basis, proposed, brand, packaging), true);
  assert.equal(matchesEstimatedListingInput(basis, { ...proposed, salePrice: '1.00' }, brand, packaging), false);
  assert.equal(matchesEstimatedListingInput(basis, { ...proposed, shadowBasis: undefined }, brand, packaging), false);
  assert.equal(matchesEstimatedListingInput(basis, proposed, brand, { ...packaging, measured: true }), false);
  assert.equal(matchesEstimatedListingInput(basis, proposed, brand, { ...packaging, source: { length: 30, width: 22.6, height: 7 } }), false);
});

function detail(status = 'ACTIVATE', audit = 'APPROVED') {
  return {
    id: productId, status, audit: { status: audit }, title: sample.title, description: sample.description,
    brand: { id: sample.brandId }, main_images: sample.imageUris.map(uri => ({ uri })),
    skus: [{ id: skuId, seller_sku: sku, price: { currency: 'MYR', sale_price: '37.9' }, inventory: [{ warehouse_id: warehouseId, quantity: 100 }] }],
  };
}

function fixtures(overrides = {}) {
  return {
    created: { product_id: productId, skus: [{ id: skuId, seller_sku: sku }] },
    draft: detail('DRAFT', 'NONE'),
    submitted: { product_id: productId, audit: { status: 'AUDITING' } },
    observed: [detail('PENDING', 'AUDITING'), detail()],
    ...overrides,
  };
}

test('plans local draft and the same-SKU edit-and-submit with a stable key and MYR display price', () => {
  const plan = planListing(sample);
  const other = planListing({ ...sample, salePrice: '38.90' });
  assert.equal(plan.create.path, '/product/202309/products');
  assert.equal(plan.create.body.save_mode, 'AS_DRAFT');
  assert.equal(plan.create.body.skus[0].price.sale_price, '37.90');
  assert.equal(plan.create.body.idempotency_key, planListing(sample).create.body.idempotency_key);
  assert.notEqual(plan.create.body.idempotency_key, other.create.body.idempotency_key);
  const r = replayListing(plan, fixtures());
  assert.equal(r.result, 'LIVE_VERIFIED');
  assert.equal(r.shopWrites, 0);
  assert.equal(r.simulated.submit.path, `/product/202509/products/${productId}`);
  assert.equal(r.simulated.submit.body.save_mode, 'LISTING');
  assert.equal(r.simulated.submit.body.skus[0].id, skuId);
  assert.equal(r.simulated.submit.body.idempotency_key, undefined);
});

test('stops duplicate creates and holds unknown results for reconciliation by the original SKU', () => {
  const plan = planListing(sample);
  for (const state of ['ACTIVATE', 'DRAFT']) {
    const r = replayListing(plan, fixtures({ existing: [{ id: productId, status: state }] }));
    assert.equal(r.result, 'EXISTING_PRODUCT');
    assert.deepEqual(r.simulated, {});
  }
  const create = replayListing(plan, fixtures({ created: null }));
  assert.equal(create.result, 'CREATE_UNKNOWN');
  assert.equal(create.reconcileBy.sellerSku, sku);
  assert.equal(create.simulated.submit, undefined);
  const submit = replayListing(plan, fixtures({ submitted: null }));
  assert.equal(submit.result, 'SUBMIT_UNKNOWN');
  assert.equal(submit.reconcileBy.productId, productId);
});

test('a shared submission builder keeps the existing live mode and idempotency key', () => {
  const plan = planListing(sample);
  const body = listingSubmission(plan);
  assert.equal(body.save_mode, 'LISTING');
  assert.equal(body.idempotency_key, createHash('sha256').update('LISTING:' + plan.create.body.idempotency_key).digest('hex'));
  assert.equal(plan.create.body.save_mode, 'AS_DRAFT');
  assert.deepEqual(body.main_images, plan.create.body.main_images);
  assert.deepEqual(body.skus, plan.create.body.skus);
});

test('never edits if the draft contains other SKUs or is already live', () => {
  const multiple = detail('DRAFT', 'NONE');
  multiple.skus.push({ id: '9000000000000000053', seller_sku: 'OTHER' });
  for (const draft of [multiple, detail()]) {
    const r = replayListing(planListing(sample), fixtures({ draft }));
    assert.equal(r.result, 'DRAFT_MISMATCH');
    assert.equal(r.simulated.submit, undefined);
  }
});

test('distinguishes approval, rejection and wrong live product data', () => {
  const plan = planListing(sample);
  assert.equal(replayListing(plan, fixtures({ observed: [detail('PENDING', 'AUDITING')] })).result, 'REVIEW_PENDING');
  assert.equal(replayListing(plan, fixtures({ observed: [detail('FAILED', 'FAILED')] })).result, 'REVIEW_FAILED');
  assert.equal(verifyListing(plan, productId, skuId, detail()).status, 'LIVE_VERIFIED');
  for (const change of [
    p => { p.id = '9000000000000000051'; },
    p => { p.skus[0].price.sale_price = '37.91'; },
    p => { p.skus[0].inventory[0].quantity = 99; },
    p => { p.skus[0].inventory.push({ warehouse_id: '9000000000000000095', quantity: 1 }); },
    p => { p.main_images.reverse(); },
    p => { p.description = '<p>Other</p>'; },
  ]) {
    const p = detail();
    change(p);
    assert.equal(verifyListing(plan, productId, skuId, p).status, 'LIVE_MISMATCH');
  }
});

test('refuses an unsupported route, wrong shop, insufficient images or invalid price', () => {
  for (const change of [
    { shopId: '9000000000000000100' }, { listingMethods: ['GLOBAL_PUBLISHING'] },
    { imageUris: ['tos-example/1'] }, { salePrice: '37.001' },
  ]) assert.throws(() => planListing({ ...sample, ...change }));
});

test('the local listing gate detects missing parcel dimensions before reading or uploading images', async () => {
  const input = { ...sample, packageDimensions: null, images: ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg', 'five.jpg'] };
  await assert.rejects(runSingleSkuListing({ mode: '--validate', input }), /package weight and dimensions required/u);
});

test('the local listing gate identifies independently missing brand and package dimensions', async () => {
  const input = { ...sample, brandId: null, packageDimensions: null, images: ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg', 'five.jpg'] };
  await assert.rejects(runSingleSkuListing({ mode: '--validate', input }), {
    message: 'Verified category, brand and sales warehouse required',
    fields: ['brandId', 'packageDimensions'],
  });
});

test('a manifest marked for local validation cannot dispatch real submissions', async () => {
  const input = { ...sample, shadowBasis: { usage: 'LOCAL_VALIDATION_ONLY', platformSubmissionAuthorized: false } };
  await assert.rejects(runSingleSkuListing({ mode: '--submit', input }), /marked for local validation only/u);
});

test('reads the official category brand tier and distinguishes permission from display', async () => {
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(url.pathname, '/product/202309/brands');
    assert.equal(url.searchParams.get('category_id'), '603818');
    assert.equal(url.searchParams.get('category_version'), 'v2');
    assert.equal(url.searchParams.get('brand_name'), 'Example');
    return Response.json({ code: 0, data: { total_count: 1, brands: [{
      id: '9000000000000000091', name: 'Example', authorized_status: 'UNAUTHORIEZD', brand_status: 'AVAILABLE',
      is_t1_brand: false,
    }] } });
  } });
  const page = await client.listingBrandsPage('fixture-token', { region: 'MY', cipher: 'fixture-cipher' },
    { categoryId: '603818', name: 'Example' });
  const [brand] = page.rows;
  assert.equal(listingBrandAvailability(brand), 'selectable_without_brand_display');
  assert.equal(listingBrandAvailability({ ...brand, isT1: true }), 'authorization_required');
  assert.equal(listingBrandAvailability({ ...brand, isT1: null }), 'unverified');
  assert.equal(listingBrandAvailability({ ...brand, authorization: 'AUTHORIZED' }), 'selectable_and_displayed');
  assert.equal(listingBrandAvailability({ ...brand, authorization: 'AUTHORIZED', categoryStatus: 'UNAVAILABLE' }), 'unverified');
});
