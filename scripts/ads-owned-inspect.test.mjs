import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {buildOwnedInspectArgs} from './ads-owned-inspect.mjs';
const url='https://seller.tiktokshopglobalselling.com/ads-creation/dashboard?shop_region=MY&campaign_id=9000000000000003&product_id=9000000000000000016';
const scope={windowName:'codex-ads-20261019',inventory:{observedAt:Date.now(),urls:[url]}};
test('inspection accepts only fixed modes and bounded offsets',()=>{
 for(const spec of [{mode:'script',js:'1'},{mode:'creative_rows',offset:-1},{mode:'creative_rows',offset:1001},{mode:'ui',expression:'location.href="x"'}])assert.throws(()=>buildOwnedInspectArgs(scope,spec));
 const a=buildOwnedInspectArgs(scope,{mode:'creative_rows',offset:0});assert.equal(a.params.download,false);assert.equal(a.action,'evaluate');
});
test('strict scope refuses prefix ID before reading a table',()=>{
 const caller={name:scope.windowName,location:{href:url.replace('9000000000000003','90000000000000001')},document:{body:{innerText:'MY\nMalaysia\n(example-shop-my)'},querySelectorAll(){throw Error('Must not inspect');}}};
 assert.equal(vm.runInNewContext(buildOwnedInspectArgs(scope,{mode:'creative_rows',offset:0}).params.js,{window:caller,URL,Date}).reason,'campaign_mismatch');
});
test('missing creative table is unknown, never zero orders',()=>{
 const caller={name:scope.windowName,location:{href:url},document:{body:{innerText:'MY\nMalaysia\n(example-shop-my)'},querySelectorAll(){return [];}}};
 const r=vm.runInNewContext(buildOwnedInspectArgs(scope,{mode:'creative_rows',offset:0}).params.js,{window:caller,URL,Date});assert.equal(r.ok,true);assert.equal(r.data.available,false);assert.equal(r.data.orders,null);
});
