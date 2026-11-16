import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireLocks,withinWorkWindow,contentContinuationPending} from './ziniao-cdp.mjs';
import {matchesSchema} from './ads-manifest-contract.mjs';
import {buildOwnedInspectArgs,buildOwnedUiArgs} from './ads-owned-inspect.mjs';
import {connectionMetadataPreflight} from './ziniao-readonly-preflight.mjs';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV='90000000000001',HOST='seller.tiktokshopglobalselling.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
async function read(p){try{return JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function save(p,v,exclusive=false){await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v,null,2)+'\n',exclusive?{flag:'wx'}:{});}
function payload(reply){const t=reply.output?.content?.find(c=>c.type==='text')?.text;if(!t)return {};try{return JSON.parse(t);}catch{return {snapshot:t};}}
const terminal=r=>['succeeded','failed','cancelled'].includes(r?.status)||!!r?.error;
const retired=r=>['RUNTIME_NOT_FOUND','TOOL_CALL_NOT_FOUND'].includes(r?.error?.code);
function verificationPolicy(value){
 if(value.required_verification_call)return {call:value.required_verification_call,basis:'exact_required_verification_call'};
 if(value.verification_pending&&typeof value.verification_instruction==='string'&&value.verification_instruction.includes('inspect a successful complete snapshot, visible_dom, or screenshot'))return {call:{action:'snapshot',params:{interactive:true}},basis:'explicit_complete_observation_instruction',instruction:value.verification_instruction};
 return {call:null,basis:'missing_contract'};
}
function matching(url,c){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname===HOST&&(Array.isArray(c.path)?c.path:[c.path]).some(p=>u.pathname===p||p.endsWith('/')&&u.pathname.startsWith(p))&&Object.entries(c.query??{}).every(([k,v])=>u.searchParams.getAll(k).length===1&&u.searchParams.get(k)===v);}catch{return false;}}
export function identityGuardArgs(config){
 const js=`(()=>{const c=${JSON.stringify(config)},u=new URL(location.href),h=(document.body?.innerText??'').slice(0,1500);const country={MY:['Malaysia','马来西亚'],SG:['Singapore','新加坡'],VN:['Vietnam','越南']}[c.market]??[],isCS=c.module==='customer_service';const countryMatch=country.some(x=>h.includes(x));const market=isCS?countryMatch&&u.searchParams.get('shop_region')===c.market:h.split(/\\r?\\n/).some(x=>x.trim()===c.market)&&h.includes(({MY:'Malaysia',SG:'Singapore',VN:'Vietnam'})[c.market]??'__unknown__');const route=${matching.toString()}(location.href,c);const shop=isCS?!!c.query?.oec_seller_id&&u.searchParams.get('oec_seller_id')===c.query.oec_seller_id:h.includes(c.shopLabel);const ok=window.name===c.windowName&&route&&shop&&market&&(!u.searchParams.has('shop_region')||u.searchParams.get('shop_region')===c.market);if(!ok)return{ok:false,name:window.name,url:location.href,reason:'owner_market_route_mismatch'};return{ok:true,name:window.name,url:location.href,market:c.market,dates:Array.from(document.querySelectorAll('input[placeholder="开始日期"],input[placeholder="结束日期"]')).filter(e=>e.getClientRects().length).map(e=>({placeholder:e.placeholder,value:e.value})),search:Array.from(document.querySelectorAll('input[placeholder="输入 [/] 进行搜索和筛选"]')).filter(e=>e.getClientRects().length).map(e=>e.value),selected_creatives:document.querySelectorAll('table input[type=checkbox]:checked').length}})()`;
 return {action:'evaluate',params:{download:false,js:js.replace('u.hostname===HOST',`u.hostname===${JSON.stringify(HOST)}`)}};
}
export function assessConnectionState({environmentId,expectedStoreName,health,online,connection,healthAfter}){
 const base={environment:environmentId,observedAt:new Date().toISOString(),ready:false,businessReady:false,automaticLifecycleAllowed:false,requestManualStoreStart:false,testWindowProven:false,serviceHealthy:false,storeRunning:null,connected:null,serverInstanceId:health?.server_instance_id??null};
 const fail=code=>({...base,code});
 if(!['90000000000001','90000000000002'].includes(environmentId)||!expectedStoreName)return fail('EXPLICIT_EXPECTED_ENVIRONMENT_REQUIRED');
 if(health?.status!=='ok'||health?.service!=='ziniao-eco-tools'||!health.server_instance_id)return fail('LOCAL_AGENT_SERVICE_UNAVAILABLE');
 base.serviceHealthy=true;
 if(healthAfter?.status!=='ok'||healthAfter?.service!=='ziniao-eco-tools'||healthAfter.server_instance_id!==health.server_instance_id)return fail('LOCAL_AGENT_REPLACED_DURING_CHECK');
 if(online?.success!==true||!Array.isArray(online?.data?.items))return fail('RUNNING_STORE_INVENTORY_UNAVAILABLE');
 const matches=online.data.items.filter(x=>x.store_id===environmentId);
 if(matches.length===0)return {...fail('STORE_NOT_RUNNING'),storeRunning:false,requestManualStoreStart:true};
 if(matches.length!==1||matches[0].store_name!==expectedStoreName||matches[0].platform_id!=='92')return fail('EXACT_STORE_IDENTITY_MISMATCH');
 base.storeRunning=true;
 if(connection?.success!==true||!connection.data||typeof connection.data.connected!=='boolean')return fail('CONNECTION_STATUS_UNAVAILABLE');
 if(connection.data.store_id!==environmentId)return fail('CONNECTION_TARGET_MISMATCH');
 base.connected=connection.data.connected;
 if(!base.connected)return fail('MANUAL_INSTANCE_AGENT_DISCONNECTED');
 return {...base,ready:true,code:'READY_FOR_OWNED_PAGE_VERIFICATION'};
}
export function createCliTransport({root=ROOT,spawnImpl=spawn,binary=path.join(root,'outputs/fulfillment-daily/2026-10-17/cli-recovery-options/package/bin/zn-open-eco.exe'),metadataRetryDelayMs=750}={}){
 const approved=path.join(root,'outputs/fulfillment-daily/2026-10-17/cli-recovery-options/package/bin/zn-open-eco.exe');if(path.resolve(binary)!==path.resolve(approved))throw Error('OnlyApprovedNativeEcoTransport');
 const invoke=argv=>new Promise((resolve,reject)=>{
  const operation=argv[0]==='browser'?`browser.${argv[1]}`:argv[1]==='tool'?(argv[2]==='status'?'agent.tool.status':'agent.tool.submit'):'agent.manifest';
  // Never kill an in-flight CLI on a local timeout: server watchClientAbort disposes its runtime.
  const child=spawnImpl(binary,argv,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'}});let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>{try{resolve(JSON.parse(stdout));}catch{reject(new Error('CLIResponseUnknown:'+JSON.stringify({operation,code,pid:child.pid,stderr:stderr.slice(0,500),stdout:stdout.slice(0,500)})));}});
 });
 return {preflight:()=>connectionMetadataPreflight({invoke,assessConnectionState,environmentId:ENV,expectedStoreName:'马来西亚示例店（玩具）',retryDelayMs:metadataRetryDelayMs}),manifest:()=>invoke(['agent','manifest']),submit:r=>invoke(['agent','tool','--browser-id',ENV,'--task-id',r.taskId,'--tool-call-id',r.toolCallId,'--name',r.name??'browser','--arguments-json',JSON.stringify(r.args),'--wait-seconds','0']),status:r=>invoke(['agent','tool','status','--browser-id',ENV,'--tool-call-id',r.toolCallId,'--wait-seconds','1'])};
}
export async function loadGatewayConfigs(root=ROOT){
 const registry=await read(path.join(root,'operations/browser-module-targets.json')),cfg={};
 for(const b of registry.bindings.filter(b=>b.environment_id===ENV&&b.eco_binding?.task_id&&b.eco_binding?.window_name)){
  const e=b.eco_binding,url=e.last_observed_url??e.marker_url??b.last_observed_url;let u;try{u=new URL(url);}catch{continue;}
  cfg[b.module]={module:b.module,taskId:e.task_id,windowName:e.window_name,market:e.market??b.market,shopLabel:e.shop_label??b.shop_label,path:e.allowed_paths??u.pathname,query:{},evidence:e.evidence??e.current_page_evidence};
  if(b.module==='ads')Object.assign(cfg[b.module],{market:'MY',path:'/ads-creation/dashboard',query:{shop_region:'MY',campaign_id:'9000000000000003',product_id:'9000000000000000016'}});
  if(b.module==='customer_service')cfg[b.module].query={shop_region:e.market??b.market,oec_seller_id:e.shop_id};
 }
 return cfg;
}
export class EcoGateway {
 constructor({root=ROOT,configs,transport,clock=()=>new Date(),manifest,allowReportUi=false}={}){Object.assign(this,{root,configs,transport:transport??createCliTransport({root}),clock,manifest,allowReportUi});this.base=path.join(root,'operations/browser-runtime/eco-gateway');}
 async section({module,sectionId,waitMs=0,reconcileOnly=false},job=async()=>{}){
  if(!/^[a-z0-9_-]+$/.test(module??'')||!/^[a-z0-9_-]{1,90}$/.test(sectionId??''))throw Error('ExplicitModuleAndUniqueSectionRequired');
  if(!withinWorkWindow(this.clock(),['--module',module,'--environment',ENV],process.env.DALEI_FULFILLMENT_NIGHT_ROUND_DATE??'','',module==='content'&&contentContinuationPending()))throw Error('Outside09To23');
  const configs=this.configs??await loadGatewayConfigs(this.root),config=configs[module];if(!config?.taskId||!config.windowName)throw Error('RegisteredOriginalContextMissing');
  const dir=path.join(this.base,'sections',module,sectionId),resultFile=path.join(dir,'result.json');if(await read(path.join(dir,'intent.json')))throw Error('SectionAlreadyAttempted_ReadSavedResult');
  let lock;const deadline=Date.now()+Math.min(Math.max(waitMs,0),20000);
  for(;;){try{lock=await acquireLocks(path.join(this.root,'operations/browser-runtime/initialization'),['environment:'+ENV],module);break;}catch(e){if(!e.message.startsWith('ResourceBusy')||Date.now()>=deadline)throw e;await sleep(30);}}
  let sequence=0,lastId,selected=false,ownsIntent=false;
  const section={module,sectionId,taskId:config.taskId,startedAt:this.clock().toISOString(),canonicalLock:'initialization/environment:'+ENV};
  const activeFile=path.join(this.base,'active.json'),contextFile=path.join(this.base,'context.json');
  const recordStatus=async(old,r)=>{const p=path.join(this.base,'reconciliations',hash(old.toolCallId).slice(0,24)+'-'+Date.now()+'.json');await save(p,{at:this.clock().toISOString(),original:old,reply:r,replayed:false});return p;};
  try{
   if(await read(path.join(dir,'intent.json')))throw Error('SectionAlreadyAttempted_ReadSavedResult');
   try{await save(path.join(dir,'intent.json'),section,true);ownsIntent=true;}catch(e){if(e.code==='EEXIST')throw Error('SectionAlreadyAttempted_ReadSavedResult');throw e;}
   await save(path.join(dir,'lock-acquired.json'),{at:new Date().toISOString(),owner:module,canonicalLock:section.canonicalLock,paths:lock.paths},true);
   if(this.transport.preflight){let ready;try{ready=await this.transport.preflight();}catch(e){ready={ready:false,code:'CONNECTION_METADATA_UNAVAILABLE',error:e.message,automaticLifecycleAllowed:false,requestManualStoreStart:false};}await save(path.join(dir,'connection-preflight.json'),ready,true);if(ready.ready!==true)throw Error('ConnectionPreflight:'+ready.code);}
   if(this.transport.manifest){const m=await this.transport.manifest();if(!m.tools?.find(t=>t.function?.name==='browser'))throw Error('FreshManifestUnavailable');this.manifest=m;await save(path.join(dir,'current-manifest.json'),{observedAt:this.clock().toISOString(),source:'official agent manifest',manifest:m},true);}
   const pending=await read(activeFile);if(pending){const r=await this.transport.status({toolCallId:pending.toolCallId});await recordStatus(pending,r);if(!terminal(r))throw Error('PriorToolStillActive_QueryOriginalOnly');if(retired(r)){await save(path.join(this.base,'retired-unknown',hash(pending.toolCallId)+'.json'),{original:pending,reply:r,businessOutcomeKnown:false,replayed:false});}else if(pending.kind==='verification'||r.status==='succeeded'&&payload(r).verification_pending){
    const pendingConfig=configs[pending.module],resolvedSnapshot=payload(r).snapshot,alreadyVerified=pending.verificationToolCallId===pending.toolCallId&&r.status==='succeeded'&&resolvedSnapshot&&!resolvedSnapshot.includes('[truncated')&&(!pending.ownedURLRequired||pendingConfig&&matching(resolvedSnapshot.split('\n')[0].replace(/^url:\s*/,''),pendingConfig));
    const policy=verificationPolicy(payload(r)),required=pending.requiredVerification??policy.call;if(!alreadyVerified){if(module!==pending.module||!required)throw Error('PriorRequiredVerificationUnresolved_ResumeOriginalContext');
    if(this.manifest&&!matchesSchema(this.manifest.tools.find(t=>t.function?.name==='browser').function.parameters,required))throw Error('RequiredVerificationSchemaMismatch');
    const toolCallId='eg-resume-'+hash(sectionId+'-'+pending.toolCallId).slice(0,30),request={taskId:pending.taskId,toolCallId,args:required,verificationBasis:pending.verificationBasis??policy.basis,instructionSourceToolCallId:pending.parentToolCallId??pending.toolCallId};await save(path.join(dir,'resume-required.request.json'),request,true);await save(activeFile,{...pending,parentToolCallId:pending.parentToolCallId??pending.toolCallId,verificationToolCallId:toolCallId,toolCallId,phase:'required_dispatched',kind:'verification',requiredVerification:required,verificationBasis:request.verificationBasis});let v=await this.transport.submit(request),polls=0;while(!terminal(v)&&polls++<30)v=await this.transport.status({toolCallId});await save(path.join(dir,'resume-required.result.json'),v,true);const s=payload(v).snapshot;if(v.status!=='succeeded'||!s||s.includes('[truncated')||pending.ownedURLRequired&&!matching(s.split('\n')[0].replace(/^url:\s*/,''),config))throw Error('PriorRequiredVerificationUnresolved');}
   }await fs.unlink(activeFile);}
   if(reconcileOnly){if(!pending||retired((await read(path.join(this.base,'retired-unknown',hash(pending.toolCallId)+'.json')))?.reply))throw Error('OriginalVerificationNotAvailable_NoReplay');const outcome={...section,status:'verification_completed',originalToolCallId:pending.parentToolCallId??pending.toolCallId,finishedAt:this.clock().toISOString(),replayed:false,reconcileOnly:true};await save(resultFile,outcome);return outcome;}
   const send=async(label,args,{effect='read',autoVerify=true,name='browser'}={})=>{
    if(effect==='business')throw Error('BusinessNotEnabled_RequiresLiveCrossWindowAndActionValidation');
    if(!['read','report-ui'].includes(effect))throw Error('ExplicitEffectRequired');
    if(name==='browser'&&effect==='read'&&!['navigate','tabs','snapshot','visible_dom','screenshot','evaluate'].includes(args.action))throw Error('WriteRequiresExplicitEffect');
    if(name==='browser'&&(args.action==='upload_file'||args.action==='navigate'&&args.params?.url||args.action==='tabs'&&!['list','select'].includes(args.params?.action)))throw Error('LifecycleOrUnreviewedSubmissionDisabled');
    if(this.manifest&&!matchesSchema(this.manifest.tools.find(t=>t.function?.name===name).function.parameters,args))throw Error('CurrentManifestArgumentsMismatch');
    const step=String(++sequence).padStart(3,'0')+'-'+label.replace(/[^a-z0-9_-]/g,'').slice(0,35),toolCallId='eg-'+module.slice(0,12)+'-'+hash(sectionId).slice(0,12)+'-'+step;
    lastId=toolCallId;const request={taskId:config.taskId,toolCallId,name,args},pending={...section,toolCallId,effect,argsHash:hash(args),step,dispatchedAt:this.clock().toISOString()};
    await save(path.join(dir,step+'.request.json'),request,true);await save(activeFile,pending);
    let reply;try{reply=await this.transport.submit(request);await save(path.join(dir,step+'.submit.json'),reply,true);let polls=0;while(!terminal(reply)&&polls++<30){reply=await this.transport.status({toolCallId});await save(path.join(dir,step+'.status-'+polls+'.json'),reply,true);if(!terminal(reply))await sleep(150);}}catch(e){await save(path.join(dir,step+'.unknown.json'),{toolCallId,error:e.message,replayed:false});throw Error('UnknownTool:'+toolCallId+':'+e.message);}
    if(retired(reply)||!terminal(reply))throw Error('UnknownTool:'+toolCallId+':'+(reply.error?.code??reply.status));
    await fs.unlink(activeFile);const value=payload(reply);
    if(autoVerify&&value.verification_pending){const policy=verificationPolicy(value),required=policy.call;let verificationId;const hold=async reason=>{const inflight=await read(activeFile);await save(activeFile,{...pending,...(inflight??{}),kind:'verification',parentToolCallId:pending.toolCallId,verificationToolCallId:inflight?.toolCallId??verificationId??lastId,toolCallId:inflight?.toolCallId??pending.toolCallId,ownedURLRequired:selected,requiredVerification:required??null,verificationBasis:policy.basis,reason});throw Error(reason);};if(!required)await hold('RequiredVerificationContractMissing');await save(path.join(dir,step+'.verification-policy.json'),policy,true);let v;try{const verified=await send(label+'-verify',required,{effect:'read',autoVerify:false});verificationId=verified.toolCallId;v=verified.value;}catch(e){await hold('RequiredVerificationFailed:'+e.message);}if(!v.snapshot||v.snapshot.includes('[truncated'))await hold('CompleteVerificationRequired');if(selected){const u=v.snapshot.split('\n')[0].replace(/^url:\s*/,'');if(!matching(u,config))await hold('VerificationOwnerURLMismatch');}}
    if(reply.error||reply.status!=='succeeded'||reply.output?.is_error)throw Error('ToolFailed:'+JSON.stringify(reply.error??value));
    return {reply,value,toolCallId};
   };
   const context=await read(contextFile);let compatible=context?.taskId===config.taskId;
   if(compatible&&context.lastToolCallId){const r=await this.transport.status({toolCallId:context.lastToolCallId});await recordStatus({...context,toolCallId:context.lastToolCallId},r);compatible=!retired(r)&&r.status==='succeeded';}
   const inventory=await send('tabs',{action:'tabs',params:{action:'list'}}),tabs=inventory.value.tabs?.filter(t=>matching(t.url,config));if(tabs?.length!==1)throw Error('ExactOwnedURLMissingOrAmbiguous');
   await send('select',{action:'tabs',params:{action:'select',index:tabs[0].index}});selected=true;
   // tabs(list/select) are metadata routing prerequisites, not a page inspection.
   // Bootstrap a new original context only after selecting its exact owned URL:
   // navigating the previous owner's media page caused a live payload disconnect.
   if(!compatible)await send('bootstrap',{action:'navigate',params:{}},{effect:'read'});
   const guard=async label=>{
    const args=identityGuardArgs(config);
    const r=await send(label,args);const identity=r.value.result;if(identity?.ok!==true||identity.name!==config.windowName||!matching(identity.url,config))throw Error('OwnerGuardRejected:'+JSON.stringify(identity));return identity;
   };
   const identity=await guard('guard-before');
   const ownedScope=()=>({windowName:config.windowName,inventory:{observedAt:Date.now(),urls:[identity.url]}});
   const result=await job({identity,config,call:async(label,args,options={})=>{if(!selected)throw Error('OwnerNotBound');if(options.effect&&options.effect!=='read')throw Error('BusinessNotEnabled_ReadOnlyProjectionPhase');if(args.action==='evaluate')throw Error('ArbitraryEvaluationDisabled_UseFixedProjection');if(!['snapshot','visible_dom','screenshot'].includes(args.action))throw Error('WriteRequiresExplicitEffect_FixedReadsOnly');return send(label,args,{effect:'read'});},tabs:()=>send('listed-tabs',{action:'tabs',params:{action:'list'}}),store:(label,value)=>send(label,{operation:'write_variable',name:'gateway_'+module+'_'+hash(sectionId).slice(0,16),value},{name:'variable_storage',effect:'read'}),adsRead:async(label,spec)=>{if(module!=='ads')throw Error('AdsProjectionScopeOnly');return send(label,buildOwnedInspectArgs(ownedScope(),spec),{effect:'read'});},adsUi:async(label,spec)=>{if(module!=='ads'||!this.allowReportUi)throw Error('ReportUiNotEnabledUntilCrossWindowReview');return send(label,buildOwnedUiArgs(ownedScope(),spec),{effect:'report-ui'});},guard});
   const finalIdentity=await guard('guard-after');await save(contextFile,{module,taskId:config.taskId,lastToolCallId:lastId,at:this.clock().toISOString(),verifiedIdentity:finalIdentity});
   const outcome={...section,status:'verified',finishedAt:this.clock().toISOString(),identity,finalIdentity,result,lastToolCallId:lastId,replayed:false};await save(resultFile,outcome);return outcome;
  }catch(e){if(ownsIntent){const active=await read(activeFile),outcome={...section,status:active?'unknown':'failed_before_business_dispatch',error:e.message,lastToolCallId:lastId,activeQueue:active,replayed:false,finishedAt:this.clock().toISOString()};await save(resultFile,outcome);}throw e;}
  finally{await lock.release();if(ownsIntent)await save(path.join(dir,'lock-released.json'),{at:new Date().toISOString(),owner:module,canonicalLock:section.canonicalLock,queue:await read(activeFile)},true);}
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,module,sectionId]=process.argv.slice(2);if(!['probe','verify-pending'].includes(command))throw Error('CLI supports probe/verify-pending MODULE UNIQUE_SECTION_ID');
 const gateway=new EcoGateway();try{const out=await gateway.section({module,sectionId,waitMs:20000,reconcileOnly:command==='verify-pending'});console.log(JSON.stringify(out));}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
}
