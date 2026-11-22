// Stable public errors intentionally contain no request, credential or DB details.
export class ShadowError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'ShadowError';
    this.status = status;
    this.code = code;
  }
}
export function fail(status, code) { throw new ShadowError(status, code); }
export function requireValue(condition, code = 'INVALID_REQUEST', status = 400) {
  if (!condition) fail(status, code);
}
