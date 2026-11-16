import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {fixture} from './support.mjs';
import {OfficialDriver} from '../lib/browser-driver.mjs';
import {readJSON} from '../lib/common.mjs';
const S=readJSON(new URL('../selectors.json',import.meta.url));
function setup(){
 const f=fixture(),url='https://seller.tiktokshopglobalselling.com/shoppable-videos/inspiration/videos?shop_region=MY&scene_type=1',owner='codex-content-offline-test';
 const node=(extra={})=>({getClientRects:()=>[{}],getAttribute:()=>null,disabled:false,innerText:'',...extra});
 const map=new Map([
  [S.shop,[node({innerText:'MY Malaysia (example-shop-my)'})]],[S.form,[node()]],[S.account,[node({innerText:'example-creator-1'})]],
  [S.video,[node({readyState:2,duration:15.04,currentSrc:'blob:original'})]],
  [S.attachedProduct,[node({parentElement:{parentElement:{parentElement:{innerText:'Kit DIY'}}}})]],
  [S.submit,[node()]],[S.tags,[node({innerText:'#KitDIY'})]],
  [S.description,[node({value:f.pkg.description_ms})]],[S.short_name,[node({value:'Kit DIY'})]],
  ...['ai_disclosure','commercial_disclosure'].map(k=>[S[k],[node({getAttribute:()=> 'true'})]]),
  ...['own_brand','music_agreement','branded_content'].map(k=>[S[k],[node({checked:k!=='branded_content'})]]),
 ]);
 const context={document:{querySelectorAll:s=>map.get(s)??[],body:{innerText:''}},window:{name:owner},location:{href:url},Date,JSON};
 const calls=[];const tr={preflight:async()=>({ready:true,serverInstanceId:'fake'}),submit:async request=>{
  calls.push(request);const args=request.args;let value={ok:true},tabs;
  if(args.action==='tabs'&&args.params.action==='list')tabs=[{index:3,id:'current-target',url}];
  if(args.action==='evaluate')value=await vm.runInNewContext(args.params.js,context);
  return{request_id:'req-'+request.toolCallId,tool_call_id:request.toolCallId,browser_id:'fake',status:'succeeded',output:{content:[{type:'text',text:JSON.stringify({result:value,...tabs?{tabs}:{}})}]}};
 }};
 const driver=new OfficialDriver({root:f.dir,stateDir:path.join(f.dir,'state'),runtime:{task_id:'offline-task',environment_id:'fake',owner,product_owner:'codex-content-product-offline',publish_url:url,product_edit_url:'https://seller.tiktokshopglobalselling.com/product/edit/200?shop_region=MY'},transport:tr});
 const page={owner,url,target_id:'current-target',shop:'MY Malaysia (example-shop-my)'};
 return{f,map,calls,driver,page,close:()=>f.cleanup()};
}
test('official driver is lazy; generated complete form read executes against independent fake DOM',async()=>{
 const t=setup();try{
  assert.equal(t.calls.length,0);assert.equal((await t.driver.call('read','connection')).ready,true);assert.equal(t.calls.length,0);
  const p=await t.driver.call('read','final_readback',{job:{...t.f.pkg,account:'example-creator-1'},context:{page:t.page,attached:{product_id:'200',text:'Kit DIY'}}});
  assert.equal(p.description,t.f.pkg.description_ms);assert.equal(p.account,'example-creator-1');assert.equal(p.product_id,'200');assert.equal(p.submit_count,1);assert.equal(t.calls.some(c=>c.args.action==='click'),false);
 }finally{t.close();}
});
test('official driver missing or ambiguous submit control never dispatches click',async()=>{
 for(const count of [0,2]){const t=setup();try{
  t.driver.page=t.page;t.map.set(S.submit,Array.from({length:count},()=>({getClientRects:()=>[{}]})));
  await assert.rejects(()=>t.driver.uiClick(S.submit),/UniqueSelector/);assert.equal(t.calls.some(c=>c.args.action==='click'),false);
 }finally{t.close();}}
});
test('complete readback never echoes intended parent after visible attached card changes',async()=>{
 const t=setup();try{
  t.map.get(S.attachedProduct)[0].parentElement.parentElement.parentElement.innerText='Different product';
  const p=await t.driver.call('read','final_readback',{job:{...t.f.pkg,account:'example-creator-1'},context:{page:t.page,attached:{product_id:'200',text:'Kit DIY'}}});
  assert.equal(p.product_id,null);
 }finally{t.close();}
});
test('confirmed empty inventory permits one explicit MY homepage entry before owned-page creation',async()=>{
 const t=setup();try{
  const home='https://seller.tiktokshopglobalselling.com/homepage?shop_region=MY';t.driver.runtime.source={owner:'',url:home};
  t.driver.inventory=async()=>[];const calls=[];
  t.driver.raw=async a=>{calls.push(a);return{value:{ok:true}};};
  t.driver.findOwned=async(owner,url)=>({owner,url,shop:'MY Malaysia (example-shop-my)',target_id:'fresh-home',dirty:false});
  t.driver.mutate=async()=>({ok:true});
  await t.driver.call('write','create_owned_page');assert.equal(calls.filter(c=>c.action==='navigate').length,1);assert.equal(calls[0].params.url,home);
 }finally{t.close();}
});
