import limits from './publication-limits.cjs';
const routes={WH:'example-creator-1',SH:'example-creator-2',TB:'example-creator-3',EX:'example-creator-4',LF:'example-creator-5',CR:'example-creator-5'};
export function eligibility(job,records,history,at=new Date().toISOString()){
  const stop=(reason,extra={})=>({eligible:false,reason,...extra});
  const now=Date.parse(at);
  if(String(job.product_id)==='9000000000000000026')return stop('secondary_aircraft_listing_prohibited_use_verified_zigzoom_main');
  if(!Number.isFinite(now)||job.region!=='MY'||!routes[job.content_code]||routes[job.content_code]!==job.account)return stop('account_type_mismatch');
  if(!/^[a-f0-9]{64}$/i.test(job.sha256||'')||!/^\d+$/.test(job.product_id||''))return stop('product_or_file_missing');
  if(!job.description?.trim()||!Array.isArray(job.tags)||!job.tags.length)return stop('caption_missing');
  if(job.description.length>3000||job.tags.join(' ').length>1000||/[\u3400-\u9fff]/.test(job.description)||job.tags.some(x=>!/^#[\p{L}\p{N}_]+$/u.test(x)||/[\u3400-\u9fff]/.test(x)))return stop('caption_invalid');
  if(!['footer','video','product','caption'].every(x=>job.qa?.[x]===true))return stop('qa_missing');
  if(records.some(r=>r.sha256===job.sha256&&r.published))return stop('duplicate');
  const unresolved=new Set(['submit_attempt_recorded','result_pending','submitting','unknown_after_submit']);
  const latest=new Map(records.map(r=>[`${r.region||'MY'}:${r.account}:${r.sha256}`,r]));
  if([...latest.values()].some(r=>!r.published&&unresolved.has(r.status)&&(r.sha256===job.sha256||r.account===job.account)))return stop('submission_unresolved');
  const day=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
  const baseline=history?.accounts?.[job.account];
  if(history?.date!==day(now)||!baseline||!Number.isInteger(baseline.count)||baseline.count<0||(baseline.count>0&&!Number.isFinite(Date.parse(baseline.last_post_at))))return stop('history_missing');
  const published=records.filter(r=>r.account===job.account&&r.published);
  if(published.some(r=>!Number.isFinite(Date.parse(r.published_at))))return stop('history_missing');
  const distinct=new Map(published.map(r=>[r.video_id||r.sha256,r]));
  const todays=[...distinct.values()].filter(r=>day(Date.parse(r.published_at))===day(now));
  const count=baseline.count+todays.length;
  const {dailyCap}=limits.getPublicationLimits();if(count>=dailyCap)return stop('daily_limit',{count});
  const stamps=[...distinct.values()].map(r=>Date.parse(r.published_at));
  if(baseline.last_post_at)stamps.push(Date.parse(baseline.last_post_at));
  const last=stamps.length?Math.max(...stamps):null;
  if(last!==null&&now-last<3600000)return stop('interval',{count,next_at:new Date(last+3600000).toISOString()});
  return {eligible:true,count,slots_remaining:dailyCap-count};
}

