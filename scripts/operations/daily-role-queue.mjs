import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const timeZone = 'Asia/Shanghai';
const openingHour = 8;
const leaseMs = 20 * 60_000;
const tasksPerModule = 250;
const moduleRoles = {
  replenishment: new Set(['procurement']),
  creative: new Set(['video-production', 'video-publishing', 'ads-analysis']),
};
const allowedRoles = new Set(Object.values(moduleRoles).flatMap(roles => [...roles]));
const scheduleClock = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric',
  month: '2-digit', day: '2-digit', hour: '2-digit' });

export const defaultDailyRoleQueueDir = join(projectRoot, 'apps/customer-service/data/operations-role-queue');

function openWriter(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS daily_runs (
        day TEXT NOT NULL, module TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
        next_run_at TEXT, lease_id TEXT, lease_until TEXT, error TEXT, updated_at TEXT NOT NULL,
        summary TEXT, sources TEXT, PRIMARY KEY (day, module)
      );
      CREATE TABLE IF NOT EXISTS daily_tasks (
        module TEXT NOT NULL, task_key TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL, priority TEXT NOT NULL, state TEXT NOT NULL, first_day TEXT NOT NULL,
        last_day TEXT NOT NULL, source_ref TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (module, task_key)
      );
      CREATE TABLE IF NOT EXISTS role_deliveries (
        role TEXT NOT NULL, signature TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (role, signature)
      );`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizeFirstRunKeys(db) {
  transaction(db, () => {
    db.exec(`UPDATE daily_tasks SET state='queued' WHERE module='replenishment' AND state='approval'
      AND task_key LIKE 'replenishment:unmapped:%';
      UPDATE daily_tasks AS task SET task_key=replace(task_key,'creative:corroborate:','creative:single-opening-variable:')
      WHERE module='creative' AND task_key LIKE 'creative:corroborate:%' AND NOT EXISTS (
        SELECT 1 FROM daily_tasks newer WHERE newer.module=task.module AND
        newer.task_key=replace(task.task_key,'creative:corroborate:','creative:single-opening-variable:'));
      UPDATE daily_tasks SET state='superseded' WHERE module='creative' AND task_key LIKE 'creative:corroborate:%';`);
  });
}

function claim(db, day, module, timestamp) {
  const observedAt = timestamp.toISOString();
  return transaction(db, () => {
    const prior = db.prepare('SELECT * FROM daily_runs WHERE day = ? AND module = ?').get(day, module);
    if (prior?.state === 'done' || prior?.next_run_at > observedAt || prior?.lease_until > observedAt) return null;
    const otherRun = db.prepare(`SELECT 1 FROM daily_runs WHERE module = ? AND lease_until > ? LIMIT 1`).get(module, observedAt);
    if (otherRun) return null;
    const lease = { id: randomUUID(), attempts: (prior?.attempts ?? 0) + 1 };
    db.prepare(`INSERT INTO daily_runs (day,module,state,attempts,lease_id,lease_until,updated_at)
      VALUES (?,?,'running',?,?,?,?) ON CONFLICT (day,module) DO UPDATE SET state='running',attempts=excluded.attempts,
      next_run_at=NULL,lease_id=excluded.lease_id,lease_until=excluded.lease_until,error=NULL,updated_at=excluded.updated_at`)
      .run(day, module, lease.attempts, lease.id, new Date(timestamp.getTime() + leaseMs).toISOString(), observedAt);
    return lease;
  });
}

function checkedResult(module, result) {
  if (!Array.isArray(result?.tasks) || result.tasks.length > tasksPerModule || !Array.isArray(result?.sources) ||
      !result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) throw new Error('Invalid collector output');
  const seen = new Set();
  for (const task of result.tasks) {
    if (!task?.key || typeof task.key !== 'string' || task.key.length > 250 || seen.has(task.key) ||
        !moduleRoles[module].has(task.role) || typeof task.title !== 'string' || !task.title || task.title.length > 300 ||
        (typeof task.detail !== 'string' && (!task.detail || typeof task.detail !== 'object')) ||
        !['urgent', 'normal'].includes(task.priority) || (task.sourceRef != null && typeof task.sourceRef !== 'string') ||
        (task.state != null && (task.role !== 'procurement' || !['approval', 'queued'].includes(task.state)))) {
      throw new Error('Invalid role task');
    }
    seen.add(task.key);
  }
  return result;
}

function complete(db, day, module, lease, result, observedAt) {
  transaction(db, () => {
    const written = db.prepare(`UPDATE daily_runs SET state='done', lease_id=NULL, lease_until=NULL, error=NULL,
      updated_at=?, summary=?, sources=? WHERE day=? AND module=? AND lease_id=?`)
      .run(observedAt, JSON.stringify(result.summary), JSON.stringify(result.sources), day, module, lease.id);
    if (!written.changes) return;
    // A successful stock snapshot supersedes older proposals absent from the new snapshot.
    if (module === 'replenishment') db.prepare(`UPDATE daily_tasks SET state='superseded',updated_at=?
      WHERE module=? AND last_day < ? AND state IN ('approval','queued')`).run(observedAt, module, day);
    const upsert = db.prepare(`INSERT INTO daily_tasks
      (module,task_key,role,title,detail,priority,state,first_day,last_day,source_ref,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (module,task_key) DO UPDATE SET role=excluded.role,title=excluded.title,detail=excluded.detail,
      priority=excluded.priority,state=excluded.state,last_day=excluded.last_day,source_ref=excluded.source_ref,updated_at=excluded.updated_at
      WHERE daily_tasks.last_day <= excluded.last_day`);
    for (const task of result.tasks) {
      const state = task.state ?? (task.role === 'procurement' ? 'approval' : 'queued');
      upsert.run(module, task.key, task.role, task.title, JSON.stringify(task.detail), task.priority, state,
        day, day, task.sourceRef ?? null, observedAt);
    }
  });
}

function defer(db, day, module, lease, timestamp, message) {
  const delay = Math.min(60, 5 * 2 ** Math.min(lease.attempts - 1, 4)) * 60_000;
  db.prepare(`UPDATE daily_runs SET state='retry', next_run_at=?, lease_id=NULL, lease_until=NULL,
    error=?, updated_at=? WHERE day=? AND module=? AND lease_id=?`)
    .run(new Date(timestamp.getTime() + delay).toISOString(), message, timestamp.toISOString(), day, module, lease.id);
}

function safeFailure(error) {
  if (error?.message === 'Invalid collector output' || error?.message === 'Invalid role task') return '任务数据格式不符，已保留上一轮回执。';
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return '取数模块未能加载，已排队重试。';
  if (error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') return '接口读取超时，已排队重试。';
  return '取数或数据核验未完成，已保留上一轮回执，稍后重试。';
}

export function readDailyRoleQueue({ dataDir = defaultDailyRoleQueueDir, role, limit = 100 } = {}) {
  if (role && !allowedRoles.has(role)) throw new RangeError('Unknown role');
  const file = join(dataDir, 'tasks.sqlite');
  if (!existsSync(file)) return { updatedAt: null, runs: [], tasks: [] };
  const rowLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const runs = db.prepare(`SELECT day,module,state,attempts,next_run_at AS nextRunAt,error,updated_at AS updatedAt,summary,sources
      FROM daily_runs ORDER BY day DESC,module LIMIT 14`).all().map(row => ({ ...row,
      summary: row.summary ? JSON.parse(row.summary) : null, sources: row.sources ? JSON.parse(row.sources) : [] }));
    const rows = db.prepare(`SELECT module,task_key AS key,role,title,detail,priority,state,first_day AS firstDay,
      last_day AS lastDay,source_ref AS sourceRef,updated_at AS updatedAt FROM daily_tasks
      WHERE (? IS NULL OR role=?) ORDER BY state='superseded',priority='urgent' DESC,last_day DESC,task_key LIMIT ?`)
      .all(role ?? null, role ?? null, rowLimit);
    const tasks = rows.map(row => ({ ...row, detail: JSON.parse(row.detail) }));
    const updatedAt = runs.reduce((latest, run) => !latest || run.updatedAt > latest ? run.updatedAt : latest, null);
    return { updatedAt, runs, tasks };
  } finally {
    db.close();
  }
}

export function reserveRoleDeliveries({ dataDir = defaultDailyRoleQueueDir, role } = {}) {
  if (role && !allowedRoles.has(role)) throw new RangeError('Unknown role');
  const { tasks } = readDailyRoleQueue({ dataDir, limit: 500, role });
  const result = [];
  if (!tasks.length) return result;
  const db = openWriter(dataDir);
  try {
    return transaction(db, () => {
      const insert = db.prepare(`INSERT OR IGNORE INTO role_deliveries (role,signature,delivery_id,state,updated_at)
        VALUES (?,?,?,'reserved',?)`);
      const group = Map.groupBy(tasks.filter(task => task.state !== 'superseded'), task => task.role);
      for (const [name, rows] of group) {
        const newTasks = [];
        const id = randomUUID();
        const at = new Date().toISOString();
        for (const task of rows) {
          const signature = JSON.stringify([task.key, task.role]);
          // Each task goes to a role once. Later data updates remain visible on the workbench.
          if (insert.run(name, signature, `${id}:${newTasks.length}`, at).changes) newTasks.push(task);
        }
        if (newTasks.length) result.push({ id, role: name, tasks: newTasks.map(({ key, title, priority }) => ({ key, title, priority })) });
      }
      return result;
    });
  } finally {
    db.close();
  }
}

export function closeRoleDelivery(id, state, dataDir = defaultDailyRoleQueueDir) {
  if (!/^[a-f0-9-]{36}$/u.test(id ?? '') || !['sent', 'unknown'].includes(state)) throw new Error('Invalid delivery result');
  const db = openWriter(dataDir);
  try {
    return Number(db.prepare(`UPDATE role_deliveries SET state=?,updated_at=?
      WHERE delivery_id LIKE ? AND state='reserved'`).run(state, new Date().toISOString(), `${id}:%`).changes);
  } finally {
    db.close();
  }
}

const liveCollectors = {
  replenishment: async context => (await import('./replenishment-tasks.mjs')).collectReplenishmentTasks(context),
  creative: async context => (await import('./creative-feedback-tasks.mjs')).collectCreativeFeedbackTasks(context),
};

export async function runDailyRoleQueue({ dataDir = defaultDailyRoleQueueDir, root = projectRoot, collectors = liveCollectors, now = null } = {}) {
  const timestamp = () => now ?? new Date();
  const parts = Object.fromEntries(scheduleClock.formatToParts(timestamp()).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) < openingHour) return { day, outsideHours: true, ...readDailyRoleQueue({ dataDir }) };
  const db = openWriter(dataDir);
  try {
    normalizeFirstRunKeys(db);
    const outcomes = await Promise.allSettled(Object.keys(moduleRoles).filter(module => collectors[module]).map(async module => {
      const lease = claim(db, day, module, timestamp());
      if (!lease) return;
      let result;
      try {
        result = checkedResult(module, await collectors[module]({ day, root }));
      } catch (error) {
        defer(db, day, module, lease, timestamp(), safeFailure(error));
        return;
      }
      complete(db, day, module, lease, result, timestamp().toISOString());
    }));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    db.close();
  }
  return { day, ...readDailyRoleQueue({ dataDir }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataDir = process.env.TTS_OPERATIONS_QUEUE_DIR || defaultDailyRoleQueueDir;
  const [command, first, second] = process.argv.slice(2);
  if (command === 'reserve-role-deliveries') {
    console.log(JSON.stringify(reserveRoleDeliveries({ dataDir, role: first })));
  } else if (command === 'record-role-delivery') {
    console.log(JSON.stringify({ updated: closeRoleDelivery(first, second, dataDir) }));
  } else if (command == null) runDailyRoleQueue({ dataDir }).then(result => {
    const runs = result.runs.filter(run => run.day === result.day);
    console.log(JSON.stringify({ day: result.day, outsideHours: result.outsideHours ?? false, runs,
      taskCount: result.tasks.filter(task => task.state !== 'superseded').length }));
  }).catch(error => {
    console.error(error?.code ? `任务台账执行失败 (${error.code})` : '任务台账执行失败');
    process.exitCode = 1;
  });
  else process.exitCode = 1;
}
