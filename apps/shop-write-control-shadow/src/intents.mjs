import { createHash } from 'node:crypto';
import { requireValue } from './errors.mjs';

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
export const ACTIONS = Object.freeze(['listing.create', 'promotion.configure']);
export const IDENTITY_KEYS = Object.freeze(['principal_id', 'tenant_id', 'grant_id', 'service_id', 'shop_id', 'region']);

export function canonicalJson(value) {
  const active = new Set();
  let nodes = 0;
  function visit(item, depth) {
    requireValue(++nodes <= 10000 && depth <= 30);
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') { requireValue(item.length <= 16384); return JSON.stringify(item); }
    if (typeof item === 'number') { requireValue(Number.isSafeInteger(item) && !Object.is(item, -0)); return String(item); }
    requireValue(typeof item === 'object' && !active.has(item));
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      requireValue(Object.getPrototypeOf(item) === Array.prototype && item.length <= 1000);
      const keys = Reflect.ownKeys(item);
      requireValue(keys.length === item.length + 1 && keys.at(-1) === 'length');
      result = '[' + Array.from({ length: item.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        requireValue(descriptor && 'value' in descriptor && descriptor.enumerable);
        return visit(descriptor.value, depth + 1);
      }).join(',') + ']';
    } else {
      requireValue(Object.getPrototypeOf(item) === Object.prototype);
      const keys = Reflect.ownKeys(item);
      requireValue(keys.every((key) => typeof key === 'string' && !forbiddenKeys.has(key)));
      result = '{' + keys.sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireValue(descriptor && 'value' in descriptor && descriptor.enumerable);
        return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(item);
    return result;
  }
  return visit(value, 0);
}

export function hashCanonical(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function exactKeys(value, expected) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Object.keys(value).sort();
  requireValue(keys.length === expected.length && keys.every((key, i) => key === [...expected].sort()[i]));
}
export function fixtureId(value) { return typeof value === 'string' && /^fixture_[A-Za-z0-9_-]{1,90}$/.test(value); }
export function requestId(value) { return typeof value === 'string' && /^fixture_[A-Za-z0-9_-]{1,90}:fixture_[A-Za-z0-9_-]{1,100}$/.test(value); }
export function fixtureRef(value) { return typeof value === 'string' && /^fixture:\/\/[a-z][a-z0-9-]*\/[A-Za-z0-9_/-]{1,160}$/.test(value); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function normalizeIntent(authority, principal, request) {
  const identity = authority.authorize(principal, 'propose');
  canonicalJson(request);
  requireValue(request && Object.getPrototypeOf(request) === Object.prototype);
  authority.authorize(principal, 'propose', { shop_id: request.shop_id, action: request.action });
  requireValue(requestId(request.request_id));
  requireValue(request.request_id.startsWith(identity.principal_id + ':'), 'ACCESS_DENIED', 403);
  const currency = { MY: 'MYR', TH: 'THB', US: 'USD' }[identity.region];
  function quantity(value) { requireValue(Number.isSafeInteger(value) && value > 0 && value <= 1000000); }
  function money(amount, givenCurrency) {
    requireValue(givenCurrency === currency && typeof amount === 'string' && /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(amount) && amount !== '0.00');
  }
  if (request.action === 'listing.create') {
    exactKeys(request, ['request_id', 'shop_id', 'action', 'listing']);
    exactKeys(request.listing, ['client_sku', 'quantity', 'currency', 'amount']);
    requireValue(fixtureId(request.listing.client_sku));
    quantity(request.listing.quantity);
    money(request.listing.amount, request.listing.currency);
  } else {
    exactKeys(request, ['request_id', 'shop_id', 'action', 'items', 'currency', 'amount']);
    requireValue(Array.isArray(request.items) && request.items.length > 0 && request.items.length <= 100);
    const unique = new Set();
    for (const item of request.items) {
      exactKeys(item, ['sku_id', 'quantity']);
      requireValue(fixtureId(item.sku_id) && !unique.has(item.sku_id));
      unique.add(item.sku_id); quantity(item.quantity);
    }
    authority.authorizeSkus(principal, request.items.map((item) => item.sku_id));
    money(request.amount, request.currency);
  }
  // Identity is copied only from the authority, never from the request.
  const intent = { fixture_only: true, identity, ...JSON.parse(canonicalJson(request)) };
  const intent_json = canonicalJson(intent);
  return deepFreeze({ intent, intent_json, intent_hash: sha256(intent_json) });
}
