import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {validateBrowserReadArgs} from './ads-manifest-contract.mjs';import {buildOwnedReadArgs} from './ads-owned-window.mjs';
const dir=new URL('../outputs/ads-monitoring/2026-10-19/page-routing-1406/continuation-1431/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('current-manifest.json',dir),'utf8'));
const result=JSON.parse(fs.readFileSync(new URL('w2-tabs-a.result.json',dir),'utf8'));
const tabs=JSON.parse(JSON.parse(result.stdout).output.content[0].text).tabs;
const scope={windowName:'codex-ads-20261019',inventory:{observedAt:Date.now(),urls:tabs.map(t=>t.url)}};
test('full generated request validates against current browser schema',()=>{
 assert.equal(validateBrowserReadArgs(manifest,buildOwnedReadArgs(scope)).action,'evaluate');
 assert.equal(validateBrowserReadArgs(manifest,{action:'tabs',params:{action:'list'}}).action,'tabs');
});
test('old code, missing download, unknown property and navigation are refused',()=>{
 for(const args of [{action:'evaluate',params:{code:'1'}},{action:'evaluate',params:{js:'1'}},{action:'evaluate',params:{js:'1',download:false,code:'1'}},{action:'evaluate',params:{js:'1',download:true}},{action:'navigate',params:{}}])assert.throws(()=>validateBrowserReadArgs(manifest,args));
});
test('real five-tab/two-ads fixture resolves only exact campaign/product candidate',()=>{
 assert.equal(tabs.length,5);assert.equal(tabs.filter(t=>new URL(t.url).pathname.startsWith('/ads')).length,2);
 const own={name:scope.windowName,closed:false,location:{href:tabs[2].url},document:{body:{innerText:'MY\nMalaysia\n(example-shop-my)'}}};
 const caller={name:'codex-content-20261018',location:{href:tabs[1].url},open:(url,name)=>{assert.equal(url,'');assert.equal(name,scope.windowName);return own;}};
 const args=buildOwnedReadArgs(scope),out=vm.runInNewContext(args.params.js,{window:caller,URL,Date});
 assert.equal(out.ok,true);assert.equal(out.identity.ownerUrl,tabs[2].url);
});
