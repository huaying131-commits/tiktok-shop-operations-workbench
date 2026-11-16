import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let api;
try { api = await import('../lib/planner.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const policy = {
  publishing_target: { natural_day_cap_per_account: 2, daily_total_target: 3, minimum_real_success_interval_seconds: 3600, minimum_aircraft_successes_per_actual_day: 1 },
  content_account_vertical_policy: { accounts: [{ account: 'a', code: 'WH' }, { account: 'b', code: 'TB' }] },
};
const job = (id = 'v', account = 'a', more = {}) => ({ video_id: id, account, sha256: id.repeat(64).slice(0,64), identifiers: [id], aircraft: false, ...more });
const at = '2026-11-08T10:00:00Z';
const snapshot = (more = {}) => ({ policy, jobs: [job()], rows: [], ledgerDays: ['2026-11-07','2026-11-08'], coverages: [], ...more });
const success = (id, account, time) => ({ job_id: id, account, sha256: id, published: true, published_at: time, identifiers: [id] });

test('policy caps, interval and cross-midnight use real success timestamps', () => {
  assert.equal(api.plan(snapshot({ rows: [success('old','a','2026-11-08T09:30:00Z')] }), at).accounts[0].reason, 'interval');
  assert.equal(api.plan(snapshot({ rows: [success('one','a','2026-11-08T07:00:00Z'),success('two','a','2026-11-08T08:00:00Z')] }), at).accounts[0].reason, 'daily_cap');
  const r=api.plan(snapshot({ rows:[success('old','a','2026-11-08T15:45:00Z')] }), '2026-11-08T16:10:00Z');
  assert.equal(r.accounts[0].reason,'interval');
  assert.equal(r.accounts[0].earliest_at,'2026-11-08T16:45:00.000Z');
});
test('unknown locks only affected account; success resolves exact intent', () => {
  const intent={account:'a',sha256:'old',action_key:'key',result_unknown:true,submit_attempted:true};
  const s=snapshot({ jobs:[job(),job('w','b')],rows:[intent] });
  assert.equal(api.plan(s,at).accounts[0].reason,'unknown_operation');
  assert.equal(api.plan(s,at).accounts[1].decision,'publish');
  s.rows.push({...intent,published:true,result_unknown:false,published_at:'2026-11-08T07:00:00Z'});
  assert.equal(api.plan(s,at).unknown_submissions.length,0);
});
test('dedup rejects final hash, lineage and a second account; hold is explicit data', () => {
  for (const more of [{identifiers:['ancestor']},{sha256:'ancestor'}]) {
    const s=snapshot({jobs:[job('v','b',more)],rows:[{...success('ancestor','a','2026-11-07T07:00:00Z'),identifiers:['ancestor']}]});
    assert.equal(api.plan(s,at).accounts[1].reason,'already_published');
  }
  assert.equal(api.plan(snapshot({jobs:[job('v','a',{hold:{active:true}})]}),at).accounts[0].reason,'publication_hold');
  assert.equal(api.plan(snapshot({jobs:[job('v','a',{identifiers:['same']}),job('w','b',{identifiers:['same']})]}),at).accounts[0].reason,'lineage_collision');
});
test('history gap is not zero; authenticated coverage must name missing day/account', () => {
  const s=snapshot({ledgerDays:['2026-11-06','2026-11-08']});
  assert.equal(api.plan(s,at).exit_code,20);
  assert.equal(api.plan(s,at).accounts[0].reason,'history_gap');
  s.coverages=[{source_type:'direct_human_confirmation',quote:'核清当天无发布',recorded_at:'2026-11-07T15:59:00Z',actual_date:'2026-11-07',timezone:'Asia/Shanghai',market:'MY',accounts:['a','b'],baseline_success_count:0}];
  assert.equal(api.plan(s,at).accounts[0].decision,'publish');
});
test('shop cap and aircraft priority; one job per account per current round', () => {
  const s=snapshot({jobs:[job('v'),job('w','a',{aircraft:true}),job('x','b')], rows:[success('1','b','2026-11-08T01:00:00Z'),success('2','b','2026-11-08T03:00:00Z')]});
  const r=api.plan(s,at);
  assert.equal(r.accounts[0].video_id,'w');
  assert.equal(r.accounts.filter(x=>x.decision==='publish').length,1);
});
test('state SQLite uniqueness, exclusive intents, independent readonly handle', async () => {
  const {State}=await import('../lib/state.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-rules-'));
  try {
    const s=new State(dir); s.putJob(job());s.putJob(job());assert.equal(s.jobs().length,1);
    s.beginAction({action_key:'x',job_id:'v',account:'a',stage:'submit',at});
    assert.throws(()=>s.beginAction({action_key:'x',job_id:'v',account:'a',stage:'submit',at}));
    s.close();const before=fs.statSync(path.join(dir,'state.db')).mtimeMs;
    const ro=new State(dir,{readonly:true});assert.equal(ro.attempts().length,1);ro.close();
    assert.equal(fs.statSync(path.join(dir,'state.db')).mtimeMs,before);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
