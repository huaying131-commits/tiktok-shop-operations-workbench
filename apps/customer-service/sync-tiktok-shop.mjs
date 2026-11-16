import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { snapshotFilename } from './tiktok-shop-finance.mjs';

const dataDirectory = fileURLToPath(new URL('./data/', import.meta.url));
const launcher = fileURLToPath(new URL('./start-tiktok-auth.ps1', import.meta.url));
const run = promisify(execFile);

export async function syncFromLocalService(shopId, {
  port = 3000, directory = dataDirectory, financeBasis, persist = true,
} = {}) {
  if (!/^\d{8,30}$/.test(shopId ?? '')) throw new Error('请指定官方授权结果页上的马来西亚店铺 ID。');
  if (financeBasis !== undefined && !snapshotFilename.test(financeBasis)) throw new Error('请指定本店铺的订单快照文件名。');
  const host = 'localhost:' + port;
  const ca = await readFile(join(directory, 'tiktok-auth', 'localhost.crt'));
  let cookie;
  function request(path, method = 'GET') {
    return new Promise((resolve, reject) => {
      const headers = { host, ...(cookie ? { cookie } : {}) };
      if (method === 'POST') Object.assign(headers, { origin: 'https://' + host, 'content-length': '0' });
      const req = httpsRequest({ hostname: '127.0.0.1', port, servername: 'localhost', ca, path, method,
        headers, signal: AbortSignal.timeout(170_000) }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  let connect;
  try {
    connect = await request('/tts/connect');
  } catch (error) {
    if (error.code !== 'ECONNREFUSED' || port !== 3000 || resolve(directory) !== resolve(dataDirectory) ||
        process.platform !== 'win32') throw error;
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', launcher, '-Background'],
        { windowsHide: true, timeout: 20000 });
    } catch {
      throw new Error('本机授权服务未能自动启动。初次使用请运行 start-tiktok-auth.cmd -RememberCredentials；已有配置时请打开前台启动器查看详情。');
    }
    connect = await request('/tts/connect');
  }
  cookie = connect.headers['set-cookie']?.[0]?.split(';')[0];
  if (connect.status !== 200 || !cookie) throw new Error('本机授权服务没有建立会话。');
  const resume = await request('/tts/resume', 'POST');
  if (resume.status !== 303 || resume.headers.location !== '/tts/result') throw new Error('本机授权没有恢复。');
  const result = await request(financeBasis ? '/tts/shop/finance?shop=' + shopId + '&snapshot=' + encodeURIComponent(financeBasis) :
    '/tts/shop/sync?shop=' + shopId, 'POST');
  if (result.status === 404 || result.status === 405) throw new Error('当前运行的授权服务版本较早，请启动新版再同步。');
  const snapshot = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(snapshot.error || '店铺同步未完成。');
  if (snapshot.schemaVersion !== 1 || snapshot.shop?.id !== shopId || snapshot.shop.region !== 'MY' ||
      !Number.isFinite(Date.parse(snapshot.collectedAt))) throw new Error('快照格式或店铺与请求不一致。');
  if (financeBasis) {
    if (snapshot.kind !== 'order-finance' || snapshot.basis !== financeBasis || !Array.isArray(snapshot.orders)) {
      throw new Error('财务快照与基准订单不一致。');
    }
    if (snapshot.returns?.status !== 'available' && snapshot.statements?.status !== 'available') {
      throw new Error([snapshot.returns?.error, snapshot.statements?.error].filter(Boolean).join(' ') || '退款和结算都未读取成功。');
    }
  } else if (!Array.isArray(snapshot.products?.rows) || !Array.isArray(snapshot.orders?.rows)) {
    throw new Error('商品或订单快照数据缺失。');
  }
  if (!persist) return snapshot;

  const destination = financeBasis ? join(directory, 'tiktok-shop', shopId, 'finance') : join(directory, 'tiktok-shop', shopId);
  await mkdir(destination, { recursive: true });
  const filename = snapshot.collectedAt.replace(/[^\dTZ]/g, '') + '-' + randomUUID() + '.json';
  const output = join(destination, filename);
  const pending = output + '.tmp';
  try {
    await writeFile(pending, JSON.stringify(snapshot) + '\n', { flag: 'wx' });
    await rename(pending, output);
  } finally {
    await unlink(pending).catch(() => {});
  }
  if (financeBasis) return { output, shop: snapshot.shop, basis: financeBasis,
    returns: snapshot.returns, statements: snapshot.statements, counts: snapshot.counts };
  return { output, shop: snapshot.shop, products: snapshot.products.rows.length,
    orders: snapshot.orders.rows.length, skuCoverage: snapshot.skuCoverage };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const args = process.argv.slice(2);
  if (args[0] !== '--shop' || (args.length !== 2 && (args.length !== 4 || args[2] !== '--finance'))) {
    console.error('用法：node apps/customer-service/sync-tiktok-shop.mjs --shop <店铺ID> [--finance <订单快照文件名>]');
    process.exitCode = 1;
  } else {
    syncFromLocalService(args[1], { financeBasis: args[3] }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      console.error(error.code === 'ECONNREFUSED' ? '本机授权服务尚未启动。' : error.code ?? error.message);
      process.exitCode = 1;
    });
  }
}
