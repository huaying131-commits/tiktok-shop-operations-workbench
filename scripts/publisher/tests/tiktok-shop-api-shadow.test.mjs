import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { implemented, openCreatorSession, planShoppableVideo, readShoppableProductAssociation, readShoppableReadiness, readShoppableReconciliation, runShoppablePost,
  runShoppableUploadPrecheck, runVerifiedShoppablePrecheck } from '../channels/tiktok-shop-api.mjs';
import { main as runCli } from '../cli.mjs';
import { createTikTokClient } from '../../../apps/customer-service/tiktok-shop-read.mjs';
import { State } from '../lib/state.mjs';

test('reuses the same creator authorization while verifying the eligible product for each new job', async () => {
  const account = 'fixture.creator';
  const originalProduct = '9000000000000000047';
  const nextProduct = '9000000000000000016';
  const accountType = 'TIKTOK_MARKETING_ACCOUNT';
  const job = { account, product_id: nextProduct };
  const authorization = { serviceId: '123456789', tokens: { user_type: 1, access_token: 'fixture', granted_scopes: ['creator.video.write'] },
    verified: { account, market: 'MY', productId: originalProduct, accountType } };
  let eligible = nextProduct;
  let productReads = 0;
  const deps = { loadAuthorization: async () => authorization, loadCredentials: async () => ({ serviceId: authorization.serviceId }),
    createClient: () => ({ creatorProfile: async () => ({ username: account, selection_region: 'MY', user_type: accountType, creator_user_open_id: 'fixture-id' }),
      creatorShopProducts: async () => { productReads++; return { products: [{ id: eligible, added_status: 'ADDED' }] }; } }) };
  const current = await openCreatorSession(job, { ...deps, checkProduct: true });
  assert.equal(current.verified.productId, nextProduct);
  assert.equal(authorization.verified.productId, originalProduct);
  assert.equal(productReads, 1);
  eligible = originalProduct;
  await assert.rejects(openCreatorSession(job, { ...deps, checkProduct: true }), /未核到原商品/u);
  assert.equal((await openCreatorSession(job, deps)).verified, null);
  assert.equal(productReads, 2);
});

test('uses exact file and product for the official shadow plan without making any submission', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-api-shadow-'));
  const file = join(dir, 'fixture.mp4');
  t.after(async () => {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
  });
  const bytes = Buffer.from('fixture data');
  await writeFile(file, bytes);
  const job = { video_id: 'fixture-video', market: 'MY', account: 'fixture.creator', file,
    sha256: createHash('sha256').update(bytes).digest('hex'), product_id: '9000000000000000047', sku_id: '9000000000000000049',
    description: 'Kaleidoskop siap guna', tags: ['#Mainan'], short_name: 'Kaleidoskop Tiub Kertas',
    fields: { ai_disclosure: true, commercial_disclosure: true } };
  const result = await planShoppableVideo(job);
  assert.equal(result.remote_requests, 0);
  assert.equal(implemented, false);
  assert.equal(result.submission, false);
  assert.equal(result.file.expected_upload_md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(result.precheck.body_template.product_link_info.product_id, job.product_id);
  assert.equal(result.post.path, '/affiliate_creator/202607/videos');
  assert.equal(result.post.body_template.video_info.title, 'Kaleidoskop siap guna\n#Mainan');
  assert.equal(result.post.body_template.video_info.is_ai_generated, true);
  assert.equal(result.post.commercial_disclosure, 'platform_behavior_unverified');
  assert.equal(result.result.confirm_product_anchor_separately, true);
  await assert.rejects(planShoppableVideo({ ...job, short_name: 'Kaleidoskop 🛒' }), /anchor_title_invalid/);
  await assert.rejects(planShoppableVideo({ ...job, sha256: '0'.repeat(64) }), /sha256_mismatch/);
});

test('queries the original platform video once and keeps the public anchor pending', async () => {
  const job = { video_id: 'fixture-video', account: 'fixture.creator', market: 'MY', sha256: 'a'.repeat(64),
    product_id: '9000000000000000047', sku_id: '9000000000000000049' };
  const videoId = '9000000000000000103';
  const action = { job_id: job.video_id, account: job.account, sha256: job.sha256, channel: 'tiktok-shop-api', stage: 'submit',
    status: 'unknown', original_request_id: 'original-post-id', result: { platform_video_id: videoId } };
  const requests = [];
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', now: () => 1794519400000,
    fetchApi: async (url, options) => {
      requests.push({ path: url.pathname, method: options.method, body: options.body, signed: url.searchParams.has('sign') });
      return Response.json({ code: 0, request_id: 'platform-readback-id', data: {
        video: { id: videoId, post_status: 'SUCCESS', post_time: 1794519300 },
      } });
    } });
  const openSession = async () => ({ client, token: 'fixture-token' });
  const result = await readShoppableReconciliation({ job, attempts: [action], openSession,
    readProductAssociation: async input => {
      assert.deepEqual(input, { job, videoId, postTime: 1794519300 });
      return { state: 'product_analytics_confirmed' };
    } });
  assert.deepEqual(requests, [{ path: `/affiliate_creator/202509/videos/${videoId}/status`, method: 'GET', body: undefined, signed: true }]);
  assert.equal(result.original_request_id, 'original-post-id');
  assert.equal(result.read_request_id, 'platform-readback-id');
  assert.equal(result.platform_status, 'SUCCESS');
  assert.equal(result.conclusion, 'platform_post_success_anchor_unverified');
  assert.equal(result.product_association.state, 'product_analytics_confirmed');
  assert.equal(result.public_product_anchor_verified, false);
  assert.equal(result.automatic_replay, false);
  assert.equal(result.attempt_state_changed, false);

  const pending = await readShoppableReconciliation({ job, attempts: [{ ...action, result: {} }],
    openSession: () => assert.fail('A missing video ID must never dispatch a query') });
  assert.equal(pending.conclusion, 'original_platform_id_unavailable');
  assert.equal(pending.original_request_id, 'original-post-id');
});

test('associates a video and product using exact account and publication time without claiming a public anchor', async () => {
  const job = { market: 'MY', account: 'fixture.creator', product_id: '9000000000000000047' };
  const videoId = '9000000000000000103';
  const postTime = Date.parse('2026-11-13T00:30:01+08:00') / 1000;
  let latest = '2026-11-12';
  let username = job.account;
  let productReads = 0;
  let products = [{ id: job.product_id, product_impressions: 100, product_clicks: 7 }];
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(url.searchParams.get('start_date_ge'), '2026-11-13');
    assert.equal(url.searchParams.get('end_date_lt'), '2026-11-14');
    if (url.pathname.endsWith('/batch_performance')) {
      return Response.json({ code: 0, request_id: 'video-analytics', data: { latest_available_date: latest, videos: [
        { video_id: videoId, video: { id: videoId, username, video_post_time: '2026-11-13 00:30:01' } },
      ] } });
    }
    assert.equal(url.pathname, `/analytics/202509/shop_videos/${videoId}/products/performance`);
    productReads++;
    return Response.json({ code: 0, request_id: 'product-analytics', data: { latest_available_date: latest,
      total_count: products.length, products } });
  } });
  const args = { job, videoId, postTime, openShop: async () => ({ client, token: 'seller', shop: { region: 'MY', cipher: 'test' } }) };
  assert.equal((await readShoppableProductAssociation(args)).state, 'video_analytics_not_ready');
  latest = '2026-11-13';
  username = 'other.creator';
  assert.equal((await readShoppableProductAssociation(args)).state, 'video_analytics_identity_unverified');
  assert.equal(productReads, 0);
  username = job.account;
  const read = await readShoppableProductAssociation(args);
  assert.equal(read.state, 'product_analytics_confirmed');
  assert.equal(read.analytics_request_id, 'video-analytics');
  assert.deepEqual(read.product_request_ids, ['product-analytics']);
  assert.deepEqual(read.product_engagement, { startInclusive: '2026-11-13', endExclusive: '2026-11-14',
    impressions: 100, clicks: 7, unitsSold: null });
  assert.equal(read.public_product_anchor_verified, undefined);
  products = [...products, ...products];
  assert.equal((await readShoppableProductAssociation(args)).state, 'video_product_analytics_unavailable');
});

test('preflight reads the exact seller SKU before checking creator eligibility and keeps disclosure pending', async t => {
  const { job } = await transportFixture(t);
  job.package = { seller_sku: 'FIXTURE-SKU' };
  let sellerSku = 'OTHER-SKU';
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(url.pathname, `/product/202309/products/${job.product_id}`);
    assert.equal(url.searchParams.has('sign'), true);
    return Response.json({ code: 0, request_id: 'sku-read-id', data: { id: job.product_id, status: 'ACTIVATE',
      audit: { status: 'APPROVED' }, skus: [{ id: job.sku_id, seller_sku: sellerSku }] } });
  } });
  const openShop = async shopId => {
    assert.equal(shopId, '9000000000000000099');
    return { client, token: 'fixture-seller', shop: { cipher: 'fixture-cipher', region: 'MY' } };
  };
  const mismatch = await readShoppableReadiness({ job, openShop, openCreator: () => assert.fail('Wrong SKU') });
  assert.equal(mismatch.conclusion, 'seller_listing_not_verified_active');
  assert.equal(mismatch.seller.exact_sku_verified, false);

  sellerSku = job.package.seller_sku;
  const missing = await readShoppableReadiness({ job, openShop, openCreator: () => {
    throw Object.assign(new Error('private path'), { code: 'ENOENT' });
  } });
  assert.equal(missing.seller.request_id, 'sku-read-id');
  assert.equal(missing.seller.exact_sku_verified, true);
  assert.equal(missing.conclusion, 'creator_authorization_unavailable');
  assert.doesNotMatch(JSON.stringify(missing), /private path/);

  const eligible = await readShoppableReadiness({ job, openShop, openCreator: (current, options) => {
    assert.equal(current, job);
    assert.equal(options.checkProduct, true);
    return { accountType: 'TIKTOK_MARKETING_ACCOUNT' };
  } });
  assert.equal(eligible.creator.exact_product_eligible, true);
  assert.equal(eligible.conclusion, 'commercial_disclosure_unverified');
  assert.equal(eligible.submission, false);
});

test('reads the 202601 precheck only for the exact original task and rejects an ID mismatch', async () => {
  const job = { video_id: 'fixture-video', account: 'fixture.creator', market: 'MY', sha256: 'b'.repeat(64),
    product_id: '9000000000000000047', sku_id: '9000000000000000049' };
  const taskId = '9000000000000000097';
  const action = { job_id: job.video_id, account: job.account, sha256: job.sha256, channel: 'tiktok-shop-api', stage: 'precheck',
    status: 'unknown', original_request_id: 'original-precheck-id', result: { precheck_task_id: taskId } };
  let mismatched = false;
  const client = createTikTokClient({ appKey: 'fixture-app', appSecret: 'fixture-secret', fetchApi: async (url, options) => {
    assert.equal(url.pathname, `/affiliate_creator/202601/videos/precheck_tasks/${taskId}`);
    assert.equal(options.method, 'GET');
    return Response.json({ code: 0, request_id: 'precheck-readback-id', data: { precheck_task: {
      id: mismatched ? '9000000000000000098' : taskId, violation_check_result: { status: 'SUCCESS' },
      good_quality_check_result: { status: 'PROCESSING' },
    } } });
  } });
  const openSession = async () => ({ client, token: 'fixture-token' });
  const result = await readShoppableReconciliation({ job, attempts: [action], openSession });
  assert.equal(result.conclusion, 'platform_precheck_passed');
  assert.equal(result.read_request_id, 'precheck-readback-id');
  assert.equal(result.quality_status, 'PROCESSING');
  mismatched = true;
  const wrong = await readShoppableReconciliation({ job, attempts: [action], openSession });
  assert.equal(wrong.conclusion, 'platform_read_unverified');
  assert.equal(wrong.original_request_id, 'original-precheck-id');
});

async function transportFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tts-upload-precheck-'));
  const file = join(dir, 'fixture.mp4');
  const bytes = Buffer.from('exact asset bytes');
  await writeFile(file, bytes);
  const job = { video_id: 'fixture-upload', account: 'fixture.creator', market: 'MY', file,
    sha256: createHash('sha256').update(bytes).digest('hex'), product_id: '9000000000000000047', sku_id: '9000000000000000049',
    description: 'Kaleidoskop siap guna', tags: ['#Mainan'], short_name: 'Kaleidoskop Tiub Kertas',
    fields: { ai_disclosure: true, commercial_disclosure: true } };
  const state = new State(dir);
  t.after(async () => { state.close(); await rm(dir, { recursive: true, force: true }); });
  const session = { credentials: { appKey: 'fixture-app', appSecret: 'fixture-secret' },
    tokens: { user_type: 1, access_token: 'fixture-token', granted_scopes: ['creator.video.write'] },
    verified: { account: job.account, productId: job.product_id, market: job.market } };
  return { job, state, session, bytes, md5: createHash('md5').update(bytes).digest('hex') };
}

test('uploads the exact multipart bytes once and prechecks the original file for the exact product', async t => {
  const fixture = await transportFixture(t);
  const { job, state, bytes, md5 } = fixture;
  const fileId = 'v12d00gd0024d3nfqr7og65';
  const taskId = '9000000000000000097';
  const calls = [];
  const fetchApi = async (url, options) => {
    calls.push(url.pathname);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-tts-access-token'], 'fixture-token');
    assert.equal(url.searchParams.has('sign'), true);
    assert.equal(state.attempts().at(-1).status, 'unknown');
    if (calls.length === 1) {
      assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.body.get('data').type, 'video/mp4');
      assert.deepEqual(Buffer.from(await options.body.get('data').arrayBuffer()), bytes);
      return Response.json({ code: 0, request_id: 'upload-origin-id', data: { video_file: { id: fileId, md5: md5.toUpperCase() } } });
    }
    assert.deepEqual(JSON.parse(options.body), { video_info: { file_id: fileId },
      product_link_info: { product_id: job.product_id, title: job.short_name } });
    return Response.json({ code: 0, request_id: 'precheck-origin-id', data: { precheck: { task_id: taskId } } });
  };
  const result = await runShoppableUploadPrecheck({ ...fixture, fetchApi });
  assert.deepEqual(calls, ['/affiliate_creator/202505/videos/video_files', '/affiliate_creator/202511/videos/precheck_task']);
  assert.equal(result.file_id, fileId);
  assert.equal(result.precheck_task_id, taskId);
  assert.equal(result.submission, false);
  assert.deepEqual(state.attempts().map(item => [item.stage, item.status, item.original_request_id]),
    [['upload', 'verified', 'upload-origin-id'], ['precheck', 'verified', 'precheck-origin-id']]);
  const resumed = await runShoppableUploadPrecheck({ ...fixture, fetchApi: () => assert.fail('Verified stage must not POST again') });
  assert.equal(resumed.precheck_task_id, taskId);
  assert.equal(resumed.remote_requests, 0);
});

test('stops the precheck command before opening a live ledger while live is disabled', async () => {
  await assert.rejects(runCli(['api-upload-precheck', '--job', 'fixture-video', '--mode', 'live']),
    { reason: 'publisher_live_disabled' });
  await assert.rejects(runCli(['api-upload-precheck', '--job', 'fixture-video', '--mode', 'live', '--at', '2026-11-13T09:00:00Z']),
    { reason: 'api_precheck_requires_canonical_state_and_real_time' });
});

test('runs the authorized upload and independently reads the original precheck without publishing', async t => {
  const fixture = await transportFixture(t);
  const { job, state, session, md5 } = fixture;
  const paths = [];
  const taskId = '9000000000000000097';
  const fetchApi = async (url, options) => {
    paths.push([options.method ?? 'GET', url.pathname]);
    if (url.pathname.endsWith('/video_files')) return Response.json({ code: 0, request_id: 'upload-request',
      data: { video_file: { id: 'original-video-file', md5 } } });
    if (url.pathname.endsWith('/precheck_task')) return Response.json({ code: 0, request_id: 'precheck-request',
      data: { precheck: { task_id: taskId } } });
    assert.equal(url.pathname, '/affiliate_creator/202601/videos/precheck_tasks/' + taskId);
    return Response.json({ code: 0, request_id: 'independent-read', data: { precheck_task: {
      id: taskId, violation_check_result: { status: 'SUCCESS' },
    } } });
  };
  const openShop = async () => ({ token: 'fixture-seller', shop: {}, client: { productDetail: async () => ({
    requestId: 'seller-read', data: { id: job.product_id, skus: [{ id: job.sku_id }], status: 'ACTIVATE', audit: { status: 'APPROVED' } },
  }) } });
  const args = { job, state, openShop, fetchApi, approvalKey: 'fixture-approval' };
  const blocked = await runVerifiedShoppablePrecheck({ ...args, openCreator: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  assert.equal(blocked.conclusion, 'creator_authorization_unavailable');
  assert.equal(state.attempts().length, 0);
  const result = await runVerifiedShoppablePrecheck({ ...args, openCreator: async (_, { checkProduct }) => {
    assert.equal(checkProduct, true);
    return { ...session, accountType: 'TIKTOK_MARKETING_ACCOUNT', token: session.tokens.access_token,
      client: createTikTokClient({ ...session.credentials, fetchApi }) };
  } });
  assert.equal(result.exit_code, 0);
  assert.equal(result.conclusion, 'platform_precheck_passed');
  assert.equal(result.submission, false);
  assert.equal(result.verification.conclusion, 'platform_precheck_passed');
  assert.equal(result.verification.read_request_id, 'independent-read');
  assert.deepEqual(paths.map(([method]) => method), ['POST', 'POST', 'GET']);
  assert.deepEqual(state.attempts().map(row => [row.stage, row.approval_key]), [['upload', 'fixture-approval'], ['precheck', 'fixture-approval']]);
});

test('keeps a bad upload checksum with its original request and blocks any repeat or precheck', async t => {
  const fixture = await transportFixture(t);
  const calls = [];
  const fetchApi = async url => {
    calls.push(url.pathname);
    return Response.json({ code: 0, request_id: 'mismatched-upload-id', data: {
      video_file: { id: 'v12d00gd0024d3nfqr7og65', md5: '0'.repeat(32) },
    } });
  };
  const result = await runShoppableUploadPrecheck({ ...fixture, fetchApi });
  assert.equal(result.conclusion, 'original_operation_unverified');
  assert.equal(result.original_request_id, 'mismatched-upload-id');
  assert.equal(fixture.state.attempts()[0].status, 'unknown');
  const resumed = await runShoppableUploadPrecheck({ ...fixture, fetchApi: () => assert.fail('Unknown upload must not POST again') });
  assert.equal(resumed.stage, 'upload');
  assert.equal(resumed.original_request_id, 'mismatched-upload-id');
  assert.equal(resumed.remote_requests, 0);
  assert.deepEqual(calls, ['/affiliate_creator/202505/videos/video_files']);
});

test('recovers a recorded upload when precheck was never dispatched', async () => {
  const job = { video_id: 'fixture-video', account: 'fixture.creator', market: 'MY', sha256: 'a'.repeat(64),
    product_id: '9000000000000000047', sku_id: '9000000000000000049' };
  const action = { job_id: job.video_id, account: job.account, sha256: job.sha256, channel: 'tiktok-shop-api', stage: 'upload',
    status: 'verified', original_request_id: 'upload-origin-id',
    result: { file_id: 'v12d00gd0024d3nfqr7og65', media_md5: 'a'.repeat(32) } };
  const result = await readShoppableReconciliation({ job, attempts: [action],
    openSession: () => assert.fail('Recorded upload should not query a new upload') });
  assert.equal(result.exit_code, 0);
  assert.equal(result.conclusion, 'upload_verified_precheck_not_started');
  assert.equal(result.file_id, action.result.file_id);
  assert.equal(result.original_request_id, action.original_request_id);
});

test('resuming after an ambiguous precheck never retries the precheck or reuploads', async t => {
  const fixture = await transportFixture(t);
  const calls = [];
  const fileId = 'v12d00gd0024d3nfqr7og65';
  const result = await runShoppableUploadPrecheck({ ...fixture, fetchApi: async url => {
    calls.push(url.pathname);
    if (calls.length > 1) throw new Error('Socket disconnected');
    return Response.json({ code: 0, request_id: 'upload-origin-id', data: { video_file: { id: fileId, md5: fixture.md5 } } });
  } });
  assert.equal(result.stage, 'precheck');
  assert.equal(result.upload_request_id, 'upload-origin-id');
  assert.equal(fixture.state.attempts().at(-1).result_unknown, true);
  const resumed = await runShoppableUploadPrecheck({ ...fixture, fetchApi: () => assert.fail('Ambiguous operation cannot be repeated') });
  assert.equal(resumed.stage, 'precheck');
  assert.equal(resumed.file_id, fileId);
  assert.equal(resumed.remote_requests, 0);
  assert.equal(calls.length, 2);
});

test('submits the original prechecked file once and reconciles its platform video after reopening the ledger', async t => {
  const fixture = await transportFixture(t);
  const job = { ...fixture.job, fields: { ...fixture.job.fields, commercial_disclosure: false } };
  const fileId = 'v12d00gd0024d3nfqr7og65';
  const taskId = '9000000000000000097';
  const videoId = '9000000000000000103';
  const calls = [];
  let precheckStatus = 'PROCESSING';
  const fetchApi = async (url, options) => {
    const path = url.pathname;
    calls.push([options.method, path]);
    assert.equal(url.searchParams.has('sign'), true);
    if (path.endsWith('/video_files')) return Response.json({ code: 0, request_id: 'upload-original', data: {
      video_file: { id: fileId, md5: fixture.md5 },
    } });
    if (path.endsWith('/precheck_task')) return Response.json({ code: 0, request_id: 'precheck-original', data: {
      precheck: { task_id: taskId },
    } });
    if (path.endsWith('/' + taskId)) return Response.json({ code: 0, request_id: 'precheck-read', data: {
      precheck_task: { id: taskId, violation_check_result: { status: precheckStatus } },
    } });
    if (path === '/affiliate_creator/202607/videos') {
      assert.deepEqual(JSON.parse(options.body), { video_info: { file_id: fileId,
        title: job.description + '\n' + job.tags.join(' '), is_ai_generated: true },
      product_link_info: { product_id: job.product_id, title: job.short_name } });
      assert.equal(fixture.state.attempts().at(-1).status, 'unknown');
      return Response.json({ code: 0, request_id: 'post-original', data: { video: { id: videoId } } });
    }
    assert.equal(path, `/affiliate_creator/202509/videos/${videoId}/status`);
    return Response.json({ code: 0, request_id: 'post-status-read', data: { video: {
      id: videoId, post_status: 'SUCCESS', post_time: 1794519300,
    } } });
  };
  await runShoppableUploadPrecheck({ ...fixture, job, fetchApi });
  const args = { ...fixture, job, fetchApi };
  const wrongTitle = await runShoppablePost({ ...args, job: { ...job, short_name: 'Tajuk baharu' },
    fetchApi: () => assert.fail('A changed anchor must not use the previous precheck') });
  assert.equal(wrongTitle.conclusion, 'original_upload_precheck_unverified');
  const pending = await runShoppablePost(args);
  assert.equal(pending.conclusion, 'platform_precheck_processing');
  assert.equal(pending.submit_dispatched, false);
  precheckStatus = 'SUCCESS';
  const disclosure = await runShoppablePost({ ...args, job: fixture.job });
  assert.equal(disclosure.conclusion, 'commercial_disclosure_unverified');
  assert.equal(disclosure.submit_dispatched, false);
  const first = await runShoppablePost(args);
  assert.equal(first.conclusion, 'platform_post_success_anchor_unverified');
  assert.equal(first.submit_dispatched, true);
  assert.equal(first.public_product_anchor_verified, false);
  assert.equal(first.original_request_id, 'post-original');
  assert.equal(first.read_request_id, 'post-status-read');
  assert.equal(first.precheck_task_id, taskId);
  const reopened = new State(fixture.state.dir);
  try {
    const second = await runShoppablePost({ ...args, state: reopened });
    assert.equal(second.original_request_id, 'post-original');
    assert.equal(second.submit_dispatched, false);
    assert.equal(second.platform_id, videoId);
    assert.equal(second.precheck_task_id, taskId);
    assert.equal(reopened.attempts().filter(row => row.stage === 'submit').length, 1);
  } finally {
    reopened.close();
  }
  assert.deepEqual(calls.filter(([method]) => method === 'POST').map(([, path]) => path), [
    '/affiliate_creator/202505/videos/video_files', '/affiliate_creator/202511/videos/precheck_task',
    '/affiliate_creator/202607/videos',
  ]);
});

test('an ambiguous post is read only by its original ID and a missing ID never sends another POST', async t => {
  const fixture = await transportFixture(t);
  const job = { ...fixture.job, fields: { ...fixture.job.fields, commercial_disclosure: false } };
  const fileId = 'v12d00gd0024d3nfqr7og65';
  const taskId = '9000000000000000097';
  const fetchApi = async url => {
    if (url.pathname.endsWith('/video_files')) return Response.json({ code: 0, request_id: 'upload-original', data: {
      video_file: { id: fileId, md5: fixture.md5 },
    } });
    if (url.pathname.endsWith('/precheck_task')) return Response.json({ code: 0, request_id: 'precheck-original', data: {
      precheck: { task_id: taskId },
    } });
    if (url.pathname.endsWith('/' + taskId)) return Response.json({ code: 0, request_id: 'precheck-read', data: {
      precheck_task: { id: taskId, violation_check_result: { status: 'SUCCESS' } },
    } });
    assert.equal(url.pathname, '/affiliate_creator/202607/videos');
    throw new Error('Connection lost after POST');
  };
  const args = { ...fixture, job, fetchApi };
  await runShoppableUploadPrecheck(args);
  const first = await runShoppablePost(args);
  assert.equal(first.conclusion, 'original_platform_id_unavailable');
  assert.equal(first.submit_dispatched, true);
  const next = await runShoppablePost({ ...args, fetchApi: () => assert.fail('Original POST cannot be repeated') });
  assert.equal(next.conclusion, 'original_platform_id_unavailable');
  assert.equal(next.submit_dispatched, false);
  assert.equal(fixture.state.attempts().at(-1).result_unknown, true);
});
