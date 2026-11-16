import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {buildOwnedUiArgs} from './ads-owned-inspect.mjs';
const url='https://seller.tiktokshopglobalselling.com/ads-creation/dashboard?shop_region=MY&campaign_id=9000000000000003&product_id=9000000000000000016';
const scope={windowName:'codex-ads-20261019',inventory:{observedAt:Date.now(),urls:[url]}};
const spec={kind:'open-search',expected_start:'2026-10-18',expected_end:'2026-10-18',expected_pairs:1,expected_search:''};
function fake({shop='MY\nMalaysia\n(example-shop-my)',changed=false,selected=false}={}){
 let clicks=0;const start={value:changed?'2026-10-17':'2026-10-18'},end={value:'2026-10-18'},field={value:'',focus(){},click(){clicks++;}},table={querySelectorAll(s){if(s==='thead th')return [{innerText:'创意素材'},{innerText:'作品 ID'}];if(s.includes('checked'))return selected?[{}]:[];return [];}};
 const document={body:{innerText:shop},querySelectorAll(s){if(s==='table')return [table];if(s==='input[placeholder="开始日期"]')return [start];if(s==='input[placeholder="结束日期"]')return [end];if(s==='input[placeholder="输入 [/] 进行搜索和筛选"]')return [field];return [];}};
 const window={name:scope.windowName,location:{href:url},document};return {window,clicks:()=>clicks};
}
test('fixed search action operates only after scope and state checks',()=>{const f=fake();const r=vm.runInNewContext(buildOwnedUiArgs(scope,spec).params.js,{window:f.window,URL,Date});assert.equal(r.data.dispatched,true);assert.equal(f.clicks(),1);});
test('wrong shop, changed dates and selected creative never click',()=>{for(const p of [{shop:'MY\nMalaysia\n(other)'},{changed:true},{selected:true}]){const f=fake(p);const r=vm.runInNewContext(buildOwnedUiArgs(scope,spec).params.js,{window:f.window,URL,Date});assert.equal(f.clicks(),0);assert(r.ok===false||r.data.dispatched===false);}});
test('paid exclusion, arbitrary selector and scripts are refused',()=>{for(const s of [{...spec,kind:'exclude'},{...spec,selector:'button'},{...spec,expression:'1'}])assert.throws(()=>buildOwnedUiArgs(scope,s));});
test('slash filter entry uses a fixed value, no arbitrary search string',()=>{assert.doesNotThrow(()=>buildOwnedUiArgs(scope,{...spec,kind:'filter-menu'}));assert.throws(()=>buildOwnedUiArgs(scope,{...spec,kind:'filter-menu',value:'arbitrary'}));});
test('date selection accepts a valid fixed day and refuses invalid days',()=>{assert.doesNotThrow(()=>buildOwnedUiArgs(scope,{...spec,kind:'choose-date',date:'2026-10-03'}));assert.throws(()=>buildOwnedUiArgs(scope,{...spec,kind:'choose-date',date:'2026-02-31'}));});
