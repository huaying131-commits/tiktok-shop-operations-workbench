import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {buildOwnedRead,buildOwnedReadArgs} from './ads-owned-window.mjs';
const url='https://seller.tiktokshopglobalselling.com/ads-creation/dashboard?shop_region=MY&campaign_id=9000000000000003&product_id=9000000000000000016';
const stamp=Date.now();
const scope={windowName:'codex-ads-20261019',inventory:{observedAt:stamp,urls:[url]},requireCampaign:true,requireProduct:true};
function page(name,href=url,shop='MY\nMalaysia\n(example-shop-my)'){
 return {name,closed:false,location:{href},document:{body:{innerText:shop,childElementCount:1}},close(){this.closed=true;}};
}
const code=()=>buildOwnedRead(scope);
test('drifted current page reads own named window only',()=>{
 const own=page(scope.windowName),other=page('content','https://seller.tiktokshopglobalselling.com/affiliate/landing');
 const calls=[];other.open=(u,n)=>{calls.push([u,n]);return own;};
 const r=vm.runInNewContext(code(),{window:other,URL,Date});
 assert.equal(r.ok,true);assert.equal(r.data.actual,scope.windowName);assert.equal(other.name,'content');
 assert.deepEqual(calls,[['',scope.windowName]]);
});
test('already-owned caller does not open any window',()=>{
 const own=page(scope.windowName);own.open=()=>{throw Error('Must not open');};
 assert.equal(vm.runInNewContext(code(),{window:own,URL,Date}).ok,true);
});
test('wrong shop cannot run payload',()=>{
 const own=page(scope.windowName,url,'MY\nMalaysia\n(other-shop)');
 const r=vm.runInNewContext(code(),{window:own,URL,Date});assert.equal(r.ok,false);assert.equal(r.reason,'shop_mismatch');assert(!r.data);
});
test('wrong campaign fails before payload',()=>{
 const own=page(scope.windowName,url.replace('9000000000000003','000'));
 const r=vm.runInNewContext(code(),{window:own,URL,Date});assert.equal(r.ok,false);assert.equal(r.reason,'campaign_mismatch');
});
test('lookup requires a fresh unique ads inventory',()=>{
 const other=page('content');let calls=0;other.open=()=>{calls++;return page(scope.windowName);};
 const expr=buildOwnedRead({...scope,inventory:{observedAt:stamp-120000,urls:[url]}});
 const r=vm.runInNewContext(expr,{window:other,URL,Date});assert.equal(r.reason,'fresh_unique_inventory_required');assert.equal(calls,0);
});
test('unexpected blank fails and cleans only fresh created empty named window',()=>{
 const other=page('content'),blank=page(scope.windowName,'about:blank','');blank.opener=other;blank.document.body.childElementCount=0;
 other.open=()=>blank;const r=vm.runInNewContext(code(),{window:other,URL,Date});
 assert.equal(r.reason,'owned_window_missing');assert.equal(blank.closed,true);assert.equal(r.cleanedNewBlank,true);
});
test('cross-origin handle is refused with no payload',()=>{
 const other=page('content');other.open=()=>({closed:false,get location(){throw Error('SecurityError');}});
 const r=vm.runInNewContext(code(),{window:other,URL,Date});assert.equal(r.reason,'owned_window_not_accessible');assert(!r.data);
});
test('longer IDs sharing the prefix are refused',()=>{
 const own=page(scope.windowName,url.replace('9000000000000003','90000000000000001').replace('9000000000000000016','90000000000000000001'));
 const r=vm.runInNewContext(code(),{window:own,URL,Date});assert.equal(r.ok,false);
});
test('read helper rejects arbitrary expressions including location writes',()=>{
 assert.throws(()=>buildOwnedRead(scope,'(location.href="https://example.invalid/")'),/FixedReadOnlyProjection/);
});
test('product ID prefix and duplicate campaign params are refused independently',()=>{
 for(const href of [url.replace('9000000000000000016','90000000000000000001'),url+'&campaign_id=9000000000000003']){
  assert.equal(vm.runInNewContext(code(),{window:page(scope.windowName,href),URL,Date}).ok,false);
 }
});
test('ordinary ads overview does not make exact campaign/product candidate ambiguous',()=>{
 const own=page(scope.windowName),other=page('content');other.open=()=>own;
 const code=buildOwnedRead({...scope,inventory:{observedAt:Date.now(),urls:[url,'https://seller.tiktokshopglobalselling.com/ads-creation/dashboard?mpa=1&type=product']}});
 assert.equal(vm.runInNewContext(code,{window:other,URL,Date}).ok,true);
});
test('complete public evaluate arguments obey freshly captured manifest',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../outputs/ads-monitoring/2026-10-19/page-routing-1406/continuation-1431/current-manifest.json',import.meta.url),'utf8'));
 const branch=manifest.tools.find(t=>t.function?.name==='browser').function.parameters.anyOf.find(b=>b.properties?.action?.const==='evaluate');
 const args=buildOwnedReadArgs(scope),schema=branch.properties.params;
 for(const key of schema.required)assert(key in args.params,'Missing public required '+key);
 for(const key of Object.keys(args.params))assert(key in schema.properties,'Unknown public property '+key);
 assert.equal(args.action,'evaluate');assert.equal(args.params.download,false);assert.equal(typeof args.params.js,'string');
});
