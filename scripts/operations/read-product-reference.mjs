import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isPlatformId } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const imageHosts = new Set(['p16-oec-va.ibyteimg.com', 'p19-oec-va.ibyteimg.com']);
const maxBytes = 12 * 1024 * 1024;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function matchCandidates(products, query) {
  const key = normalize(query);
  if (key.length < 2) throw new Error('Enter a model name or SKU.');
  const terms = normalize(query).replace(/银灰(?:色)?/gu, ' silvergray ').replace(/(?:墨|深)绿(?:色)?/gu, ' darkgreen ').trim().split(/\s+/u);
  return products.filter(product => product.status === 'ACTIVATE' && isPlatformId(product.id)).flatMap(product =>
    (product.skus ?? []).filter(sku => isPlatformId(sku.id)).flatMap(sku => {
      const exact = sku.id === query || normalize(sku.sellerSku) === key;
      const sellerKey = normalize(sku.sellerSku).replace(/grey/gu, 'gray');
      const searchMatch = terms.every(term => sellerKey.includes(term.replace(/grey/gu, 'gray')));
      return exact || searchMatch ? [{ productId: product.id, skuId: sku.id, sellerSku: sku.sellerSku, title: product.title, exact }] : [];
    })).sort((a, b) => Number(b.exact) - Number(a.exact) || a.skuId.localeCompare(b.skuId));
}

function referenceMetadata(product, productId, skuId) {
  if (product?.id !== productId || product.status !== 'ACTIVATE' || product.audit?.status !== 'APPROVED') {
    throw new Error('The product is not verified as listed in MY example-shop-my.');
  }
  const selected = product.skus?.filter(sku => sku.id === skuId) ?? [];
  if (selected.length !== 1) throw new Error('The exact SKU is unavailable on this product.');
  const [sku] = selected;
  if (sku.status_info?.status && sku.status_info.status !== 'NORMAL') throw new Error('The exact SKU is not active.');
  const attributes = (sku.sales_attributes ?? []).map(attribute => ({ name: attribute.name, value: attribute.value_name?.trim() }));
  const variants = (sku.sales_attributes ?? []).flatMap(attribute => attribute.sku_img ? [{ image: attribute.sku_img, kind: 'sku_image' }] : []);
  const eligible = product.skus.length === 1 && !variants.length
    ? (product.main_images ?? []).map(image => ({ image, kind: 'single_sku_gallery' })) : variants;
  const distinct = new Map(eligible.filter(({ image }) => image?.uri).map(item => [item.image.uri, item]));
  return { productId, skuId, title: product.title, sellerSku: sku.seller_sku, status: product.status, attributes,
    variantsOnListing: product.skus.length, skuStatus: sku.status_info?.status ?? null, images: [...distinct.values()] };
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && imageHosts.has(url.hostname) && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function matchesImage(type, bytes) {
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

async function readImage(media) {
  const urls = (media.urls ?? []).map(safeUrl).filter(Boolean);
  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const type = response.headers.get('content-type')?.split(';')[0].trim();
      if (!response.ok || !extensions[type] || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
        await response.body?.cancel();
        continue;
      }
      const chunks = [];
      let count = 0;
      for await (const chunk of response.body) {
        count += chunk.byteLength;
        if (count > maxBytes) throw new Error('Image size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, count);
      if (matchesImage(type, bytes)) return { bytes, type, host: url.hostname };
    } catch {
      // The product response may provide an alternate official CDN URL for the same image.
    }
  }
  return null;
}

async function createReference(session, productId, skuId, output) {
  const { client, token, shop } = session;
  const { data, requestId } = await client.productDetail(token, shop, productId, { includeRequestId: true });
  if (!requestId) throw new Error('The platform did not return a product request ID.');
  const { images, ...metadata } = referenceMetadata(data, productId, skuId);
  const collectedAt = new Date().toISOString();
  const path = join(output, skuId, collectedAt.replace(/[:.]/gu, '-'));
  await mkdir(path, { recursive: true });
  const downloads = [];
  for (const { image, kind } of images) {
    const download = await readImage(image);
    if (!download) continue;
    const file = `${kind}-${downloads.length + 1}.${extensions[download.type]}`;
    await writeFile(join(path, file), download.bytes, { flag: 'wx' });
    downloads.push({ file, kind, uri: image.uri, host: download.host, mimeType: download.type,
      width: image.width ?? null, height: image.height ?? null, bytes: download.bytes.length,
      sha256: createHash('sha256').update(download.bytes).digest('hex') });
  }
  const state = !images.length ? 'exact_image_missing' : downloads.length ? 'downloaded' : 'image_download_unavailable';
  const manifest = { schema: 'shop-product-reference/v1', shop: { id: shop.id, name: shop.name, market: shop.region },
    ...metadata, requestId, collectedAt, state, availableImages: images.length, images: downloads };
  const receipt = join(path, 'product-reference.json');
  await writeFile(receipt, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { state, receipt, images: downloads.map(image => join(path, image.file)) };
}

async function main() {
  const { values } = parseArgs({ options: { query: { type: 'string' }, 'product-id': { type: 'string' },
    'sku-id': { type: 'string' }, output: { type: 'string' } } });
  const { query, 'product-id': productId, 'sku-id': skuId } = values;
  if (query ? productId || skuId || normalize(query).length < 2 : !isPlatformId(productId) || !isPlatformId(skuId)) {
    throw new Error('Use --query MODEL, or provide both --product-id and --sku-id.');
  }
  const session = await openMyShopSession(shopId);
  if (query) {
    const { client, token, shop } = session;
    const list = await collectPages(cursor => client.productsPage(token, shop, 100, cursor), Date.now() + 75_000);
    const matches = matchCandidates(list.rows, query);
    console.log(JSON.stringify({ query, collectedAt: new Date().toISOString(), total: matches.length, candidates: matches.slice(0, 25) }));
    return;
  }
  const output = values.output ? resolve(values.output) : join(projectRoot, 'outputs', 'operations-product-reference');
  const result = await createReference(session, productId, skuId, output);
  console.log(JSON.stringify(result));
  if (result.state !== 'downloaded') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = /^[A-Za-z .,-]+$/u.test(error?.message ?? '') ? error.message : '商品素材只读查询未完成。';
    console.error(message);
    process.exitCode = 1;
  });
}
