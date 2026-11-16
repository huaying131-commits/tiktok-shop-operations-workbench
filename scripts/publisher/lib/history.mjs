import fs from 'node:fs';
import path from 'node:path';
import {readJSON,walk,fail,fileHash} from './common.mjs';
import {publicationIdentifiers} from './identifiers.mjs';

export function loadHistory(root) {
 const outputs=path.join(root,'outputs'),rows=[],ledgerDays=[],coverages=[],reservations=[],sources=[];
 const cache=new Map();
 const pkg=p=>{if(!p)return null;const file=path.resolve(root,p);if(cache.has(file))return cache.get(file);const v=fs.existsSync(file)?readJSON(file):null;cache.set(file,v);return v;};
 if(!fs.existsSync(outputs))return{rows,ledgerDays,coverages,reservations,sources};
 for(const dir of fs.readdirSync(outputs).filter(n=>/^video-publishing-\d{4}-\d{2}-\d{2}$/.test(n)).sort()){
  const base=path.join(outputs,dir),ledger=path.join(base,'发布记录.jsonl');
  if(fs.existsSync(ledger)){
   ledgerDays.push(dir.slice(-10));sources.push({path:ledger,sha256:fileHash(ledger)});
   for(const line of fs.readFileSync(ledger,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean)){
    let r;try{r=JSON.parse(line);}catch{fail('ledger_corrupt',40,{file:ledger});}
    const p=pkg(r.package);rows.push({...r,identifiers:[...new Set([...publicationIdentifiers(r),...(p?publicationIdentifiers(p):[])])],source:ledger});
   }
  }
  for(const file of walk(base).filter(f=>/\.json$/.test(f)&&(/(?:^|[\\/])(checkpoint|upload-checkpoint|submit-checkpoint|archive-manifest|实际发布信息|发布任务(?:_.*)?)\.json$/.test(f)||/direct-human-.*zero-baseline.*\.json$/.test(f)))){
   let p;try{p=readJSON(file);}catch{fail('history_json_corrupt',40,{file});}
   if(p.source_type&&p.baseline_success_count===0){coverages.push(p);continue;}
   if(Array.isArray(p.accepted_jobs)){
    for(const j of p.accepted_jobs){const packageData=pkg(j.package);const v={...j,video_id:j.video_id??j.job_id,identifiers:[...publicationIdentifiers(j),...(packageData?publicationIdentifiers(packageData):[])],source:file};reservations.push(v);if(j.published||j.result_unknown||j.submit_attempted)rows.push(v);}
   }
   const isArchive=file.includes(path.sep+'archive'+path.sep),isAttempt=/upload-checkpoint|submit-checkpoint/.test(path.basename(file));
   if(isAttempt&&p.job_id){rows.push({...p,identifiers:publicationIdentifiers(p),source:file,result_unknown:p.result_unknown===true||(!p.published&&(p.current_upload_attempt?.official_file_transfer_count>0||p.current_upload_attempt?.actual_input_assignment_count>0))});}
   if(isArchive){
    const identities=publicationIdentifiers(p);if(p.files)for(const entry of Object.values(p.files)){if(entry.archived_sha256)identities.push(entry.archived_sha256);if(entry.sha256)identities.push(entry.sha256);}
    const parts=file.split(path.sep),pos=parts.lastIndexOf('archive');
    if(identities.length)rows.push({...p,job_id:p.job_id??p.video_id??p.success?.job_id??parts[pos+2],account:p.account??p.target_account??p.success?.account??parts[pos+1],sha256:p.sha256??p.success?.sha256,identifiers:identities,published:true,published_at:p.published_at??p.success?.at,source:file,archive_identity_only:true});
   }
  }
 }
 return{rows,ledgerDays,coverages,reservations,sources};
}
