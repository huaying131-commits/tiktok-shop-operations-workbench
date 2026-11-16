// One-off direct user instruction: 今天一条视频都没发，抓紧发啊. Only content/cross1; expires 2026-10-14 01:00 Beijing. Shared runtime unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE=path.join(ROOT,'operations/browser-runtime');
const REGISTRY=path.join(ROOT,'operations/browser-module-targets.json');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
export function withinWorkWindow(now,argv=[],nightDate=''){
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const value=t=>parts.find(p=>p.type===t).value,h=Number(value('hour'));
 if(h>=9&&h<23)return true;
 const date=[value('year'),value('month'),value('day')].join('-');
 const modules=argv.flatMap((x,i)=>x==='--module'?[argv[i+1]]:x.startsWith('--module=')?[x.slice(9)]:[]);
 return h===23&&nightDate===date&&modules.length===1&&modules[0]==='procurement_fulfillment';
}
export function workTime(){const a=process.argv;const scoped=a[a.indexOf('--module')+1]==='content'&&a[a.indexOf('--environment')+1]==='90000000000001';if(!scoped||Date.now()<Date.parse('2026-10-13T15:29:00Z')||Date.now()>=Date.parse('2026-10-13T17:00:00Z'))throw Error('OutsideExplicitContentContinuation');}
export function resolveBinding(config,module,environment){const rows=config.bindings.filter(x=>x.module===module&&x.environment_id===environment);if(rows.length!==1)throw Error('BindingMissingOrAmbiguous');return rows[0];}
export function resolveExactTarget(tabs,id){const row=tabs.find(x=>x.id===id&&x.type==='page');if(!row)throw Error('ExactTargetMissing_NoActivePageFallback');return row;}
export function allowedBrowserHosts(config,b){return [...new Set([...(config.allowed_hosts||[]),...(b.allowed_hosts||[])])];}
export function allowedBrowserUrl(value,hosts){try{const u=new URL(value);return u.protocol==='https:'&&hosts.includes(u.hostname);}catch{return false;}}
export function guardedExpression(config,b,g,source){
 const country={MY:'Malaysia',SG:'Singapore',VN:'Vietnam'}[g.market];
 return `(()=>{const g=${JSON.stringify(g)};const u=new URL(location.href);const h=(document.body?.innerText||'').slice(0,2200);if(u.protocol!=='https:'||!${JSON.stringify(allowedBrowserHosts(config,b))}.includes(u.hostname)||location.href!==g.url||document.querySelector('input[type=password]'))throw Error('GuardRejectedURLOrLogin');const m=u.searchParams.get('shop_region');if(m&&m!==g.market)throw Error('GuardRejectedMarket');if(g.id){const key=u.hostname==='affiliate.tiktokshopglobalselling.com'?'shop_id':'oec_seller_id';if(u.searchParams.get(key)!==g.id)throw Error('GuardRejectedShopId');}else if(!h.includes(g.label)||!h.includes(${JSON.stringify(country)}))throw Error('GuardRejectedShopLabel');return (${source.trim().replace(/;\s*$/,'')});})()`;
}
const contained=(base,file)=>{const rel=path.relative(path.resolve(base),path.resolve(file));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('PathOutsideWorkspace');return path.resolve(file);};
async function save(file,data){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(data,null,2)+'\n');}

export async function acquireLocks(base,keys,owner){
 base=path.resolve(base);await fs.mkdir(base,{recursive:true});const token=crypto.randomUUID();const held=[];
 async function release(){for(const dir of held.reverse()){const f=path.join(dir,'owner.json');const current=JSON.parse(await fs.readFile(f,'utf8'));if(current.token!==token)throw Error('LockOwnershipChanged');await fs.unlink(f);await fs.rmdir(dir);}held.length=0;}
 try{for(const key of [...new Set(keys)].sort()){const dir=contained(base,path.join(base,digest(key)));try{await fs.mkdir(dir);}catch(e){if(e.code==='EEXIST')throw Error('ResourceBusy:'+key);throw e;}held.push(dir);await save(path.join(dir,'owner.json'),{key,owner,token,pid:process.pid,at:new Date().toISOString(),status:'active'});}}
 catch(e){await release();throw e;}
 return {token,paths:[...held],release,async quarantine(details){for(const dir of held){const f=path.join(dir,'owner.json');const old=JSON.parse(await fs.readFile(f,'utf8'));await save(f,{...old,...details,status:details.status||'unknown'});}}};
}

export class Cdp{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.method){this.events.push(r);return;}const p=this.pending.get(r.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(r.id);r.error?p.reject(Error('CDP:'+r.error.message)):p.resolve(r.result);});ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDPDisconnected'));}this.pending.clear();});}
 static async connect(url){const u=new URL(url);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1')throw Error('OnlyObservedLocalZiniaoEndpointAllowed');const ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('CDPConnectTimeout'));},7000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDPConnectRejected'));},{once:true});});return new Cdp(ws);}
 call(method,params={},sessionId){workTime();const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDPRequestTimeout'));},25000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
 close(){this.ws.close();}
}

export async function jsonGet(url){const r=await fetch(url,{signal:AbortSignal.timeout(7000)});if(!r.ok)throw Error('LocalEndpointHTTP'+r.status);return r.json();}
export async function attachTab(browser,tabId){
 const info=(await browser.call('Target.getTargetInfo',{targetId:tabId})).targetInfo;
 if(info.type!=='tab')throw Error('StableTabTargetRequired');
 const parent=(await browser.call('Target.attachToTarget',{targetId:tabId,flatten:true})).sessionId;
 await browser.call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'page'}]},parent);
 let event;
 for(let i=0;i<20;i++){event=browser.events.find(x=>x.method==='Target.attachedToTarget'&&x.sessionId===parent&&x.params.targetInfo.type==='page'&&!x.params.targetInfo.subtype);if(event)break;await new Promise(r=>setTimeout(r,50));}
 if(!event)throw Error('ExactTabCurrentPageUnavailable');
 const session=event.params.sessionId;
 return {target:event.params.targetInfo,tabTargetId:tabId,cdp:{call:(m,p)=>browser.call(m,p,session),close:()=>browser.close()}};
}
export async function recoverOwnedTab(browser,b,hosts=['seller.tiktokshopglobalselling.com']){
 const tabs=(await browser.call('Target.getTargets',{filter:[{type:'tab'}]})).targetInfos;
 const hits=[];
 for(const t of tabs.filter(x=>x.type==='tab'&&(allowedBrowserUrl(x.url,hosts)||x.url===b.initial_url))){
  const a=await attachTab(browser,t.targetId);const h=await a.cdp.call('Page.getNavigationHistory');
  if(h.entries.some(x=>x.url===b.initial_url))hits.push(a);
 }
 if(hits.length!==1)throw Error('OwnedTabMissingOrAmbiguous_NoURLOrActivePageFallback');
 return hits[0];
}
export async function connectBinding(config,b){
 workTime();const e=config.environments.find(x=>x.environment_id===b.environment_id);if(!e)throw Error('UnknownEnvironment');
 if(e.paused_by_user)throw Error('EnvironmentDeferredByUser_NoBrowserAccess');
 const version=await jsonGet(`http://127.0.0.1:${e.port}/json/version`);
 if(version.webSocketDebuggerUrl!==e.browser_websocket)throw Error('BrowserRestarted_RebindFromLiveIdentity_NoFallback');
 if(b.tab_target_id){const browser=await Cdp.connect(e.browser_websocket);try{let a;try{a=await attachTab(browser,b.tab_target_id);}catch(err){if(!err.message.includes('No target with given id'))throw err;a=await recoverOwnedTab(browser,b,allowedBrowserHosts(config,b));}return {...a,environment:e};}catch(err){browser.close();throw err;}}
 const t=resolveExactTarget(await jsonGet(`http://127.0.0.1:${e.port}/json/list`),b.target_id);
 const c=await Cdp.connect(t.webSocketDebuggerUrl);
 try{const i=(await c.call('Target.getTargetInfo',{targetId:b.target_id})).targetInfo;if(i.targetId!==b.target_id)throw Error('TargetMismatch');return {cdp:c,target:i,environment:e};}catch(e){c.close();throw e;}
}
export const INSPECT=`(()=>{const h=(document.body?.innerText||'').slice(0,1800);return {url:location.href,title:document.title,ready:document.readyState,visibility:document.visibilityState,countries:['Malaysia','Singapore','Vietnam'].filter(x=>h.includes(x)),shopLabels:h.split(/\\n/).map(x=>x.trim()).filter(x=>/^\\([^()]{1,120}\\)$/.test(x)&&!/^[()0-9]+$/.test(x)),hasPassword:!!document.querySelector('input[type=password]'),dialogs:document.querySelectorAll('[role=dialog]').length};})()`;
export async function evaluate(c,expression){const r=await c.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('PageException:'+(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,500));return r.result?.value;}
function argumentsMap(argv){const [command,...rest]=argv;const a={command};for(let i=0;i<rest.length;i++){if(!rest[i].startsWith('--'))throw Error('ExpectedNamedArgument');const k=rest[i].slice(2);const v=rest[i+1]?.startsWith('--')||rest[i+1]===undefined?true:rest[++i];if(k==='resource')(a.resources??=[]).push(v);else a[k]=v;}return a;}

async function main(){
 workTime();const a=argumentsMap(process.argv.slice(2));const config=JSON.parse(await fs.readFile(REGISTRY,'utf8'));
 if(!config.enabled)throw Error('ModuleTargetRuntimeDisabled');
 if(a.command==='list'){console.log(JSON.stringify(config.bindings.map(x=>({module:x.module,environment_id:x.environment_id,tab_target_id:x.tab_target_id,target_id:x.target_id,initial_url:x.initial_url})),null,2));return;}
 if(!a.module||!a.environment)throw Error('ExplicitModuleAndEnvironmentRequired');
 const b=resolveBinding(config,a.module,a.environment);
 if(a.command==='reconcile'){
  if(!a['action-key']||!['verified','failed_before_effect'].includes(a.status)||!a.evidence)throw Error('ReconcileNeedsKeyStatusAndEvidence');
  const ev=contained(ROOT,path.resolve(ROOT,a.evidence));const evidence=await fs.readFile(ev);const file=path.join(STATE,'actions',digest(a['action-key'])+'.json');const journal=JSON.parse(await fs.readFile(file,'utf8'));
  if(journal.module!==a.module||journal.environment!==a.environment)throw Error('ActionOwnerMismatch');
  if(!['awaiting_readback','unknown'].includes(journal.status))throw Error('ActionAlreadyReconciledOrNotDispatched');
  for(const dir of journal.lock_paths){contained(path.join(STATE,'resources'),dir);const f=path.join(dir,'owner.json');const owner=JSON.parse(await fs.readFile(f,'utf8'));if(owner.token!==journal.lock_token)throw Error('LockOwnershipChanged');await fs.unlink(f);await fs.rmdir(dir);}
  journal.status=a.status;journal.evidence={path:path.relative(ROOT,ev),sha256:digest(evidence)};journal.reconciled_at=new Date().toISOString();await save(file,journal);console.log(JSON.stringify({status:a.status,action_key:a['action-key']}));return;
 }
 const stableTarget='module:'+b.module+':environment:'+b.environment_id;
 const lock=await acquireLocks(path.join(STATE,'pages'),['target:'+b.environment_id+':'+stableTarget],a.module);
 let c,resource,actionFile,journal,actualTarget,actualTab,dispatched=false;const started=new Date().toISOString();
 const output=a.output?contained(ROOT,path.resolve(ROOT,a.output)):path.join(STATE,'receipts',Date.now()+'-'+crypto.randomUUID()+'.json');
 try{
  const connection=await connectBinding(config,b);c=connection.cdp;actualTarget=connection.target.targetId;actualTab=connection.tabTargetId||null;
  if(a.command==='activate'){
   const startup=await acquireLocks(path.join(STATE,'initialization'),['environment:'+b.environment_id],a.module);
   try{await c.call('Page.bringToFront');}finally{await startup.release();}
   const record={status:'owned_page_activated_loading_not_yet_verified',started,finished:new Date().toISOString(),module:a.module,environment_id:b.environment_id,tab_target_id:actualTab,target_id:actualTarget};
   await save(output,record);console.log(JSON.stringify({output,...record}));return;
  }
  const before=await evaluate(c,INSPECT);let result;
  if(a.command==='inspect'){result=before;}
  else if(a.command==='navigate'){
   if(!a.url||!a['expect-url']||before.url!==a['expect-url'])throw Error('FreshObservedURLRequired');
   if(!allowedBrowserUrl(a.url,allowedBrowserHosts(config,b)))throw Error('UnapprovedBrowserHost');
   if((await fs.readdir(path.join(STATE,'actions')).catch(()=>[])).length){
    for(const f of await fs.readdir(path.join(STATE,'actions'))){const x=JSON.parse(await fs.readFile(path.join(STATE,'actions',f),'utf8'));if(x.module===b.module&&x.environment===b.environment_id&&['awaiting_readback','unknown'].includes(x.status))throw Error('ReconcilePendingActionBeforeNavigating');}
   }
   result=await c.call('Page.navigate',{url:a.url});if(result.errorText)throw Error('NavigationError:'+result.errorText);
  }else if(a.command==='exec'){
   if(!a.script||!a['expect-url']||!['MY','SG','VN'].includes(a.market)||(!a['shop-label']&&!a['shop-id']))throw Error('ScriptFreshURLMarketAndShopGuardRequired');
   const source=await fs.readFile(contained(ROOT,path.resolve(ROOT,a.script)),'utf8');
   const g={url:a['expect-url'],market:a.market,label:a['shop-label']||null,id:a['shop-id']||null};
   const expression=guardedExpression(config,b,g,source);
   if(a.write){
    if(!a['action-key']||!a.resources?.length)throw Error('BusinessWriteNeedsUniqueActionKeyAndResources');
    resource=await acquireLocks(path.join(STATE,'resources'),a.resources,a.module);
    actionFile=path.join(STATE,'actions',digest(a['action-key'])+'.json');await fs.mkdir(path.dirname(actionFile),{recursive:true});
    journal={action_key:a['action-key'],module:a.module,environment:a.environment,target:stableTarget,tab_target_id:actualTab,page_target_id:actualTarget,resources:a.resources,lock_paths:resource.paths,lock_token:resource.token,status:'dispatch_pending',script_sha256:digest(source),started};
    try{await fs.writeFile(actionFile,JSON.stringify(journal,null,2),{flag:'wx'});}catch(e){await resource.release();resource=null;if(e.code==='EEXIST')throw Error('ActionKeyAlreadyAttempted_ReadExistingResult');throw e;}
   }
   workTime();dispatched=!!a.write;result=await evaluate(c,expression);
   if(journal){journal.status='awaiting_readback';journal.returned_at=new Date().toISOString();await save(actionFile,journal);await resource.quarantine({status:'awaiting_readback',action_key:a['action-key']});resource=null;}
  }else throw Error('UnknownCommand');
  const record={status:a.write?'returned_independent_readback_required':'returned',started,finished:new Date().toISOString(),module:a.module,environment_id:b.environment_id,tab_target_id:actualTab,target_id:actualTarget,before,result,action_key:a['action-key']||null};
  await save(output,record);console.log(JSON.stringify({output,...record}));
 }catch(e){if(resource){if(dispatched){journal.status='unknown';journal.error=e.message;await save(actionFile,journal);await resource.quarantine({status:'unknown',action_key:a['action-key']});}else await resource.release();}await save(output,{status:dispatched?'unknown':'failed_before_business_dispatch',started,module:a.module,environment_id:b.environment_id,tab_target_id:b.tab_target_id||null,target_id:actualTarget||null,error:e.message,action_key:a['action-key']||null});throw e;}
 finally{c?.close();await lock.release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});

