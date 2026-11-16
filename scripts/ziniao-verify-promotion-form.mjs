import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const expected=JSON.parse(await fs.readFile(job.integrity,'utf8'));
const q=JSON.stringify;
const guard=`if(location.hostname!=='seller.tiktokshopglobalselling.com'||location.pathname!=='/promotion/marketing-tools/discount/create'||new URL(location.href).searchParams.get('shop_region')!==${q(job.market)}||document.querySelector('.ub-triggerContent-c31a58')?.textContent!==${q(job.expectedHeader)})throw Error('Wrong promotion page');`;
function call(body){
 const p=spawnSync(job.cli,['page','exec','--store-id',job.storeId,'--target-id',job.targetId,'--script',`(()=>{${guard}${body}})()`],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:1024*1024});
 if(p.error||p.status!==0)throw Error('CLI failure');
 const o=JSON.parse(p.stdout),d=o.data?.data;
 if(!o.ok||d?.exceptionDetails||d?.targetId!==job.targetId)throw Error('Page/target mismatch '+JSON.stringify(d?.exceptionDetails));
 return JSON.parse(d.result);
}
call(`const a=document.querySelectorAll('.theme-arco-table-body');if(a.length!==1)throw Error('Ambiguous table');a[0].scrollTop=0;return JSON.stringify({top:0});`);
const found=new Map();let ended=false;
for(let step=0;step<160;step++){
 const data=call(`const a=document.querySelector('.theme-arco-table-body');const rows=[...document.querySelectorAll('input[data-prefill-id^="sku_discount_percentage__"]')].map(e=>({key:e.getAttribute('data-prefill-id'),value:e.value,priceText:e.parentElement.parentElement.parentElement.parentElement.textContent}));const top=a.scrollTop,max=a.scrollHeight-a.clientHeight;a.scrollTop=Math.min(max,top+400);return JSON.stringify({rows,top,max});`);
 for(const row of data.rows){const [,product,sku]=row.key.split('__');if(!product||!sku)throw Error('Bad DOM ID');found.set(sku,{sku_id:sku,product_id:product,raw_value:row.value,value:row.value.trim()===''?null:Number(row.value),price_text:row.priceText});}
 if(step%20===0)console.log(JSON.stringify({market:job.market,visible_skus_collected:found.size,scroll_top:data.top}));
 if(data.top>=data.max-1){ended=true;break;}
}
const allowed=new Set(expected.sku_ids);
const rows=[...found.values()];
const omitted=new Set(expected.omitted.map(r=>r.sku_id));
const configured=rows.filter(r=>r.value!==null),empty=rows.filter(r=>r.value===null);
const missing=[...allowed].filter(id=>!found.has(id)||found.get(id).value===null);
const unexpected=configured.filter(r=>!allowed.has(r.sku_id));
const wrongDiscounts=configured.filter(r=>r.value!==50);
const unexpectedEmpty=empty.filter(r=>!omitted.has(r.sku_id));
const result={market:job.market,expected_sku_count:allowed.size,actual_sku_count:configured.length,empty_excluded_skus:empty.map(r=>r.sku_id),ended,missing,unexpected,wrongDiscounts,unexpectedEmpty,all_match:ended&&!missing.length&&!unexpected.length&&!wrongDiscounts.length&&!unexpectedEmpty.length,rows};
call(`document.querySelector('.theme-arco-table-body').scrollTop=0;return JSON.stringify({restored:true});`);
await fs.writeFile(job.report.replace(/upload-attempt-2\.json$/,'form-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,rows:rows.length}));
if(!result.all_match)throw Error('Promotion form scope or discount mismatch');
