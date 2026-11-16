// Offline research: read existing code/data, write evidence only inside publisher.
import fs from 'node:fs';
import path from 'node:path';
import {walk,readJSON,writeJSON,fileHash} from '../lib/common.mjs';
const root=path.resolve('../..'),matches=[];
const pattern=/video-publishing-continuation|eco-worker-state|heartbeat-latest|video-publishing-2026-10-17[\\/]checkpoint/;
function* files(root){const pending=[root];while(pending.length){const dir=pending.pop();for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink()||p.includes(path.sep+'scripts'+path.sep+'publisher'))continue;if(e.isDirectory())pending.push(p);else if(e.isFile())yield p;}}}
for(const dir of ['scripts','operations'])for(const file of files(path.join(root,dir))){
 if(file.includes(path.sep+'scripts'+path.sep+'publisher'+path.sep)||! /\.(?:[cm]?js|ps1|py)$/.test(file))continue;
 const lines=fs.readFileSync(file,'utf8').split(/\r?\n/);
 for(let i=0;i<lines.length;i++)if(pattern.test(lines[i]))matches.push({file:path.relative(root,file),line:i+1,text:lines[i],source_sha256:fileHash(file)});
}
writeJSON('evidence/compat-consumer-search.json',{at:new Date().toISOString(),scope:['scripts','operations'],matches});
const research=readJSON('evidence/round2-research.json');
const examples=new Map();
for(const c of research.candidates){
 const q=c.review??{},keys=Object.keys(q).sort().join(',');
 if(!examples.has(keys))examples.set(keys,{video:c.video_id,manifest:c.manifest,review_keys:keys,qa:Object.fromEntries(Object.entries(c.qa??{}).filter(([k])=>!['evidence','primary_current_final_QA','limitations'].includes(k))),scene:c.scene,conclusions:{status:q.status,productionPass:q.productionPass,qualified:q.qualified,final_sha:q.final?.sha256??q.final_sha256,picture:Object.fromEntries(Object.entries(q.picture??{}).filter(([,v])=>typeof v==='boolean'||typeof v==='string').map(([k,v])=>[k,typeof v==='string'?v.slice(0,260):v])),dedup:q.dedup,product_truth:Object.fromEntries(Object.entries(q.productTruth??{}).filter(([,v])=>typeof v==='boolean'||typeof v==='string')),footer:q.footer?Object.fromEntries(Object.entries(q.footer).filter(([,v])=>typeof v==='boolean'||typeof v==='string')):null}});
}
writeJSON('evidence/legacy-qa-shapes.json',[...examples.values()]);
console.log(JSON.stringify({matching_lines:matches.length,files:[...new Set(matches.map(m=>m.file))],qa_shapes:examples.size},null,2));
