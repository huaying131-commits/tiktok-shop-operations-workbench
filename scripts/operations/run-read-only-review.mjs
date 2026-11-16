import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncFromLocalService } from '../../apps/customer-service/sync-tiktok-shop.mjs';
import { snapshotFilename } from '../../apps/customer-service/tiktok-shop-finance.mjs';
import { reviewFinanceSnapshot } from './finance-review.mjs';

const shopId = '9000000000000000099';
const outputDirectory = fileURLToPath(new URL('../../apps/customer-service/data/operations-board/reviews/', import.meta.url));

export async function runReadOnlyReview({ receiptDirectory = outputDirectory, sync = syncFromLocalService,
  review = reviewFinanceSnapshot } = {}) {
  const startedAt = new Date().toISOString();
  const fileId = startedAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = join(receiptDirectory, fileId + '.json');
  const receipt = { schema: 'operations-read-only-run/v1', startedAt, shopId, catalogFile: null,
    financeFile: null, state: 'failed', failedStep: 'catalog', error: null, review: null };

  try {
    const catalog = await sync(shopId);
    const catalogFile = basename(catalog.output);
    if (!snapshotFilename.test(catalogFile)) throw new Error('Invalid catalog snapshot filename');
    receipt.catalogFile = catalogFile;
    receipt.failedStep = 'finance';
    const finance = await sync(shopId, { financeBasis: catalogFile });
    receipt.financeFile = basename(finance.output);
    receipt.failedStep = 'review';
    const reviewed = review(finance.output);
    if (reviewed.catalogFile !== catalogFile) throw new Error('Finance review has a different catalog snapshot');
    receipt.review = reviewed;
    receipt.state = reviewed.statementsStatus !== 'available' || reviewed.refundsStatus !== 'available' ? 'partial' : 'verified';
    receipt.failedStep = null;
  } catch (error) {
    receipt.error = error.message;
  }

  const temporary = join(receiptDirectory, fileId + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify({ ...receipt, completedAt: new Date().toISOString() }, null, 2) + '\n',
      { flag: 'wx' });
    await rename(temporary, receiptPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { ...receipt, receiptPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/operations/run-read-only-review.mjs');
    const { review, ...run } = await runReadOnlyReview();
    console.log(JSON.stringify({ ...run, summary: review?.summary ?? null,
      costReviewCount: review?.costReviewQueue.length ?? null }, null, 2));
    if (run.state !== 'verified') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
