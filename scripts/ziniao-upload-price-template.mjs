import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const promotion=job.kind==='promotion_skus';
if(job.kind&&!promotion)throw Error('Unknown upload purpose');
if(!['SG','VN'].includes(job.market)||!job.expectedHeader)throw Error('Exact authorized market/header required');
const integrity=JSON.parse(await fs.readFile(job.integrity,'utf8'));
const bytes=await fs.readFile(job.file),hash=createHash('sha256').update(bytes).digest('hex');
if(integrity.market!==job.market||integrity.sha256!==hash)throw Error('XLSX integrity validation missing');
if(promotion){
 if(!integrity.only_fifty_percent||!integrity.id_text_percent_points_verified||integrity.upload_discount_points!==50||integrity.discount_fraction!==0.5||!integrity.sku_count)throw Error('Final promotion template validation missing');
}else if(!integrity.only_F_values_changed||!integrity.all_other_zip_parts_identical)throw Error('Price-only integrity validation missing');
if(bytes.length>5*1024*1024||bytes.subarray(0,2).toString()!=='PK')throw Error('Invalid XLSX');
try{await fs.access(job.report);throw Error('Report exists: inspect website before any retry');}catch(e){if(e.code!=='ENOENT')throw e;}
const key='__daleiPrice_'+randomUUID().replaceAll('-',''),q=JSON.stringify;
const expectedPath=promotion?'/promotion/marketing-tools/discount/create':'/product/batch/edit-prods';
const selector=promotion?'[role="dialog"] input[type="file"]':'input[type="file"][accept=".xlsx"]';
const guard=`if(location.hostname!=='seller.tiktokshopglobalselling.com'||location.pathname!==${q(expectedPath)}||new URL(location.href).searchParams.get('shop_region')!==${q(job.market)}||document.querySelector('.ub-triggerContent-c31a58')?.textContent!==${q(job.expectedHeader)})throw Error('XLSX upload page identity mismatch');`;
function call(body){
 const script=`(()=>{${guard}${body}})()`;
 const p=spawnSync(job.cli,['page','exec','--store-id',job.storeId,'--target-id',job.targetId,'--script',script],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:1024*1024});
 if(p.error||p.status!==0)throw Error('CLI failure; no automatic retry');
 const outer=JSON.parse(p.stdout),v=outer.data?.data;
 if(!outer.ok||outer.data?.ok===false||v?.exceptionDetails||v?.targetId!==job.targetId)throw Error('Page/permission/target mismatch: '+JSON.stringify({actual_target:v?.targetId,expected_target:job.targetId,exception:v?.exceptionDetails?.exception?.description?.split('\n')[0]}));
 return JSON.parse(v.result);
}
const report={market:job.market,sha256:hash,file:job.file,expected_header:job.expectedHeader,store_id:job.storeId,target_id:job.targetId,
 dispatch_attempted:false,website_import_verified:false,status:'prepared'};
const save=()=>fs.writeFile(job.report,JSON.stringify(report,null,2));
await save();
try{
 report.before=call(`const a=document.querySelectorAll(${q(selector)});if(a.length!==1||a[0].disabled)throw Error('Upload control mismatch');window[${q(key)}]={parts:[]};return JSON.stringify({header:document.querySelector('.ub-triggerContent-c31a58').textContent,control_count:a.length});`);
 const base64=bytes.toString('base64');
 for(let i=0;i<base64.length;i+=16000)call(`const b=window[${q(key)}];if(b.parts.length!==${i/16000})throw Error('Buffer mismatch');b.parts.push(${q(base64.slice(i,i+16000))});return JSON.stringify({parts:b.parts.length});`);
 call(`const b=window[${q(key)}];b.bytes=Uint8Array.from(atob(b.parts.join('')),c=>c.charCodeAt(0));b.state='hashing';crypto.subtle.digest('SHA-256',b.bytes).then(h=>{b.hash=[...new Uint8Array(h)].map(v=>v.toString(16).padStart(2,'0')).join('');b.state='ready'});return JSON.stringify({size:b.bytes.length});`);
 const ready=call(`const b=window[${q(key)}];return JSON.stringify({state:b.state,hash:b.hash,size:b.bytes.length});`);
 if(ready.state!=='ready'||ready.hash!==hash||ready.size!==bytes.length)throw Error('Page bytes not verified');
 report.dispatch_attempted=true;report.status='dispatch_pending';await save();
 report.dispatch=call(`const b=window[${q(key)}];if(b.hash!==${q(hash)}||b.state!=='ready')throw Error('Buffer changed');const a=document.querySelectorAll(${q(selector)});if(a.length!==1||a[0].disabled)throw Error('Control changed');const t=new DataTransfer();t.items.add(new File([b.bytes],${q(path.basename(job.file))},{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));a[0].files=t.files;b.state='dispatching';a[0].dispatchEvent(new Event('input',{bubbles:true}));a[0].dispatchEvent(new Event('change',{bubbles:true}));b.state='dispatched';return JSON.stringify({dispatched:true,file:${q(path.basename(job.file))}});`);
 report.status='uploaded_platform_validation_pending';await save();
 console.log(JSON.stringify(report));
}catch(e){report.status=report.dispatch_attempted?'unknown_inspect_before_retry':'failed_before_dispatch';report.error=e.message;await save();throw e;}
