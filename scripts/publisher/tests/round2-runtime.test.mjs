import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture} from './support.mjs';import {OfficialDriver} from '../lib/browser-driver.mjs';
import * as cli from '../cli.mjs';import {Protocol} from '../lib/protocol.mjs';
let runtime;try{runtime=await import('../lib/runtime-config.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('CLI default clock advances; explicit --at is the only fixed-time mode',()=>{
 assert.equal(typeof cli.clockFor,'function');let current=Date.parse('2026-11-10T00:00:00Z');
 const real=cli.clockFor({},()=>current);assert.equal(real(),'2026-11-10T00:00:00.000Z');current+=600000;assert.equal(real(),'2026-11-10T00:10:00.000Z');
 const fixed=cli.clockFor({at:'2026-11-08T10:00:00Z'},()=>current);current+=600000;assert.equal(fixed(),'2026-11-08T10:00:00.000Z');
 assert.throws(()=>cli.clockFor({at:'2026-11-08T10:00:00'},()=>current),/explicit_iso_time_required/);
});
test('delayed success confirmation waits injectable 3000ms between reads',async()=>{
 const f=fixture(),waits=[];try{
  const d=new OfficialDriver({root:f.dir,stateDir:path.join(f.dir,'state'),runtime:{task_id:'offline',environment_id:'fake',owner:'codex-content-offline-test',product_owner:'product',publish_url:'https://example.invalid/',product_edit_url:'https://example.invalid/product'},transport:{},pause:async ms=>waits.push(ms)});
  let reads=0;d.bind=async()=>({});d.evaluate=async()=>({success:++reads===3,message:reads===3?'Your video has been posted!':''});
  const p=await d.call('read','confirm',{context:{page:{}}});assert.equal(p.success,true);assert.deepEqual(waits,[3000,3000]);
 }finally{f.cleanup();}
});
test('live guard reads original automation file; only PAUSED permits continuation',()=>{
 assert.equal(typeof runtime?.assertLegacyPublisherPaused,'function');const f=fixture();try{
  const file=path.join(f.dir,'automation.toml');for(const status of ['ACTIVE','UNKNOWN']){fs.writeFileSync(file,`status = "${status}"\n`);assert.throws(()=>runtime.assertLegacyPublisherPaused(file),e=>e.reason==='legacy_publisher_not_paused');}
  fs.writeFileSync(file,'status = "PAUSED"\n');assert.equal(runtime.assertLegacyPublisherPaused(file).status,'PAUSED');
 }finally{f.cleanup();}
});
test('all generated toolCallIds remain ASCII <=64 independent of long video/task names',async()=>{
 const f=fixture();try{
  const ids=[],p=new Protocol({environment:'fake',taskId:'very-long-context-'.repeat(20),activeFile:path.join(f.dir,'active.json'),receipts:path.join(f.dir,'requests'),transport:{submit:async r=>{ids.push(r.toolCallId);return{browser_id:'fake',tool_call_id:r.toolCallId,request_id:'original',status:'succeeded',output:{content:[{type:'text',text:'{"result":{"ok":true}}'}]}};}}});
  await p.call({action:'evaluate',params:{js:'1'}},{readOnly:true});assert(ids.every(id=>/^[\x21-\x7e]{1,64}$/.test(id)));
 }finally{f.cleanup();}
});
test('unroutable legacy 105-character ID remains unknown and is never replaced or replayed',async()=>{
 const f=fixture();try{
  const {writeJSON}=await import('../lib/common.mjs');const file=path.join(f.dir,'active.json');writeJSON(file,{taskId:'task',toolCallId:'x'.repeat(105)},true);let calls=0;
  const p=new Protocol({transport:{status:async()=>{calls++;throw Error('route rejected');}},environment:'fake',taskId:'task',activeFile:file,receipts:path.join(f.dir,'requests')});
  const r=await p.readOriginal();assert.equal(r.conclusion,'unknown');assert.equal(calls,0);assert(fs.existsSync(file));
 }finally{f.cleanup();}
});
test('occupied original page creation uses a new unique owner rather than reusing the old window name',async()=>{
 const f=fixture();try{
  const d=new OfficialDriver({root:f.dir,stateDir:path.join(f.dir,'state'),runtime:{task_id:'offline',environment_id:'fake',owner:'codex-content-original-page',product_owner:'codex-content-product-page',publish_url:'https://seller.tiktokshopglobalselling.com/shoppable-videos/inspiration/videos?shop_region=MY',product_edit_url:'https://seller.tiktokshopglobalselling.com/product/edit/200?shop_region=MY',source:{owner:'',url:'https://seller.tiktokshopglobalselling.com/homepage?shop_region=MY'}},transport:{}});
  d.inventory=async()=>[{index:0}];d.findOwned=async(owner,url)=>({owner,url,target_id:'source',shop:'MY Malaysia (example-shop-my)'});d.mutate=async()=>({ok:true});
  await d.call('write','create_owned_page',{occupied_page:{owner:d.runtime.owner,dialogs:1,progress:true}});
  assert.notEqual(d.runtime.owner,'codex-content-original-page');assert(d.runtime.owner.startsWith('codex-content-'));
 }finally{f.cleanup();}
});
test('owned-page receipts require today, exact target, URL, window name and MY identity',async()=>{
 let api;try{api=await import('../lib/owned-page-receipt.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof api?.verifyOwnedPageReceipt,'function');
 const p={owner:'codex-content-test-owner',target_id:'current-target',url:'https://seller.tiktokshopglobalselling.com/shoppable-videos/inspiration/videos?shop_region=MY',shop:'MY Malaysia (example-shop-my)'},r={target_id:p.target_id,url:p.url,window_name:p.owner,shop:p.shop,observed_at:'2026-11-10T09:00:00Z'};
 assert.equal(api.verifyOwnedPageReceipt(p,r,'2026-11-10T10:00:00Z').verified,true);
 for(const changed of [{target_id:'old'},{url:'https://example.invalid/'},{window_name:'different'},{shop:'SG Singapore'},{observed_at:'2026-11-09T09:00:00Z'}])assert.throws(()=>api.verifyOwnedPageReceipt(p,{...r,...changed},'2026-11-10T10:00:00Z'));
});
