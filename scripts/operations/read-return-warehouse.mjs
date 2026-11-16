import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isPlatformId, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';
import { collectPages } from '../../apps/customer-service/tiktok-shop-sync.mjs';
import { dayKey } from '../../apps/customer-service/operations-board-evidence.mjs';
import { openMyShopSession } from './verify-promotion-outcome.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shopId = '9000000000000000099';
const runFile = promisify(execFile);
const warehouseId = '148';
const dateTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short', timeStyle: 'medium' });
const launcher = '& $env:TIKTOK_WMS_SCRIPT -Warehouse shenniu -WarehouseId 148 -Operation returns -OutputPath $env:TIKTOK_WMS_OUTPUT -ReturnPlatformOrder $env:TIKTOK_WMS_ORDER -ReturnTrackingSha256 $env:TIKTOK_WMS_DIGEST -ReturnModifiedFrom $env:TIKTOK_WMS_FROM -ReturnModifiedTo $env:TIKTOK_WMS_TO -Cursor $env:TIKTOK_WMS_CURSOR; exit $LASTEXITCODE';

async function readWarehouse({ orderId, trackingSha256, from, to, directory, stamp }) {
  const sources = [];
  const rows = [];
  const visited = new Set();
  let cursor = '';
  let scanned = 0;
  let total = null;
  for (let page = 1; page <= 10; page++) {
    const source = join(directory, `warehouse-return-page-${stamp}-${page}.json`);
    const env = { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      TIKTOK_WMS_SCRIPT: join(root, 'scripts/verify-topwms-api.ps1'), TIKTOK_WMS_OUTPUT: source, TIKTOK_WMS_ORDER: orderId,
      TIKTOK_WMS_DIGEST: trackingSha256, TIKTOK_WMS_FROM: from, TIKTOK_WMS_TO: to, TIKTOK_WMS_CURSOR: cursor };
    sources.push(source);
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { cwd: root, env, windowsHide: true, timeout: 40_000 });
      const receipt = JSON.parse(await readFile(source, 'utf8'));
      if (receipt.apiConnected !== true || receipt.warehouseSystem !== 'shenniu' || receipt.warehouseId !== warehouseId ||
          receipt.operation !== 'returns' || !Array.isArray(receipt.records) || receipt.records.some(row => row.platformOrderSn !== orderId ||
            !isPlatformId(row.warehouseReturnOrderId)) || !Number.isSafeInteger(receipt.totalReported) ||
          !Number.isSafeInteger(receipt.scannedRowCount) || receipt.scannedRowCount < receipt.records.length) break;
      if (total === null) total = receipt.totalReported;
      if (receipt.totalReported !== total && receipt.totalReported !== total - scanned) break;
      scanned += receipt.scannedRowCount;
      rows.push(...receipt.records);
      if (scanned > total || new Set(rows.map(row => row.warehouseReturnOrderId)).size !== rows.length) break;
      if (scanned === total) return { complete: true, scanned, rows, sources };
      cursor = receipt.cursor;
      if (!cursor || visited.has(cursor)) break;
      visited.add(cursor);
    } catch {
      break;
    }
  }
  return { complete: false, scanned, rows, sources };
}

async function main() {
  const [file, extra] = process.argv.slice(2);
  if (!file || extra) throw new Error('Usage: node scripts/operations/read-return-warehouse.mjs <exact logistics receipt>');
  const source = resolve(file);
  const original = JSON.parse(await readFile(source, 'utf8'));
  const { returnId, orderId, skuId, productId } = original;
  const orderLineId = original.returnLogistics?.orderLineId;
  if (original.schema !== 'operations-return-logistics-reconciliation/v1' || original.shop?.id !== shopId ||
      original.shop.region !== 'MY' || original.shop.name !== 'example-shop-my' || original.shopWrites !== 0 ||
      original.originalOutbound?.wmsWarehouseId !== warehouseId || original.originalOutbound.outboundMatchesLedger !== true ||
      ![returnId, orderId, skuId, productId, orderLineId].every(isPlatformId)) throw new Error('Exact MY Shenniu return logistics receipt required');
  const requests = [];
  const { client, token, shop } = await openMyShopSession(shopId, { async fetchApi(url, options) {
    const response = await fetch(url, options);
    const envelope = await response.clone().json().catch(() => null);
    requests.push({ path: url.pathname, method: options.method, status: response.status,
      code: envelope?.code ?? null, requestId: envelope?.request_id ?? null });
    return response;
  } });
  const cutoff = new Date();
  const [{ rows }, events] = await Promise.all([
    collectPages(cursor => client.exactReturnPage(token, shop, returnId, orderId, cursor,
      { includeTrackingDigest: true }), Date.now() + 60_000),
    client.returnRecords(token, shop, returnId),
  ]);
  const [platform] = rows;
  if (rows.length !== 1 || platform.id !== returnId || platform.orderId !== orderId ||
      !/^[a-f0-9]{64}$/u.test(platform.trackingSha256 ?? '') || !Number.isSafeInteger(platform.updatedAt) ||
      platform.lines?.length !== 1 || platform.lines[0].orderLineId !== orderLineId || platform.lines[0].skuId !== skuId) {
    throw new Error('Return tracking identity is unavailable');
  }
  const directory = join(root, 'outputs/operations-return-quality', dayKey(cutoff));
  const stamp = cutoff.toISOString().replace(/[:.]/gu, '-');
  await mkdir(directory, { recursive: true });
  const firstEvent = Math.min(platform.updatedAt, ...events.map(event => event.at).filter(at => Number.isSafeInteger(at) && at > 0));
  const from = dateTime.format(new Date((firstEvent - 86_400) * 1000));
  const to = dateTime.format(cutoff);
  const warehouse = await readWarehouse({ orderId, trackingSha256: platform.trackingSha256, from, to, directory, stamp });
  const receipt = { schema: 'operations-return-warehouse-read/v1', observedAt: new Date().toISOString(),
    shop: { id: shop.id, name: shop.name, region: shop.region }, source, returnId, orderId, orderLineId, skuId, productId, warehouseId,
    warehouse: { ...warehouse, window: { from, to, timeZone: 'Asia/Kuala_Lumpur' } },
    exactTrackingAndOrderMatch: warehouse.complete && warehouse.rows.length === 1, requests,
    physicalInspectionVerified: false, platformWrites: 0 };
  const output = join(directory, `return-warehouse-followup-${stamp}.json`);
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file: output, complete: warehouse.complete, scanned: warehouse.scanned,
    matched: warehouse.rows.length, status: warehouse.rows.length === 1 ? warehouse.rows[0].tab : null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(publicPlatformError(error, error.message)); process.exitCode = 1; });
}
