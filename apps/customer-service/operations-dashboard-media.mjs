import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const route = '/api/operations/dashboard/videos/';
const productId = '9000000000000000016';

// The private runtime populates verified media records.
const videos = new Map();

export function dashboardVideoMedia(video) {
  const asset = videos.get(video.videoId);
  // Analytics can give the exact video and product without a variant. The matched
  // archive carries its own SKU, and an explicit conflicting SKU blocks playback.
  if (!asset || video.account !== account || video.productId !== productId ||
      (video.skuId != null && video.skuId !== asset.skuId)) return null;
  return { playbackUrl: route + video.videoId + '/clip', coverUrl: route + video.videoId + '/cover',
    skuId: asset.skuId, durationSeconds: 15, source: 'matched_upload_archive' };
}

export function isDashboardVideoPath(pathname) {
  return pathname.startsWith(route);
}

export async function getDashboardVideo(pathname) {
  const match = /^([0-9]+)\/(clip|cover)$/u.exec(pathname.slice(route.length));
  if (!match) return null;
  const [, id, kind] = match;
  const asset = videos.get(id)?.[kind];
  if (!asset) return null;
  try {
    const root = await realpath(workspace);
    const target = await realpath(resolve(root, asset.path));
    const localPath = relative(root, target);
    if (!localPath || localPath === '..' || localPath.startsWith('..' + sep) || isAbsolute(localPath)) return null;
    const file = await open(target, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== asset.size) return null;
      const bytes = await file.readFile();
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.hash) return null;
      return { id, bytes, type: kind === 'clip' ? 'video/mp4' : 'image/jpeg' };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

export function mediaRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const [, left, right] = /^bytes=(\d*)-(\d*)$/u.exec(header) ?? [];
  if (!left && !right) return null;
  const start = left ? Number(left) : Math.max(0, size - Number(right));
  const end = left && right ? Math.min(Number(right), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end, partial: true };
}
