import { open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const owners = {
  controller: '00000000-0000-4000-8000-000000000001',
  selection: '00000000-0000-4000-8000-000000000002',
  listing: '00000000-0000-4000-8000-000000000003',
  production: '00000000-0000-4000-8000-000000000004',
  publishing: '00000000-0000-4000-8000-000000000005',
  promotion: '00000000-0000-4000-8000-000000000006',
  fulfillment: '00000000-0000-4000-8000-000000000007',
  ads: '00000000-0000-4000-8000-000000000008',
  service: '00000000-0000-4000-8000-000000000009',
};
const eventTypes = { task_started: 'started', task_complete: 'ended', turn_aborted: 'interrupted' };
const chunkSize = 512 * 1024;
const tailLimit = 32 * 1024 * 1024;

async function lastEvent(path, size) {
  if (!size) return null;
  const limit = Math.max(0, size - tailLimit);
  const handle = await open(path, 'r');
  try {
    let pending = Buffer.alloc(0);
    let latest;
    function addEvent(event) {
      if (!event) return false;
      latest ??= event;
      if (!latest.turnId) return true;
      if (event.state !== 'started' || event.turnId !== latest.turnId) return false;
      latest.trigger = event.trigger;
      return true;
    }
    function result() {
      if (!latest) return null;
      const { state, at, trigger } = latest;
      return { state, at, ...(trigger ? { trigger } : {}) };
    }
    for (let end = size; end > limit;) {
      const start = Math.max(limit, end - chunkSize);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(end - start), 0, end - start, start);
      const bytes = Buffer.concat([buffer.subarray(0, bytesRead), pending]);
      let lineEnd = bytes.length;
      for (let newline = bytes.lastIndexOf(10, lineEnd - 1); newline >= 0;) {
        const line = bytes.toString('utf8', newline + 1, lineEnd);
        if (addEvent(parseRunEvent(line))) return result();
        lineEnd = newline;
        newline = lineEnd > 0 ? bytes.lastIndexOf(10, lineEnd - 1) : -1;
      }
      pending = bytes.subarray(0, lineEnd);
      end = start;
    }
    if (limit === 0) addEvent(parseRunEvent(pending.toString('utf8')));
    return result();
  } finally {
    await handle.close();
  }
}

function parseRunEvent(line) {
  if (line.includes('"event_msg"')) {
    try {
      const entry = JSON.parse(line);
      const state = eventTypes[entry.payload?.type];
      if (entry.type === 'event_msg' && state && Number.isFinite(Date.parse(entry.timestamp))) {
        return { state, at: entry.timestamp, turnId: entry.payload.turn_id,
          trigger: entry.payload.turn_attribution?.turn_trigger };
      }
    } catch {
      // A writer can leave the last line incomplete until its next write.
    }
  }
  return null;
}

export function createRunEvidence(scheduleDirectory) {
  const databaseFile = join(dirname(scheduleDirectory), 'state_5.sqlite');
  const cache = new Map();
  let paths;
  let pathsReadAt = 0;

  return async function readRuns() {
    if (Date.now() - pathsReadAt > 60_000) {
      pathsReadAt = Date.now();
      try {
        await stat(databaseFile);
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(databaseFile, { readOnly: true });
        try {
          const find = db.prepare('SELECT rollout_path FROM threads WHERE id = ?');
          paths = Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, find.get(owner)?.rollout_path]));
        } finally {
          db.close();
        }
      } catch {
        paths = undefined;
      }
    }
    if (!paths) return {};
    const results = await Promise.all(Object.entries(paths).filter(([, path]) => path).map(async ([id, path]) => {
      try {
        const info = await stat(path);
        const existing = cache.get(id);
        if (existing?.size === info.size && existing.mtime === info.mtimeMs && existing.path === path) return [id, existing.event];
        const event = await lastEvent(path, info.size);
        cache.set(id, { path, event, size: info.size, mtime: info.mtimeMs });
        return [id, event];
      } catch {
        return [id, null];
      }
    }));
    return Object.fromEntries(results);
  };
}
