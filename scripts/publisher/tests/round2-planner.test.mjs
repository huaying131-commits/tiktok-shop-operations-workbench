import test from 'node:test';
import assert from 'node:assert/strict';
import {readJSON} from '../lib/common.mjs';
import {plan,checkJob} from '../lib/planner.mjs';
const uploads=readJSON(new URL('./fixtures/upload-only-unknowns.json',import.meta.url));
const accounts=['example-creator-1','example-creator-2','example-creator-3','example-creator-4','example-creator-5'];
const policy={publishing_target:{natural_day_cap_per_account:4,daily_total_target:20,minimum_real_success_interval_seconds:3600,minimum_aircraft_successes_per_actual_day:5},content_account_vertical_policy:{accounts:accounts.map(account=>({account}))}};
const at='2026-11-10T10:00:00Z';
const fresh=(account,i)=>({video_id:'NEW-'+i,account,sha256:String(i).repeat(64),identifiers:['brand-new-'+i]});
const snapshot={policy,jobs:accounts.map(fresh),rows:uploads,ledgerDays:['2026-11-09'],coverages:[]};
test('11 real upload-only unknowns protect their videos and lineage without locking all five accounts',()=>{
 assert.equal(uploads.length,11);assert(uploads.every(x=>x.submit_attempted===false));
 const r=plan(snapshot,at);assert(r.accounts.every(x=>x.decision==='publish'),JSON.stringify(r.accounts));
 assert.equal(r.unknown_submissions.length,0);assert.equal(r.unknown_uploads.length,11);
 for(const row of uploads){
  const same={video_id:'RENAMED',account:'different-account',sha256:row.sha256,identifiers:row.identifiers};
  assert.equal(checkJob(same,{...snapshot,jobs:[same]},at).reason,'unknown_operation');
 }
});
test('explicit submit intent or submit-class status locks account even when upload flag is false',()=>{
 for(const row of [{...uploads[0],submit_attempted:true},{...uploads[0],status:'unknown_after_submit'},{...uploads[0],status:'result_pending'},{...uploads[0],submit_attempted:true,result_unknown:false,status:'route_failed'}]){
  const r=plan({...snapshot,rows:[row]},at);assert.equal(r.accounts.find(a=>a.account===row.account).reason,'unknown_operation');
 }
});
test('only today/yesterday gaps block; older holes become history_warnings',()=>{
 const s={...snapshot,rows:[],ledgerDays:['2026-10-11','2026-10-13','2026-11-05','2026-11-07','2026-11-08','2026-11-09']};
 const r=plan(s,at);assert(r.accounts.every(a=>a.decision==='publish'));
 assert(r.history_warnings.some(x=>x.date==='2026-10-12'));assert(r.history_warnings.some(x=>x.date==='2026-11-06'));
 const recent=plan({...s,ledgerDays:s.ledgerDays.filter(d=>d!=='2026-11-09')},at);
 assert.equal(recent.exit_code,20);assert(recent.accounts.every(a=>a.reason==='history_gap'));assert(recent.accounts.every(a=>a.missing_days.includes('2026-11-09')));
});
test('official list alone cannot close a recent history gap',()=>{
 const official={source_type:'official_platform_account_history_read',timezone:'Asia/Shanghai',market:'MY',accounts,actual_date:'2026-11-09',interval_start:'2026-11-08T16:00:00Z',interval_end:'2026-11-09T15:59:59.999Z',observed_at:'2026-11-10T09:00:00Z',complete:true,includes_manual:true,request_id:'list-that-omitted-11-08'};
 const r=plan({...snapshot,rows:[],ledgerDays:['2026-11-08'],coverages:[official]},at);assert.equal(r.accounts[0].reason,'history_gap');
});
