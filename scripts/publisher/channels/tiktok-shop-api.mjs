import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadLocalAppCredentials, loadLocalCreatorAuthorization } from '../../../apps/customer-service/tiktok-auth.mjs';
import { CreatorTrialError, validCreatorTrial, verifyCreatorIdentity, verifyCreatorTrial } from '../../../apps/customer-service/tiktok-creator-auth.mjs';
import { createTikTokClient, isPlatformId, publicPlatformError, signTikTokShopUrl } from '../../../apps/customer-service/tiktok-shop-read.mjs';
import { readHistoricalVideoProduct } from '../../operations/run-shop-video-reconciliation.mjs';
import { openMyShopSession } from '../../operations/verify-promotion-outcome.mjs';
import { fail, safeID } from '../lib/common.mjs';

export const channelName='tiktok-shop-api';
export const implemented=false;

const directUploadLimit = 10_000_000;
const platformStatuses = new Set(['SUCCESS', 'FAIL', 'PROCESSING']);

async function prepareShoppableVideo(job) {
  if (job.market !== 'MY' || !/^\d{8,30}$/u.test(job.product_id) || !/^\d{8,30}$/u.test(job.sku_id) ||
      extname(job.file).toLowerCase() !== '.mp4') fail('api_shadow_job_identity_invalid');
  const caption = [job.description, job.tags.join(' ')].join('\n');
  const title = job.short_name;
  if (caption.length > 4000 || !title || title.length > 30 || !/^[\p{L}\p{N} ]+$/u.test(title)) {
    fail('api_shadow_caption_or_anchor_title_invalid');
  }
  const file = await open(job.file, 'r');
  let bytes;
  try {
    const { size } = await file.stat();
    if (size === 0 || size >= directUploadLimit) fail('api_shadow_direct_upload_size_out_of_range');
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read({ buffer, position: 0 });
    if (bytesRead !== size) fail('api_shadow_file_changed');
    bytes = buffer.subarray(0, size);
  } finally {
    await file.close();
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== job.sha256) fail('api_shadow_sha256_mismatch');
  const productLink = { product_id: job.product_id, title };
  const fileId = '<video_file.id from original upload>';
  const plan = {
    exit_code: 0, mode: 'api-shadow', readiness: 'request_contract_only', channel: channelName, video_id: job.video_id, account: job.account,
    market: job.market, product_id: job.product_id, sku_id: job.sku_id,
    file: { bytes: bytes.length, sha256, expected_upload_md5: createHash('md5').update(bytes).digest('hex') },
    required_scope: 'creator.video.write',
    upload: { method: 'POST', path: '/affiliate_creator/202505/videos/video_files', encoding: 'multipart/form-data', field: 'data' },
    precheck: { method: 'POST', path: '/affiliate_creator/202511/videos/precheck_task',
      body_template: { video_info: { file_id: fileId }, product_link_info: productLink },
      result_path: '/affiliate_creator/202601/videos/precheck_tasks/{task_id}',
      required_my_result: 'precheck_task.violation_check_result.status=SUCCESS' },
    post: { method: 'POST', path: '/affiliate_creator/202607/videos',
      body_template: { video_info: { file_id: fileId, title: caption, is_ai_generated: job.fields.ai_disclosure },
        product_link_info: productLink },
      commercial_disclosure: job.fields.commercial_disclosure ? 'platform_behavior_unverified' : 'not_required_by_job' },
    result: { method: 'GET', path: '/affiliate_creator/202509/videos/{video_id}/status',
      required_status: 'SUCCESS', confirm_product_anchor_separately: true },
    remote_requests: 0, upload_performed: false, submission: false,
  };
  return { bytes, plan };
}

export async function planShoppableVideo(job) {
  return (await prepareShoppableVideo(job)).plan;
}

export async function openCreatorSession(job, { checkProduct = false, loadAuthorization = loadLocalCreatorAuthorization,
  loadCredentials = loadLocalAppCredentials, createClient = createTikTokClient } = {}) {
  const [authorization, credentials] = await Promise.all([
    loadAuthorization(job.account, job.product_id), loadCredentials(),
  ]);
  const saved = authorization.verified;
  if (authorization.serviceId !== credentials.serviceId || saved?.account !== job.account || saved.market !== 'MY') {
    fail('creator_authorization_identity_mismatch');
  }
  const client = createClient(credentials);
  const input = { tokens: authorization.tokens, client, account: job.account, productId: job.product_id };
  const verified = checkProduct ? await verifyCreatorTrial(input) : null;
  const accountType = verified?.accountType ?? await verifyCreatorIdentity(input);
  if (saved.accountType !== accountType) fail('creator_authorization_account_type_changed');
  return { client, token: authorization.tokens.access_token, accountType, credentials, tokens: authorization.tokens, verified };
}

function requestId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/iu.test(value) ? value : null;
}

const malaysiaDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'short' });

export async function readShoppableProductAssociation({ job, videoId, postTime, openShop = openMyShopSession }) {
  const postedAt = new Date(postTime * 1000);
  if (job.market !== 'MY' || !validCreatorTrial({ account: job.account, productId: job.product_id }) ||
      !isPlatformId(videoId) || !Number.isSafeInteger(postTime) || postTime <= 0 || !Number.isFinite(postedAt.getTime())) {
    fail('api_video_product_readback_identity_invalid');
  }
  const start = malaysiaDay.format(postedAt);
  const end = new Date(Date.parse(start + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const result = { video_id: videoId, account: job.account, product_id: job.product_id, post_day: start,
    analytics_request_id: null, latest_available_date: null, product_request_ids: [] };
  try {
    const { client, token, shop } = await openShop('9000000000000000099');
    const { data, requestId: rawId } = await client.batchVideoPerformance(token, shop, start, end, [videoId], { includeRequestId: true });
    result.analytics_request_id = requestId(rawId);
    if (!result.analytics_request_id || !/^\d{4}-\d{2}-\d{2}$/u.test(data.latest_available_date ?? '')) {
      return { ...result, state: 'video_analytics_unverified' };
    }
    result.latest_available_date = data.latest_available_date;
    if (data.latest_available_date < start) return { ...result, state: 'video_analytics_not_ready' };
    const [row] = data.videos ?? [];
    const video = row?.video;
    const localTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(video?.video_post_time ?? '')
      ? Date.parse(video.video_post_time.replace(' ', 'T') + '+08:00') : NaN;
    if (data.videos?.length !== 1 || row.error?.code || row.video_id !== videoId || video?.id !== videoId ||
        typeof video.username !== 'string' || video.username.replace(/^@/u, '').toLowerCase() !== job.account || localTime !== postedAt.getTime()) {
      return { ...result, state: 'video_analytics_identity_unverified' };
    }
    const product = await readHistoricalVideoProduct(client, token, shop, start, end,
      { platformVideoId: videoId, productId: job.product_id });
    const productAvailable = product.latestAvailableDate >= start;
    return { ...result, state: productAvailable ? product.state : 'product_analytics_not_ready',
      product_request_ids: product.requestIds, product_latest_available_date: product.latestAvailableDate,
      product_engagement: productAvailable ? product.engagement : null };
  } catch (error) {
    return { ...result, state: 'video_product_analytics_unavailable',
      error: publicPlatformError(error, '无法核实该平台视频和商品的分析数据。') };
  }
}

export async function readShoppableReadiness({ job, openShop = openMyShopSession, openCreator = openCreatorSession }) {
  if (!validCreatorTrial({ account: job.account, productId: job.product_id })) fail('api_preflight_job_identity_invalid');
  const { plan } = await prepareShoppableVideo(job);
  const shopId = '9000000000000000099';
  const result = { schema: 'tiktok-shop-shoppable-readiness/v1', channel: channelName, observed_at: new Date().toISOString(),
    shop_id: shopId, job_id: job.video_id, account: job.account, market: job.market, file: plan.file,
    product_id: job.product_id, sku_id: job.sku_id, seller_sku: job.package?.seller_sku ?? null,
    read_only: true, upload_performed: false, submission: false,
    commercial_disclosure: plan.post.commercial_disclosure, seller: null, creator: null };
  try {
    const { client, token, shop } = await openShop(shopId);
    const { data, requestId: rawId } = await client.productDetail(token, shop, job.product_id, { includeRequestId: true });
    const matches = data.skus?.filter(row => row.id === job.sku_id && (!result.seller_sku || row.seller_sku === result.seller_sku));
    const readId = requestId(rawId);
    const exact = data.id === job.product_id && matches?.length === 1 && !!readId;
    result.seller = { request_id: readId, exact_sku_verified: exact, status: data.status ?? null, audit: data.audit?.status ?? null };
    if (!exact || data.status !== 'ACTIVATE' || data.audit?.status !== 'APPROVED') {
      return { ...result, exit_code: 20, conclusion: 'seller_listing_not_verified_active' };
    }
  } catch (error) {
    return { ...result, exit_code: 20, conclusion: 'seller_listing_read_unavailable',
      error: publicPlatformError(error, '无法核实原商品在售状态。') };
  }
  try {
    const { accountType } = await openCreator(job, { checkProduct: true });
    result.creator = { account_type: accountType, required_scope: plan.required_scope, exact_product_eligible: true };
    return { ...result, exit_code: job.fields.commercial_disclosure ? 20 : 0, conclusion: job.fields.commercial_disclosure ?
      'commercial_disclosure_unverified' : 'seller_and_creator_readbacks_verified' };
  } catch (error) {
    const conclusion = error.code === 'ENOENT' ? 'creator_authorization_unavailable' : 'creator_readiness_unverified';
    return { ...result, exit_code: 20, conclusion, error: publicPlatformError(error,
      error instanceof CreatorTrialError ? error.message : '无法核实原发布账号的挂车授权。') };
  }
}

function uploadFileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : null;
}

function assertWriteSession({ job, state, session, fetchApi }, reason) {
  const { credentials, tokens, verified } = session ?? {};
  if (state.readonly || typeof fetchApi !== 'function' || !credentials?.appKey || !credentials.appSecret ||
      !validCreatorTrial({ account: job.account, productId: job.product_id }) ||
      tokens?.user_type !== 1 || typeof tokens.access_token !== 'string' || !tokens.access_token ||
      !Array.isArray(tokens.granted_scopes) || !tokens.granted_scopes.includes('creator.video.write') ||
      verified?.account !== job.account || verified.market !== 'MY' || verified.productId !== job.product_id) {
    fail(reason);
  }
  const originalRows = [...state.attempts(), ...state.orphanIntents()];
  if (originalRows.some(row => row.sha256 === job.sha256 && row.channel !== channelName &&
      (row.stage === 'upload' || row.stage === 'submit') &&
      (row.published === true || row.result_unknown === true || ['verified', 'unknown'].includes(row.status)))) {
    fail('prior_operation_in_other_channel');
  }
}

function shoppableActionKey(job, stage) {
  return `${job.market}:${job.sha256}:${stage}:${channelName}`;
}

function originalShoppableAction(state, job, stage, path) {
  const key = shoppableActionKey(job, stage);
  const row = state.action(key) ?? state.orphanIntents().find(candidate => candidate.action_key === key);
  if (row && (row.job_id !== job.video_id || row.account !== job.account || row.product_id !== job.product_id ||
      row.sku_id !== job.sku_id || row.channel !== channelName || row.stage !== stage ||
      row.sha256 !== job.sha256 || row.request_path !== path)) fail('original_api_operation_identity_mismatch');
  return row;
}

async function postShoppableOnce({ job, state, session, fetchApi, now, approvalKey }, { stage, path, body, multipart = false, verifyResult }) {
  const prior = originalShoppableAction(state, job, stage, path);
  if (prior) return { action: prior, dispatched: false };

  const { credentials, tokens } = session;
  const key = shoppableActionKey(job, stage);
  const action = { action_key: key, job_id: safeID(job.video_id), account: job.account, sha256: job.sha256,
    product_id: job.product_id, sku_id: job.sku_id, channel: channelName, stage, request_path: path,
    at: new Date(now()).toISOString(), ...(approvalKey ? { approval_key: approvalKey } : {}) };
  const url = signTikTokShopUrl({ ...credentials, path, timestamp: String(Math.floor(now() / 1000)), body: multipart ? '' : body });
  state.beginAction(action);
  let response, envelope;
  try {
    response = await fetchApi(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { 'x-tts-access-token': tokens.access_token, ...(multipart ? {} : { 'Content-Type': 'application/json' }) } });
    envelope = await response.json();
  } catch {
    // The request may have been accepted before the response was lost.
  }
  const original_request_id = requestId(envelope?.request_id);
  const result = response?.ok && envelope?.code === 0 && original_request_id ? verifyResult(envelope.data) : null;
  const verified = Boolean(result && stage !== 'submit');
  const observed = { status: verified ? 'verified' : 'unknown', result_unknown: !verified, original_request_id,
    http_status: response?.status ?? null, platform_code: Number.isSafeInteger(envelope?.code) ? envelope.code : null, result };
  state.finishAction(key, observed);
  return { action: { ...action, ...observed }, dispatched: true };
}

export async function runShoppableUploadPrecheck({ job, state, session, fetchApi, now = Date.now, approvalKey }) {
  const jobId = safeID(job.video_id);
  const context = { job, state, session, fetchApi, now, approvalKey };
  assertWriteSession(context, 'creator_upload_session_unverified');
  const { bytes, plan } = await prepareShoppableVideo(job);
  let requests = 0;
  const base = { schema: 'tiktok-shop-shoppable-upload-precheck/v1', job_id: jobId, account: job.account, market: job.market,
    product_id: job.product_id, sku_id: job.sku_id, sha256: job.sha256, submission: false, automatic_replay: false };
  const unresolved = (action, extra = {}) => ({ ...base, ...extra, exit_code: 20, conclusion: 'original_operation_unverified',
    stage: action.stage, original_request_id: action.original_request_id ?? null, remote_requests: requests });
  const form = new FormData();
  form.append(plan.upload.field, new Blob([bytes], { type: 'video/mp4' }), basename(job.file));
  const uploaded = await postShoppableOnce(context, {
    stage: 'upload', path: plan.upload.path, body: form, multipart: true,
    verifyResult(data) {
      const file = data?.video_file;
      const fileId = uploadFileId(file?.id);
      return fileId && typeof file.md5 === 'string' && file.md5.toLowerCase() === plan.file.expected_upload_md5
        ? { file_id: fileId, media_md5: plan.file.expected_upload_md5 } : null;
    },
  });
  const upload = uploaded.action;
  if (uploaded.dispatched) requests++;
  const fileId = uploadFileId(upload.result?.file_id);
  if (upload.status !== 'verified' || !fileId || upload.result.media_md5 !== plan.file.expected_upload_md5) return unresolved(upload);
  const precheckBody = JSON.stringify({ ...plan.precheck.body_template, video_info: { file_id: fileId } });
  const precheckBodySha256 = createHash('sha256').update(precheckBody).digest('hex');
  const prechecked = await postShoppableOnce(context, {
    stage: 'precheck', path: plan.precheck.path, body: precheckBody,
    verifyResult: data => isPlatformId(data?.precheck?.task_id)
      ? { precheck_task_id: data.precheck.task_id, file_id: fileId, body_sha256: precheckBodySha256 } : null,
  });
  const precheck = prechecked.action;
  if (prechecked.dispatched) requests++;
  const precheckId = precheck.result?.precheck_task_id;
  if (precheck.status !== 'verified' || !isPlatformId(precheckId) || precheck.result.file_id !== fileId) {
    return unresolved(precheck, { file_id: fileId, upload_request_id: upload.original_request_id });
  }
  return { ...base, exit_code: 0, conclusion: 'precheck_created', remote_requests: requests, file_id: fileId,
    precheck_task_id: precheckId, upload_request_id: upload.original_request_id, precheck_request_id: precheck.original_request_id };
}

export async function runVerifiedShoppablePrecheck({ job, state, approvalKey, openShop = openMyShopSession,
  openCreator = openCreatorSession, fetchApi = fetch, now = Date.now }) {
  let session;
  const readiness = await readShoppableReadiness({ job, openShop, openCreator: async (...args) => {
    session = await openCreator(...args);
    return session;
  } });
  if (readiness.creator?.exact_product_eligible !== true) return readiness;
  const result = await runShoppableUploadPrecheck({ job, state, session, fetchApi, now, approvalKey });
  if (result.conclusion !== 'precheck_created') return result;
  const verification = await readShoppableReconciliation({ job, attempts: [...state.attempts(), ...state.orphanIntents()],
    openSession: async () => ({ client: session.client, token: session.token }) });
  return { ...result, exit_code: verification.conclusion === 'platform_precheck_passed' ? 0 : 20,
    conclusion: verification.conclusion, verification };
}

export async function runShoppablePost({ job, state, session, fetchApi, now = Date.now }) {
  safeID(job.video_id);
  const context = { job, state, session, fetchApi, now };
  assertWriteSession(context, 'creator_post_session_unverified');
  const plan = await planShoppableVideo(job);
  const client = createTikTokClient({ ...session.credentials, fetchApi, now });
  const openSession = async () => ({ client, token: session.tokens.access_token });
  const reconcile = action => readShoppableReconciliation({ job, attempts: [action], openSession });
  const prior = originalShoppableAction(state, job, 'submit', plan.post.path);
  if (prior) return { ...await reconcile(prior), submit_dispatched: false,
    precheck_task_id: prior.result?.precheck_task_id ?? null,
    precheck_read_request_id: prior.result?.precheck_read_request_id ?? null };

  const base = { channel: channelName, job_id: job.video_id, account: job.account, market: job.market,
    product_id: job.product_id, sku_id: job.sku_id, sha256: job.sha256, submit_dispatched: false,
    public_product_anchor_verified: false, automatic_replay: false };
  const upload = originalShoppableAction(state, job, 'upload', plan.upload.path);
  const precheck = originalShoppableAction(state, job, 'precheck', plan.precheck.path);
  const fileId = uploadFileId(upload?.result?.file_id);
  const expectedPrecheck = JSON.stringify({ ...plan.precheck.body_template, video_info: { file_id: fileId } });
  if (upload?.status !== 'verified' || !fileId || !requestId(upload.original_request_id) ||
      upload.result.media_md5 !== plan.file.expected_upload_md5 || precheck?.status !== 'verified' ||
      !requestId(precheck.original_request_id) || precheck.result?.file_id !== fileId ||
      precheck.result?.body_sha256 !== createHash('sha256').update(expectedPrecheck).digest('hex')) {
    return { ...base, exit_code: 20, conclusion: 'original_upload_precheck_unverified' };
  }
  const checked = await reconcile(precheck);
  if (checked.conclusion !== 'platform_precheck_passed') return { ...checked, submit_dispatched: false };
  const origin = { precheck_task_id: checked.platform_id, precheck_read_request_id: checked.read_request_id };
  if (job.fields.commercial_disclosure !== false) {
    return { ...base, ...origin, exit_code: 20, conclusion: 'commercial_disclosure_unverified' };
  }

  const body = JSON.stringify({ ...plan.post.body_template,
    video_info: { ...plan.post.body_template.video_info, file_id: fileId } });
  const posted = await postShoppableOnce(context, {
    stage: 'submit', path: plan.post.path, body,
    verifyResult: data => isPlatformId(data?.video?.id)
      ? { platform_video_id: data.video.id, file_id: fileId, ...origin } : null,
  });
  return { ...await reconcile(posted.action), ...origin, read_only: !posted.dispatched,
    attempt_state_changed: posted.dispatched, submit_dispatched: posted.dispatched };
}

export async function readShoppableReconciliation({ job, attempts, openSession = openCreatorSession, readProductAssociation }) {
  if (job.market !== 'MY' || !validCreatorTrial({ account: job.account, productId: job.product_id }) ||
      !isPlatformId(job.sku_id) || !/^[a-f0-9]{64}$/u.test(job.sha256)) fail('api_reconciliation_job_identity_invalid');
  const base = { schema: 'tiktok-shop-shoppable-reconciliation/v1', channel: channelName, observed_at: new Date().toISOString(),
    job_id: job.video_id, account: job.account, market: job.market, sha256: job.sha256, product_id: job.product_id, sku_id: job.sku_id,
    read_only: true, automatic_replay: false, attempt_state_changed: false, public_product_anchor_verified: false };
  const exact = attempts.filter(row => row.channel === channelName && row.job_id === job.video_id &&
    row.account === job.account && row.sha256 === job.sha256 && ['submit', 'precheck', 'upload'].includes(row.stage));
  const stage = ['submit', 'precheck', 'upload'].find(name => exact.some(row => row.stage === name));
  if (!stage) return { ...base, exit_code: 10, conclusion: 'no_original_api_operation' };
  const records = exact.filter(row => row.stage === stage);
  if (records.length !== 1) return { ...base, exit_code: 20, stage, conclusion: 'original_api_operation_ambiguous' };
  const original = records[0];
  const evidence = { ...base, stage, action_key: original.action_key ?? null,
    original_request_id: requestId(original.original_request_id ?? original.result?.original_request_id) };
  if ((original.product_id !== undefined && original.product_id !== job.product_id) ||
      (original.sku_id !== undefined && original.sku_id !== job.sku_id)) {
    return { ...evidence, exit_code: 20, conclusion: 'original_api_operation_identity_mismatch' };
  }
  if (stage === 'upload') {
    const fileId = uploadFileId(original.result?.file_id);
    if (original.status === 'verified' && fileId && evidence.original_request_id && /^[a-f0-9]{32}$/u.test(original.result.media_md5)) {
      return { ...evidence, exit_code: 0, conclusion: 'upload_verified_precheck_not_started', file_id: fileId };
    }
    return { ...evidence, exit_code: 20, conclusion: 'upload_requires_original_file_receipt' };
  }
  const isPost = stage === 'submit';
  const platformId = isPost ? original.result?.platform_video_id : original.result?.precheck_task_id;
  if (!isPlatformId(platformId)) return { ...evidence, exit_code: 20, conclusion: 'original_platform_id_unavailable' };
  const result = { ...evidence, platform_id: platformId };
  try {
    const { client, token } = await openSession(job);
    const response = await (isPost ? client.creatorVideoStatus(token, platformId) : client.creatorVideoPrecheckStatus(token, platformId));
    result.read_request_id = requestId(response.requestId);
    const remote = isPost ? response.data.video : response.data.precheck_task;
    const status = isPost ? remote?.post_status : remote?.violation_check_result?.status;
    if (remote?.id !== platformId || !result.read_request_id || !platformStatuses.has(status) ||
        (isPost && status === 'SUCCESS' && (!Number.isSafeInteger(remote.post_time) || remote.post_time <= 0))) {
      return { ...result, exit_code: 20, conclusion: 'platform_read_unverified' };
    }
    const conclusion = isPost
      ? { SUCCESS: 'platform_post_success_anchor_unverified', FAIL: 'platform_post_failed', PROCESSING: 'platform_post_processing' }[status]
      : { SUCCESS: 'platform_precheck_passed', FAIL: 'platform_precheck_failed', PROCESSING: 'platform_precheck_processing' }[status];
    const quality = remote.good_quality_check_result?.status;
    const productAssociation = isPost && status === 'SUCCESS' && readProductAssociation
      ? await readProductAssociation({ job, videoId: platformId, postTime: remote.post_time }) : null;
    return { ...result, exit_code: 0, conclusion, platform_status: status,
      ...(isPost ? { post_time: status === 'SUCCESS' ? remote.post_time : null,
        ...(productAssociation ? { product_association: productAssociation } : {}) } :
        { quality_status: platformStatuses.has(quality) ? quality : null }) };
  } catch (error) {
    return { ...result, exit_code: 20, conclusion: error.code === 'ENOENT' ? 'creator_authorization_unavailable' : 'platform_read_unverified',
      error: publicPlatformError(error, '无法核实原官方请求结果。') };
  }
}
