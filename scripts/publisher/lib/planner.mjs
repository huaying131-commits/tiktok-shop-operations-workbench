import {day,instant,fail} from './common.mjs';

export function limits(policy) {
  const p=policy?.publishing_target;
  const x={perAccount:p?.natural_day_cap_per_account,total:p?.daily_total_target,interval:p?.minimum_real_success_interval_seconds,aircraft:p?.minimum_aircraft_successes_per_actual_day};
  if(Object.values(x).some(v=>!Number.isInteger(v)||v<0)||!x.perAccount||!x.total||!x.interval||x.aircraft>x.total)fail('invalid_publishing_target',40);
  return x;
}
const ids=x=>new Set([x.video_id,x.job_id,x.sha256,x.upload_sha256,...(x.identifiers??[]),...(x.known_lineage_identifiers??[])].filter(Boolean).map(String));
export const overlaps=(a,b)=>{const right=ids(b);return [...ids(a)].some(i=>right.has(i));};
const key=r=>r.action_key??`${r.account}:${r.sha256??r.job_id??r.video_id}`;
export function currentRows(rows) {
  const result=new Map();
  for(const r of rows) {
    const k=key(r),old=result.get(k);
    if(old?.published&&!r.published)continue;
    const defined=Object.fromEntries(Object.entries(r).filter(([,v])=>v!==undefined&&v!==null));
    result.set(k,{...old,...defined,archive_identity_only:!!r.archive_identity_only&&(!old||!!old.archive_identity_only),identifiers:[...new Set([...(old?.identifiers??[]),...(r.identifiers??[])])]});
  }
  return [...result.values()];
}
export function unknowns(rows) {
  const latest=currentRows(rows),posted=latest.filter(x=>x.published);
  return latest.filter(x=>!x.published&&(x.submit_attempted===true||x.result_unknown===true||x.status==='unknown'||/submitting|submit_attempt_recorded|result_pending|unknown_after_submit|awaiting_human|unknown_upload/.test(x.status??'')))
    .filter(x=>!posted.some(p=>p.account===x.account&&p.sha256&&p.sha256===x.sha256));
}
export function isSubmissionUnknown(row){
 return row.submit_attempted===true||row.stage==='submit'||row.op==='submit'||/^(?:submitting|submit_attempt_recorded|unknown_after_submit|submission_unknown|submit_result_pending|result_pending)(?:_|$)/.test(row.status??'');
}
function validCoverage(c,account,d,now) {
  if(c.market!=='MY'||c.timezone!=='Asia/Shanghai'||!c.accounts?.includes(account)||c.actual_date!==d||Date.parse(c.recorded_at??c.observed_at)>now)return false;
  if(c.source_type==='direct_human_confirmation')return !!c.quote?.trim()&&c.baseline_success_count===0&&Number.isFinite(Date.parse(c.recorded_at));
  // Seller Center lists have demonstrably omitted known successful posts. A complete flag is insufficient.
  return c.source_type==='verified_history_reconciliation'&&c.verified===true&&c.includes_manual===true&&
    c.evidence?.sha256&&c.evidence?.path&&c.record_count===0&&Number.isFinite(Date.parse(c.observed_at));
}
function gaps(s,account,now) {
  const today=day(now),known=[...new Set(s.ledgerDays??[])].filter(d=>d<=today).sort();
  const yesterday=day(now-86400000),covered=d=>known.includes(d)||(s.coverages??[]).some(c=>validCoverage(c,account,d,now));
  const missing=[];
  if(!covered(yesterday))missing.push(yesterday);
  // No file for a newly started day is legitimate when yesterday is covered; plan remains readonly.
  if(!covered(today)&&!covered(yesterday))missing.push(today);
  return missing;
}
function historyWarnings(s,now){
 const known=[...new Set(s.ledgerDays??[])].sort(),oldest=known[0],end=Date.parse(day(now-86400000)+'T00:00:00+08:00'),out=[];
 if(!oldest)return out;
 for(let t=Date.parse(oldest+'T00:00:00+08:00');t<end;t+=86400000){const d=day(t);if(!known.includes(d))out.push({date:d,reason:'older_history_gap',blocks:false});}
 return out;
}
export function checkJob(job,s,at) {
  const now=typeof at==='number'?at:instant(at),l=limits(s.policy),rows=currentRows(s.rows??[]),account=job.account;
  const stop=(reason,extra={})=>({eligible:false,reason,...extra});
  if(job.published===true)return stop('already_published');
  if(unknowns(rows).some(x=>isSubmissionUnknown(x)&&x.account===account||overlaps(x,job)))return stop('unknown_operation');
  if(job.hold?.active||job.publication_hold?.active)return stop('publication_hold');
  if(rows.some(r=>r.published&&overlaps(r,job)))return stop('already_published');
  if((s.reservations??[]).some(r=>r.video_id!==job.video_id&&overlaps(r,job)))return stop('lineage_collision');
  if(s.jobs.some(j=>j.video_id!==job.video_id&&overlaps(j,job)))return stop('lineage_collision');
  if(job.issues?.length)return stop(job.issues[0],{issues:job.issues});
  const missing=gaps(s,account,now);if(missing.length)return stop('history_gap',{missing_days:missing});
  const distinct=[...new Map(rows.filter(x=>x.published&&!x.archive_identity_only).map(x=>[`${x.account}:${x.sha256??x.job_id}`,x])).values()];
  const uncountedArchive=rows.some(x=>x.published&&x.archive_identity_only&&(!x.account||x.account===account)&&!distinct.some(y=>y.account===x.account&&overlaps(x,y)));
  if(uncountedArchive)return stop('published_time_unknown');
  if(distinct.some(x=>!Number.isFinite(Date.parse(x.published_at))||Date.parse(x.published_at)>now))return stop('published_time_unknown');
  const own=distinct.filter(x=>x.account===account),today=distinct.filter(x=>day(x.published_at)===day(now));
  if(own.filter(x=>day(x.published_at)===day(now)).length>=l.perAccount)return stop('daily_cap');
  if(today.length>=l.total)return stop('shop_daily_cap');
  const last=Math.max(-Infinity,...own.map(x=>Date.parse(x.published_at))),earliest=last+l.interval*1000;
  if(now<earliest)return stop('interval',{earliest_at:new Date(earliest).toISOString()});
  return {eligible:true,reason:'eligible',earliest_at:new Date(now).toISOString()};
}
export function plan(s,at=new Date().toISOString()) {
  const now=instant(at),l=limits(s.policy),rows=currentRows(s.rows??[]),today=rows.filter(r=>r.published&&!r.archive_identity_only&&Number.isFinite(Date.parse(r.published_at))&&day(r.published_at)===day(now));
  const unique=[...new Map(today.map(r=>[`${r.account}:${r.sha256??r.job_id}`,r])).values()];
  let slots=Math.max(0,l.total-unique.length),aircraftGap=Math.max(0,l.aircraft-unique.filter(r=>r.aircraft===true||(s.policy.content_aircraft_product_link_policy?.known_aircraft_product_ids??[]).includes(r.product_id)).length);
  const mappings=s.policy.content_account_vertical_policy?.accounts;if(!Array.isArray(mappings)||!mappings.length)fail('account_mapping_missing',40);
  const choices=mappings.map(({account})=>{
    const own=s.jobs.filter(j=>j.account===account).sort((a,b)=>aircraftGap?(Number(b.aircraft)-Number(a.aircraft)||a.video_id.localeCompare(b.video_id)):a.video_id.localeCompare(b.video_id));
    const checked=own.map(j=>({j,c:checkJob(j,s,now)}));
    const chosen=checked.find(x=>x.c.eligible)??checked[0];
    if(!chosen){const missing=gaps(s,account,now),reason=unknowns(rows).some(x=>isSubmissionUnknown(x)&&x.account===account)?'unknown_operation':missing.length?'history_gap':'no_candidate';return{account,decision:reason==='no_candidate'?'wait':'blocked',reason,video_id:null,earliest_at:null,...missing.length?{missing_days:missing}:{}};}
    return{account,video_id:chosen.j.video_id,decision:chosen.c.eligible?'publish':chosen.c.reason==='interval'?'wait':'blocked',...chosen.c,aircraft:chosen.j.aircraft===true,earliest_at:chosen.c.earliest_at??null,candidates:checked.map(x=>({video_id:x.j.video_id,...x.c}))};
  });
  for(const choice of [...choices].sort((a,b)=>aircraftGap?Number(b.aircraft)-Number(a.aircraft):0)) {
    if(choice.decision!=='publish')continue;
    if(!slots){Object.assign(choice,{decision:'wait',reason:'round_shop_capacity'});continue;}
    slots--;if(choice.aircraft)aircraftGap=Math.max(0,aircraftGap-1);
  }
  const serious=choices.some(x=>x.decision==='blocked'&&!['already_published','daily_cap','shop_daily_cap'].includes(x.reason));
  const pending=unknowns(rows);
  return{at:new Date(now).toISOString(),date:day(now),accounts:choices,unknown_submissions:pending.filter(isSubmissionUnknown),unknown_uploads:pending.filter(x=>!isSubmissionUnknown(x)),history_warnings:historyWarnings(s,now),aircraft_remaining:aircraftGap,missed_rounds_replayed:false,exit_code:serious?20:choices.some(x=>x.decision==='publish')?0:10};
}
