#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {State} from './lib/state.mjs';
import {readJSON,writeJSON,fail,acquireLock,safeID,instant} from './lib/common.mjs';
import {loadHistory} from './lib/history.mjs';
import {intake,validatePackage} from './lib/intake.mjs';
import {channelName,planShoppableVideo,readShoppableProductAssociation,readShoppableReadiness,readShoppableReconciliation,runVerifiedShoppablePrecheck} from './channels/tiktok-shop-api.mjs';
import {checkJob,plan} from './lib/planner.mjs';
import {run,reconcile,validateApproval} from './lib/engine.mjs';
import {loadRuntimeConfig,assertLegacyPublisherPaused} from './lib/runtime-config.mjs';
import {buildShortNameCatalog,loadApprovedShortNames,mergeApprovedNames} from './lib/product-short-names.mjs';
import {exportCompat} from './lib/export-compat.mjs';

const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const DEFAULT_SOURCE='C:/Users/Operator/Workspace/我的产品/产品视频/未发布视频';
export function clockFor(options,getNow=Date.now){if(options.at){const fixed=instant(options.at);return()=>new Date(fixed).toISOString();}return()=>new Date(getNow()).toISOString();}
export function parse(argv){
 const [command,...args]=argv;
 const commands=['intake','plan','run','reconcile','status','export-compat','api-shadow','api-preflight','api-reconcile','api-upload-precheck'];
 if(!commands.includes(command))fail('usage: '+commands.join('|'),40);
 const opts={command},allowed=new Set(['root','state-dir','source-dir','job','mode','approval','at','out']);
 for(let n=0;n<args.length;n+=2){const key=args[n]?.replace(/^--/,'');if(!args[n]?.startsWith('--')||!allowed.has(key)||!args[n+1]||args[n+1].startsWith('--')||key in opts)fail('invalid_cli_arguments',40);opts[key]=args[n+1];}
 return opts;
}
function recordCase(state,job,error,stage='intake'){
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+(job??'intake')+'-'+crypto.randomBytes(4).toString('hex');
 return state.putCase({id,job_id:job??null,manifest:error.manifest??null,failed_stage:stage,error,readbacks:[],page_text:'',completed_stages:[],submit_intent_exists:false,suggested_next_step:'读取准确清单及原因，补齐制作验收数据；保留所有原始文件和旧队列。',exit_code:20});
}
export async function main(argv){
 const o=parse(argv),root=path.resolve(o.root??DEFAULT_ROOT),stateDir=path.resolve(o['state-dir']??path.join(root,'operations/publisher'));
 const apiPrecheckLive=o.command==='api-upload-precheck'&&o.mode==='live';
 if(apiPrecheckLive&&(o.at||o.root||o['state-dir']))fail('api_precheck_requires_canonical_state_and_real_time',40);
 const readonly=['status','plan','export-compat','api-shadow','api-preflight','api-reconcile','api-upload-precheck'].includes(o.command);
 const runtimeConfig=loadRuntimeConfig();
 if(apiPrecheckLive&&runtimeConfig.live_enabled!==true)fail('publisher_live_disabled',40);
 const state=new State(stateDir,{readonly:readonly&&!apiPrecheckLive});
 try{
  const policy=readJSON(path.join(root,'operations/module-execution-policy.json'));
  const clock=clockFor(o),at=clock();
  if(o.command==='status')return{exit_code:0,jobs:state.jobs().map(j=>({video_id:j.video_id,account:j.account,sha256:j.sha256,status:j.status??'validated',issues:j.issues??[]})),attempts:[...state.attempts(),...state.orphanIntents()],stages:state.jobs().flatMap(j=>state.stages(j.video_id).map(s=>({job_id:j.video_id,...s}))),cases:state.cases(),state_exists:!!state.db};
  const history=()=>loadHistory(root);
  if(o.command==='export-compat'){if(!o.out)fail('temporary_output_required',40);return exportCompat({root,state,outDir:o.out,policy,history:history(),at});}
  if(o.command==='plan'){
   const h=history(),attempts=[...state.attempts(),...state.orphanIntents()];
   return plan({...h,policy,jobs:state.jobs(),rows:[...h.rows,...attempts.filter(a=>a.status==='unknown'||a.published)]},at);
  }
  if(o.command==='intake'){
   const release=acquireLock(path.join(stateDir,'publisher.lock'),{mode:'intake'});
   try{
    const h=history();
    // Source snapshots replace their own import rows; never mutate the old queue or ledger.
    state.import('historical-ledgers',h.rows);
    const legacyNames=path.join(root,'operations/publisher/product-short-names.json');
    const shortNames=mergeApprovedNames(buildShortNameCatalog(h),loadApprovedShortNames(legacyNames));
    const candidateFile=path.join(stateDir,'product-short-names.json');writeJSON(candidateFile,shortNames);
    const result=intake({state,sourceDir:path.resolve(o['source-dir']??DEFAULT_SOURCE),policy,history:h,shortNames,runtimeConfig});
    writeJSON(path.join(stateDir,'products-needing-short-names.json'),result.products_needing_short_names);
    result.short_name_catalog=candidateFile;
    for(const r of result.results.filter(x=>!x.accepted&&x.exit_code===20)){
     const prior=state.cases().find(c=>c.failed_stage==='intake'&&c.manifest===r.manifest&&c.error?.reason===r.reason);
     r.case_file=prior?path.join(stateDir,'cases',prior.id+'.json'):recordCase(state,r.video_id,{reason:r.reason,issues:r.issues,semantic_mapping:r.semantic_mapping,manifest:r.manifest});
    }
    return result;
   }finally{release();}
  }
  const jobId=safeID(o.job),job=state.job(jobId);if(!job)return{exit_code:40,reason:'job_not_found'};
  if(o.command==='api-reconcile')return await readShoppableReconciliation({job,attempts:[...state.attempts(),...state.orphanIntents()],
   readProductAssociation:readShoppableProductAssociation});
  const mode=o.mode??'dry';if(!['dry','live'].includes(mode))return{exit_code:40,reason:'invalid_mode'};
  const approval=o.approval?readJSON(path.resolve(o.approval)):null;
  const catalog=path.join(stateDir,'product-short-names.json'),shortNames=fs.existsSync(catalog)?readJSON(catalog):job.short_names_snapshot;
  if(['api-shadow','api-preflight','api-upload-precheck'].includes(o.command)){
   const current=validatePackage(readJSON(job.manifest),{policy,manifest:job.manifest,shortNames,runtimeConfig});
   if(current.account!==job.account||current.sha256!==job.sha256||current.manifest_sha256!==job.manifest_sha256)fail('job_changed_after_intake');
   if(o.command==='api-preflight')return await readShoppableReadiness({job:current});
   if(!apiPrecheckLive)return await planShoppableVideo(current);
   if(approval?.channel!==channelName||approval.operation!=='upload_precheck'||approval.account!==current.account||
      approval.product_id!==current.product_id||approval.sku_id!==current.sku_id||approval.sha256!==current.sha256){
    fail('api_precheck_approval_required',40);
   }
   const release=acquireLock(path.join(root,'operations/publisher/global.lock'),{job_id:jobId,channel:channelName});
   try{
    const approvalKey=validateApproval(approval,job,clock(),state);
    assertLegacyPublisherPaused();
    const attempts=[...state.attempts(),...state.orphanIntents()];
    if(attempts.some(row=>row.sha256===job.sha256&&row.stage==='submit'))fail('original_submission_requires_reconciliation');
    const h=history();
    const decision=checkJob(current,{...h,policy,jobs:state.jobs(),
      rows:[...h.rows,...state.imported(),...attempts.filter(row=>row.status==='unknown'||row.published)]},clock());
    if(!decision.eligible)return{exit_code:20,reason:decision.reason,details:decision};
    return await runVerifiedShoppablePrecheck({job:current,state,approvalKey});
   }finally{release();}
  }
  const input={state,jobId,mode,approval,policy,history,clock,shortNames,runtimeConfig,outputRoot:path.join(root,'outputs'),lockFile:path.join(root,'operations/publisher/global.lock')};
  if(o.command==='reconcile'){
   // First phase keeps CLI reconcile local/read-only. Official request correlation can be injected in the library.
   return await reconcile(input);
  }
  if(mode==='live'){
   // Validate approval before loading anything that can invoke the CLI.
   validateApproval(approval,job,at,state);
   assertLegacyPublisherPaused();
   // This release is intentionally offline: real submission switching requires a separate direct human decision.
   return{exit_code:40,reason:'phase1_offline_only_real_live_switch_not_released',approval_validated:true};
  }
  return await run(input);
 }finally{state.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await main(process.argv.slice(2));console.log(JSON.stringify(result,null,2));process.exitCode=result.exit_code;}
 catch(e){const code=[20,30,40].includes(e.code)?e.code:40;console.log(JSON.stringify({exit_code:code,reason:e.reason??e.message,details:e.details??{}}));process.exitCode=code;}
}
