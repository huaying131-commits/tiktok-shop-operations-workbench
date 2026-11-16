import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { authorizedImageType } from './upload-image-type.mjs';

// Uses only the official CLI and standard DOM file controls. Never calls seller APIs.
const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const field of ['cli', 'storeId', 'targetId', 'shopText', 'sellerSku', 'fileSelector', 'file', 'report'])
  if (!job[field]) throw new Error(`Missing job field: ${field}`);
// The caller must have authorization for the market; this pilot supports only MY, SG, and VN.
// Omission preserves existing MY jobs. Empty strings, null, and lowercase codes are rejected.
function validateMarket(value = 'MY') {
  if (typeof value !== 'string' || !['MY', 'SG', 'VN'].includes(value))
    throw new Error('Invalid market: expected exactly MY, SG, or VN');
  return value;
}
const market = validateMarket(job.market);
if (job.transferMode && job.transferMode !== 'chunks') throw new Error('Only the verified chunks image transport is supported');
// Count actual detail-editor image wrappers, not the editor's hidden template/mirror images.
// For detail uploads use successSelector: '.ProseMirror .syl-image-wrapper img', scoped to
// the intended editor when necessary. A previous unknown result requires readback, not reupload.
if (job.successSelector?.replace(/\s+/g, ' ').trim() === '.ProseMirror img')
  throw new Error('Detail successSelector must use .ProseMirror .syl-image-wrapper img; the broader selector counts hidden mirrors');
const bytes = await readFile(job.file);
const mimeType = authorizedImageType(bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const key = `__daleiUpload_${randomUUID().replaceAll('-', '')}`;
const quote = JSON.stringify;
const expectedPath = job.expectedPath || '/product/create';
if (!/^\/product\/(?:create|edit-draft\/\d+)$/.test(expectedPath)) throw new Error('Invalid expected product form path');
const guard = `if(location.hostname!=='seller.tiktokshopglobalselling.com'||location.pathname!==${quote(expectedPath)}||new URL(location.href).searchParams.get('shop_region')!==${quote(market)})throw Error('Page mismatch');if(!document.body.innerText.replace(/\\s+/g,' ').includes(${quote(job.shopText)}))throw Error('Shop mismatch');if(/请完成下列验证|拖动.*拼图|滑块验证|验证你是人/.test(document.body.innerText))throw Error('Human verification required');if(![...document.querySelectorAll('input')].some(e=>e.value===${quote(job.sellerSku)}))throw Error('SKU mismatch');`;

function safeText(value, limit = 600) {
  return String(value ?? '')
    .replace(/\bdata:[^,\s]+,[^\s"'<>]+/gi, '[data-url omitted]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/(--confirmation-token\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|authorization|cookie|password|(?:access|refresh|confirmation)[-_ ]?token)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{120,}/g, '[long payload omitted]')
    .slice(0, limit);
}

function publicReport(value) {
  if (typeof value === 'string') return safeText(value, 2000);
  if (Array.isArray(value)) return value.map(publicReport);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (name === 'confirmation_material')
      return [name, { required: true, details_saved_in_local_report: true }];
    if (/token|password|secret|api[-_]?key|authorization|cookie/i.test(name))
      return [name, '[redacted]'];
    return [name, publicReport(item)];
  }));
}

function walkObjects(value, callback, trail = '$', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return undefined;
  const result = callback(value, trail);
  if (result) return result;
  for (const [name, child] of Object.entries(value)) {
    const found = walkObjects(child, callback, `${trail}.${name}`, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function confirmationMaterial(envelope) {
  return walkObjects(envelope, (node, at) => {
    if (node.confirmationRequired !== true && node.stage !== 'confirmation_pending') return undefined;
    // Preserve exact confirmation materials only in the local report, including the one-use token.
    const allowed = ['confirmationRequired', 'stage', 'confirmationMessage', 'screenshotFilePath',
      'confirmationToken', 'confirmation_token', 'token', 'confirmation'];
    return { at, ...Object.fromEntries(allowed.filter(name => name in node).map(name => [name, node[name]])) };
  });
}

function permissionDenied(envelope) {
  return walkObjects(envelope, node => {
    const code = `${node.code ?? ''} ${node.type ?? ''} ${node.message ?? ''}`;
    return /permission[ ._-]?denied|access[ ._-]?denied/i.test(code) || node.type === 'auth' ? true : undefined;
  });
}

function parseEnvelope(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function assertResponseTarget(actualTargetId, expectedTargetId) {
  if (actualTargetId === expectedTargetId) return;
  const error = new Error('CLI returned a different or missing target ID; stop and inspect the actual tab before continuing.');
  error.blocked = 'target_mismatch';
  error.targetMismatch = {
    requested_target_id: safeText(expectedTargetId, 128),
    returned_target_id: typeof actualTargetId === 'string' ? safeText(actualTargetId, 128) : null,
    returned_target_type: actualTargetId === null ? 'null' : typeof actualTargetId,
  };
  throw error;
}

function exec(body) {
  const script = `(()=>{${guard}${body}})()`;
  const result = spawnSync(job.cli, ['page', 'exec', '--store-id', job.storeId, '--target-id', job.targetId, '--script', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ZINIAO_CLI_NO_UPDATE_CHECK: '1' },
  });
  const stdout = parseEnvelope(result.stdout);
  const stderr = parseEnvelope(result.stderr);
  for (const envelope of [stdout, stderr]) {
    const material = confirmationMaterial(envelope);
    if (material) {
      const error = new Error('Tool requires confirmation; upload stopped. Exact materials are in the local report.');
      error.confirmationMaterial = material;
      error.blocked = 'confirmation_required';
      throw error;
    }
    if (permissionDenied(envelope)) {
      const error = new Error('Tool denied permission or authentication; upload stopped.');
      error.blocked = 'permission_denied';
      throw error;
    }
  }
  if (result.error || result.status !== 0) {
    const code = result.error?.code || stderr?.error?.code || result.status;
    // Do not log stderr, command arguments, script snippets, or arbitrary CLI envelope objects.
    throw new Error(`CLI failed (${safeText(code, 80)}): ${safeText(stderr?.error?.message || 'No safe structured error detail')}`);
  }
  const envelope = stdout;
  if (!envelope) throw new Error('CLI returned a non-JSON response; payload omitted');
  const inner = envelope.data?.data;
  // Bridge has returned the active tab despite an explicit --target-id. Check every response.
  // This happens after execution and is not an atomic safeguard against a concurrent tab switch:
  // retain the in-page URL/market/shop/SKU guard, and after opening a tab or changing countries
  // first read the actual returned target ID, URL, and shop rather than trusting the requested ID.
  assertResponseTarget(inner?.targetId, job.targetId);
  if (!envelope.ok || envelope.data?.ok === false || inner?.exceptionDetails) {
    const detail = inner?.exceptionDetails;
    const description = detail?.exception?.description?.split('\n')[0];
    const error = new Error(`Page operation failed: ${safeText(description || detail?.text || envelope.error?.message || 'Unknown page error')}`);
    if (/Human verification required/.test(description || '')) error.blocked = 'human_verification_required';
    throw error;
  }
  try { return JSON.parse(inner.result); }
  catch { throw new Error('Page result is not valid JSON; payload omitted'); }
}

const report = { file: path.resolve(job.file), name: path.basename(job.file), bytes: bytes.length, sha256,
  mime_type: mimeType, transfer_mode: job.transferMode || 'chunks',
  store_id: job.storeId, target_id: job.targetId, seller_sku: job.sellerSku,
  market, expected_path: expectedPath,
  method: 'official_cli_standard_dom_File_DataTransfer', website_upload_verified: false,
  dispatch_attempted: false };

// A process may stop after the website receives the event but before the CLI returns.
// Keep that checkpoint and prohibit silently replaying the same job/report after any dispatch attempt.
try {
  const previous = JSON.parse(await readFile(job.report, 'utf8'));
  if (previous.dispatch_attempted || previous.dispatched || previous.website_upload_verified)
    throw new Error('This report already records an upload attempt. Inspect the saved report and website before any new job; automatic replay is blocked.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const persist = () => writeFile(job.report, JSON.stringify(report, null, 2));
const countExpression = job.successSelector ? `document.querySelectorAll(${quote(job.successSelector)}).length` : 'null';
const countGuard = `const count=${countExpression};if(${job.expectedBeforeCount !== undefined}&&count!==${job.expectedBeforeCount ?? 'null'})throw Error('Existing image count changed; inspect before uploading');`;
let bufferCreated = false;
let blocked = false;
try {
  report.before = exec(`const inputs=document.querySelectorAll(${quote(job.fileSelector)});if(inputs.length!==1||inputs[0].disabled)throw Error('Upload control mismatch');${countGuard}window[${quote(key)}]={parts:[],state:'receiving'};return JSON.stringify({inputCount:inputs.length,accept:inputs[0].accept,successCount:count});`);
  bufferCreated = true;
    const base64 = bytes.toString('base64');
    const chunkSize = 24000; // Remains below Windows' command-line limit including the guard.
    const chunks = Math.ceil(base64.length / chunkSize);
    for (let i = 0; i < chunks; i++) {
      const chunk = base64.slice(i * chunkSize, (i + 1) * chunkSize);
      const reply = exec(`const b=window[${quote(key)}];if(!b||b.parts.length!==${i})throw Error('Buffer sequence mismatch');b.parts.push(${quote(chunk)});return JSON.stringify({chunks:b.parts.length});`);
      if (reply.chunks !== i + 1) throw new Error('Chunk acknowledgement mismatch');
      if ((i + 1) % 20 === 0 || i + 1 === chunks)
        console.log(JSON.stringify(publicReport({ file: report.name, stage: 'transfer_to_page_buffer', chunks: i + 1, total: chunks })));
    }
    exec(`const b=window[${quote(key)}];const s=atob(b.parts.join(''));b.bytes=Uint8Array.from(s,c=>c.charCodeAt(0));b.parts=[];b.state='verifying';crypto.subtle.digest('SHA-256',b.bytes).then(h=>{b.sha256=[...new Uint8Array(h)].map(v=>v.toString(16).padStart(2,'0')).join('');b.state='ready'}).catch(e=>{b.state='error';b.error=String(e)});return JSON.stringify({bytes:b.bytes.length});`);
  let ready;
  for (let attempt = 0; attempt < 20; attempt++) {
    ready = exec(`const b=window[${quote(key)}];return JSON.stringify({state:b.state,bytes:b.bytes?.length,sha256:b.sha256,error:b.error});`);
    if (ready.state !== 'verifying') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  report.transport_result = publicReport(ready);
  if (ready.state !== 'ready' || ready.bytes !== bytes.length || ready.sha256 !== sha256)
    throw new Error('Image byte/hash verification failed before touching the upload control');
  report.byte_integrity_verified_in_page = true;
  report.dispatch_attempted = true;
  report.status = 'dispatch_attempted_result_pending';
  await persist();
  report.dispatched = exec(`const b=window[${quote(key)}];if(b.state!=='ready'||b.sha256!==${quote(sha256)})throw Error('Buffer not verified');const inputs=document.querySelectorAll(${quote(job.fileSelector)});if(inputs.length!==1||inputs[0].disabled)throw Error('Upload control changed');${countGuard}const input=inputs[0];const dt=new DataTransfer();dt.items.add(new File([b.bytes],${quote(report.name)},{type:${quote(mimeType)}}));b.state='dispatching';input.files=dt.files;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));b.state='dispatched';return JSON.stringify({state:b.state,fileCount:input.files.length,names:[...input.files].map(f=>f.name)});`);
  report.status = 'dispatched_wait_for_website_verification';
  await persist();
  if (job.successSelector && job.expectedBeforeCount !== undefined) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const website = exec(`return JSON.stringify({images:[...document.querySelectorAll(${quote(job.successSelector)})].map(e=>{const src=e.currentSrc||e.src;let safeSrc='';try{const u=new URL(src,location.href);safeSrc=u.protocol==='http:'||u.protocol==='https:'?u.origin+u.pathname:u.protocol+'[contents omitted]'}catch{safeSrc='[source omitted]'}return{src:safeSrc,width:e.naturalWidth,height:e.naturalHeight}}),messages:[...document.querySelectorAll('[role=alert],.core-message,.arco-message')].map(e=>e.innerText)});`);
      report.website_result = publicReport(website);
      if (report.website_result.images.length === job.expectedBeforeCount + 1 && report.website_result.images.every(e=>e.width>0&&e.height>0)) {
        report.website_upload_verified = true;
        report.status = 'website_image_control_success_backend_save_pending';
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!report.website_upload_verified) throw new Error('Website upload result not confirmed; inspect before retrying');
  }
} catch (error) {
  blocked = Boolean(error.blocked);
  if (error.confirmationMaterial) report.confirmation_material = error.confirmationMaterial;
  if (error.targetMismatch) {
    report.target_mismatch = error.targetMismatch;
    report.dispatch_result = report.dispatch_attempted ? 'unknown' : 'not_attempted';
  }
  report.status = error.blocked || (report.dispatch_attempted ? 'dispatch_result_unknown_inspect_before_retry' : 'failed_before_dispatch');
  report.error = safeText(error.message);
  report.automatic_retry_allowed = false;
  process.exitCode = 1;
} finally {
  if (bufferCreated && !blocked) {
    try { exec(`delete window[${quote(key)}];return JSON.stringify({temporaryBufferRemoved:true});`); report.buffer_removed = true; }
    catch (error) {
      report.buffer_removed = false;
      report.buffer_cleanup_error = safeText(error.message);
      if (error.confirmationMaterial) report.confirmation_material = error.confirmationMaterial;
      if (error.targetMismatch) report.target_mismatch = error.targetMismatch;
      if (error.blocked) { report.cleanup_blocked = error.blocked; process.exitCode = 1; }
    }
  } else if (bufferCreated) {
    report.buffer_removed = false;
    report.buffer_cleanup_deferred = 'No further page calls after a confirmation, permission, or target mismatch block';
  }
  await persist();
  console.log(JSON.stringify(publicReport(report), null, 2));
}
