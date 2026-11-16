import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { listingBrandAvailability, listingInputIssues } from './listing-shadow.mjs';
import { runSingleSkuListing } from './run-single-sku-listing.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const sources = {
  pending: 'operations/product-operations/daily/2026-11-11/six-remaining-accepted-skus-current-readback-and-source-updates.json',
  listed: 'operations/product-operations/daily/2026-11-11/two-original-trials-independently-live-five-and-bilingual-actual.json',
  draft: 'operations/product-operations/daily/2026-11-12/a28-private-draft-manual-submission-handoff-actual.json',
  production: 'outputs/operations-automation-2026-11-12-followup/QD19-caption-shadow/发布任务.json',
};
const execute = promisify(execFile);
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function inspect(work) {
  try {
    return { available: true, result: await work() };
  } catch (error) {
    return { available: false, error: publicPlatformError(error, error.message) };
  }
}

async function exactProduct(client, token, shop, sellerSku, productId, platformSku, draft = false) {
  const { data: detail, requestId } = await client.productDetail(token, shop, productId, { draft, includeRequestId: true });
  const matched = detail.skus?.filter(row => row.seller_sku === sellerSku);
  if (!requestId || detail.id !== productId || matched?.length !== 1 || !isPlatformId(matched[0].id) ||
      (platformSku && matched[0].id !== platformSku)) throw new Error('Exact listing SKU identity mismatch');
  const variant = matched[0];
  return { productId, skuId: variant.id, state: detail.status, audit: detail.audit?.status ?? null,
    requestId, draftVersionRequested: draft,
    notSubmittedReasons: Array.isArray(detail.audit?.not_submitted_reasons) ? detail.audit.not_submitted_reasons : null,
    price: variant.price ?? null, listedQuantity: Array.isArray(variant.inventory) &&
      variant.inventory.every(row => Number.isSafeInteger(row.quantity) && row.quantity >= 0)
      ? variant.inventory.reduce((total, row) => total + row.quantity, 0) : null,
    imageCount: Array.isArray(detail.main_images) ? detail.main_images.length : null,
    ...(draft ? { descriptionPresent: typeof detail.description === 'string' ? Boolean(detail.description.trim()) : null,
      hasDraft: detail.has_draft ?? null, packageDimensions: detail.package_dimensions ?? null,
      packageWeight: detail.package_weight ?? null, brandId: detail.brand?.id ?? null } : {}) };
}

async function checkCandidate(client, token, shop, candidate) {
  const { sku, lookup, lookupSHA256, productId, platformSku } = candidate;
  const sourceMatches = lookup && lookupSHA256
    ? await digest(join(root, lookup)).then(hash => hash === lookupSHA256, () => false) : null;
  const observed = await inspect(async () => {
    if (productId) return { lookup: 'known_product_id',
      products: [await exactProduct(client, token, shop, sku, productId, platformSku, candidate.readDraftVersion)] };
    const search = await collectPages(async cursor => {
      const page = await client.searchListingSku(token, shop, sku, cursor);
      if (!Array.isArray(page.products) || !Number.isSafeInteger(page.total_count) ||
          page.products.some(row => !isPlatformId(row.id) || !row.skus?.some(variant => variant.seller_sku === sku))) {
        throw new Error('Exact merchant SKU search response incomplete');
      }
      return { rows: page.products, totalCount: page.total_count,
        nextToken: page.next_page_token };
    }, Date.now() + 35_000);
    const products = await Promise.all(search.rows.map(row => exactProduct(client, token, shop, sku, row.id)));
    return { lookup: 'seller_sku_search', matches: search.totalCount, products };
  });
  return { sku, name: candidate.name, oldLookupMatchesRecordedHash: sourceMatches, originalGap: candidate.currentGap ?? null, ...observed };
}

async function optionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function isSameShop(value, shop) {
  return value?.id === shop.id && value?.name === shop.name && value?.region === shop.region;
}

export async function readDailySelectionHandoffs(day, { client, token, shop }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !isSameShop(shop, { id: shopId, name: 'example-shop-my', region: 'MY' })) {
    throw new Error('Exact MY shop and handoff date are required');
  }
  const directory = join(root, 'operations/product-operations/selection-research', day);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const rows = [];
  const seen = new Set();
  for (const entry of entries.filter(item => item.isDirectory())) {
    const folder = join(directory, entry.name);
    const source = join(folder, 'handoff.json');
    const handoff = await optionalJson(source);
    const dispatchSource = join(folder, '交接回执.json');
    const dispatch = await optionalJson(dispatchSource);
    if (!handoff && dispatch?.schema === 'selection-handoff-dispatch/v1' &&
        dispatch.result === 'DELIVERED_AND_ACKNOWLEDGED_IN_DESTINATION_CHAT') {
      const { candidateId: sku, handoffId, confirmedAt, research: refs } = dispatch;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/u.test(sku ?? '') || handoffId !== `${sku}-${day.replaceAll('-', '')}-V1` ||
          dispatch.destinationThreadId !== '00000000-0000-4000-8000-000000000003' ||
          !dispatch.destinationTurnId || !dispatch.destinationInputItemId || !dispatch.destinationAssistantAckId ||
          !Number.isFinite(Date.parse(confirmedAt)) || dayKey(new Date(confirmedAt)) !== day ||
          typeof refs?.note !== 'string' || basename(refs.note) !== refs.note || refs.evidence !== 'research-evidence.json' ||
          seen.has(sku)) throw new Error('Acknowledged selection handoff identity mismatch');
      const research = join(folder, refs.note);
      const evidenceSource = join(folder, refs.evidence);
      const [report, noteHash, evidenceHash] = await Promise.all([readJson(evidenceSource), digest(research), digest(evidenceSource)]);
      if (report.schema !== 'selection-research-evidence/v1' || report.candidateId !== sku || report.handoffId !== handoffId ||
          report.market !== shop.region || report.shopId !== shop.id || noteHash !== refs.noteSha256?.toLowerCase() ||
          evidenceHash !== refs.evidenceSha256?.toLowerCase()) throw new Error('Acknowledged selection source differs from the dispatched version');
      seen.add(sku);
      const normal = report.contribution?.rows?.find(row => row.scenario === 'normal');
      const [west, east] = normal?.region ?? [];
      const official = await checkCandidate(client, token, shop, { sku });
      rows.push({ sku, handoffId, confirmedAt, source: evidenceSource, dispatchSource, research,
        buyerPriceMyr: normal?.p ?? null, naturalWestMyr: west?.base ?? null, naturalEastMyr: east?.base ?? null,
        status: 'delivered_to_listing', official: official.available ? official.result : { error: official.error } });
      continue;
    }
    if (handoff?.schema !== 'single-sku-selection-handoff/v1' || handoff.status !== 'QUALIFIED_FOR_EXECUTION_REVIEW') continue;
    if (dispatch?.schema !== 'selection-handoff-dispatch/v1' || dispatch.result !== 'DELIVERED_IN_DESTINATION_CHAT') continue;
    const { sellerSku: sku, handoffId, recipient, researchDoc } = handoff;
    if (handoff.shop !== shop.name || handoff.market !== shop.region ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/u.test(sku ?? '') || typeof handoffId !== 'string' ||
        dispatch.handoffId !== handoffId || dispatch.destinationThreadId !== recipient || !dispatch.destinationTurnId ||
        !dispatch.destinationInputItemId || !Number.isFinite(Date.parse(dispatch.confirmedAt)) ||
        dayKey(new Date(dispatch.confirmedAt)) !== day || typeof researchDoc !== 'string' ||
        basename(researchDoc) !== researchDoc || seen.has(sku)) throw new Error('Original selection handoff identity mismatch');
    seen.add(sku);
    const research = join(folder, researchDoc);
    if (await digest(research) !== handoff.researchDocSha256) throw new Error('Selection research differs from the dispatched version');
    const official = await checkCandidate(client, token, shop, { sku });
    rows.push({ sku, handoffId, confirmedAt: dispatch.confirmedAt, source, dispatchSource, research,
      buyerPriceMyr: handoff.test?.buyerPriceInclLVGExFreightMYR ?? null,
      naturalWestMyr: handoff.test?.naturalWestMYR ?? null, naturalEastMyr: handoff.test?.naturalEastMYR ?? null,
      status: 'delivered_to_listing', official: official.available ? official.result : { error: official.error } });
  }
  return { observedAt: new Date().toISOString(), rows, writes: 0 };
}

async function candidateFromHandoffPreflight(directory, day, shop) {
  const source = join(directory, 'listing-preflight-shadow-readback.json');
  const original = await optionalJson(source);
  if (!original) return null;
  const manifest = join(directory, 'listing.json');
  const input = await readJson(manifest);
  const sku = input.sellerSku;
  const inputHash = await digest(manifest);
  const official = original.officialPreflight;
  const handoffPath = typeof original.source?.handoff === 'string' ? resolve(root, original.source.handoff) : '';
  if (original.schema !== 'single-sku-handoff-preflight-shadow/v1' || !isSameShop(original.shop, shop) ||
      original.sellerSku !== sku || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/u.test(sku ?? '') ||
      original.input?.path !== 'listing.json' || original.input.sha256 !== inputHash ||
      !isSameShop(official?.shop, shop) || official.sellerSku !== sku || official.writes !== 0 ||
      official.runner?.mode !== '--preflight' || official.runner.completed !== true || original.shadow?.writes !== 0 ||
      original.submission?.platformWrites !== 0 || basename(handoffPath) !== 'handoff.json' ||
      dirname(dirname(handoffPath)) !== join(root, 'operations/product-operations/selection-research', day)) {
    throw new Error('Listing preflight receipt identity mismatch');
  }
  const handoff = await readJson(handoffPath);
  if (handoff.schema !== 'single-sku-selection-handoff/v1' || handoff.handoffId !== original.handoffId ||
      handoff.sellerSku !== sku || handoff.shop !== shop.name || handoff.market !== shop.region ||
      await digest(handoffPath) !== original.source.handoffSha256) throw new Error('Listing preflight source handoff changed');
  const unauthorized = original.brand?.aliasLookup?.exactNames?.find(row =>
    ['UNAUTHORIEZD', 'UNAUTHORIZED'].includes(row.authorizedStatus) && typeof row.name === 'string' && row.name.trim());
  let brandEvidence;
  if (unauthorized) {
    const files = (await readdir(directory)).filter(name => /^official-brand-tier-followup-.*\.json$/u.test(name)).sort().reverse();
    for (const filename of files) {
      const file = join(directory, filename);
      const evidence = await readJson(file);
      const [brand] = evidence.brand?.exact ?? [];
      if (evidence.schema !== 'operations-exact-listing-brand-and-category/v1' || !isSameShop(evidence.shop, shop) ||
          evidence.sellerSku !== sku || evidence.categoryId !== input.categoryId || evidence.writes !== 0 ||
          !(Date.parse(evidence.observedAt) > Date.parse(original.observedAt)) || dayKey(new Date(evidence.observedAt)) !== day ||
          evidence.brand?.exact?.length !== 1 || brand.id !== unauthorized.id || brand.name !== unauthorized.name ||
          !evidence.requests?.some(request => request.method === 'GET' && request.path === '/product/202309/brands' &&
            request.queryBrand === brand.name && request.code === 0 && request.status === 200 && request.requestId)) continue;
      brandEvidence = { source: file, observedAt: evidence.observedAt, id: brand.id, name: brand.name,
        availability: listingBrandAvailability(brand) };
      break;
    }
  }
  const sourceNotes = !input.brandId && unauthorized && brandEvidence?.availability !== 'selectable_without_brand_display'
    ? [`店铺未授权 ${unauthorized.name}`] : [];
  const validatedDraft = brandEvidence ? await inspect(() =>
    readPackingDraft(directory, shop, original.handoffId, source, input, inputHash, brandEvidence)) : null;
  return { sku, source, manifest, inputHash, input, originalTaskId: original.handoffId, sourceNotes, brandEvidence, validatedDraft };
}

async function readPackingDraft(directory, shop, handoffId, preflightSource, input, inputHash, brandEvidence) {
  const source = join(directory, 'brand-parcel-local-shadow-readback-v1.json');
  const receipt = await optionalJson(source);
  if (!receipt) return null;
  const original = receipt.source?.originalListing;
  const preflight = receipt.source?.originalPreflight;
  const tier = receipt.source?.tierReceipt;
  const { execution, validation, trial } = receipt;
  const packing = receipt.package?.proposedPacking;
  const readback = validation?.independentLocalPayloadReadback;
  const filename = validation?.localInput;
  if (receipt.schema !== 'single-sku-brand-and-parcel-local-shadow/v1' || !isSameShop(receipt.shop, shop) ||
      receipt.handoffId !== handoffId || receipt.sellerSku !== input.sellerSku ||
      original?.file !== 'listing.json' || original.sha256 !== inputHash ||
      preflight?.file !== basename(preflightSource) || preflight.sha256 !== await digest(preflightSource) ||
      tier?.file !== basename(brandEvidence.source) || tier.sha256 !== await digest(brandEvidence.source) ||
      receipt.brand?.proposedPlatformBrand?.id !== brandEvidence.id || validation?.exitCode !== 0 ||
      execution?.platformWrites !== 0 || execution.platformSubmissionAuthorized !== false ||
      readback?.offline !== true || readback.writes !== 0 || readback.sourceSha256 !== inputHash ||
      typeof filename !== 'string' || !/^listing-[\w-]+\.json$/u.test(filename) || packing?.status !== 'TRIAL_ESTIMATE') {
    throw new Error('Packing draft does not match the original handoff and evidence');
  }
  const file = join(directory, filename);
  if (await digest(file) !== validation.localInputSha256) throw new Error('Packing draft contents changed');
  const { shadowBasis, ...candidate } = await readJson(file);
  const expected = { ...input, brandId: brandEvidence.id, packageWeight: readback.packageWeight,
    packageDimensions: readback.packageDimensions, packageBasis: candidate.packageBasis };
  const dimensionsCm = ['length', 'width', 'height'].map(axis => Number(candidate.packageDimensions?.[axis]));
  const weightG = Number(candidate.packageWeight?.value) * 1000;
  if (shadowBasis?.usage !== 'LOCAL_VALIDATION_ONLY' || shadowBasis.platformSubmissionAuthorized !== false ||
      shadowBasis.originalInputSha256 !== inputHash || shadowBasis.packageDimensionsAreEstimate !== true ||
      shadowBasis.proposedListingQuantity !== trial?.listingQuantity ||
      !isDeepStrictEqual(candidate, expected) || readback.oneSku !== input.sellerSku ||
      readback.categoryId !== input.categoryId || readback.brandId !== candidate.brandId ||
      readback.price?.currency !== 'MYR' || readback.price.sale_price !== input.salePrice ||
      !Number.isSafeInteger(trial?.listingQuantity) || trial.listingQuantity < 1 ||
      readback.inventory?.warehouse_id !== input.warehouseId || readback.inventory.quantity !== trial?.listingQuantity ||
      trial.salePriceMyr !== input.salePrice || !isDeepStrictEqual(dimensionsCm, packing.outerDimensionsCm) ||
      weightG !== packing.estimatedSealedG) throw new Error('Packing draft fields differ from the original plan');
  const verified = await runSingleSkuListing({ mode: '--validate', input: candidate, media: directory, log: false });
  if (!isDeepStrictEqual(verified.mediaHashes, validation.output?.mediaHashes)) throw new Error('Packing draft media changed');
  return { source, file, observedAt: receipt.observedAt, verifiedAt: verified.observedAt, salePrice: candidate.salePrice,
    quantity: readback.inventory.quantity, estimatedParcel: { dimensionsCm, weightG },
    mediaCount: verified.mediaHashes.length, mediaHashes: verified.mediaHashes };
}

export function reviewListingCarriage(receipt, { shop, original, price }) {
  const { supplier, carrier, currentDecision } = receipt ?? {};
  const source = original.supplier;
  if (receipt?.schema !== 'tc27-exact-english-option-carriage-and-cost-followup/v1' ||
      !isSameShop({ ...receipt.shop, region: receipt.shop?.market }, shop) || receipt.sellerSku !== original.sellerSku ||
      !source?.exactOfferId || supplier?.offerId !== source.exactOfferId ||
      !source.supplierSku || supplier.englishSupplierSkuFromOriginalHandoff !== source.supplierSku ||
      !source.exactOption || supplier.exactOption !== source.exactOption || receipt.pricing?.amountMyr !== price ||
      currentDecision?.shopWrites !== 0 || currentDecision.mediaUploads !== 0 || currentDecision.submissions !== 0 ||
      currentDecision.readyToSubmit !== false || typeof currentDecision.actualParcelVerified !== 'boolean' ||
      typeof carrier?.exactEnglishKitCarriageVerified !== 'boolean' || typeof supplier.publishedBatteryRemovalOptionFound !== 'boolean') return null;
  return { carriageVerified: carrier.exactEnglishKitCarriageVerified, parcelVerified: currentDecision.actualParcelVerified,
    publishedBatteryFreeOption: supplier.publishedBatteryRemovalOptionFound };
}

async function readListingCarriage(directory, day, shop, original, preparationSource, prepared) {
  const names = await readdir(directory);
  const files = names.filter(name => /^TC27-英文版承运与RM[\d.]+复核-\d{8}\.json$/u.test(name));
  const reports = await Promise.all(files.map(async name => {
    const source = join(directory, name);
    const receipt = await readJson(source);
    const observedAt = Date.parse(receipt.recordedAt);
    const summary = reviewListingCarriage(receipt, { shop, original, price: prepared.input.salePrice });
    if (!summary || !Number.isFinite(observedAt) || dayKey(new Date(observedAt)) !== day || !Array.isArray(receipt.sources)) return null;
    const matches = (path, sha256) => receipt.sources.some(row => typeof row.file === 'string' &&
      resolve(root, row.file) === path && row.sha256 === sha256);
    if (!matches(prepared.file, prepared.hash) || !matches(preparationSource, await digest(preparationSource))) return null;
    return { ...summary, source, observedAt: receipt.recordedAt };
  }));
  return reports.filter(Boolean).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
}

async function dailyListingCandidate(directory, day, shop) {
  const source = join(directory, 'api-preparation-readback.json');
  const original = await optionalJson(source);
  if (!original) return candidateFromHandoffPreflight(directory, day, shop);
  const manifest = join(directory, 'listing.json');
  const input = await readJson(manifest);
  const sku = input.sellerSku;
  if (original.schema !== 'single-sku-listing-api-preparation/v1' || !original.originalTaskId ||
      !isSameShop(original.shop, shop) || original.sellerSku !== sku || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/u.test(sku ?? '') ||
      typeof original.manifest?.path !== 'string' || resolve(root, original.manifest.path) !== manifest) {
    throw new Error('Original listing manifest identity mismatch');
  }
  const inputHash = await digest(manifest);
  const adoptionSource = join(directory, 'api-price-adoption-readback.json');
  const adoption = await optionalJson(adoptionSource);
  let prepared;
  if (adoption?.state === 'PRICE_EVIDENCE_ADOPTED_LOCAL_ONLY' && isSameShop(adoption.shop, shop) && adoption.sellerSku === sku &&
      inputHash === adoption.originalManifest?.sha256 && typeof adoption.preparedManifest?.path === 'string') {
    const file = join(directory, 'listing-price-prepared.json');
    const hash = await digest(file);
    if (resolve(root, adoption.preparedManifest.path) !== file || hash !== adoption.preparedManifest.sha256) {
      throw new Error('Price preparation receipt does not match the saved manifest');
    }
    const candidate = await readJson(file);
    if (candidate.sellerSku !== sku || candidate.salePrice !== adoption.price?.plannedApiSalePrice ||
        !isDeepStrictEqual({ ...input, salePrice: candidate.salePrice }, candidate)) {
      throw new Error('Price preparation changed other listing fields');
    }
    prepared = { file, hash, source: adoptionSource, input: candidate };
  }
  const [validatedDraft, carriage] = prepared ? await Promise.all([
    inspect(() => readSourceBackedDraft(day, shop, prepared, original)),
    inspect(() => readListingCarriage(directory, day, shop, original, source, prepared)),
  ]) : [null, null];
  const sourceNotes = original.supplier?.kitLightingSource?.exactEnglishOptionShipsWithCells === null ? ['随盒电池'] : [];
  if (carriage?.result?.carriageVerified === false) sourceNotes.push('胶水实配和承运资格');
  if (carriage?.result?.parcelVerified === false) sourceNotes.push('封箱毛重');
  return { sku, source, manifest, inputHash, input, prepared, validatedDraft, carriage, originalTaskId: original.originalTaskId, sourceNotes };
}

export function matchesEstimatedListingInput(basis, candidate, brand, packaging) {
  const { shadowBasis, ...input } = candidate;
  const dimensions = packaging?.outerDimensions;
  return shadowBasis?.usage === 'LOCAL_VALIDATION_ONLY' && shadowBasis.platformSubmissionAuthorized === false &&
    shadowBasis.packageDimensionsAreEstimate === true && packaging?.measured === false &&
    listingBrandAvailability(brand) === 'selectable_without_brand_display' &&
    Number(input.packageWeight?.value) === packaging.estimatedWeightKg &&
    ['length', 'width', 'height'].every(axis => Number(dimensions?.[axis]) > packaging.source?.[axis]) &&
    isDeepStrictEqual(input, { ...basis, brandId: brand.id, packageDimensions: dimensions, packageBasis: input.packageBasis });
}

async function readSourceBackedDraft(day, shop, prepared, original) {
  const basis = prepared.input;
  const output = join(root, 'outputs/operations-listings', shop.region, basis.sellerSku);
  const names = await readdir(output).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names.filter(file => /^source-backed-shadow-[\dTZ-]+\.json$/u.test(file)).sort().reverse()) {
    const source = join(output, name);
    const receipt = await readJson(source);
    const refs = receipt.sources;
    if (receipt.schema !== 'operations-listing-source-backed-shadow/v1' || !isSameShop(receipt.shop, shop) ||
        receipt.sellerSku !== basis.sellerSku || receipt.categoryId !== basis.categoryId || receipt.shopWrites !== 0 ||
        receipt.mediaUploads !== 0 || !Number.isFinite(Date.parse(receipt.observedAt)) || dayKey(new Date(receipt.observedAt)) !== day ||
        typeof refs?.manifest !== 'string' || resolve(root, refs.manifest) !== prepared.file || refs.manifestSha256 !== prepared.hash ||
        !/^listing-source-backed-shadow-[\dTZ-]+\.json$/u.test(refs.input) ||
        !/^outputs\/operations-listing-shadow\/source-readback-[\dTZ-]+\.json$/u.test(refs.brandRead) ||
        !original.supplier?.sourceImages?.some(row => row.path === refs.sourceImage && row.sha256 === refs.sourceImageSha256)) continue;
    const file = join(output, refs.input);
    const brandFile = join(root, refs.brandRead);
    if (await digest(file) !== refs.inputSha256 || await digest(brandFile) !== refs.brandReadSha256 ||
        await digest(join(root, refs.sourceImage)) !== refs.sourceImageSha256) continue;
    const candidate = await readJson(file);
    const evidence = await readJson(brandFile);
    const brandSearch = evidence.tc27?.brandSearch?.find(row => row.name === receipt.brand?.name);
    const { mapping, ...brand } = receipt.brand ?? {};
    if (mapping !== 'matching_printed_brand_name_shadow_only' || evidence.schema !== 'operations-listing-source-readback/v1' ||
        !isSameShop(evidence.shop, shop) || evidence.writes !== 0 || evidence.tc27?.sellerSku !== basis.sellerSku ||
        evidence.tc27.categoryId !== basis.categoryId || evidence.tc27.exactSkuSearch !== 0 || evidence.tc27.hasNext !== false ||
        brandSearch?.exact?.length !== 1 || !isDeepStrictEqual(brandSearch.exact[0], brand) ||
        !evidence.requests?.some(row => row.path === '/product/202309/brands' && row.method === 'GET' &&
          row.brandName === brand.name && row.code === 0 && row.requestId) ||
        !isDeepStrictEqual(original.supplier.publishedRetailBoxDimensionsCm, receipt.packaging?.source) ||
        !matchesEstimatedListingInput(basis, candidate, brand, receipt.packaging)) continue;
    const verified = await runSingleSkuListing({ mode: '--validate', input: candidate, media: dirname(prepared.file), log: false });
    const shadow = await readSubmissionShadow(day, shop, candidate, verified.mediaHashes);
    if (shadow?.state !== 'SHADOW_VERIFIED' || basename(shadow.source) !== refs.shadow || shadow.observedAt !== receipt.observedAt) continue;
    const shadowReceipt = await readJson(shadow.source);
    return { file, source, observedAt: receipt.observedAt, salePrice: candidate.salePrice, quantity: shadowReceipt.submission.quantity,
      mediaCount: verified.mediaHashes.length, mediaHashes: verified.mediaHashes, brand,
      estimatedParcel: { dimensionsCm: ['length', 'width', 'height'].map(axis => Number(candidate.packageDimensions[axis])),
        weightG: receipt.packaging.estimatedWeightKg * 1000 } };
  }
  return null;
}

async function readCategoryContract(client, token, shop, input) {
  const [rules, attributes] = await Promise.all([
    client.listingCategoryRules(token, shop, input.categoryId), client.listingCategoryAttributes(token, shop, input.categoryId),
  ]);
  if (!Array.isArray(rules.product_certifications) || !Array.isArray(attributes.attributes) ||
      typeof rules.package_dimension?.is_required !== 'boolean') throw new Error('Official category contract incomplete');
  const catalog = new Map(attributes.attributes.map(attribute => [attribute.id, attribute]));
  const supplied = new Map((input.productAttributes ?? []).map(attribute => [attribute.id, attribute]));
  const required = attributes.attributes.filter(attribute => (attribute.is_required ?? attribute.is_requried) === true);
  const missing = required.filter(attribute => !supplied.get(attribute.id)?.values?.length).map(attribute => attribute.id);
  const unverified = [...supplied.values()].filter(attribute => {
    const current = catalog.get(attribute.id);
    return !current || attribute.values.some(value => !current.values?.some(allowed => allowed.id === value.id));
  }).map(attribute => attribute.id);
  return { categoryId: input.categoryId, parcelDimensionsRequired: rules.package_dimension.is_required,
    requiredCertificates: rules.product_certifications.filter(item => item.is_required === true).map(item => item.id),
    requiredAttributes: required.map(attribute => attribute.id), missingRequiredAttributes: missing, unverifiedSuppliedAttributes: unverified };
}

async function readSubmissionShadow(day, shop, input, mediaHashes) {
  const directory = join(root, 'outputs/operations-listings', shop.region, input.sellerSku);
  const files = await readdir(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const requiredReads = ['/authorization/202309/shops', '/product/202502/products/search',
    '/product/202507/global_listing_rules', `/product/202309/categories/${input.categoryId}/rules`];
  for (const file of files.filter(name => /^submit-shadow-.*\.json$/u.test(name)).sort().reverse()) {
    const source = join(directory, file);
    const receipt = await readJson(source);
    if (receipt.schema !== 'operations-listing-submit-shadow/v1' || receipt.shopId !== shop.id ||
        receipt.sellerSku !== input.sellerSku || receipt.categoryId !== input.categoryId || receipt.inputHash !== inputHash ||
        receipt.shopWrites !== 0 || receipt.mediaUploads !== 0 || !Number.isFinite(Date.parse(receipt.observedAt)) ||
        dayKey(new Date(receipt.observedAt)) !== day || receipt.existingCount !== 0 ||
        !['skuAbsent', 'listingMethod', 'warehouse', 'certificateFields'].every(key => receipt.official?.[key] === true) ||
        !requiredReads.every(path => receipt.requests?.some(row => row.path === path && row.httpStatus === 200 && row.code === 0 && row.requestId))) continue;
    const { submission, missingLocalFields } = receipt;
    if (receipt.state === 'SHADOW_VERIFIED' && submission?.saveMode === 'LISTING' && submission.imageUrisArePlaceholders === true &&
        submission.sellerSku === input.sellerSku && submission.price?.sale_price === input.salePrice &&
        isDeepStrictEqual(receipt.mediaHashes, mediaHashes)) return { source, observedAt: receipt.observedAt, state: receipt.state };
    if (receipt.state === 'SHADOW_INCOMPLETE' && submission === null && Array.isArray(missingLocalFields) && missingLocalFields.length) {
      return { source, observedAt: receipt.observedAt, state: receipt.state, missingLocalFields };
    }
  }
  return null;
}

export async function readDailyListingCandidates(day, { client, token, shop }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !isSameShop(shop, { id: shopId, name: 'example-shop-my', region: 'MY' })) {
    throw new Error('Exact MY shop and listing date are required');
  }
  const directory = join(root, 'operations/product-operations/daily', day);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const candidates = (await Promise.all(entries.filter(entry => entry.isDirectory())
    .map(entry => dailyListingCandidate(join(directory, entry.name), day, shop)))).filter(Boolean);
  if (new Set(candidates.map(row => row.sku)).size !== candidates.length) throw new Error('Duplicate listing preparation for the same seller SKU');
  const rows = [];
  for (const candidate of candidates) {
    const { sku, source, manifest, inputHash, input, prepared, originalTaskId, sourceNotes, brandEvidence, validatedDraft, carriage } = candidate;
    const working = prepared?.input ?? input;
    const fields = listingInputIssues({ ...working, shopId, listingMethods: ['LOCAL_REPLICATION'], categoryVersion: 'v2',
      imageUris: Array.isArray(working.images) ? working.images.map((_, index) => `tos-local-validation-${index + 1}`) : [] });
    const local = fields.length ? { available: false, fields: fields.map(issue => issue.field) } :
      await inspect(() => runSingleSkuListing({ mode: '--validate', input: working, media: dirname(manifest), log: false }));
    const [observed, category] = await Promise.all([checkCandidate(client, token, shop, candidate),
      inspect(() => readCategoryContract(client, token, shop, working))]);
    const packing = validatedDraft?.result;
    const shadowInput = packing ? await readJson(packing.file) : working;
    const shadow = await readSubmissionShadow(day, shop, shadowInput, packing?.mediaHashes ?? local.result?.mediaHashes);
    rows.push({ sku, source, manifest, inputHash, originalTaskId, sourceNotes, brandEvidence, validatedDraft, carriage, shadow, salePrice: working.salePrice ?? null,
      baseSalePrice: input.salePrice ?? null, prepared: prepared && { file: prepared.file, hash: prepared.hash, source: prepared.source },
      local, category, official: observed.available ? observed.result : { error: observed.error } });
  }
  return { observedAt: new Date().toISOString(), shop: { id: shop.id, name: shop.name, region: shop.region }, rows, writes: 0 };
}

async function runPublisher(args) {
  try {
    const { stdout } = await execute(process.execPath, [join(root, 'scripts/publisher/cli.mjs'), ...args],
      { cwd: root, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (![10, 20].includes(error.code) || !error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}

async function verifyProduction(client, token, shop) {
  const manifest = join(root, sources.production);
  const job = await readJson(manifest);
  const runtime = await readJson(join(root, 'scripts/publisher/config.json'));
  if (runtime.live_enabled !== false || job.market !== 'MY' || job.ready_to_publish !== true ||
      job.file?.path !== job.final_video || job.file?.sha256 !== job.sha256 || job.semantic_review?.sha256 !== job.sha256) {
    throw new Error('Production handoff identity or dry-mode requirement changed');
  }
  const [hash, captionHash, media, listing] = await Promise.all([
    digest(job.file.path), digest(job.semantic_review.evidence.path),
    execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,width,height,avg_frame_rate',
      '-of', 'json', job.file.path], { windowsHide: true, timeout: 20_000 }),
    exactProduct(client, token, shop, job.seller_sku, job.product_id, job.sku_id),
  ]);
  const probe = JSON.parse(media.stdout);
  const picture = probe.streams?.find(row => row.codec_type === 'video');
  const duration = Number(probe.format?.duration);
  const [frames, unit] = (picture?.avg_frame_rate ?? '').split('/').map(Number);
  const fps = frames / unit;
  if (hash !== job.sha256 || captionHash !== job.semantic_review.evidence.sha256 || Number(probe.format?.size) !== job.file.bytes ||
      picture?.width !== job.width || picture.height !== job.height || !Number.isFinite(duration) ||
      Math.abs(duration - job.duration_seconds) > 0.1 || !Number.isFinite(fps) || Math.abs(fps - job.fps) > 0.01 ||
      !probe.streams.some(row => row.codec_type === 'audio')) throw new Error('Published-candidate media does not match the source package');
  const temporary = await mkdtemp(join(tmpdir(), 'tiktok-handoff-'));
  const state = ['--state-dir', temporary];
  const intake = await runPublisher(['intake', ...state, '--source-dir', dirname(manifest)]);
  const plan = await runPublisher(['plan', ...state]);
  const dry = await runPublisher(['run', '--job', job.video_id, '--mode', 'dry', ...state]);
  const diagnostic = dry.case_file ? await readJson(dry.case_file) : null;
  return { manifest: sources.production, videoId: job.video_id, sha256: hash, account: job.target_account,
    picture: { width: picture.width, height: picture.height, duration, fps },
    captionSha256: captionHash, officialListing: listing, intakeAccepted: intake.accepted,
    publisherPlan: plan.accounts?.find(row => row.account === job.target_account) ?? null, dry,
    diagnostic: diagnostic ? { failedStage: diagnostic.failed_stage, missingDays: diagnostic.error?.details?.missing_days ?? [],
      submitIntentExists: diagnostic.submit_intent_exists } : null };
}

async function main() {
  const [credentials, authorization, pending, listed, draft] = await Promise.all([
    loadLocalAppCredentials(), loadLocalAuthorization(),
    ...[sources.pending, sources.listed, sources.draft].map(file => readJson(join(root, file))),
  ]);
  const { tokens } = authorization;
  if (credentials.serviceId !== authorization.serviceId || tokens?.user_type !== 0 || !tokens.access_token) {
    throw new Error('Matching seller authorization is required');
  }
  const requests = [];
  const client = createTikTokClient({ ...credentials, async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ method: options.method, path: url.pathname, status: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const token = tokens.access_token;
  const shop = (await client.authorizedShops(token)).find(row => row.id === shopId && row.region === 'MY' && row.name === 'example-shop-my');
  if (!shop) throw new Error('Exact Malaysia Cross1 shop is required');
  const sourceBatch = [
    ...pending.candidates.map(row => row.sku === draft.sku ? { ...row, productId: draft.product, platformSku: draft.nativeSku,
      readDraftVersion: true } : row),
    ...[listed.classroom, listed.kite].map(row => ({ sku: row.sellerSKU, productId: row.productId, platformSku: row.platformSku })),
  ];
  if (sourceBatch.some(row => typeof row.sku !== 'string') || new Set(sourceBatch.map(row => row.sku)).size !== sourceBatch.length) {
    throw new Error('Source batch is missing exact, unique SKUs');
  }
  const candidates = [];
  const production = inspect(() => verifyProduction(client, token, shop));
  for (const row of sourceBatch) candidates.push(await checkCandidate(client, token, shop, row));
  const observedAt = new Date().toISOString();
  const day = dayKey(new Date(observedAt));
  const receipt = { schema: 'operations-handoff-reconciliation/v1', observedAt, day,
    shop: { id: shop.id, name: shop.name, region: shop.region }, sources, candidates, production: await production, requests };
  const directory = join(root, 'outputs/operations-handoff-reconciliation', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'official-read-' + observedAt.replace(/[:.]/gu, '-') + '.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, ...receipt }, null, 2));
  if (candidates.some(row => !row.available) || !receipt.production.available) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(publicPlatformError(error, error.message));
    process.exitCode = 1;
  });
}
