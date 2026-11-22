import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createAuthority } from '../src/capabilities.mjs';
import { canonicalJson, sha256 } from '../src/intents.mjs';
import { WriteStore } from '../src/write-store.mjs';
import { projectTask } from '../src/task-view.mjs';
import { fixtureConfiguration } from './fixture-config.mjs';

// This script performs no network operation. Its only send is an integer increment.
const directory = mkdtempSync(join(tmpdir(), 'fixture-shadow-demo-'));
const authority = createAuthority(fixtureConfiguration);
const author = authority.principal('fixture_demo_author');
const approver = authority.principal('fixture_demo_approver');
let fakeSendCount = 0;
let fixtureObserved = false;
const store = new WriteStore({ file: join(directory, 'demo.sqlite'), authority, readFixture: async (query) => {
  if (!fixtureObserved) return null;
  const observed_at = new Date().toISOString();
  const observation = { fixture_only: true, outcome: 'FIXTURE_CONFIRMED', ...query };
  return { fixture_only: true, observed_at, observation, evidence_ref: 'fixture://demo/read-001', evidence_sha256: sha256(canonicalJson({ observed_at, observation })) };
} });
try {
  const proposed = store.propose(author, {
    request_id: 'fixture_demo_author:fixture_demo_request', shop_id: 'fixture_demo_shop', action: 'listing.create',
    listing: { client_sku: 'fixture_demo_new_sku', quantity: 2, currency: 'MYR', amount: '12.30' }
  });
  const approved = store.approveFixture(approver, {
    request_id: proposed.request_id, shop_id: 'fixture_demo_shop', intent_hash: proposed.intent_hash, intent: proposed.intent,
    authority_ref: 'fixture://demo/manual-approval-001', fixture_only: true
  });
  const claimInput = { request_id: approved.request_id, shop_id: 'fixture_demo_shop', provider_id: 'fixture_demo_provider', provider_request_id: 'fixture_demo_provider_request', object_id: 'fixture_demo_listing_object' };
  const once = store.claimFixture(author, claimInput);
  if (once.claimed) fakeSendCount += 1;
  const reconcileInput = { request_id: approved.request_id, shop_id: 'fixture_demo_shop', claim_token: once.claim_token };
  const unknown = await store.reconcileFixture(author, reconcileInput);
  fixtureObserved = true;
  const verified = await store.reconcileFixture(author, reconcileInput);
  const replay = store.claimFixture(author, claimInput);
  if (replay.claimed) fakeSendCount += 1;
  console.log(JSON.stringify({
    label: '仅离线 fixture 样例；没有真实上架、促销或发布', fixtureOnly: true, fakeSendCount,
    stages: [{ step: 'proposal', task: projectTask(proposed) }, { step: 'fixture approval', task: projectTask(approved) },
      { step: 'single fake claim, absent read evidence', task: projectTask(unknown) }, { step: 'exact fixture read reconciliation', task: projectTask(verified) }]
  }, null, 2));
} finally {
  store.close();
  const absolute = resolve(directory);
  if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe temporary directory');
  rmSync(absolute, { recursive: true, force: true });
}
