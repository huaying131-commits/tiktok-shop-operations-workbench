import fs from 'node:fs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const invalid = format => { throw new Error(`${format}图片头或文件结构不完整，无法确认尺寸。`); };

function pngSize(bytes) {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  let offset = 8, hasPixels = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) invalid('PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 0) hasPixels = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasPixels) invalid('PNG');
      return {format: 'PNG', width, height};
    }
    offset = end;
  }
  invalid('PNG');
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid('JPEG');
  let offset = 2, dimensions;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid('JPEG');
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid('JPEG');
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid('JPEG');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid('JPEG');
    if (JPEG_SOF.has(marker)) {
      if (length < 8 || length !== 8 + 3 * bytes[offset + 7]) invalid('JPEG');
      dimensions = {format: 'JPEG', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3)};
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6) invalid('JPEG');
      return dimensions;
    }
    offset += length;
  }
  invalid('JPEG');
}

function webpSize(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('WebP');
  let offset = 12, canvas, pixels;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (end + (length & 1) > bytes.length) invalid('WebP');
    if (type === 'VP8X') {
      if (length !== 10) invalid('WebP');
      if (bytes[start] & 0x02) throw new Error('暂不支持动画WebP，请提供静态PNG、JPEG或WebP图片。');
      canvas = {width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1};
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[start] & 1) || bytes.toString('hex', start + 3, start + 6) !== '9d012a') invalid('WebP');
      pixels = {width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff};
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) invalid('WebP');
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) invalid('WebP');
      pixels = {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1};
    }
    offset = end + (length & 1);
  }
  if (!pixels || offset !== bytes.length || (canvas && (canvas.width !== pixels.width || canvas.height !== pixels.height))) invalid('WebP');
  return {format: 'WebP', ...pixels};
}

// Checks actual file bytes and structural headers only: no pixel decode, CRC verification,
// visual/product-content validation, or white-background recognition is performed.
export function inspectImage(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('图片路径不是文件。');
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片文件超过10MB。');
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片文件超过10MB。');
    let dimensions;
    if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) dimensions = pngSize(bytes);
    else if (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) dimensions = jpegSize(bytes);
    else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') dimensions = webpSize(bytes);
    else throw new Error('无法识别图片格式；目前仅支持静态PNG、JPEG、WebP，不能仅修改扩展名。');
    if (dimensions.width <= 0 || dimensions.height <= 0) throw new Error('图片像素尺寸必须为正数。');
    return {...dimensions, bytes: bytes.length};
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('图片文件不存在。');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
