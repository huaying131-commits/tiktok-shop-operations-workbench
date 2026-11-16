import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,FakeDriver,hash} from './support.mjs';
import {State} from '../lib/state.mjs';
import {validatePackage} from '../lib/intake.mjs';
import {run,validateApproval} from '../lib/engine.mjs';
import {loadHistory} from '../lib/history.mjs';
import {checkJob,plan} from '../lib/planner.mjs';

function setup(options={}){const f=fixture(),s=new State(path.join(f.dir,'state'));f.job=validatePackage(f.pkg,{policy:f.policy,manifest:f.manifest});s.putJob(f.job);const driver=new FakeDriver(f,options),approval={dalei_quote:'离线测试',jobs:[f.job.video_id,'SECOND'],max_count:1,valid_from:'2026-11-08T00:00:00Z',expires_at:'2026-11-09T00:00:00Z'};return{f,s,driver,input:{state:s,jobId:f.job.video_id,mode:'live',approval,policy:f.policy,driver,automationFile:f.automationFile,clock:()=>f.at,history:{rows:[],ledgerDays:['2026-11-07','2026-11-08'],coverages:[]},outputRoot:path.join(f.dir,'outputs')},close:()=>{s.close();f.cleanup();}};}
test('preview failure after transfer/input remains unknown and cannot restart upload',async()=>{
 const t=setup({fail:'preview'});try{
  assert.equal((await run(t.input)).exit_code,20);
  assert(t.s.attempts().some(x=>x.status==='unknown'&&x.stage==='upload'));
  const n=t.driver.calls.length;t.driver.options={};assert.equal((await run(t.input)).exit_code,20);
  assert.equal(t.driver.calls.length,n);
 }finally{t.close();}
});
test('new natural day ledger exists before an upload, even when upload never starts',async()=>{
 const t=setup({login:true});try{
  await run(t.input);assert(fs.existsSync(path.join(t.input.outputRoot,'video-publishing-2026-11-08','发布记录.jsonl')));
 }finally{t.close();}
});
test('archive identity without timestamp deduplicates without erasing real ledger times',()=>{
 const t=setup();try{
  const base=path.join(t.f.dir,'outputs','video-publishing-2026-11-07'),dir=path.join(base,'archive','example-creator-1','OLD');fs.mkdirSync(dir,{recursive:true});
  const row={job_id:'OLD',account:'example-creator-1',sha256:'old',published:true,published_at:'2026-11-07T10:00:00Z'};
  fs.writeFileSync(path.join(base,'发布记录.jsonl'),JSON.stringify(row)+'\n');fs.writeFileSync(path.join(dir,'archive-manifest.json'),JSON.stringify({...row,published_at:undefined,files:{}}));
  const h=loadHistory(t.f.dir);assert.equal(checkJob(t.f.job,{...h,policy:t.f.policy,jobs:[t.f.job]},t.f.at).eligible,true);
 }finally{t.close();}
});
test('approval max_count counts consumed jobs, including unknown original actions',()=>{
 const t=setup();try{
  const key=validateApproval(t.input.approval,t.f.job,t.f.at,t.s);
  t.s.beginAction({action_key:'unknown',job_id:t.f.job.video_id,account:t.f.job.account,stage:'upload',at:t.f.at,approval_key:key});
  assert.throws(()=>validateApproval(t.input.approval,{...t.f.job,video_id:'SECOND'},t.f.at,t.s),e=>e.code===40);
 }finally{t.close();}
});
test('archive conflict never overwrites destination bytes',async()=>{
 const t=setup();try{
  const dir=path.join(t.input.outputRoot,'video-publishing-2026-11-08','archive',t.f.job.account,t.f.job.video_id);fs.mkdirSync(dir,{recursive:true});const dest=path.join(dir,'video.mp4');fs.writeFileSync(dest,'existing unrelated bytes');
  const r=await run(t.input);assert.equal(r.exit_code,20);assert.equal(r.reason,'archive_conflict_no_overwrite');assert.equal(fs.readFileSync(dest,'utf8'),'existing unrelated bytes');
 }finally{t.close();}
});
test('hold release must bind exact hold, video SHA, account and evidence',()=>{
 const t=setup();try{
  const p={...t.f.pkg,publication_hold:{active:true,id:'quality-1'}};
  assert.throws(()=>validatePackage(p,{policy:t.f.policy,manifest:t.f.manifest}),e=>e.reason==='publication_hold');
  p.publication_hold_release={hold_id:'quality-1',video_id:p.video_id,account:p.target_account,sha256:p.sha256,released:true,source_type:'direct_human_confirmation',quote:'解除这个保留',recorded_at:'2026-11-08T01:00:00Z',evidence:{path:t.f.evidence,sha256:hash(fs.readFileSync(t.f.evidence))}};
  assert.equal(validatePackage(p,{policy:t.f.policy,manifest:t.f.manifest}).hold.active,false);
  p.publication_hold_release.sha256='b'.repeat(64);assert.throws(()=>validatePackage(p,{policy:t.f.policy,manifest:t.f.manifest}),e=>e.reason==='publication_hold');
 }finally{t.close();}
});
test('unsupported or missing selector returns a structured case, no submit',async()=>{
 const t=setup();try{
  t.driver.call=async(kind,op,data)=>{t.driver.calls.push({kind,op});if(op==='owned_page')throw Error('UniqueSelectorRequired');return op==='connection'?{ready:true}:{};};
  const r=await run(t.input);assert.equal(r.exit_code,20);const c=JSON.parse(fs.readFileSync(r.case_file));assert.match(c.error.reason,/UniqueSelector/);assert.equal(t.driver.calls.some(x=>x.op==='submit'),false);
 }finally{t.close();}
});
test('cleanup closes a clean owned product helper and preserves a dirty helper independently',async()=>{
 for(const dirty of [false,true]){
  const t=setup();try{
   const original=t.driver.call.bind(t.driver);
   t.driver.call=async(kind,op,data)=>op==='product_cleanup_state'?{owner:'codex-content-link-offline',target_id:'product-helper',created:true,dirty,unknown:false}:original(kind,op,data);
   assert.equal((await run(t.input)).exit_code,0);
   assert.equal(t.driver.calls.filter(x=>x.op==='close_product_page').length,dirty?0:1);
  }finally{t.close();}
 }
});
