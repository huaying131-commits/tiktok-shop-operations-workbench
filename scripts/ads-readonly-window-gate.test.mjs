import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {validateReadonlyWindow,reserveWindowCall} from './ads-readonly-window-gate.mjs';
const now=Date.parse('2026-10-19T14:45:00+08:00');
const gate={id:'ADS-PAGE-20261019-1406',environment_id:'90000000000001',repair_owner_thread_id:'00000000-0000-4000-8000-000000000008',live_verification_ready:true,window_id:'ADS-PAGE-20261019-1406-W2',window_start:new Date(now-1000).toISOString(),window_end:new Date(now+299000).toISOString()};
test('gate refuses stale, not-ready or expanded windows',()=>{
 assert.equal(validateReadonlyWindow(gate,now).windowId,gate.window_id);
 for(const g of [{...gate,live_verification_ready:false},{...gate,window_end:new Date(now-1).toISOString()},{...gate,window_end:new Date(now+301000).toISOString()},{...gate,window_id:undefined}])assert.throws(()=>validateReadonlyWindow(g,now));
});
test('same window accepts at most six unique intents and refuses replay',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ads-window-test-'));
 try{for(let i=0;i<6;i++)reserveWindowCall(dir,gate.window_id,'call-'+i,{read_only:true});
  assert.throws(()=>reserveWindowCall(dir,gate.window_id,'call-6',{}),/WindowCallLimit/);
  assert.throws(()=>reserveWindowCall(dir,gate.window_id,'call-0',{}),/IntentAlreadyExists|WindowCallLimit/);
 }finally{for(const f of fs.readdirSync(dir)){const p=path.join(dir,f);if(fs.statSync(p).isFile())fs.unlinkSync(p);}fs.rmdirSync(dir);}
});
