import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,FakeDriver} from './support.mjs';import {State} from '../lib/state.mjs';import {validatePackage} from '../lib/intake.mjs';import {run} from '../lib/engine.mjs';import {readJSON,fileHash,writeJSON} from '../lib/common.mjs';
let channels,compat;try{channels=await import('../channels/index.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}try{compat=await import('../lib/export-compat.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('page channel has replaceable publishing methods; future API channel stays explicitly unavailable',()=>{
 assert.equal(typeof channels?.SellerCenterPageChannel,'function');const methods=['uploadStep','selectAccount','attachProduct','fillField','submitOnce'];
 for(const method of methods)assert.equal(typeof channels.SellerCenterPageChannel.prototype[method],'function');
 assert.throws(()=>channels.createChannel('tiktok-shop-api',{}),/not_implemented/);
});
test('channel success preserves original request/video IDs and full ledger contract at actual observation time',async()=>{
 const f=fixture(),s=new State(path.join(f.dir,'state'));try{
  const job=validatePackage(f.pkg,{policy:f.policy,manifest:f.manifest});s.putJob(job);const driver=new FakeDriver({...f,job});const base=driver.call.bind(driver);
  driver.call=async(kind,op,data)=>op==='submit'?{...await base(kind,op,data),original_request_id:'original-api-or-page-request',tool_call_id:'publisher-ascii-call',platform_video_id:'123456789'}:base(kind,op,data);
  let time=Date.parse(f.at);
  const r=await run({state:s,jobId:job.video_id,mode:'live',channel:driver,policy:f.policy,automationFile:f.automationFile,approval:{dalei_quote:'离线假通道测试',jobs:[job.video_id],max_count:1,valid_from:'2026-11-08T00:00:00Z',expires_at:'2026-11-09T00:00:00Z'},clock:()=>new Date(time).toISOString(),afterStage:stage=>{if(stage==='upload')time+=600000;},history:{rows:[],ledgerDays:['2026-11-07'],coverages:[]},outputRoot:path.join(f.dir,'outputs')});
  assert.equal(r.exit_code,0,JSON.stringify(r));assert.equal(r.platform_video_id,'123456789');
  const rows=fs.readFileSync(path.join(f.dir,'outputs','video-publishing-2026-11-08','发布记录.jsonl'),'utf8').trim().split('\n').map(JSON.parse),posted=rows.find(x=>x.published);
  for(const key of ['business_date','job_id','account','original_request_id','sha256','generation_ids','revision_relation','product_link','upload_status','submission_status','result_unknown','independent_success_at','success_evidence','platform_video_id','public_status','archive_status','report_join'])assert(key in posted,key);
  assert.equal(posted.original_request_id,'original-api-or-page-request');assert.equal(posted.published_at,'2026-11-08T10:10:00.000Z');assert.equal(posted.report_join.video_id,'123456789');
 }finally{s.close();f.cleanup();}
});
test('compat export preserves unknowns/cross-day successes/source fields and never writes production files',()=>{
 assert.equal(typeof compat?.exportCompat,'function');const f=fixture(),s=new State(path.join(f.dir,'state'));try{
  const root=path.join(f.dir,'root'),source=path.join(root,'operations/video-publishing-continuation.json');
  writeJSON(source,{authorized:true,status:'complete',jobs:[{video_id:'OLD',account:'example-creator-4',completed:false,legacy_unknown_marker:true}],current_continuation:{actual_date:'2026-11-08',preserved_historical_field:'keep',protected_native_jobs:['OLD']}});const before=fileHash(source);
  const job=validatePackage(f.pkg,{policy:f.policy,manifest:f.manifest});s.putJob({...job,published:true,status:'posted_archived'});
  const h={rows:[{job_id:job.video_id,account:job.account,sha256:job.sha256,published:true,published_at:'2026-11-09T15:45:00Z'},{job_id:'OLD-UPLOAD',account:'example-creator-4',sha256:'b'.repeat(64),published:false,result_unknown:true,submit_attempted:false,status:'upload_attempt_recorded'}],ledgerDays:['2026-11-09','2026-11-10'],coverages:[],reservations:[]};
  const out=path.join(f.dir,'export'),result=compat.exportCompat({root,state:s,outDir:out,policy:f.policy,history:h,at:'2026-11-09T16:10:00Z'});
  assert.equal(result.exit_code,0);assert.equal(fileHash(source),before);
  const c=readJSON(path.join(out,'video-publishing-continuation.json')),q=readJSON(path.join(out,'checkpoint.json')),w=readJSON(path.join(out,'eco-worker-state.json'));
  assert.equal(c.current_continuation.preserved_historical_field,'keep');assert(c.jobs.find(x=>x.video_id==='OLD').legacy_unknown_marker);assert(q.accepted_jobs.some(x=>x.video_id===job.video_id&&x.published));assert.equal(w.unknown_submissions,0);assert(w.unknown_uploads.length===1);assert.equal(w.last_success_by_account.example-creator-1,'2026-11-09T15:45:00Z');
  assert.equal(fs.existsSync(path.join(out,'heartbeat-latest.json')),true);
  assert.throws(()=>compat.exportCompat({root,state:s,outDir:path.join(process.cwd(),'evidence/forbidden-export'),policy:f.policy,history:h,at:f.at}),/temporary_output_required/);
 }finally{s.close();f.cleanup();}
});
test('occupied original publisher page is preserved and a distinct owned page is created',async()=>{
 const f=fixture(),s=new State(path.join(f.dir,'state'));try{
  const job=validatePackage(f.pkg,{policy:f.policy,manifest:f.manifest});s.putJob(job);const driver=new FakeDriver({...f,job}),base=driver.call.bind(driver);let created=false;
  driver.call=async(kind,op,data)=>{const r=await base(kind,op,data);if(op==='owned_page')return created?{...r,owner:'codex-content-new-page',target_id:'new-target',dialogs:0}:{...r,dialogs:1,progress:true};if(op==='create_owned_page'){created=true;return{ok:true};}return r;};
  const result=await run({state:s,jobId:job.video_id,mode:'live',channel:driver,policy:f.policy,automationFile:f.automationFile,approval:{dalei_quote:'离线测试',jobs:[job.video_id],max_count:1,valid_from:'2026-11-08T00:00:00Z',expires_at:'2026-11-09T00:00:00Z'},clock:()=>f.at,history:{rows:[],ledgerDays:['2026-11-07'],coverages:[]},outputRoot:path.join(f.dir,'outputs'),afterStage:stage=>{if(stage==='owned_page')throw Error('offline breakpoint');}});
  assert.equal(result.exit_code,20);assert(created);assert.equal(s.stage(job.video_id,'owned_page').context.page.target_id,'new-target');assert.equal(driver.calls.some(c=>c.op==='submit'),false);
 }finally{s.close();f.cleanup();}
});
