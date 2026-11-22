const shopScope = {
  tenant_id: 'fixture_demo_tenant', grant_id: 'fixture_demo_grant', service_id: 'fixture_demo_service',
  shop_id: 'fixture_demo_shop', region: 'MY', actions: ['listing.create', 'promotion.configure'],
  sku_ids: ['fixture_demo_existing_sku']
};
export const fixtureConfiguration = [
  { ...shopScope, principal_id: 'fixture_demo_author', capabilities: ['read', 'propose', 'claim_fixture'] },
  { ...shopScope, principal_id: 'fixture_demo_approver', capabilities: ['read', 'approve_fixture'] },
  { ...shopScope, principal_id: 'fixture_demo_reader', capabilities: ['read'] }
];
