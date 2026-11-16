import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {readJSON,writeJSON,fileHash,day,instant,fail} from './common.mjs';
import {currentRows,unknowns,isSubmissionUnknown,plan,limits} from './planner.mjs';

function temporaryOutput(outDir){
 const out=path.resolve(outDir),tmp=fs.realpathSync(os.tmpdir()),rel=path.relative(tmp,out);
 if(!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('temporary_output_required',40,{out});
 let parent=out;while(!fs.existsSync(parent))parent=path.dirname(parent);
 const actual=path.relative(tmp,fs.realpathSync(parent));if(actual.startsWith('..')||path.isAbsolute(actual))fail('temporary_output_required',40,{out});
 return out;
}
export function exportCompat({root,state,outDir,policy,history,at=new Date().toISOString()}){
 const out=temporaryOutput(outDir),now=instant(at),date=day(now),sources=[];
 function source(relative){
  if(!relative)return{};const file=path.resolve(root,relative),rel=path.relative(root,file).replaceAll('\\','/');
  if(rel.startsWith('..')||path.isAbsolute(rel)||rel==='operations/controller/latest.json')fail('invalid_compat_source',40,{file});
  if(!fs.existsSync(file))return{};sources.push({file,sha256:fileHash(file)});return readJSON(file);
 }
 const continuation=source('operations/video-publishing-continuation.json'),old=continuation.current_continuation??{};
 const canonical=source(old.canonical_accepted_queue),checkpoint=source(old.checkpoint),worker=source(old.state??old.current_native_worker_state),heartbeat=source(old.heartbeat);
 const jobs=state.jobs(),rows=currentRows([...(history.rows??[]),...state.attempts().filter(a=>a.published||a.status==='unknown'),...state.orphanIntents()]),pending=unknowns(rows),submissions=pending.filter(isSubmissionUnknown),uploads=pending.filter(r=>!isSubmissionUnknown(r));
 const successes=[...new Map(rows.filter(r=>r.published&&!r.archive_identity_only).map(r=>[r.account+':'+r.sha256,r])).values()];
 const status=plan({...history,rows,policy,jobs:[]},at),l=limits(policy),counts={},last={};
 for(const {account}of policy.content_account_vertical_policy.accounts){
  const gap=status.accounts.find(x=>x.account===account)?.reason==='history_gap';
  counts[account]=gap?null:successes.filter(r=>r.account===account&&Number.isFinite(Date.parse(r.published_at))&&day(r.published_at)===date).length;
  const times=successes.filter(r=>r.account===account&&Number.isFinite(Date.parse(r.published_at))&&Date.parse(r.published_at)<=now).map(r=>r.published_at).sort((a,b)=>Date.parse(a)-Date.parse(b));last[account]=times.at(-1)??null;
 }
 const countKnown=Object.values(counts).every(n=>n!==null),total=countKnown?Object.values(counts).reduce((a,b)=>a+b,0):null;
 const today=successes.filter(r=>Number.isFinite(Date.parse(r.published_at))&&day(r.published_at)===date);
 const aircraft=countKnown?today.filter(r=>r.aircraft||(policy.content_aircraft_product_link_policy?.known_aircraft_product_ids??[]).includes(r.product_id)).length:null;
 const byId=new Map((canonical.accepted_jobs??checkpoint.accepted_jobs??history.reservations??[]).map(j=>[j.video_id??j.job_id,{...j}])),conflicts=[];
 for(const job of jobs){const prior=byId.get(job.video_id);if(prior&&(prior.account!==job.account||prior.sha256&&prior.sha256!==job.sha256)){conflicts.push({video_id:job.video_id,reason:'legacy_job_identity_conflict'});continue;}byId.set(job.video_id,{...prior,...job,package:job.manifest,published:job.published===true,publication_authorized:false});}
 for(const job of byId.values()){
  const posted=successes.find(r=>r.account===job.account&&r.sha256===job.sha256);
  if(posted)Object.assign(job,{published:true,published_at:posted.published_at,status:posted.status??'posted',success_evidence:posted.success_evidence??null});
  const unknown=pending.filter(r=>r.account===job.account&&r.sha256===job.sha256);
  if(!job.published&&unknown.length)Object.assign(job,{result_unknown:true,submit_attempted:unknown.some(isSubmissionUnknown),original_unknown_operations:unknown});
 }
 const accepted=[...byId.values()],waiting=accepted.filter(j=>!j.published),completed=accepted.filter(j=>j.published).map(j=>j.video_id);
 const shared={updated_at:at,at,actual_date:date,today_successes:total,today_independent_successes:total,success_count_today:total,business_publication_successes:total,verified_today_successes:total,real_success_today:total,successes_by_account:counts,counts_by_account:counts,account_counts:counts,last_success_by_account:last,daily_target:l.total,daily_target_gap:total===null?null:Math.max(0,l.total-total),daily_target_remaining:total===null?null:Math.max(0,l.total-total),daily_target_complete:total!==null&&total>=l.total,per_account_daily_cap:l.perAccount,minimum_account_interval_seconds:l.interval,actual_aircraft_successes_today:aircraft,aircraft_successes:aircraft,aircraft_successes_today:aircraft,aircraft_daily_gap:aircraft===null?null:Math.max(0,l.aircraft-aircraft),unknown_submissions:submissions.length,unknown_submission_count_for_this_round:submissions.length,unknown_uploads:uploads,protected_operation_records:pending,protected_current_native_upload:pending.length>0||old.protected_current_native_upload===true,registered_pending:waiting.length,registered_pending_count:waiting.length,pending:waiting.map(j=>({video_id:j.video_id,account:j.account,sha256:j.sha256,status:j.status})),pending_registered_job_ids:waiting.map(j=>j.video_id),completed_registered_job_ids:[...new Set([...(old.completed_registered_job_ids??[]),...completed])],history_gap:status.accounts.some(a=>a.reason==='history_gap'),history_warnings:status.history_warnings,counts_verified:countKnown,compatibility_export_only:true,live_enabled:false,publication_authorized_by_export:false};
 const rootJobs=[...(continuation.jobs??[])];
 for(const job of accepted){const i=rootJobs.findIndex(j=>j.video_id===job.video_id);const entry={...(i>=0?rootJobs[i]:{}),video_id:job.video_id,account:job.account,sha256:job.sha256,completed:job.published===true,published:job.published===true,result_unknown:job.result_unknown===true,publication_authorized:false};if(i>=0)rootJobs[i]=entry;else rootJobs.push(entry);}
 const documents={
  'video-publishing-continuation.json':{...continuation,updated_at:at,jobs:rootJobs,current_continuation:{...old,...shared},compatibility_export_only:true,live_enabled:false},
  'checkpoint.json':{...checkpoint,...canonical,...shared,accepted_jobs:accepted},
  'eco-worker-state.json':{...worker,...shared},
  'heartbeat-latest.json':{...heartbeat,...shared},
 };
 fs.mkdirSync(out,{recursive:true});
 for(const [name,value]of Object.entries(documents))writeJSON(path.join(out,name),value,true);
 const manifest={schema:'publisher-compat-export/v1',at,source_database:path.join(state.dir,'state.db'),source_files:sources,outputs:Object.keys(documents).map(name=>({name,sha256:fileHash(path.join(out,name))})),conflicts,production_files_modified:false,export_only:true};
 writeJSON(path.join(out,'export-manifest.json'),manifest,true);
 return{exit_code:0,out_dir:out,files:Object.keys(documents),manifest:path.join(out,'export-manifest.json'),unknown_submissions:submissions.length,unknown_uploads:uploads.length,counts_verified:countKnown,conflicts};
}
