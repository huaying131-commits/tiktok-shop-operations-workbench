import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTikTokClient, publicPlatformError } from './tiktok-shop-read.mjs';
import { CreatorTrialError, creatorAuthorizationUrl, validCreatorTrial, verifyCreatorTrial } from './tiktok-creator-auth.mjs';
import { createAuthorizationAccess, SnapshotError, syncSkuSnapshot } from './tiktok-shop-sync.mjs';
import { reconcileOrderFinance, snapshotFilename } from './tiktok-shop-finance.mjs';

export { createTikTokClient } from './tiktok-shop-read.mjs';

const localDirectory = fileURLToPath(new URL('./data/tiktok-auth/', import.meta.url));
const redirect = '/tts/authorize';
const sessionLifetime = 15 * 60 * 1000;
const cookieName = '__Host-tts_oauth';
const style = 'html{background:#f3f5f2;color:#182727;font:15px/1.6 Inter,Segoe UI,Microsoft YaHei UI,system-ui,sans-serif}main{max-width:960px;margin:32px auto;padding:24px;background:#fff;border:1px solid #dce4e0;border-radius:12px}a{color:#055b4d}button{font:inherit;padding:6px 12px;background:#e6f3ed;color:#182727;border:1px solid #bad2c9;border-radius:6px;cursor:pointer}ul{padding-left:22px}table{width:100%;border-collapse:collapse}td,th{padding:8px;text-align:left;border-bottom:1px solid #dce4e0;overflow-wrap:anywhere}code{overflow-wrap:anywhere}';
const styleHash = createHash('sha256').update(style).digest('base64');
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'sha256-" + styleHash + "'",
  'X-Content-Type-Options': 'nosniff',
};

function page(response, title, body, status = 200, extraHeaders = {}) {
  response.writeHead(status, { ...headers, ...extraHeaders, 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
    style + '</style><title>' + title + '</title><main><h1>' + title + '</h1>' + body + '</main></html>');
}

function redirectToResult(response, path = '/tts/result') {
  response.writeHead(303, { ...headers, Location: path }).end();
}

function json(response, status, data) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function cookie(request) {
  return (request.headers.cookie ?? '').split(';').map(item => item.trim())
    .find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}

function oneQuery(url, key) {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function eligibleShops(shops) {
  return shops.filter(shop => shop?.region === 'MY' && typeof shop.id === 'string' && /^\d{8,30}$/.test(shop.id) &&
    typeof shop.cipher === 'string' && shop.cipher);
}

function shopLinks(shops) {
  return eligibleShops(shops).map(shop =>
    '<li>' + escapeHtml(shop.name || '马来西亚店铺') + ' <code>' + escapeHtml(shop.id) +
    '</code> · <a href="/tts/shop/products?shop=' + shop.id + '">查看商品样本</a> · ' +
    '<a href="/tts/shop/orders?shop=' + shop.id + '">查看近 7 天订单样本</a></li>').join('');
}

function sampleTable(sample, products) {
  const columns = ['编号', products ? '商品名称' : '下单时间（UTC+8）', '状态', 'SKU'];
  const orderTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short', timeStyle: 'short',
  });
  const rows = sample.rows.map(row => {
    const time = row.createdAt ? new Date(row.createdAt * 1000) : null;
    const timeLabel = time && Number.isFinite(time.getTime()) ? orderTime.format(time) : null;
    const skus = row.skus?.map(sku => [sku.sellerSku, sku.id].filter(Boolean).join(' / ')).filter(Boolean).join('，');
    const cells = [row.id, products ? row.title : timeLabel, row.status, skus];
    return '<tr>' + cells.map(value => '<td>' + escapeHtml(value ?? '—') + '</td>').join('') + '</tr>';
  }).join('');
  const total = sample.totalCount === null ? '' : '，接口报告总数 ' + sample.totalCount;
  const info = '<p>当前仅显示首页样本 ' + sample.rows.length + ' 条' + total + '。</p>';
  return info + (rows ? '<table><thead><tr>' + columns.map(col => '<th scope="col">' + col + '</th>').join('') +
    '</tr></thead><tbody>' + rows + '</tbody></table>' : '<p>本次查询没有记录。</p>');
}

export function createCallbackServer({ tls, serviceId, client, saveAuthorization, loadAuthorization, creatorTrial, now = Date.now,
  snapshotDirectory = fileURLToPath(new URL('./data/tiktok-shop/', import.meta.url)) }) {
  const sessions = new Map();
  const syncing = new Set();
  const access = createAuthorizationAccess({ serviceId, client, loadAuthorization, saveAuthorization, now, expectedUserType: 0 });
  if (creatorTrial && (!validCreatorTrial(creatorTrial) || !creatorTrial.appKey || typeof creatorTrial.saveAuthorization !== 'function')) {
    throw new Error('Creator trial requires a fixed account, product, and separate authorization store');
  }
  async function verifyShops(session, authorization) {
    try {
      session.shops = await access.read(authorization, token => client.authorizedShops(token));
      session.authorization = authorization;
      session.phase = 'verified';
    } catch (error) {
      session.phase = 'saved';
      session.detail = publicPlatformError(error, '未能读回已授权店铺。');
    }
  }
  const server = createServer(tls, async (request, response) => {
    const host = 'localhost:' + server.address().port;
    if (request.headers.host !== host || !request.url?.startsWith('/')) {
      page(response, '请求无效', '', 400);
      return;
    }
    const url = URL.parse(request.url, 'https://' + host);
    if (!url || url.host !== host) {
      page(response, '请求无效', '', 400);
      return;
    }
    const current = now();
    for (const [id, session] of sessions) if (session.expires < current) sessions.delete(id);
    const session = sessions.get(cookie(request));

    if (request.method === 'POST' && url.pathname === '/tts/resume') {
      if (!loadAuthorization || session?.phase !== 'ready' || session.kind !== 'seller' || request.headers.origin !== 'https://' + host) {
        page(response, '请从官方接入页打开已保存授权', '', 403);
        return;
      }
      session.phase = 'processing';
      session.state = null;
      try {
        await verifyShops(session, await access.restore());
      } catch {
        session.phase = 'failed';
        session.detail = '没有找到本应用可用的本机授权。请先完成店铺授权。';
      }
      redirectToResult(response);
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/tts/shop/sync' || url.pathname === '/tts/shop/finance')) {
      const shopId = oneQuery(url, 'shop');
      const matches = session?.phase === 'verified' ? eligibleShops(session.shops).filter(shop => shop.id === shopId) : [];
      if (request.headers.origin !== 'https://' + host) {
        json(response, 403, { error: '请先读取已授权的马来西亚店铺。' });
        return;
      }
      if (matches.length !== 1) {
        json(response, 403, { error: session?.detail ?? '请先读取已授权的马来西亚店铺。' });
        return;
      }
      if (syncing.has(shopId)) {
        json(response, 409, { error: '该店铺已有同步在运行。' });
        return;
      }
      const finance = url.pathname === '/tts/shop/finance';
      const basis = oneQuery(url, 'snapshot');
      if (finance && !snapshotFilename.test(basis ?? '')) {
        json(response, 400, { error: '请指定已验收的本店铺订单快照文件名。' });
        return;
      }
      syncing.add(shopId);
      try {
        const read = action => access.read(session.authorization, action);
        const params = { client, shop: matches[0], read, now };
        if (finance) {
          const snapshot = await readFile(join(snapshotDirectory, shopId, basis), 'utf8').then(JSON.parse).catch(() => {
            throw new SnapshotError('本店铺的订单快照不可读取。');
          });
          json(response, 200, await reconcileOrderFinance({ ...params, basis, snapshot }));
        } else {
          json(response, 200, await syncSkuSnapshot(params));
        }
      } catch (error) {
        json(response, 502, { error: error instanceof SnapshotError ? error.message :
          publicPlatformError(error, '同步未完成，请核对本机授权与 API 权限。') });
      } finally {
        syncing.delete(shopId);
      }
      return;
    }
    if (request.method !== 'GET') {
      page(response, '请求无效', '', 405);
      return;
    }

    if (url.pathname === '/tts/health') {
      page(response, '授权回调服务在线', '<p>回调路径 <code>/tts/authorize</code></p>');
      return;
    }

    const isCreatorEntry = url.pathname === '/tts/creator/connect' && Boolean(creatorTrial);
    if (url.pathname === '/tts/connect' || isCreatorEntry) {
      if (sessions.size >= 32) {
        page(response, '请稍后重试', '', 429);
        return;
      }
      const id = randomBytes(24).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const authorize = isCreatorEntry ? creatorAuthorizationUrl(creatorTrial.appKey, state) :
        new URL('https://services.tiktokshop.com/open/authorize');
      if (!isCreatorEntry) authorize.search = new URLSearchParams({ service_id: serviceId, state }).toString();
      sessions.set(id, { state, expires: current + sessionLifetime, phase: 'ready', kind: isCreatorEntry ? 'creator' : 'seller' });
      const resume = !isCreatorEntry && loadAuthorization
        ? '<form method="post" action="/tts/resume"><button>使用已保存的店铺授权</button></form>' : '';
      const title = isCreatorEntry ? 'TikTok Shop 达人账号接入' : 'TikTok Shop 官方接入';
      const account = isCreatorEntry
        ? '在同一个浏览器里用 TikTok 账号 <code>@' + escapeHtml(creatorTrial.account) + '</code> 完成授权及商品回读。'
        : '在同一个浏览器里完成马来西亚店铺授权。';
      page(response, title, '<p>' + account + '</p><p><a href="' +
        escapeHtml(authorize.href) + '">打开 TikTok Shop 授权页</a></p>' + resume, 200,
      { 'Set-Cookie': cookieName + '=' + id + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900' });
      return;
    }

    if (url.pathname === redirect) {
      const state = oneQuery(url, 'state');
      const code = oneQuery(url, 'code');
      if (!session || session.phase !== 'ready' || !state || session.state !== state) {
        redirectToResult(response, '/tts/invalid');
        return;
      }
      session.phase = 'processing';
      session.state = null;
      if (!code || code.length > 2048 || url.searchParams.has('error')) {
        session.phase = 'failed';
        session.detail = '授权已取消，或平台未返回有效的授权码。';
        redirectToResult(response);
        return;
      }
      if (session.kind === 'creator') {
        try {
          if (oneQuery(url, 'app_key') !== creatorTrial.appKey) throw new CreatorTrialError('回调的应用与本机试验配置不符。');
          const tokens = await client.exchange(code);
          session.creator = await verifyCreatorTrial({ tokens, client, account: creatorTrial.account, productId: creatorTrial.productId });
          await creatorTrial.saveAuthorization({ serviceId, tokens, verified: session.creator, verifiedAt: new Date(now()).toISOString() });
          session.phase = 'creator_verified';
        } catch (error) {
          session.phase = 'failed';
          session.detail = error instanceof CreatorTrialError ? error.message :
            publicPlatformError(error, '达人授权交换、回读或本机安全保存未完成。');
        }
        redirectToResult(response);
        return;
      }
      let authorization;
      try {
        authorization = await access.install(await client.exchange(code));
        session.phase = 'saved';
      } catch (error) {
        session.phase = 'failed';
        session.detail = publicPlatformError(error, '令牌交换或本机安全保存失败。请检查网络与本机权限，再从授权入口重新开始。');
      }
      if (session.phase === 'saved') {
        await verifyShops(session, authorization);
      }
      redirectToResult(response);
      return;
    }

    if (url.pathname === '/tts/shop/products' || url.pathname === '/tts/shop/orders') {
      const shopId = oneQuery(url, 'shop');
      const matches = session?.phase === 'verified' ? eligibleShops(session.shops).filter(shop => shop.id === shopId) : [];
      if (matches.length !== 1) {
        page(response, '请先选择已授权的马来西亚店铺', '<p><a href="/tts/connect">打开官方接入</a></p>', 403);
        return;
      }
      const products = url.pathname === '/tts/shop/products';
      const back = '<p><a href="/tts/result">返回授权店铺</a></p>';
      try {
        const sample = await access.read(session.authorization, token => products
          ? client.sampleProducts(token, matches[0])
          : client.sampleOrders(token, matches[0]));
        page(response, products ? '商品样本 · 官方 API' : '近 7 天订单样本 · 官方 API', sampleTable(sample, products) + back);
      } catch (error) {
        page(response, '读取失败', '<p>' + escapeHtml(publicPlatformError(error, '连接或响应校验失败。')) +
          '。请核对当前令牌和对应接口权限。</p>' + back, 502);
      }
      return;
    }
    if (url.pathname === '/tts/result' && session?.phase === 'verified') {
      const regions = session.shops.map(shop => shop?.region).filter(region => typeof region === 'string' && /^[A-Z]{2}$/.test(region));
      const links = shopLinks(session.shops);
      page(response, regions.includes('MY') ? '马来西亚店铺授权已验证' : '已读取授权店铺，请核对马来西亚店铺',
        '<p>已授权店铺数 ' + session.shops.length + '，市场 ' + (regions.join('、') || '平台未返回地区') + '。</p>' +
        (links ? '<ul>' + links + '</ul>' : ''));
      return;
    }
    if (url.pathname === '/tts/result' && session?.phase === 'saved') {
      page(response, '令牌已保存，店铺待验证', '<p>' + escapeHtml(session.detail) +
        '</p><p><a href="/tts/connect">返回官方接入</a></p>');
      return;
    }
    if (url.pathname === '/tts/result' && session?.phase === 'creator_verified') {
      page(response, '原发布账号及可挂车商品已验证', '<p>马来西亚账号 <code>@' + escapeHtml(session.creator.account) +
        '</code>，商品 <code>' + escapeHtml(session.creator.productId) +
        '</code>。授权已单独保存。实际发布回执待后续执行。</p>');
      return;
    }
    if (url.pathname === '/tts/result' && session?.phase === 'failed') {
      const entry = session.kind === 'creator' ? '/tts/creator/connect' : '/tts/connect';
      page(response, '授权未完成', '<p>' + escapeHtml(session.detail) + '</p><p><a href="' + entry + '">重新开始授权</a></p>');
      return;
    }
    if (url.pathname === '/tts/result' || url.pathname === '/tts/invalid') {
      page(response, '回调无效或已使用', '<p><a href="/tts/connect">重新开始授权</a></p>', 400);
      return;
    }
    page(response, '页面不存在', '', 404);
  });
  return server;
}

function windowsDpapi(script, input) {
  return new Promise((resolve, reject) => {
    const windows = process.env.SystemRoot;
    const env = windows ? { ...process.env,
      PSModulePath: join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    } : process.env;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', exitCode => {
      if (exitCode === 0) resolve(output.trim());
      else reject(new Error('Windows DPAPI failed'));
    });
    child.stdin.end(input);
  });
}

export async function saveLocalAuthorization(value, directory = localDirectory) {
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $value=[Console]::In.ReadToEnd(); ConvertFrom-SecureString -SecureString (ConvertTo-SecureString $value -AsPlainText -Force)";
  const ciphertext = await windowsDpapi(script, JSON.stringify(value));
  if (!/^[a-f0-9]+$/i.test(ciphertext)) throw new Error('Invalid DPAPI payload');
  await mkdir(directory, { recursive: true });
  const pending = join(directory, 'authorization-' + randomBytes(8).toString('hex') + '.tmp');
  try {
    await writeFile(pending, ciphertext + '\n', { flag: 'wx' });
    await rename(pending, join(directory, 'authorization.dpapi'));
  } finally {
    await unlink(pending).catch(() => {});
  }
}

async function loadEncryptedJson(path) {
  const ciphertext = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]+$/i.test(ciphertext)) throw new Error('Invalid DPAPI payload');
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $value=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($value); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $value.Dispose() }";
  return JSON.parse(await windowsDpapi(script, ciphertext));
}

export function loadLocalAuthorization(directory = localDirectory) {
  return loadEncryptedJson(join(directory, 'authorization.dpapi'));
}

export function loadLocalCreatorAuthorization(account, productId) {
  if (!validCreatorTrial({ account, productId })) throw new Error('Invalid creator account or product');
  return loadLocalAuthorization(join(localDirectory, 'creators', account));
}

export async function loadLocalAppCredentials(directory = localDirectory) {
  try {
    const value = await loadEncryptedJson(join(directory, 'app-credentials.dpapi'));
    if (!/^\d{8,30}$/.test(value?.serviceId ?? '') || typeof value.appKey !== 'string' || !value.appKey ||
        typeof value.appSecret !== 'string' || !value.appSecret) throw new Error('Invalid credential record');
    return value;
  } catch {
    throw new Error('无法读取本机加密应用凭据，请在当前 Windows 用户下重新保存。');
  }
}

async function main() {
  const { TTS_SERVICE_ID, TTS_APP_KEY, TTS_APP_SECRET } = process.env;
  delete process.env.TTS_APP_SECRET;
  const { serviceId, appKey, appSecret } = process.argv.includes('--saved-credentials') ? await loadLocalAppCredentials() :
    { serviceId: TTS_SERVICE_ID, appKey: TTS_APP_KEY, appSecret: TTS_APP_SECRET };
  if (!/^\d{8,30}$/.test(serviceId ?? '') || !appKey || !appSecret) {
    throw new Error('请通过 start-tiktok-auth.ps1 配置服务 ID 和应用凭据。');
  }
  const [cert, key] = await Promise.all([
    readFile(join(localDirectory, 'localhost.crt')),
    readFile(join(localDirectory, 'localhost.key')),
  ]);
  const { TTS_CREATOR_TRIAL_ACCOUNT: account, TTS_CREATOR_TRIAL_PRODUCT_ID: productId } = process.env;
  let creatorTrial;
  if (account || productId) {
    if (!validCreatorTrial({ account, productId })) throw new Error('达人授权试验需要指定原账号和原商品 ID。');
    creatorTrial = { appKey, account, productId, saveAuthorization: value =>
      saveLocalAuthorization(value, join(localDirectory, 'creators', account)) };
  }
  const server = createCallbackServer({
    tls: { cert, key }, serviceId, client: createTikTokClient({ appKey, appSecret }),
    saveAuthorization: saveLocalAuthorization, loadAuthorization: loadLocalAuthorization, creatorTrial,
  });
  server.once('error', error => {
    console.error('授权服务启动失败：' + (error.code ?? 'UNKNOWN'));
    process.exitCode = 1;
  });
  server.listen(3000, '127.0.0.1', () => {
    console.log('授权入口 https://localhost:3000/tts/connect');
    console.log('保持窗口运行，在本机 Chrome 或 Edge 打开授权入口。');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  main().catch(error => {
    console.error(error.code === 'ENOENT' ? '本机 HTTPS 证书缺失，请使用启动脚本。' : error.message);
    process.exitCode = 1;
  });
}
