import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CREATORS_CONTEXT as c, RELEASE_FILE, assessCreatorsIdentity, creatorsPreflight, runCreatorsReadonly} from './creators-eco-readonly.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = new Date('2026-10-19T12:00:00+08:00');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creators-adapter-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const evidence = {module: c.module, environment_id: c.environment, task_id: c.taskId,
    observed_at: '2026-10-19T11:00:00+08:00', identity: {ok: true, name: 'codex-creators-fixture',
      url: `https://${c.host}${c.pathname}?shop_region=MY&shop_id=${c.shopId}`,
      market: c.market, shop_id: c.shopId, shop_label: c.shopLabel}};
  const bytes = JSON.stringify(evidence);
  await fs.writeFile(path.join(root, 'identity.json'), bytes);
  const binding = {module: c.module, environment_id: c.environment, market: c.market, shop_id: c.shopId,
    eco_binding: {task_id: c.taskId, window_name: evidence.identity.name, market: c.market,
      shop_id: c.shopId, shop_label: c.shopLabel, last_observed_url: evidence.identity.url,
      identity_verified: true, current_page_evidence: 'identity.json', current_page_evidence_sha256: sha(bytes)}};
  return {root, registry: {bindings: [binding]}, binding, evidence};
}
async function copyRelease(root) {
  const release = JSON.parse(await fs.readFile(path.join(ROOT, RELEASE_FILE), 'utf8'));
  for (const file of [RELEASE_FILE, ...release.files.map(x => x.path)]) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), {recursive: true});
    if (file === RELEASE_FILE) await fs.copyFile(path.join(ROOT, file), target);
    else {
      // Test the independently archived frozen release, not a mutable working copy.
      const expected = release.files.find(x => x.path === file);
      const archive = path.join(ROOT, 'outputs/creator-ops-2026-10-19/gateway-v5-frozen-source-snapshots',
        expected.sha256.slice(0, 12) + '-' + path.basename(file));
      const bytes = await fs.readFile(archive);
      assert.equal(sha(bytes), expected.sha256, 'Archived frozen fixture must match the declared release');
      await fs.writeFile(target, bytes);
    }
  }
}
async function writeRegistry(f) {
  const target = path.join(f.root, 'operations/browser-module-targets.json');
  await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, JSON.stringify(f.registry));
}
test('missing registered context rejects before any gateway factory or browser dispatch', async t => {
  const f = await fixture(t); delete f.binding.eco_binding; await copyRelease(f.root); await writeRegistry(f);
  let dispatches = 0;
  await assert.rejects(runCreatorsReadonly({operation: 'snapshot', sectionId: 'creators-local-missing'},
    {root: f.root, now: NOW, gatewayFactory: async () => { dispatches++; throw Error('MustNotDispatch'); }}), /RegisteredOriginalContextMissing/);
  assert.equal(dispatches, 0);
});
test('even a fully registered synthetic affiliate identity is blocked by frozen seller-only v5', async t => {
  const f = await fixture(t); await copyRelease(f.root); await writeRegistry(f);
  const result = await creatorsPreflight({root: f.root, now: NOW});
  assert.equal(result.identity.ready, true); assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['FrozenV5AffiliateHostUnsupported']); assert.equal(result.browserCalls, 0);
});
test('original task, exact shop and market cannot be replaced by another module', async t => {
  const f = await fixture(t);
  f.binding.eco_binding.task_id = 'procurement-fulfillment-recovery-1908';
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'OriginalCreatorsContextMismatch');
  f.binding.eco_binding.task_id = c.taskId; f.binding.eco_binding.shop_id = '9000000000000000101';
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'ExactCreatorsMarketShopRouteRequired');
  f.binding.eco_binding.shop_id = c.shopId; f.binding.eco_binding.last_observed_url += '&shop_region=MY';
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'ExactCreatorsMarketShopRouteRequired');
});
test('evidence hash and exact owner are checked independently of registry labels', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'identity.json'), '{}');
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'CreatorsIdentityEvidenceHashMismatch');
  f.evidence.identity.name = 'codex-procurement-fulfillment-20261018';
  const bytes = JSON.stringify(f.evidence); await fs.writeFile(path.join(f.root, 'identity.json'), bytes);
  f.binding.eco_binding.current_page_evidence_sha256 = sha(bytes);
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'CreatorsIdentityEvidenceScopeMismatch');
});
test('expired evidence and ambiguous module bindings do not authorize live recovery', async t => {
  const f = await fixture(t);
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, new Date('2026-10-21T12:00:00+08:00'))).reason, 'FreshCreatorsIdentityEvidenceRequired');
  f.registry.bindings.push(f.binding);
  assert.equal((await assessCreatorsIdentity(f.root, f.registry, NOW)).reason, 'CreatorsBindingMissingOrAmbiguous');
});
test('write, arbitrary evaluate, raw CLI arguments and context overrides are rejected before file access', async () => {
  for (const request of [
    {operation: 'evaluate', sectionId: 'creators-bad'},
    {operation: 'snapshot', sectionId: 'creators-bad', task_id: 'replacement'},
    {operation: 'snapshot', sectionId: 'creators-bad', arguments: ['browser', 'open']},
    {operation: 'identity', sectionId: '../repeat'},
  ]) await assert.rejects(runCreatorsReadonly(request, {root: path.join(os.tmpdir(), 'nonexistent-creators-fixture')}),
    /FixedCreatorsReadonlyOperationRequired|UniqueCreatorsSectionIdRequired/);
});
test('frozen gateway drift stops preflight before registration or network activity', async t => {
  const f = await fixture(t); await copyRelease(f.root); await writeRegistry(f);
  await fs.appendFile(path.join(f.root, 'scripts/ziniao-eco-gateway.mjs'), '\n// fixture drift\n');
  await assert.rejects(creatorsPreflight({root: f.root, now: NOW}), /FrozenReleaseFileMismatch:scripts\/ziniao-eco-gateway/);
});
