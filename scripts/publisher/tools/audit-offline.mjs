// Read-only source audit; output is restricted to this publisher's evidence directory.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {walk,readJSON,writeJSON,fileHash} from '../lib/common.mjs';
const publisher=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [root=path.resolve(publisher,'../..'),source='C:/Users/Operator/Workspace/我的产品/产品视频/未发布视频']=process.argv.slice(2);
const files=walk(source).filter(f=>/^发布任务(?:_.*)?\.json$/.test(path.basename(f))),records=[];
for(const manifest of files){const p=readJSON(manifest);if(p.ready_to_publish!==true&&p.status!=='ready_to_publish')continue;records.push({video_id:p.video_id,manifest,manifest_sha256:fileHash(manifest),short_product_name_present:typeof p.short_product_name==='string'&&!!p.short_product_name.trim(),semantic_review_present:!!p.semantic_review,publishing_fields_present:!!p.publishing_fields,browser_runtime_present:!!p.browser_runtime});}
const out={at:new Date().toISOString(),read_only:true,ready_manifests:records.length,exact_manifest_names:records.filter(x=>path.basename(x.manifest)==='发布任务.json').length,additional_revision_manifests:records.filter(x=>path.basename(x.manifest)!=='发布任务.json').length,missing:{short_product_name:records.filter(x=>!x.short_product_name_present).length,semantic_review:records.filter(x=>!x.semantic_review_present).length,publishing_fields:records.filter(x=>!x.publishing_fields_present).length,browser_runtime:records.filter(x=>!x.browser_runtime_present).length},records};
writeJSON(path.join(publisher,'evidence/ready-metadata.json'),out);
const paths=process.argv.slice(4),audit=[];
for(const reference of paths){const p=path.resolve(root,reference),all=fs.statSync(p).isDirectory()?walk(p):[p];for(const file of all){if(path.basename(file).includes('darkbear')||!fs.statSync(p).isDirectory()){const bytes=fs.readFileSync(file);audit.push({path:path.relative(root,file),sha256:fileHash(file),bytes:bytes.length});}}}
if(audit.length)writeJSON(path.join(publisher,'evidence/reference-audit.json'),{at:out.at,read_only:true,files:audit});
console.log(JSON.stringify({...out,records:records.length,reference_files:audit.length}));
