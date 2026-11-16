// Compatibility entry for actor-specific read-only preflight tests.
import { createCliTransport as base } from './ziniao-eco-gateway.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export function createCliTransport(options = {}) { return base({ ...options, root: options.root ?? root }); }
