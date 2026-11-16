import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CREATORS_CONTEXT = Object.freeze({
  module: 'creators', environment: '90000000000001', market: 'MY',
  shopId: '9000000000000000099', shopLabel: '(example-shop-my)',
  taskId: 'creators-PERF-CRE-001-20261017',
  host: 'affiliate.tiktokshopglobalselling.com',
  pathname: '/affiliate/sample/sample-request',
});
export const RELEASE_FILE = 'outputs/ads-monitoring/2026-10-19/recovery-1832/release-readonly-v7.json';
const GATEWAY_FILE = 'scripts/ziniao-eco-gateway.mjs';
const PINNED_GATEWAY_SHA = '32a3652906df661b3bf83481f452cbf10f9c914755f83a70075dce23bdf8daf2';
const PINNED_TEST_SHA = '6a2dc5641b060e96307d4a6cc84cbfacc4d826ce8c083d7fd3feffb098b58b7c';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const parse = data => JSON.parse(data.toString().replace(/^\uFEFF/, ''));
const readJSON = async file => parse(await fs.readFile(file));
function inside(root, file) {
  if (typeof file !== 'string' || !file) throw Error('WorkspaceEvidencePathRequired');
  const resolved = path.resolve(root, file), rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('WorkspaceEvidencePathRequired');
  return resolved;
}
function exactURL(value) {
  try {
    const u = new URL(value), c = CREATORS_CONTEXT;
    return u.protocol === 'https:' && u.hostname === c.host && u.pathname === c.pathname &&
      ['shop_region', 'shop_id'].every(k => u.searchParams.getAll(k).length === 1) &&
      u.searchParams.get('shop_region') === c.market && u.searchParams.get('shop_id') === c.shopId;
  } catch { return false; }
}
export async function verifyFrozenRelease(root = ROOT) {
  const release = await readJSON(path.join(root, RELEASE_FILE));
  if (release.release !== 'readonly-v7-frozen') throw Error('ReviewedFrozenReleaseRequired');
  const files = release.files;
  if (!Array.isArray(files) || files.find(x => x.path === GATEWAY_FILE)?.sha256 !== PINNED_GATEWAY_SHA ||
      files.find(x => x.path === 'scripts/ziniao-eco-gateway.test.mjs')?.sha256 !== PINNED_TEST_SHA)
    throw Error('ReviewedReleasePinMismatch');
  for (const file of files) {
    if (sha(await fs.readFile(inside(root, file.path))) !== file.sha256) throw Error('FrozenReleaseFileMismatch:' + file.path);
  }
  return {release: release.release, gateway: GATEWAY_FILE, gatewaySha256: PINNED_GATEWAY_SHA,
    supportedHosts: ['seller.tiktokshopglobalselling.com'], source: RELEASE_FILE};
}
export async function assessCreatorsIdentity(root, registry, now = new Date()) {
  const c = CREATORS_CONTEXT;
  const bindings = registry.bindings?.filter(x => x.module === c.module && x.environment_id === c.environment) ?? [];
  if (bindings.length !== 1) return {ready: false, reason: 'CreatorsBindingMissingOrAmbiguous'};
  const b = bindings[0], e = b.eco_binding;
  if (!e?.task_id || !e.window_name) return {ready: false, reason: 'RegisteredOriginalContextMissing'};
  if (e.task_id !== c.taskId || !/^codex-creators-[a-z0-9_-]+$/.test(e.window_name))
    return {ready: false, reason: 'OriginalCreatorsContextMismatch'};
  if (b.market !== c.market || b.shop_id !== c.shopId || e.market !== c.market ||
      e.shop_id !== c.shopId || e.shop_label !== c.shopLabel || !exactURL(e.last_observed_url))
    return {ready: false, reason: 'ExactCreatorsMarketShopRouteRequired'};
  if (e.identity_verified !== true || !e.current_page_evidence || !/^[a-f0-9]{64}$/.test(e.current_page_evidence_sha256 ?? ''))
    return {ready: false, reason: 'VerifiedCreatorsIdentityEvidenceRequired'};
  let evidence;
  try {
    const bytes = await fs.readFile(inside(root, e.current_page_evidence));
    if (sha(bytes) !== e.current_page_evidence_sha256) return {ready: false, reason: 'CreatorsIdentityEvidenceHashMismatch'};
    evidence = parse(bytes);
  } catch { return {ready: false, reason: 'CreatorsIdentityEvidenceUnreadable'}; }
  const i = evidence.identity, observed = Date.parse(evidence.observed_at);
  if (!Number.isFinite(observed) || observed > +now || +now - observed > 24 * 60 * 60 * 1000)
    return {ready: false, reason: 'FreshCreatorsIdentityEvidenceRequired'};
  if (evidence.module !== c.module || evidence.environment_id !== c.environment || evidence.task_id !== c.taskId ||
      i?.ok !== true || i.name !== e.window_name || !exactURL(i.url) ||
      i.market !== c.market || i.shop_id !== c.shopId || i.shop_label !== c.shopLabel)
    return {ready: false, reason: 'CreatorsIdentityEvidenceScopeMismatch'};
  return {ready: true, evidence: e.current_page_evidence, config: {
    taskId: c.taskId, windowName: e.window_name, market: c.market, shopLabel: c.shopLabel,
    path: c.pathname, query: {shop_region: c.market, shop_id: c.shopId},
  }};
}
export async function creatorsPreflight({root = ROOT, now = new Date()} = {}) {
  const release = await verifyFrozenRelease(root);
  const registry = await readJSON(path.join(root, 'operations/browser-module-targets.json'));
  const identity = await assessCreatorsIdentity(root, registry, now);
  const reasons = [];
  if (!identity.ready) reasons.push(identity.reason);
  // Frozen v5 hard-codes the seller host. Never rewrite it or silently route creators to the seller homepage.
  if (!release.supportedHosts.includes(CREATORS_CONTEXT.host)) reasons.push('FrozenV5AffiliateHostUnsupported');
  return {module: CREATORS_CONTEXT.module, ready: reasons.length === 0, reasons, release, identity,
    originalTaskId: CREATORS_CONTEXT.taskId, gatewayDispatched: false, browserCalls: 0};
}
function validateRequest(request) {
  if (!request || Object.keys(request).some(k => !['operation', 'sectionId'].includes(k)) ||
      !['identity', 'snapshot'].includes(request.operation)) throw Error('FixedCreatorsReadonlyOperationRequired');
  if (!/^creators-[a-z0-9][a-z0-9_-]{0,80}$/.test(request.sectionId ?? '')) throw Error('UniqueCreatorsSectionIdRequired');
}
export async function runCreatorsReadonly(request, {root = ROOT, now = new Date(), gatewayFactory} = {}) {
  validateRequest(request);
  const preflight = await creatorsPreflight({root, now});
  if (!preflight.ready) throw Error('CreatorsGatewayPreflightRejected:' + preflight.reasons.join(','));
  // Import only after local integrity and identity checks; no direct child_process / CLI route exists in this adapter.
  const create = gatewayFactory ?? (async options => {
    const {EcoGateway} = await import(pathToFileURL(path.join(root, GATEWAY_FILE)).href);
    return new EcoGateway(options);
  });
  const gateway = await create({root, configs: {creators: preflight.identity.config}});
  return gateway.section({module: 'creators', sectionId: request.sectionId, waitMs: 20000}, async session => {
    if (request.operation === 'identity') return {operation: 'identity', identity: session.identity};
    const read = await session.call('creators-snapshot', {action: 'snapshot', params: {interactive: true}}, {effect: 'read'});
    return {operation: 'snapshot', identity: session.identity, read};
  });
}
async function main(args) {
  if (args.length === 1 && args[0] === 'preflight') {
    const result = await creatorsPreflight();
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ready ? 0 : 2;
    return;
  }
  if (args.length !== 2) throw Error('Usage: preflight | identity UNIQUE_SECTION_ID | snapshot UNIQUE_SECTION_ID');
  process.stdout.write(JSON.stringify(await runCreatorsReadonly({operation: args[0], sectionId: args[1]})) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({ok: false, error: error.message}) + '\n'); process.exitCode = 1; });
