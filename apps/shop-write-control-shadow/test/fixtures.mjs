import { createHash } from 'node:crypto';

export const binding = { tenant_id: 'fixture_tenant_a', grant_id: 'fixture_grant_a', service_id: 'fixture_service_a', shop_id: 'fixture_shop_a', region: 'MY' };
export const config = [
  { principal_id: 'fixture_author', ...binding, capabilities: ['read', 'propose', 'claim_fixture'], actions: ['listing.create', 'promotion.configure'] },
  { principal_id: 'fixture_approver', ...binding, capabilities: ['read', 'approve_fixture'], actions: ['listing.create', 'promotion.configure'] },
  { principal_id: 'fixture_readonly', ...binding, capabilities: ['read'], actions: ['listing.create', 'promotion.configure'] },
  { principal_id: 'fixture_other', ...binding, capabilities: ['read', 'propose', 'claim_fixture'], actions: ['listing.create'] },
  { principal_id: 'fixture_foreign', ...binding, tenant_id: 'fixture_tenant_b', grant_id: 'fixture_grant_b', shop_id: 'fixture_shop_b', capabilities: ['read', 'propose', 'approve_fixture', 'claim_fixture'], actions: ['listing.create'] },
  { principal_id: 'fixture_same_shop_foreign', ...binding, tenant_id: 'fixture_tenant_b', grant_id: 'fixture_grant_b', capabilities: ['read', 'approve_fixture'], actions: ['listing.create'] }
].map((principal) => ({ ...principal, sku_ids: principal.shop_id === 'fixture_shop_a' ? ['fixture_sku_one', 'fixture_sku_two'] : ['fixture_sku_foreign'] }));
export function proposal(suffix = '1') {
  return { request_id: `fixture_author:fixture_request_${suffix}`, shop_id: 'fixture_shop_a', action: 'listing.create', listing: { client_sku: 'fixture_sku_new', quantity: 2, currency: 'MYR', amount: '12.30' } };
}
export function promotion(suffix = 'promo') {
  return { request_id: `fixture_author:fixture_request_${suffix}`, shop_id: 'fixture_shop_a', action: 'promotion.configure', items: [{ sku_id: 'fixture_sku_one', quantity: 1 }, { sku_id: 'fixture_sku_two', quantity: 3 }], currency: 'MYR', amount: '8.00' };
}
export function approval(record) {
  return { request_id: record.request_id, shop_id: record.identity.shop_id, intent_hash: record.intent_hash, intent: record.intent, authority_ref: 'fixture://approval/manual-001', fixture_only: true };
}
export function claimInput(record) {
  return { request_id: record.request_id, shop_id: record.identity.shop_id, provider_id: 'fixture_provider', provider_request_id: `fixture_provider_request_${record.request_id.split('_').at(-1)}`, object_id: 'fixture_object_001' };
}
export function proofFor(query, canonical, observedAt = '2026-11-22T12:00:00.000Z') {
  const observation = { fixture_only: true, outcome: 'FIXTURE_CONFIRMED', ...query };
  return { fixture_only: true, observed_at: observedAt, evidence_ref: 'fixture://evidence/read-001', observation, evidence_sha256: createHash('sha256').update(canonical({ observed_at: observedAt, observation })).digest('hex') };
}
