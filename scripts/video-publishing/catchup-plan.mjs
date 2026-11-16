// Read-only planning. A due slot never bypasses rules.mjs or live publication QA.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import limits from './publication-limits.cjs';
const HOUR=3600000;
const unresolved=new Set(['submit_attempt_recorded','result_pending','submitting','unknown_after_submit']);
const localDay=ms=>new Date(ms+8*HOUR).toISOString().slice(0,10);
export function planCatchup({account,records,history,at,continuation=false}){
 const now=Date.parse(at),{dailyCap,dailyTargetPerAccount}=limits.getPublicationLimits();
 if(!Number.isFinite(now))throw Error('Invalid time');
 const date=localDay(now), start=Date.parse(date+(continuation?'T00:00:00+08:00':'T09:00:00+08:00')),end=continuation?Date.parse(date+'T00:00:00+08:00')+24*HOUR:Date.parse(date+'T23:00:00+08:00');
 const base=history?.accounts?.[account];
 if(history?.date!==date||!base||!Number.isInteger(base.count)||base.count<0||base.count>dailyCap||(base.count>0&&!Number.isFinite(Date.parse(base.last_post_at))))return {account,status:'history_requires_reconciliation',can_publish:false};
 const rows=records.filter(r=>r.account===account);
 const latest=new Map(rows.map(r=>[r.sha256,r]));
 const posts=new Map(rows.filter(r=>r.published).map(r=>[r.sha256||r.video_id,r]));
 if([...posts.values()].some(r=>!Number.isFinite(Date.parse(r.published_at))))return {account,status:'history_requires_reconciliation',can_publish:false};
 const count=base.count+[...posts.values()].filter(r=>localDay(Date.parse(r.published_at))===date).length;
 const missing=Math.max(0,dailyTargetPerAccount-count);
 const last=Math.max(base.last_post_at?Date.parse(base.last_post_at):-Infinity,...[...posts.values()].map(r=>Date.parse(r.published_at)));
 const earliest=Math.max(now,start,last+HOUR);
 const capacity=earliest<end?1+Math.floor((end-1-earliest)/HOUR):0;
 const normalTarget=[12,18,21].filter(h=>now>=Date.parse(date+'T'+h+':00:00+08:00')).length;
 const reserveTarget=now>=Date.parse(date+'T20:30:00+08:00')?Math.max(count+1,3-Math.max(0,Math.floor((end-30*60000-now)/HOUR))):0;
 const target=continuation?dailyTargetPerAccount:Math.min(dailyTargetPerAccount,Math.max(normalTarget,reserveTarget));
 const common={account,date,count,missing,target_now:target,earliest_at:new Date(earliest).toISOString(),deadline_at:new Date(end).toISOString(),remaining_capacity:capacity,minimum_unfillable_today:Math.max(0,missing-capacity),successful_posts_only:true};
 if(count>=dailyCap)return {...common,status:'daily_limit_reached',can_publish:false};
 if([...latest.values()].some(r=>!r.published&&unresolved.has(r.status)))return {...common,status:'query_unknown_submission_first',can_publish:false};
 if(now<start||now>=end)return {...common,status:'outside_work_hours',can_publish:false};
 if(earliest>now)return {...common,status:'waiting_interval',can_publish:false};
 if(count>=target)return {...common,status:'prepare_for_next_slot',can_publish:false};
 return {...common,status:'due_pending_live_checks',can_publish:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [baseline,...ledgers]=process.argv.slice(2);
 if(!baseline||!ledgers.length)throw Error('Usage: node catchup-plan.mjs dated-baseline.json ledger.jsonl [other-ledger.jsonl]');
 const parse=t=>JSON.parse(t.replace(/^\uFEFF/,''));
 const history=parse(await fs.readFile(baseline,'utf8'));
 const records=(await Promise.all(ledgers.map(async p=>(await fs.readFile(p,'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(JSON.parse)))).flat();
 const at=new Date().toISOString();
 let pending;try{pending=parse(await fs.readFile(new URL('../../operations/video-publishing-continuation.json',import.meta.url),'utf8'));}catch{}
 const continuation=account=>pending?.authorized===true&&pending?.status==='active'&&pending?.environment_id==='90000000000001'&&pending?.jobs?.some(j=>j.account===account&&!j.completed)===true;
 console.log(JSON.stringify({at,baseline,ledgers,publication_authorized_by_this_plan:false,accounts:Object.keys(history.accounts).map(account=>planCatchup({account,records,history,at,continuation:continuation(account)}))},null,2));
}

