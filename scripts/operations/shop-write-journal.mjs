import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function shopWriteJournal(directory) {
  async function read(name) {
    try { return JSON.parse(await readFile(join(directory, name + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function record(name, value) {
    await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }

  async function writeOnce(name, intent, send) {
    const previous = await read(name + '.result');
    if (previous) {
      const original = await read(name + '.intent');
      if (!original) throw new Error(name + ' has a result without the original request');
      const { at, ...originalIntent } = original;
      if (JSON.stringify(originalIntent) !== JSON.stringify(intent)) {
        throw new Error(name + ' has a result for a different request');
      }
      if (previous.httpStatus >= 200 && previous.httpStatus < 300 && previous.code === 0 && previous.data) return previous.data;
      throw new Error(name + ' has a recorded result requiring review');
    }
    await record(name + '.intent', { at: new Date().toISOString(), ...intent });
    let response;
    try { response = await send(); }
    catch (error) {
      await record(name + '.transport', { at: new Date().toISOString(), outcome: 'UNKNOWN', error: error.cause?.code ?? error.name });
      throw new Error(name + ' outcome unknown. Check the original request before continuing.');
    }
    const envelope = await response.json().catch(() => null);
    await record(name + '.result', { at: new Date().toISOString(), httpStatus: response.status, code: envelope?.code ?? null,
      requestId: envelope?.request_id ?? null, message: envelope?.message ?? null, data: envelope?.data ?? null });
    if (!response.ok || envelope?.code !== 0 || !envelope?.data) {
      throw new Error(`${name} HTTP ${response.status}, code ${envelope?.code ?? 'unknown'}`);
    }
    return envelope.data;
  }

  return { read, record, writeOnce };
}
