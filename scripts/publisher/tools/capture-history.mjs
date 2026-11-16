// Read-only research utility. Writes only fixed offline fixtures under this publisher directory.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJSON,fileHash,writeJSON} from '../lib/common.mjs';
import {publicationIdentifiers} from '../lib/identifiers.mjs';
const [root,date]=process.argv.slice(2);
if(!root||!/^\d{4}-\d{2}-\d{2}$/.test(date??''))throw Error('Usage: capture-history.mjs <root> <date>');
const ledger=path.join(root,'outputs','video-publishing-'+date,'发布记录.jsonl');
const raw=fs.readFileSync(ledger,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const first=new Map();for(const r of raw.filter(r=>r.published===true)){if(!first.has(r.job_id))first.set(r.job_id,r);}
const policyFile=path.join(root,'operations/module-execution-policy.json'),p=readJSON(policyFile);
const records=[...first.values()].sort((a,b)=>Date.parse(a.published_at)-Date.parse(b.published_at)).map(r=>{
 const manifest=path.resolve(root,r.package),pkg=readJSON(manifest);
 const ids=publicationIdentifiers(pkg);
 return{success:{job_id:r.job_id,account:r.account,sha256:r.sha256,product_id:r.product_id,published:true,published_at:r.published_at,action_key:r.action_key,identifiers:ids},job:{video_id:r.job_id,account:r.account,sha256:r.sha256,product_id:r.product_id,content_type:pkg.content_type,aircraft:(p.content_aircraft_product_link_policy.known_aircraft_product_ids??[]).includes(r.product_id),identifiers:ids},package_fields:{short_product_name:pkg.short_product_name??null,semantic_review:pkg.semantic_review??null,publishing_fields:pkg.publishing_fields??null,account_scene_review_status:pkg.account_scene_review?.status??null,account_scene_review_category:pkg.account_scene_review?.actual_category??null},source:{manifest,sha256:fileHash(manifest)}};
});
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tests/fixtures');
writeJSON(path.join(dir,'history-'+date+'.json'),{date,sources:[{path:ledger,sha256:fileHash(ledger)},{path:policyFile,sha256:fileHash(policyFile)}],policy:{publishing_target:p.publishing_target,content_account_vertical_policy:p.content_account_vertical_policy,content_aircraft_product_link_policy:p.content_aircraft_product_link_policy,latest_direct_human_role_work_windows_20261102:p.latest_direct_human_role_work_windows_20261102},ledger_rows:raw,records},false);
console.log(JSON.stringify({records:records.length,fixture:path.join(dir,'history-'+date+'.json')}));
