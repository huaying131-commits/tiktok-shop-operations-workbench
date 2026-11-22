import { canonicalJson, exactKeys, fixtureRef, sha256 } from './intents.mjs';

// The readFixture function is trusted, server-configured fixture infrastructure.
// Errors/absent/invalid observations never produce a success or writer callback.
export async function readFixtureProof(readFixture, query, { now, claimedAt, maxAgeMs = 60000 }) {
  try {
    const proof = await readFixture(query);
    canonicalJson(proof);
    exactKeys(proof, ['fixture_only', 'observed_at', 'evidence_ref', 'evidence_sha256', 'observation']);
    if (proof.fixture_only !== true || !fixtureRef(proof.evidence_ref)) return null;
    if (typeof proof.observed_at !== 'string') return null;
    const observed = Date.parse(proof.observed_at);
    if (!Number.isFinite(observed) || new Date(observed).toISOString() !== proof.observed_at) return null;
    const checkedAt = now();
    if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) return null;
    if (observed < Date.parse(claimedAt) || observed < checkedAt.getTime() - maxAgeMs || observed > checkedAt.getTime()) return null;
    const expected = { fixture_only: true, outcome: 'FIXTURE_CONFIRMED', ...query };
    if (canonicalJson(proof.observation) !== canonicalJson(expected)) return null;
    const expectedHash = sha256(canonicalJson({ observed_at: proof.observed_at, observation: proof.observation }));
    if (proof.evidence_sha256 !== expectedHash) return null;
    return { evidence_ref: proof.evidence_ref, evidence_sha256: proof.evidence_sha256, observed_at: proof.observed_at };
  } catch {
    return null;
  }
}
