import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,FakeDriver} from './support.mjs';
import {State} from '../lib/state.mjs';
let api;try{api=await import('../lib/engine.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
async function setup(options={}){
 const f=fixture(),s=new State(path.join(f.dir,'state'));
 const {validatePackage}=await import('../lib/intake.mjs');f.job=validatePackage(f.pkg,{policy:f.policy,manifest:f.manifest});s.putJob(f.job);
 const driver=new FakeDriver(f,options);
 const approval={dalei_quote:'批准离线假传输测试',jobs:[f.job.video_id],max_count:1,valid_from:'2026-11-08T00:00:00Z',expires_at:'2026-11-09T00:00:00Z'};
 const input={state:s,jobId:f.job.video_id,mode:'live',approval,driver,automationFile:f.automationFile,clock:()=>f.at,policy:f.policy,history:{rows:[],ledgerDays:['2026-11-07','2026-11-08'],coverages:[],reservations:[]},outputRoot:path.join(f.dir,'outputs')};
 return{f,s,driver,input,close:()=>{s.close();f.cleanup();}};
}
test('engine API and dry mode only performs reads',async()=>{
 assert.equal(typeof api?.run,'function');const t=await setup();try{const r=await api.run({...t.input,mode:'dry'});assert.equal(r.exit_code,0);assert(t.driver.calls.every(x=>x.kind==='read'));assert.equal(t.s.attempts().length,0);}finally{t.close();}
});
test('live approval missing, expired, wrong job and exhausted budget rejected before writes',async()=>{
 assert.equal(typeof api?.run,'function');const t=await setup();try{
  for(const approval of [null,{...t.input.approval,expires_at:'2026-11-07T00:00:00Z'},{...t.input.approval,jobs:['other']},{...t.input.approval,max_count:0}]) {
   assert.equal((await api.run({...t.input,approval})).exit_code,40);
  }
  assert(t.driver.calls.every(x=>x.kind==='read'));
 }finally{t.close();}
});
test('offline success is recorded once, archive is hash checked and source retained',async()=>{
 assert.equal(typeof api?.run,'function');const t=await setup();try{
  const r=await api.run(t.input);assert.equal(r.exit_code,0);assert.equal(t.driver.calls.filter(x=>x.op==='submit').length,1);assert(fs.existsSync(t.f.file));
  assert.equal((await api.run(t.input)).exit_code,10);assert.equal(t.driver.calls.filter(x=>x.op==='submit').length,1);
  assert(fs.existsSync(path.join(t.input.outputRoot,'video-publishing-2026-11-08','发布记录.jsonl')));
 }finally{t.close();}
});
test('every persisted stage resumes without repeating completed actions',async()=>{
 assert(Array.isArray(api?.STAGES));
 for(const stage of api.STAGES){
  const t=await setup();try{
   let hit=false;const crash=await api.run({...t.input,afterStage:name=>{if(name===stage&&!hit){hit=true;throw Error('simulated process interruption');}}});
   assert.equal(hit,true,stage);assert.equal(crash.exit_code,20);
   const before=t.driver.calls.filter(x=>x.kind==='write').map(x=>x.op);
   const result=await api.run(t.input);assert([0,10].includes(result.exit_code),`${stage}: ${JSON.stringify(result)}`);
   for(const op of new Set(before))assert.equal(t.driver.calls.filter(x=>x.kind==='write'&&x.op===op).length,before.filter(x=>x===op).length,`${stage}:${op}`);
  }finally{t.close();}
 }
});
test('intent-before-click crash is unknown and never clicked on rerun',async()=>{
 assert.equal(typeof api?.run,'function');const t=await setup();try{
  const r=await api.run({...t.input,afterIntent:stage=>{if(stage==='submit')throw Error('crash after submit intent');}});
  assert.equal(r.exit_code,20);assert.equal(t.s.attempts().filter(x=>x.stage==='submit').length,1);assert.equal(t.driver.calls.filter(x=>x.op==='submit').length,0);
  assert.equal((await api.run(t.input)).exit_code,20);assert.equal(t.driver.calls.filter(x=>x.op==='submit').length,0);
 }finally{t.close();}
});
for(const op of ['transfer','assign','confirm'])test(`${op} timeout or empty result stays unknown and never repeats`,async()=>{
 assert.equal(typeof api?.run,'function');for(const variant of ['fail','empty']){
  const t=await setup({[variant]:op});try{
   assert.equal((await api.run(t.input)).exit_code,20);
   const n=t.driver.calls.filter(x=>x.op===op).length;assert(n>0,op+' must actually be reached');t.driver.options={};assert.equal((await api.run(t.input)).exit_code,20);
   assert.equal(t.driver.calls.filter(x=>x.op===op).length,n);
  }finally{t.close();}
 }
});
test('login and captcha return 30 with self-contained case and no mutations',async()=>{
 assert.equal(typeof api?.run,'function');for(const option of ['login','captcha']){
  const t=await setup({[option]:true});try{const r=await api.run(t.input);assert.equal(r.exit_code,30);const c=JSON.parse(fs.readFileSync(r.case_file));for(const k of ['failed_stage','error','readbacks','page_text','completed_stages','submit_intent_exists','suggested_next_step'])assert(k in c);assert(t.driver.calls.every(x=>x.kind==='read'));}finally{t.close();}
 }
});
test('ambiguous submit selector creates case and never submits',async()=>{
 assert.equal(typeof api?.run,'function');for(const submitCount of [0,2]){const t=await setup({submitCount});try{const r=await api.run(t.input);assert.equal(r.exit_code,20);assert.equal(t.driver.calls.filter(x=>x.op==='submit').length,0);assert(fs.existsSync(r.case_file));}finally{t.close();}}
});
test('reconcile is read-only and never unlocks or republishes an unknown',async()=>{
 assert.equal(typeof api?.reconcile,'function');const t=await setup({fail:'confirm'});try{await api.run(t.input);const n=t.driver.calls.length;const r=await api.reconcile(t.input);assert.equal(r.exit_code,20);assert(t.driver.calls.slice(n).every(x=>x.kind==='read'));assert.equal(t.s.attempts().find(x=>x.stage==='submit').status,'unknown');}finally{t.close();}
});
