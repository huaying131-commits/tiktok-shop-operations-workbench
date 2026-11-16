import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardProductCoverUrl } from './operations-dashboard-images.mjs';
import { snapshotFilename } from './tiktok-shop-finance.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const malaysiaDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
const identifier = /^\d{14,22}$/u;
const persistedLimit = 8;
const coverRecheckMs = 45_000;
const persistedReceipts = new Map();
const projectedRows = new WeakMap();

async function readCatalogueReceipt(file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const signature = `${info.size}/${info.mtimeMs}/${info.ctimeMs}`;
  const cached = persistedReceipts.get(file);
  if (cached?.signature === signature) {
    persistedReceipts.delete(file);
    persistedReceipts.set(file, cached);
    return cached.read;
  }
  const read = readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  const entry = { signature, read };
  persistedReceipts.set(file, entry);
  while (persistedReceipts.size > persistedLimit) persistedReceipts.delete(persistedReceipts.keys().next().value);
  const receipt = await read;
  if (!receipt && persistedReceipts.get(file) === entry) persistedReceipts.delete(file);
  return receipt;
}

function hasCatalogue(receipt, day) {
  const products = receipt?.products;
  const observedAt = receipt?.collectedAt;
  return receipt?.shop?.id === shopId && receipt.shop.region === 'MY' && receipt.shop.name === 'example-shop-my' &&
    receipt.source === 'TikTok Shop Open API' && Number.isFinite(Date.parse(observedAt)) &&
    Array.isArray(products?.rows) && Number.isSafeInteger(products.pages) && products.pages > 0 &&
    (products.totalCount === null || products.totalCount === products.rows.length) &&
    (!day || malaysiaDay.format(new Date(observedAt)) <= day);
}

async function catalogueRows(receipt, root, path = null) {
  const products = receipt.products.rows;
  if (products.some(product => !identifier.test(product?.id ?? '')) ||
      new Set(products.map(product => product.id)).size !== products.length) return null;
  const rows = await Promise.all(products.map(async product => {
    const variants = (Array.isArray(product.skus) ? product.skus : []).filter(sku => identifier.test(sku?.id ?? ''))
      .map(sku => ({ skuId: sku.id, sellerSku: typeof sku.sellerSku === 'string' ? sku.sellerSku : null }));
    const imageUrl = product.status === 'ACTIVATE' ? await dashboardProductCoverUrl({ productId: product.id, workspaceRoot: root }) : null;
    return { productId: product.id, title: product.title || null, status: product.status || null, imageUrl, variants };
  }));
  return {
    activeProducts: products.filter(product => product.status === 'ACTIVATE').length,
    productsTotal: products.length,
    rows,
    rowsSource: { observedAt: receipt.collectedAt, path, label: 'TikTok Shop 官方商品目录' },
  };
}

function projectCatalogue(receipt, root, path = null) {
  // The scheduled sync replaces its snapshot object. Cover checks expire within
  // 45 seconds so new cover receipts can appear before the next shop sync.
  const cached = projectedRows.get(receipt);
  if (cached?.root === root && cached.path === path && Date.now() < cached.expiresAt) return cached.read;
  const entry = { root, path, expiresAt: Infinity, read: null };
  entry.read = catalogueRows(receipt, root, path)
    .then(rows => {
      entry.expiresAt = Date.now() + coverRecheckMs;
      return rows;
    })
    .catch(error => {
      if (projectedRows.get(receipt) === entry) projectedRows.delete(receipt);
      throw error;
    });
  projectedRows.set(receipt, entry);
  return entry.read;
}

export async function readDashboardCatalogue({ day, root = workspace, synced = null } = {}) {
  const folder = join(root, 'apps/customer-service/data/tiktok-shop', shopId);
  const names = await readdir(folder).catch(() => []);
  const runningSnapshot = hasCatalogue(synced, day) ? synced : null;
  for (const name of names.filter(name => snapshotFilename.test(name)).sort().reverse()) {
    // File timestamps are UTC, while the requested dashboard date is Malaysian.
    if (day && `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}` > day) continue;
    const path = join(folder, name);
    const receipt = await readCatalogueReceipt(path);
    if (!hasCatalogue(receipt, day)) continue;
    if (runningSnapshot && Date.parse(runningSnapshot.collectedAt) >= Date.parse(receipt.collectedAt)) {
      const latest = await projectCatalogue(runningSnapshot, root);
      if (latest) return latest;
    }
    const rows = await projectCatalogue(receipt, root, relative(root, path).replaceAll('\\', '/'));
    if (rows) return rows;
  }
  return runningSnapshot ? projectCatalogue(runningSnapshot, root) : null;
}
