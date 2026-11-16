export function authorizedImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 5 * 1024 * 1024)
    throw new Error('Expected an authorized PNG or JPEG no larger than 5 MiB');
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)
    return 'image/jpeg';
  throw new Error('Expected an authorized PNG or JPEG no larger than 5 MiB');
}
