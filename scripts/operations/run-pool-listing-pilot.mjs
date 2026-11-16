import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { runSingleSkuListing } from './run-single-sku-listing.mjs';

try {
  const manifest = resolve('operations/product-operations/daily/2026-11-11/round010-pool-retrieve/listing.json');
  const input = JSON.parse(await readFile(manifest, 'utf8'));
  await runSingleSkuListing({
    mode: process.argv[2],
    input,
    media: dirname(manifest),
    output: resolve('outputs/operations-listing-shadow/pool-pilot-2026-11-13/live'),
  });
} catch (error) {
  console.error(publicPlatformError(error, error.cause?.code ?? error.message));
  process.exitCode = 1;
}
