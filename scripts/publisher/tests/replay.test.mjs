import test from 'node:test';
import assert from 'node:assert/strict';
import {readJSON} from '../lib/common.mjs';
import {plan} from '../lib/planner.mjs';
const f=readJSON(new URL('./fixtures/history-2026-11-08.json',import.meta.url));
export function replay(){
 return f.records.map((record,index)=>{
  const s={policy:f.policy,jobs:[record.job],rows:f.records.slice(0,index).map(r=>r.success),ledgerDays:['2026-11-07','2026-11-08'],coverages:[],reservations:[]};
  const result=plan(s,record.success.published_at).accounts.find(a=>a.account===record.job.account);
  const prev=f.records.slice(0,index).filter(r=>r.job.account===record.job.account).at(-1);
  return{video_id:record.job.video_id,account:record.job.account,at:record.success.published_at,interval_seconds:prev?(Date.parse(record.success.published_at)-Date.parse(prev.success.published_at))/1000:null,decision:result.decision,reason:result.reason,earliest_at:result.earliest_at,missing_fields:Object.entries(record.package_fields).filter(([k,v])=>['short_product_name','semantic_review','publishing_fields'].includes(k)&&v===null).map(([k])=>k)};
 });
}
test('actual 11-08 replay allows all 20 at original times without bypassing quotas or interval',()=>{
 const results=replay();assert.equal(results.length,20);
 const blocked=results.filter(r=>r.decision!=='publish');
 assert.deepEqual(blocked,[]);
 assert.equal(Math.min(...results.map(r=>r.interval_seconds).filter(n=>n!==null)),3800.229);
 for(const record of f.records){assert.equal(record.success.sha256,record.job.sha256);assert.match(record.source.sha256,/^[a-f0-9]{64}$/);}
 const counts=new Map();for(const r of f.records)counts.set(r.job.account,(counts.get(r.job.account)??0)+1);
 assert.equal([...counts.values()].every(n=>n===4),true);
});
test('historical task gaps are reported, never filled with guessed names or semantic conclusions',()=>{
 assert.equal(replay().every(r=>r.missing_fields.includes('short_product_name')),true);
 assert.equal(replay().every(r=>r.missing_fields.includes('semantic_review')),true);
});
