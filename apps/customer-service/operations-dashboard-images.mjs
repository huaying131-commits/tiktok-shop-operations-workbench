import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const imageRoute = '/api/operations/dashboard/images';
const productIdPattern = /^\d{14,22}$/u;
const coverPath = new RegExp(`^${imageRoute}/(\\d{14,22})/cover$`, 'u');
const coverSources = 'outputs/operations-dashboard-product-covers';
export const dashboardCoverHosts = new Set([
  'p16-oec-va.ibyteimg.com', 'p19-oec-va.ibyteimg.com', 'p16-oec-sg.ibyteimg.com', 'p19-oec-sg.ibyteimg.com',
]);
const coverLimit = 12 * 1024 * 1024;
// The private runtime populates exact product image evidence.
const images = new Map();

function inside(root, target) {
  const path = relative(root, target);
  return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function validImage(bytes, contentType) {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/jpeg') return jpeg;
  if (contentType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (contentType === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function readCover(root, productId) {
  const folder = await realpath(resolve(root, coverSources, productId));
  if (!inside(root, folder)) return null;
  const manifestFile = await realpath(join(folder, 'latest.json'));
  if (manifestFile !== join(folder, 'latest.json') || (await stat(manifestFile)).size > 12_000) return null;
  const receipt = JSON.parse(await readFile(manifestFile, 'utf8'));
  const { image, shop } = receipt ?? {};
  if (receipt?.schema !== 'operations-dashboard-product-cover/v1' || receipt.productId !== productId ||
      receipt.writes !== 0 || shop?.id !== '9000000000000000099' || shop.name !== 'example-shop-my' || shop.region !== 'MY' ||
      !Number.isFinite(Date.parse(receipt.observedAt)) || !/^[A-Za-z0-9_-]{6,128}$/u.test(receipt.requestId ?? '') ||
      image?.position !== 0 || image.kind !== 'product_main_image' || !dashboardCoverHosts.has(image.host) ||
      !/^[0-9TZ-]+-[a-f0-9-]{36}\.image$/u.test(image.filename ?? '') ||
      !Number.isSafeInteger(image.size) || image.size < 3 || image.size > coverLimit ||
      !/^[a-f0-9]{64}$/u.test(image.sha256 ?? '')) return null;
  const target = await realpath(join(folder, image.filename));
  if (target !== join(folder, image.filename)) return null;
  const file = await stat(target);
  if (!file.isFile() || file.size !== image.size) return null;
  const bytes = await readFile(target);
  if (!validImage(bytes, image.contentType) || createHash('sha256').update(bytes).digest('hex') !== image.sha256) return null;
  return { bytes, contentType: image.contentType };
}

export async function dashboardProductCoverUrl({ productId, workspaceRoot = workspace } = {}) {
  if (typeof productId !== 'string' || !productIdPattern.test(productId)) return null;
  const location = `${imageRoute}/${productId}/cover`;
  return await getDashboardImage(location, { workspaceRoot }) ? location : null;
}

export function dashboardImageUrl({ productId, skuId } = {}) {
  if (typeof productId !== 'string' || typeof skuId !== 'string') return null;
  const url = imageRoute + '/' + productId + '/' + skuId;
  return images.has(url) ? url : null;
}

export function isDashboardImagePath(pathname) {
  return typeof pathname === 'string' && (pathname === imageRoute || pathname.startsWith(imageRoute + '/'));
}

export async function getDashboardImage(pathname, { workspaceRoot = workspace } = {}) {
  const cover = coverPath.exec(pathname);
  const image = images.get(pathname);
  if (!image && !cover) return null;

  try {
    const root = await realpath(workspaceRoot);
    if (cover) return await readCover(root, cover[1]);
    const target = await realpath(resolve(root, image.path));
    if (!inside(root, target) || extname(target).toLowerCase() !== '.jpg') return null;

    const file = await stat(target);
    if (!file.isFile() || file.size !== image.size) return null;

    const bytes = await readFile(target);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256) return null;
    return { bytes, contentType: 'image/jpeg' };
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}
