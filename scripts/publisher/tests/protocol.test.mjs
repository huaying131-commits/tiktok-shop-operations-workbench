import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fixture} from './support.mjs';
let api;try{api=await import('../lib/protocol.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const reply=(r,result,more={})=>({browser_id:'fake-env',tool_call_id:r.toolCallId,request_id:'request-'+r.toolCallId,status:'succeeded',output:{content:[{type:'text',text:JSON.stringify({_parsedJSON:true,result,...more})}]}});
test('official protocol correlates request and generation, and never resubmits timeout',async()=>{
 assert.equal(typeof api?.Protocol,'function');const f=fixture();try{
  let submits=0;const tr={submit:async r=>{submits++;return{...reply(r,null),status:'running'};},status:async({toolCallId})=>({tool_call_id:toolCallId,status:'running',request_id:'request-'+toolCallId,browser_id:'fake-env'})};
  const p=new api.Protocol({transport:tr,environment:'fake-env',taskId:'offline',activeFile:path.join(f.dir,'active.json'),receipts:path.join(f.dir,'receipts'),maxPolls:1});
  await assert.rejects(()=>p.call({action:'evaluate',params:{js:'1'}},{readOnly:true}),/unknown/i);assert.equal(submits,1);assert(fs.existsSync(p.activeFile));
  await assert.rejects(()=>p.call({action:'evaluate',params:{js:'2'}},{readOnly:true}),/inflight/i);assert.equal(submits,1);
 }finally{f.cleanup();}
});
test('official protocol rejects mismatched IDs and truncated envelopes',async()=>{
 assert.equal(typeof api?.Protocol,'function');for(const type of ['id','truncated']){const f=fixture();try{
  const tr={submit:async r=>type==='id'?{...reply(r,{ok:true}),request_id:null}:reply(r,{ok:true},{truncated:true})};
  const p=new api.Protocol({transport:tr,environment:'fake-env',taskId:'offline',activeFile:path.join(f.dir,'active.json'),receipts:path.join(f.dir,'receipts')});
  await assert.rejects(()=>p.call({action:'evaluate',params:{js:'1'}},{readOnly:true}));
 }finally{f.cleanup();}}
});
test('selector cardinality guard runs before effect for missing and duplicate elements',async()=>{
 assert.equal(typeof api?.uniqueScript,'function');
 for(const count of [0,2]){
  let clicks=0;const es=Array.from({length:count},()=>({getClientRects:()=>[{}],disabled:false,click:()=>clicks++}));
  const context={document:{querySelectorAll:()=>es},location:{href:'owned-url'},window:{name:'owner'}};
  assert.throws(()=>vm.runInNewContext(api.uniqueScript({selector:'button',effect:'click',owner:'owner',url:'owned-url'}),context),/unique/i);assert.equal(clicks,0);
 }
});
test('two processes share an exclusive global lock and never steal it',async()=>{
 const f=fixture();try{
  const {acquireLock}=await import('../lib/common.mjs');const lock=path.join(f.dir,'lock.json'),release=acquireLock(lock);
  const url=new URL('../lib/common.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireLock} from ${JSON.stringify(url)};try{acquireLock(process.argv[1]);process.exit(1)}catch(e){process.exit(e.reason==='global_lock_busy'?20:2)}`,lock],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const [code]=await once(child,'exit');assert.equal(code,20);assert(fs.existsSync(lock));release();assert(!fs.existsSync(lock));
 }finally{f.cleanup();}
});
test('unknown original request is queried once by saved ID without resubmission or gate removal',async()=>{
 assert.equal(typeof api?.Protocol,'function');const f=fixture();try{
  const {writeJSON}=await import('../lib/common.mjs');let submits=0,queries=0;
  const active=path.join(f.dir,'active.json');writeJSON(active,{toolCallId:'original-call',taskId:'original-task',requestId:'original-request'},true);
  const p=new api.Protocol({transport:{submit:async()=>{submits++;},status:async arg=>{queries++;assert.equal(arg.toolCallId,'original-call');return{tool_call_id:'original-call',request_id:'original-request',browser_id:'fake-env',status:'running'};}},environment:'fake-env',taskId:'original-task',activeFile:active,receipts:path.join(f.dir,'receipts')});
  const r=await p.readOriginal();assert.equal(r.conclusion,'unknown');assert.equal(queries,1);assert.equal(submits,0);assert(fs.existsSync(active));
 }finally{f.cleanup();}
});
