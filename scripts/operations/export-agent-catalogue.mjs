import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDashboardCatalogue } from '../../apps/customer-service/operations-dashboard-catalogue.mjs';
import { getDashboardImage } from '../../apps/customer-service/operations-dashboard-images.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const maxImageBytes = 12 * 1024 * 1024;
const platformId = /^\d{14,22}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

function imageFormat(bytes, contentType) {
  switch (contentType) {
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}

async function readExactSkuImages(workspace) {
  const references = join(workspace, 'outputs', 'operations-product-reference');
  const images = new Map();
  const skuDirs = await readdir(references, { withFileTypes: true }).catch(() => []);
  for (const entry of skuDirs.filter(item => item.isDirectory() && platformId.test(item.name))) {
    const skuDir = join(references, entry.name);
    const candidates = await readdir(skuDir, { withFileTypes: true }).catch(() => []);
    for (const candidate of candidates.filter(item => item.isDirectory() && /^[0-9TZ-]+$/u.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name))) {
      const folder = join(skuDir, candidate.name);
      const source = join(folder, 'product-reference.json');
      try {
        if (await realpath(source) !== source || (await stat(source)).size > 48_000) continue;
        const m = await readJson(source);
        if (m.schema !== 'shop-product-reference/v1' || m.state !== 'downloaded' ||
            m.shop?.id !== shopId || m.shop?.market !== 'MY' || m.shop?.name !== 'example-shop-my' ||
            !platformId.test(m.productId) || m.skuId !== entry.name || m.status !== 'ACTIVATE' ||
            !m.requestId || !Number.isFinite(Date.parse(m.collectedAt))) continue;
        for (const image of Array.isArray(m.images) ? m.images : []) {
          if (!['sku_image', 'single_sku_gallery'].includes(image.kind) ||
              (image.kind === 'single_sku_gallery' && m.variantsOnListing !== 1) ||
              !/^(?:sku_image|single_sku_gallery)-\d+\.(?:jpg|png|webp)$/u.test(image.file ?? '') ||
              !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > maxImageBytes ||
              !/^[a-f0-9]{64}$/u.test(image.sha256 ?? '')) continue;
          const file = join(folder, image.file);
          if (await realpath(file) !== file || (await stat(file)).size !== image.bytes) continue;
          const bytes = await readFile(file);
          if (!imageFormat(bytes, image.mimeType) || digest(bytes) !== image.sha256) continue;
          images.set(m.productId + ':' + m.skuId, { bytes, contentType: image.mimeType });
          break;
        }
        if (images.has(m.productId + ':' + m.skuId)) break;
      } catch {
        // Incomplete or stale image receipts are excluded from the export.
      }
    }
  }
  return images;
}

export async function exportAgentCatalogue(destination, workspace = root) {
  const canonicalWorkspace = await realpath(workspace);
  const cached = await readJson(join(canonicalWorkspace, 'apps/customer-service/data/operations-board/catalogue-live.json')).catch(() => null);
  const listing = await readDashboardCatalogue({ root: canonicalWorkspace, synced: cached });
  const active = listing?.rows.filter(row => row.status === 'ACTIVATE');
  if (!active?.length || !Number.isFinite(Date.parse(listing.rowsSource?.observedAt))) {
    throw new Error('No verified Malaysia product catalogue is available.');
  }

  const exact = await readExactSkuImages(canonicalWorkspace);
  const output = resolve(destination);
  const imageRoot = join(output, 'images');
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(imageRoot);
  const files = new Set();
  async function stageImage(image) {
    if (!image || !extensions[image.contentType]) return null;
    const name = digest(image.bytes) + '.' + extensions[image.contentType];
    if (!files.has(name)) {
      await writeFile(join(imageRoot, name), image.bytes, { flag: 'wx' });
      files.add(name);
    }
    return '/v1/images/' + name;
  }

  const products = [];
  for (const item of active) {
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 320) : '';
    if (!title || !platformId.test(item.productId)) continue;
    const cover = item.imageUrl ? await getDashboardImage(item.imageUrl, { workspaceRoot: canonicalWorkspace }) : null;
    const variants = [];
    for (const variant of item.variants) {
      variants.push({
        skuId: variant.skuId,
        sellerSku: typeof variant.sellerSku === 'string' ? variant.sellerSku.trim().slice(0, 200) || null : null,
        imageUrl: await stageImage(exact.get(item.productId + ':' + variant.skuId)),
      });
    }
    products.push({ productId: item.productId, title, imageUrl: await stageImage(cover), variants });
  }
  if (!products.length) throw new Error('No exportable active product.');
  const data = {
    schema: 'shop-agent-catalogue/v1',
    shop: { name: 'example-shop-my', market: 'MY' },
    observedAt: listing.rowsSource.observedAt,
    products,
  };
  const file = join(output, 'catalogue.json');
  await writeFile(file, JSON.stringify(data) + '\n', { flag: 'wx' });
  return { file, observedAt: data.observedAt, products: products.length,
    productImages: products.filter(p => p.imageUrl).length,
    exactSkuImages: products.reduce((n, p) => n + p.variants.filter(v => v.imageUrl).length, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/operations/export-agent-catalogue.mjs <new-export-directory>');
    process.exitCode = 1;
  } else {
    exportAgentCatalogue(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
