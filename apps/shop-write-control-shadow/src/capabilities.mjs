import { ACTIONS, IDENTITY_KEYS, canonicalJson, deepFreeze, exactKeys, fixtureId } from './intents.mjs';
import { requireValue } from './errors.mjs';

const CAPABILITIES = Object.freeze(['read', 'propose', 'approve_fixture', 'claim_fixture']);

// Composition-root configuration only. This is not an authentication endpoint.
export function createAuthority(configuration) {
  canonicalJson(configuration);
  requireValue(Array.isArray(configuration) && configuration.length > 0);
  const configured = new Map();
  const authenticated = new WeakMap();
  for (const input of configuration) {
    exactKeys(input, [...IDENTITY_KEYS, 'capabilities', 'actions', 'sku_ids']);
    requireValue(IDENTITY_KEYS.filter((key) => key !== 'region').every((key) => fixtureId(input[key])));
    requireValue(['MY', 'TH', 'US'].includes(input.region));
    requireValue(!configured.has(input.principal_id));
    requireValue(Array.isArray(input.capabilities) && input.capabilities.length > 0 && input.capabilities.every((cap) => CAPABILITIES.includes(cap)) && new Set(input.capabilities).size === input.capabilities.length);
    requireValue(Array.isArray(input.actions) && input.actions.length > 0 && input.actions.every((action) => ACTIONS.includes(action)) && new Set(input.actions).size === input.actions.length);
    requireValue(Array.isArray(input.sku_ids) && input.sku_ids.every(fixtureId) && new Set(input.sku_ids).size === input.sku_ids.length);
    const copy = deepFreeze(JSON.parse(canonicalJson(input)));
    const identity = deepFreeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, copy[key]])));
    const opaquePrincipal = Object.freeze(Object.create(null));
    authenticated.set(opaquePrincipal, { identity, capabilities: copy.capabilities, actions: copy.actions, sku_ids: copy.sku_ids });
    configured.set(copy.principal_id, opaquePrincipal);
  }
  return Object.freeze({
    principal(trustedPrincipalId) {
      const principal = configured.get(trustedPrincipalId);
      requireValue(principal, 'UNAUTHENTICATED', 401);
      return principal;
    },
    authorize(principal, capability, scope) {
      const trusted = principal && typeof principal === 'object' ? authenticated.get(principal) : undefined;
      requireValue(trusted, 'UNAUTHENTICATED', 401);
      requireValue(trusted.capabilities.includes(capability), 'ACCESS_DENIED', 403);
      if (scope) {
        requireValue(scope.shop_id === trusted.identity.shop_id, 'ACCESS_DENIED', 403);
        if ('action' in scope) requireValue(ACTIONS.includes(scope.action) && trusted.actions.includes(scope.action), 'ACTION_DENIED', 403);
      }
      return trusted.identity;
    },
    authorizeSkus(principal, skuIds) {
      const trusted = principal && typeof principal === 'object' ? authenticated.get(principal) : undefined;
      requireValue(trusted, 'UNAUTHENTICATED', 401);
      requireValue(skuIds.every((id) => trusted.sku_ids.includes(id)), 'TARGET_DENIED', 403);
    }
  });
}
