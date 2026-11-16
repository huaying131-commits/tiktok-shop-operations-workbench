import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('module-scoped browser coordination',async t=>{
 let driver;try{driver=await import('./ziniao-cdp.mjs');}catch{}
 assert.ok(driver,'Module-scoped driver is not implemented');
 const dir=path.join(root,'outputs/browser-parallel-review-2026-10-12/lock-test-'+Date.now());
 await fs.mkdir(dir,{recursive:true});
 await t.test('same business resource blocks only its competitor, different resources continue',async()=>{
   const a=await driver.acquireLocks(dir,['shop:my:order:1'],'fulfillment');
   await assert.rejects(driver.acquireLocks(dir,['shop:my:order:1'],'other'),/ResourceBusy/);
   const b=await driver.acquireLocks(dir,['shop:my:conversation:2'],'customer_service');
   await b.release();await a.release();
   const next=await driver.acquireLocks(dir,['shop:my:order:1'],'other');await next.release();
 });
 await t.test('partial multi-resource acquisition is rolled back',async()=>{
   const a=await driver.acquireLocks(dir,['Z'],'first');
   await assert.rejects(driver.acquireLocks(dir,['A','Z'],'second'),/ResourceBusy/);
   const b=await driver.acquireLocks(dir,['A'],'third');await b.release();await a.release();
 });
 await t.test('unknown action stays blocked until evidence-based reconciliation',async()=>{
   const a=await driver.acquireLocks(dir,['order:unknown'],'first');await a.quarantine({status:'unknown',actionKey:'send-1'});
   await assert.rejects(driver.acquireLocks(dir,['order:unknown'],'second'),/ResourceBusy/);
 });
 await t.test('unknown module and missing exact page cannot use another module page',()=>{
   const config={bindings:[{module:'ads',environment_id:'env',target_id:'exact'}]};
   assert.throws(()=>driver.resolveBinding(config,'customer_service','env'),/BindingMissing/);
   assert.equal(driver.resolveBinding(config,'ads','env').target_id,'exact');
   assert.throws(()=>driver.resolveExactTarget([{id:'another',type:'page'}],'missing'),/ExactTargetMissing/);
 });
 await t.test('affiliate access remains module scoped and requires the exact shop and market',()=>{
   const config={allowed_hosts:['seller.tiktokshopglobalselling.com']};
   const creator={module:'creators',allowed_hosts:['affiliate.tiktokshopglobalselling.com']};
   const ads={module:'ads'};
   const url='https://affiliate.tiktokshopglobalselling.com/affiliate/sample/sample-request?shop_region=MY&shop_id=9000000000000000099';
   assert.equal(driver.allowedBrowserUrl(url,driver.allowedBrowserHosts(config,creator)),true);
   assert.equal(driver.allowedBrowserUrl(url,driver.allowedBrowserHosts(config,ads)),false);
   assert.equal(driver.allowedBrowserUrl(url.replace('affiliate.tiktokshopglobalselling.com','affiliate.tiktokshopglobalselling.com.example.org'),driver.allowedBrowserHosts(config,creator)),false);
   const run=(binding,id='9000000000000000099',market='MY',password=false)=>vm.runInNewContext(driver.guardedExpression(config,binding,{url,id,market,label:null},'42'),{URL,location:{href:url},document:{body:{innerText:''},querySelector:()=>password?{}:null}});
   assert.equal(run(creator),42);
   assert.throws(()=>run(ads),/GuardRejectedURLOrLogin/);
   assert.throws(()=>run(creator,'wrong'),/GuardRejectedShopId/);
   assert.throws(()=>run(creator,'9000000000000000099','VN'),/GuardRejectedMarket/);
   assert.throws(()=>run(creator,'9000000000000000099','MY',true),/GuardRejectedURLOrLogin/);
   const seller='https://seller.tiktokshopglobalselling.com/chat/inbox/current?shop_region=MY&oec_seller_id=9000000000000000099';
   const sellerRun=(id,actual=seller)=>vm.runInNewContext(driver.guardedExpression(config,ads,{url:seller,id,market:'MY',label:null},'43'),{URL,location:{href:actual},document:{body:{innerText:''},querySelector:()=>null}});
   assert.equal(sellerRun('9000000000000000099'),43);
   assert.throws(()=>sellerRun('wrong'),/GuardRejectedShopId/);
   assert.throws(()=>sellerRun('9000000000000000099',seller+'&changed=1'),/GuardRejectedURLOrLogin/);
 });
});
