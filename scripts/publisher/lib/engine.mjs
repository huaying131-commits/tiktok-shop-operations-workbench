import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {PublisherError,fail,digest,fileHash,readJSON,writeJSON,appendJSON,day,instant,acquireLock,safeID} from './common.mjs';
import {checkJob,currentRows,unknowns} from './planner.mjs';
import {validatePackage} from './intake.mjs';
import {verifyProductLinkFinalReadback} from '../../../operations/video-publishing/product-link-final-readback.mjs';
import {assertLegacyPublisherPaused} from './runtime-config.mjs';
import {ledgerRecord} from './ledger.mjs';

export const STAGES=['claim','connect','owned_page','link','checkpoint','upload','account','product','fields','presubmit','submit','archive','cleanup'];
const operationKey=(job,stage,op)=>`MY:${job.sha256}:${stage}:${op}`;
export function validateApproval(a,job,at,state) {
 if(!a||typeof a.dalei_quote!=='string'||!a.dalei_quote.trim()||!Array.isArray(a.jobs)||!a.jobs.includes(job.video_id)||!Number.isInteger(a.max_count)||a.max_count<1)fail('approval_required_or_invalid',40);
 const now=instant(at),start=instant(a.valid_from),end=instant(a.expires_at);
 if(start>now||now>=end||end<=start)fail('approval_expired_or_not_yet_valid',40);
 const key=digest(JSON.stringify(a)),consumed=new Set(state.attempts().filter(x=>x.approval_key===key).map(x=>x.job_id));
 if(!consumed.has(job.video_id)&&consumed.size>=a.max_count)fail('approval_budget_exhausted',40);
 return key;
}
function checkIdentity(p,channel) {
 if(channel?.verifyIdentity)return channel.verifyIdentity(p);
 if(p?.login||p?.captcha)fail(p.login?'login_required':'captcha_required',30);
 if(!p?.owner||!p.target_id||!p.url||!p.shop?.includes('Malaysia')||!p.shop.includes('(example-shop-my)'))fail('owned_page_identity_unverified');
 const u=new URL(p.url);if(u.origin!=='https://seller.tiktokshopglobalselling.com'||u.searchParams.getAll('shop_region').length!==1||u.searchParams.get('shop_region')!=='MY')fail('owned_page_market_mismatch');
}
function snapshot(c) {
 const history=typeof c.input.history==='function'?c.input.history():c.input.history;
 const actions=[...c.state.attempts(),...c.state.orphanIntents()];
 const pending=actions.filter(a=>a.status==='unknown');
 return{...history,policy:c.policy,jobs:c.state.jobs(),rows:[...(history?.rows??[]),...c.state.imported(),...pending,...actions.filter(a=>a.published)]};
}
function guard(c) {
 const result=checkJob(c.job,snapshot(c),c.now());
 if(!result.eligible)fail(result.reason,['interval','daily_cap','shop_daily_cap','already_published'].includes(result.reason)?10:20,result);
 return result;
}
async function read(c,op,extra={}) {
 if(!c.driver)fail('browser_driver_required',40);
 const data={job:c.job,context:c.context,session_id:c.session,...extra};
 const result=await (c.driver.read?c.driver.read(op,data):c.driver.call('read',op,data));
 c.readbacks.push({op,at:c.now(),value:result});c.readbacks=c.readbacks.slice(-8);
 if(result===null||result===undefined)fail('observation_unknown',20,{op});
 return result;
}
async function once(c,stage,op,extra={}) {
 const action_key=operationKey(c.job,stage,op),prior=c.state.action(action_key);
 if(prior){if(prior.status!=='verified')fail('original_operation_unknown',20,{action_key});return prior.result;}
 const action={action_key,job_id:c.job.video_id,account:c.job.account,sha256:c.job.sha256,identifiers:c.job.identifiers,stage,op,submit_attempted:stage==='submit',at:c.now(),approval_key:c.approvalKey,session_id:c.session};
 c.state.beginAction(action);
 if(stage==='submit')appendJSON(c.ledger(),ledgerRecord({job:c.job,action,at:c.now(),context:c.context}));
 await c.input.afterIntent?.(stage,op);
 const data={job:c.job,context:c.context,session_id:c.session,action_key,...extra};let result;
 try{result=await (c.driver.write?c.driver.write(op,data):c.driver.call('write',op,data));}
 catch(e){
  const request=c.driver.lastRequest??c.driver.protocol?.lastRequest;
  const original={original_request_id:request?.request_id??null,tool_call_id:request?.tool_call_id??null};
  c.state.finishAction(action_key,{status:'unknown',result_unknown:true,...original,error:e.message});
  if(stage==='submit')appendJSON(c.ledger(),ledgerRecord({job:c.job,action,at:c.now(),context:c.context,result:original}));
  throw e;
 }
 if(!result||result.ok===false)fail('mutation_effect_unknown',20,{op,action_key});
 if(stage!=='submit')c.state.finishAction(action_key,{status:'verified',result_unknown:false,result});
 else{
  c.state.finishAction(action_key,{status:'unknown',result_unknown:true,result,original_request_id:result.original_request_id??null,tool_call_id:result.tool_call_id??null});
  appendJSON(c.ledger(),ledgerRecord({job:c.job,action,at:c.now(),context:c.context,result}));
 }
 return result;
}
async function localClaim(c) {
 const p=readJSON(c.job.manifest);
 const current=validatePackage(p,{policy:c.policy,manifest:c.job.manifest,shortNames:c.input.shortNames??c.job.short_names_snapshot,runtimeConfig:c.input.runtimeConfig});
 if(current.account!==c.job.account||current.sha256!==c.job.sha256||current.manifest_sha256!==c.job.manifest_sha256)fail('job_changed_after_intake');
 const checked=guard(c);
 if(c.input.mode==='live'){
  const file=c.ledger();fs.mkdirSync(path.dirname(file),{recursive:true});
  try{const fd=fs.openSync(file,'ax');fs.closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;}
 }
 return{guard:checked};
}
async function connect(c) {
 let p=await read(c,'connection');if(!p.ready)p=await read(c,'connection');
 if(!p.ready)fail('cli_connection_unavailable');return{serverInstanceId:p.serverInstanceId};
}
async function ownedPage(c) {
 let p=await read(c,'owned_page');
 if(p?.login||p?.captcha)checkIdentity(p,c.driver);
 if(p.missing||p.dialogs||p.progress){await once(c,'owned_page','create_owned_page',{occupied_page:p.missing?null:p});p=await read(c,'owned_page');}
 checkIdentity(p,c.driver);
 if(p.dirty||p.selectedFiles||p.media||p.dialogs||p.progress)fail('existing_form_preserved');
 return{page:p};
}
async function link(c) {
 await once(c,'link','open_product_page');
 const p=await read(c,'product_heading'),age=instant(c.now())-Date.parse(p.at);
 if(p.session_id!==c.session||p.product_id!==c.job.product_id||!p.heading||!p.owner||!p.shop?.includes('(example-shop-my)')||!p.shop.includes('Malaysia')||!Number.isFinite(age)||age<0||age>3600000)fail('current_link_evidence_required');
 const u=new URL(p.url);if(u.origin!=='https://seller.tiktokshopglobalselling.com'||u.pathname!==`/product/edit/${c.job.product_id}`||u.searchParams.get('shop_region')!=='MY')fail('link_product_mismatch');
 if(!c.job.semantic_review.link_title_terms?.length)fail('current_link_membership_rule_missing');
 if(c.job.semantic_review.link_title_terms.some(t=>!p.heading.toLocaleLowerCase().includes(t.toLocaleLowerCase())))fail('product_not_in_current_link');
 return{membership:p};
}
async function checkpoint(c) {
 const data={job_id:c.job.video_id,account:c.job.account,sha256:c.job.sha256,at:c.now(),uploaded:false,submit_attempted:false,published:false,current_upload_attempt:{index:1,official_file_transfer_count:0,actual_input_assignment_count:0}};
 const file=path.join(c.state.dir,'checkpoints',c.job.video_id+'.json');
 if(!fs.existsSync(file))writeJSON(file,data,true);else{const old=readJSON(file);if(old.sha256!==data.sha256||old.account!==data.account)fail('original_checkpoint_mismatch');}
 return{checkpoint:file};
}
async function upload(c) {
 try{
  await once(c,'upload','buffer');await once(c,'upload','transfer');
  const proof=await read(c,'buffer_hash');if(proof.sha256!==c.job.sha256)fail('browser_buffer_sha_mismatch');
  await once(c,'upload','assign');const p=await read(c,'preview');
  if(!p.ready||!p.src||!Number.isFinite(p.duration)||Math.abs(p.duration-c.job.duration_seconds)>.15)fail('original_preview_unknown');
  return{preview:p};
 }catch(e){
  // A verified transport ACK does not prove a completed upload/assignment/preview.
  const actions=c.state.attempts().filter(a=>a.job_id===c.job.video_id&&a.stage==='upload');
  const last=actions.at(-1);if(last)c.state.finishAction(last.action_key,{status:'unknown',result_unknown:true,error:e.message});
  throw e;
 }
}
async function account(c) {
 await once(c,'account','select_account');const p=await read(c,'read_account');if(p.account!==c.job.account)fail('account_readback_mismatch');return{};
}
async function product(c) {
 const attached=await once(c,'product','attach_product');const p=await read(c,'read_product',{selected_product_id:attached.selected_product_id});
 if(p.count!==1||p.product_id!==c.job.product_id||c.job.semantic_review.link_title_terms.some(t=>!p.text?.toLowerCase().includes(t.toLowerCase())))fail('attached_product_readback_mismatch');return{attached:p};
}
async function fields(c) {
 for(const field of ['description','short_name','tags','commercial_disclosure','ai_disclosure']){
  await once(c,'fields',`fill_${field}`,{field,value:c.job[field]??c.job.fields[field]});
  const p=await read(c,'read_fields');
  const expected=c.job[field]??c.job.fields[field];if(JSON.stringify(p[field])!==JSON.stringify(expected))fail('field_readback_mismatch',20,{field});
 }
 return{};
}
async function presubmit(c) {
 guard(c);const p=await read(c,'final_readback');
 const expected={account:c.job.account,description:c.job.description,short_name:c.job.short_name,tags:c.job.tags,...c.job.fields};
 for(const [field,value]of Object.entries(expected))if(JSON.stringify(p[field])!==JSON.stringify(value))fail('presubmit_readback_mismatch',20,{field});
 if(p.product_id!==c.job.product_id||p.product_count!==1||p.ready!==true||p.src!==c.context.preview?.src||Math.abs(p.duration-c.job.duration_seconds)>.15||!Array.isArray(p.errors)||p.errors.length||p.submit_count!==1||p.submit_disabled!==false)fail('presubmit_not_unique_or_not_ready');
 const m=c.context.membership,age=instant(c.now())-Date.parse(m?.at);if(!m||age<0||age>3600000||m.session_id!==c.session)fail('current_session_link_evidence_expired');
 const finalInput={job:{...c.job.package,publish_owner:c.context.page.owner,publish_target_id:c.context.page.target_id},membership:{product_id:c.job.product_id,video_sha256:c.job.sha256,product_in_link:true,product_description:m.heading,evidence_reference:c.state.dir+'/state.db#'+c.job.video_id+'/link',source_type:'official_product_information',observed_at:m.at},live:{at:c.now(),market:'MY',source:'official_owned_publish_form',owner:c.context.page.owner,target_id:c.context.page.target_id,account:p.account,attached_products:[{observed_product_id:p.product_id,source:'platform_attached_product_widget',observed_on_form:true}],upload_sha256_verified:c.job.sha256,video_ready:p.ready,description:p.description,tags:p.tags,ai_disclosure:p.ai_disclosure,commercial_disclosure:p.commercial_disclosure,music_agreement:p.music_agreement,own_brand:p.own_brand,branded_content:p.branded_content,errors:p.errors,submit_already_attempted:false},now:instant(c.now())};
 if(c.driver.verifyFinalReadback)c.driver.verifyFinalReadback(finalInput);else verifyProductLinkFinalReadback(finalInput);
 return{presubmit:p};
}
async function submit(c) {
 // Last guard and complete read immediately before the exclusive submit intent.
 await presubmit(c);const sent=await once(c,'submit','submit');
 const p=await read(c,'confirm');
 if(p.success!==true||p.message!=='Your video has been posted!'||p.owner!==c.context.page.owner||!p.shop?.includes('(example-shop-my)'))fail('submission_result_unknown');
 const at=c.now();instant(at);
 const evidence=path.join(c.state.dir,'success',c.job.video_id+'.json');
 const posted=ledgerRecord({job:c.job,action:{action_key:operationKey(c.job,'submit','submit')},at,context:c.context,result:{...sent,...p,platform_video_id:p.platform_video_id??sent.platform_video_id??null},published:true,successEvidence:evidence});
 // Durable proof precedes final ledger/state updates; reconciliation can recover bookkeeping.
 writeJSON(path.join(c.state.dir,'success',c.job.video_id+'.json'),posted,true);
 appendJSON(c.ledger(),posted);c.state.finishAction(posted.action_key,{...posted,status:'verified',result:p});
 return{posted};
}
async function archive(c) {
 const posted=c.context.posted??readJSON(path.join(c.state.dir,'success',c.job.video_id+'.json'));
 if(!posted.published||fileHash(c.job.file)!==c.job.sha256)fail('archive_source_sha_mismatch');
 const dir=path.join(c.outputRoot,'video-publishing-'+day(posted.published_at),'archive',c.job.account,c.job.video_id);
 fs.mkdirSync(dir,{recursive:true});
 const copies={'video.mp4':c.job.file,'发布任务.json':c.job.manifest};
 const hashes={};
 for(const [name,source]of Object.entries(copies)){
  const dest=path.join(dir,name),expected=fileHash(source);
  if(fs.existsSync(dest)){if(fileHash(dest)!==expected)fail('archive_conflict_no_overwrite',20,{dest});}
  else fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL);
  if(fileHash(dest)!==expected)fail('archive_hash_mismatch');hashes[name]=expected;
 }
 const receipt=path.join(dir,'实际发布信息.json'),info={...posted,description:c.job.description,tags:c.job.tags,short_name:c.job.short_name,original_source_retained:true};
 if(!fs.existsSync(receipt))writeJSON(receipt,info,true);else if(JSON.stringify(readJSON(receipt))!==JSON.stringify(info))fail('archive_receipt_conflict');
 const manifest=path.join(dir,'archive-manifest.json');if(!fs.existsSync(manifest))writeJSON(manifest,{job_id:c.job.video_id,account:c.job.account,sha256:c.job.sha256,files:hashes,source_retained:true},true);
 c.state.putJob({...c.job,published:true,status:'posted_archived',archive_folder:dir});
 appendJSON(c.ledger(),{...posted,status:'posted_archived_public_verification_pending',archived:true,archive_status:'archived',archive_folder:dir,archive_manifest:manifest});
 return{archive_folder:dir};
}
async function cleanup(c) {
 const productPage=await read(c,'product_cleanup_state');
 const productSafe=productPage.created===true&&!productPage.dirty&&!productPage.unknown&&productPage.owner===c.context.membership?.owner&&!!productPage.target_id;
 if(productSafe)await once(c,'cleanup','close_product_page',{page:productPage});
 const p=await read(c,'cleanup_state');
 if(p.dirty||p.unknown||!p.created||p.owner!==c.context.page.owner||p.target_id!==c.context.page.target_id)return{page_preserved:true,product_page_preserved:!productSafe,reason:'dirty_unknown_or_not_owned'};
 await once(c,'cleanup','close_owned_page');return{page_preserved:false,product_page_preserved:!productSafe};
}
export const stageFunctions={claim:localClaim,connect,owned_page:ownedPage,link,checkpoint,upload,account,product,fields,presubmit,submit,archive,cleanup};
function caseFile(c,error) {
 const completed=c.state.stages(c.job.video_id).map(s=>s.stage),attempts=[...c.state.attempts(),...c.state.orphanIntents()].filter(a=>a.job_id===c.job.video_id);
 const code=[10,20,30,40].includes(error.code)?error.code:20;
 if(code===10||code===40)return{exit_code:code,reason:error.reason??error.message};
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+c.job.video_id+'-'+crypto.randomBytes(4).toString('hex');
 const data={id,job_id:c.job.video_id,account:c.job.account,sha256:c.job.sha256,manifest:c.job.manifest,failed_stage:c.stage,error:{reason:error.reason??error.message,details:error.details??{},stack:error.stack},readbacks:c.readbacks,page_text:c.readbacks.map(x=>x.value?.text??x.value?.heading??x.value?.shop??'').filter(Boolean).join('\n').slice(-4000),completed_stages:completed,submit_intent_exists:attempts.some(a=>a.stage==='submit'),original_attempts:attempts,context:c.context,suggested_next_step:code===30?'请大磊本人处理原页面登录或验证码；保留原请求，不上传或提交。':attempts.some(a=>a.status==='unknown')?'只读关联原请求和原表单；确认前禁止重传、赋值、重发或关闭原页。':'核病例中的准确任务、阶段、字段或选择器，修复后恢复已记录阶段。',exit_code:code};
 return{exit_code:code,reason:data.error.reason,case_file:c.state.putCase(data)};
}
export async function run(input) {
 const state=input.state,job=state.job(safeID(input.jobId));if(!job)return{exit_code:40,reason:'job_not_found'};
 const mode=input.mode??'dry';if(!['dry','live'].includes(mode))return{exit_code:40,reason:'invalid_mode'};
 const c={input,state,job,policy:input.policy,driver:input.channel??input.driver,now:input.clock??(()=>new Date().toISOString()),session:crypto.randomUUID(),readbacks:[],context:{},stage:'claim',outputRoot:input.outputRoot??path.resolve(state.dir,'../../outputs')};
 c.ledger=()=>path.join(c.outputRoot,'video-publishing-'+day(c.now()),'发布记录.jsonl');let release;
 try{
  if(mode==='live'){c.approvalKey=validateApproval(input.approval,job,c.now(),state);assertLegacyPublisherPaused(input.automationFile);}
  if(mode==='live')release=acquireLock(input.lockFile??(c.driver?.root?path.join(c.driver.root,'operations/publisher/global.lock'):path.join(state.dir,'publisher.lock')),{job_id:job.video_id,mode});
  if(job.published&&state.stage(job.video_id,'cleanup'))return{exit_code:10,reason:'already_completed'};
  const pending=[...state.attempts(),...state.orphanIntents()].filter(a=>a.job_id===job.video_id&&a.status==='unknown');
  if(pending.length)fail('original_operation_unknown',20,{attempts:pending});
  if(!state.stage(job.video_id,'submit')){
   const current=validatePackage(readJSON(job.manifest),{policy:c.policy,manifest:job.manifest,shortNames:input.shortNames??job.short_names_snapshot,runtimeConfig:input.runtimeConfig});
   if(current.sha256!==job.sha256||current.account!==job.account||current.manifest_sha256!==job.manifest_sha256)fail('job_changed_after_intake');
  }
  if(mode==='dry'){
   await localClaim(c);
   if(c.driver){await connect(c);const p=await read(c,'owned_page',{readonly:true});if(!p.missing)checkIdentity(p,c.driver);}
   return{exit_code:0,mode,video_id:job.video_id,local_validated:true,browser_validated:!!c.driver,submission:false};
  }
  if(!c.driver)fail('browser_driver_required',40);
  // Re-associate by a fresh inventory on each process/session; never trust a persisted target/index.
  if(state.stage(job.video_id,'owned_page')&&!state.stage(job.video_id,'cleanup')){
   c.context=Object.assign({},...state.stages(job.video_id).map(s=>s.context??{}));
   const p=await read(c,'resume_page');checkIdentity(p,c.driver);
   if(p.owner!==c.context.page.owner)fail('original_page_owner_changed');c.context.page=p;
   if(!state.stage(job.video_id,'submit')){
    const linked=await link(c);Object.assign(c.context,linked);
   }
  }
  for(const name of STAGES){
   c.stage=name;const existing=state.stage(job.video_id,name);
   if(existing){for(const [k,v]of Object.entries(existing.context??{}))if(!(k==='membership'&&c.context.membership?.session_id===c.session))c.context[k]=v;continue;}
   if(name!=='claim'&&!['archive','cleanup'].includes(name)){
    if(fileHash(job.file)!==job.sha256||fileHash(job.manifest)!==job.manifest_sha256)fail('video_or_manifest_changed');
   }
   const result=await stageFunctions[name](c);Object.assign(c.context,result);
   state.complete(job.video_id,name,{context:result,at:c.now()});
   await input.afterStage?.(name);
  }
  return{exit_code:0,video_id:job.video_id,status:'posted_archived',platform_video_id:c.context.posted?.platform_video_id??null};
 }catch(e){return caseFile(c,e);}finally{release?.();}
}
export async function reconcile(input) {
 const state=input.state,job=state.job(safeID(input.jobId));if(!job)return{exit_code:40,reason:'job_not_found'};
 const pending=[...state.attempts(),...state.orphanIntents()].filter(a=>a.job_id===job.video_id&&a.status==='unknown');
 if(!pending.length)return{exit_code:10,reason:'no_unknown_operations'};
 const previous=state.cases().filter(c=>c.job_id===job.video_id).at(-1);
 const proof=path.join(state.dir,'success',job.video_id+'.json');
 let result={conclusion:fs.existsSync(proof)?'durable_success_receipt_requires_bookkeeping_review':'unknown',local_success_receipt:fs.existsSync(proof)?readJSON(proof):null};
 const c={state,job,stage:'reconcile',context:previous?.context??{},readbacks:previous?.readbacks??[],now:input.clock??(()=>new Date().toISOString())};
 try{
  const channel=input.channel??input.driver;
  if(channel)result=await (channel.read?channel.read('reconcile',{job,attempts:pending}):channel.call('read','reconcile',{job,attempts:pending}));
  c.readbacks=[...c.readbacks.slice(-7),{op:'reconcile',at:c.now(),value:result}];
  const recorded=caseFile(c,new PublisherError('original_operation_requires_readonly_reconciliation',20));
  return{...recorded,conclusion:result?.conclusion??'unknown',evidence:result,attempts:pending,read_only:true,automatic_replay:false,attempt_state_changed:false};
 }catch(e){return{...caseFile(c,e),read_only:true,automatic_replay:false,attempt_state_changed:false};}
}
