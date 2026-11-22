const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function opaqueToken() { return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function constantTimeEqual(a, b) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [left, right] = await Promise.all([digest(a), digest(b)]); let difference = 0;
  for (let i = 0; i < 32; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function keyFrom(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('invalid_vault_configuration');
  const raw = unb64(value); if (raw.length !== 32) throw new Error('invalid_vault_configuration');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, vaultKey, identity) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(canonical(identity)) }, await keyFrom(vaultKey), encoder.encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) });
}
export async function unseal(value, vaultKey, identity) {
  const envelope = JSON.parse(value); if (envelope.v !== 1) throw new Error('invalid_vault_record');
  return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: encoder.encode(canonical(identity)) }, await keyFrom(vaultKey), unb64(envelope.ciphertext))));
}
