import { appendFileSync } from 'node:fs';
import { createAuthority } from '../src/capabilities.mjs';
import { WriteStore } from '../src/write-store.mjs';
import { config } from './fixtures.mjs';

const [file, counter, mode] = process.argv.slice(2);
const authority = createAuthority(config);
const store = new WriteStore({ file, authority, clock: () => new Date('2026-11-22T12:00:00.000Z') });
process.send({ ready: true });
process.once('message', (input) => {
  try {
    const result = store.claimFixture(authority.principal('fixture_author'), input);
    if (result.claimed && mode === 'crash') process.exit(19);
    if (result.claimed) appendFileSync(counter, 'fixture-send\n');
    process.send({ claimed: result.claimed });
    store.close();
    process.disconnect();
  } catch (error) {
    process.send({ error: error.code ?? 'UNEXPECTED' });
    store.close();
    process.disconnect();
  }
});
