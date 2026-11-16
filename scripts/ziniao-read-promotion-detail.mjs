import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(!['SG','VN'].includes(job.market)||!/^\d{19}$/.test(job.campaignId)||!job.expectedHeader)throw Error('Exact campaign identity required');
const q=JSON.stringify;
const guard=`if(location.hostname!=='seller.tiktokshopglobalselling.com'||location.pathname!==${q('/promotion/marketing-tools/discount/view/'+job.campaignId)}||new URL(location.href).searchParams.get('shop_region')!==${q(job.market)}||document.querySelector('.ub-triggerContent-c31a58')?.textContent!==${q(job.expectedHeader)})throw Error('Wrong promotion detail');if(document.visibilityState!=='visible')throw Error('Show this store tab before virtual table verification');`;
function call(body){
 const p=spawnSync(job.cli,['page','exec','--store-id',job.storeId,'--target-id',job.targetId,'--script',`(()=>{${guard}${body}})()`],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:1024*1024});
 if(p.error||p.status!==0)throw Error('CLI failure');
 const o=JSON.parse(p.stdout),d=o.data?.data;
 if(!o.ok||d?.exceptionDetails||d?.targetId!==job.targetId)throw Error('Page/target mismatch '+JSON.stringify(d?.exceptionDetails));
 return JSON.parse(d.result);
}
const meta=call(`const b=document.querySelector('.theme-arco-table-body');if(!b)throw Error('No product table');b.scrollTop=0;const c=document.body.cloneNode(true);c.querySelectorAll('script,style,noscript').forEach(e=>e.remove());return JSON.stringify({href:location.href,header:document.querySelector('.ub-triggerContent-c31a58').textContent,head:c.textContent.split('最近变更')[0],columns:[...document.querySelectorAll('.theme-arco-table-th')].map(e=>e.textContent)});`);
const found=new Map(),parents=new Map();let ended=false,lastTop=null,stagnant=0,boundary=null;
for(let step=0;step<180;step++){
 const d=call(`const b=document.querySelector('.theme-arco-table-body');const rows=[...b.querySelectorAll('[id^="row-"]')].map(e=>({key:e.id,cells:[...e.children].filter(c=>c.classList.contains('theme-arco-table-td')).map(c=>c.textContent)}));const parents=[...b.querySelectorAll('.theme-arco-table-tr-custom-expand-row')].map(e=>({id:e.querySelector('[id^="row-"]')?.id,text:e.textContent}));const top=b.scrollTop,max=b.scrollHeight-b.clientHeight;b.scrollTop=Math.min(max,top+400);return JSON.stringify({rows,parents,top,max});`);
 for(const row of d.rows)found.set(row.key,row);
 for(const p of d.parents)parents.set(p.id,p);
 stagnant=d.top===lastTop?stagnant+1:0;lastTop=d.top;boundary={top:d.top,max:d.max};
 if(step%20===0)console.log(JSON.stringify({campaign:job.campaignId,collected:found.size,top:d.top}));
 // At this browser zoom the observed bottom was 2.5 CSS pixels below max.
 // SKU coverage is still independently checked against the approved manifest.
 if(d.top>=d.max-3){ended=true;break;}
 if(stagnant>=2)break;
}
call(`document.querySelector('.theme-arco-table-body').scrollTop=0;return JSON.stringify({restored:true});`);
const report={market:job.market,campaign_id:job.campaignId,at:new Date().toISOString(),...meta,ended,scroll_stalled:stagnant>=2,boundary,parents:[...parents.values()],rows:[...found.values()]};
await fs.writeFile(job.report,JSON.stringify(report,null,2));
console.log(JSON.stringify({market:job.market,campaign:job.campaignId,rows:found.size,parents:parents.size,ended,report:job.report}));
if(!ended)console.log('Scroll stopped before the computed boundary; independently verify exact SKU coverage and parent counts.');
