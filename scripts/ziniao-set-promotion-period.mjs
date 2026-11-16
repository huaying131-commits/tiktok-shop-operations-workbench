import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const q=JSON.stringify,offset={SG:8,VN:7}[job.market];
if(!offset||!job.expectedHeader)throw Error('Authorized country required');
const guard=`if(location.hostname!=='seller.tiktokshopglobalselling.com'||location.pathname!=='/promotion/marketing-tools/discount/create'||new URL(location.href).searchParams.get('shop_region')!==${q(job.market)}||document.querySelector('.ub-triggerContent-c31a58')?.textContent!==${q(job.expectedHeader)})throw Error('Wrong promotion page');`;
function call(body){
 const p=spawnSync(job.cli,['page','exec','--store-id',job.storeId,'--target-id',job.targetId,'--script',`(()=>{${guard}${body}})()`],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024});
 if(p.error||p.status!==0)throw Error('CLI failure');
 const o=JSON.parse(p.stdout),d=o.data?.data;
 if(!o.ok||d?.exceptionDetails||d?.targetId!==job.targetId)throw Error('Page/target mismatch '+JSON.stringify(d?.exceptionDetails));
 return JSON.parse(d.result);
}
const plan=call(`const start=Math.ceil(Date.now()/60000)*60000+5*60000,end=start+365*86400000-60000;const local=t=>new Date(t+${offset}*3600000).toISOString().slice(0,16).replaceAll('-','/').replace('T',' ');return JSON.stringify({start,end,startLocal:local(start),endLocal:local(end)});`);
for(const [side,placeholder] of [['start','开始时间'],['end','结束时间']]){
 const date=plan[side+'Local'].slice(0,10),[year,month,day]=date.split('/');
 const existing=call(`return JSON.stringify({value:document.querySelector('input[placeholder=${q(placeholder)}]').value});`);
 if(existing.value===date)continue;
 call(`const e=document.querySelector('input[placeholder=${q(placeholder)}]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${q(date)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return JSON.stringify({inputDate:${q(date)}});`);
 call(`document.querySelector('input[placeholder=${q(placeholder)}]').click();return JSON.stringify({calendarOpened:true});`);
 call(`const c=[...document.querySelectorAll('.theme-arco-picker-container')].filter(e=>e.getBoundingClientRect().width>0&&e.textContent.startsWith(${q(year+'-'+month)}));if(c.length!==1)throw Error('Calendar month mismatch');const a=[...c[0].querySelectorAll('.theme-arco-picker-cell-in-view')].filter(e=>e.textContent.trim()===${q(String(Number(day)))});if(a.length!==1||a[0].className.includes('disabled'))throw Error('Calendar day unavailable');a[0].click();return JSON.stringify({dateConfirmed:${q(date)}});`);
}
const visible=`const ps=[...document.querySelectorAll('.theme-arco-timepicker-container')].filter(e=>e.getBoundingClientRect().width>0);if(ps.length!==1)throw Error('Time popup ambiguous');const p=ps[0];`;
async function waitTimePopup(count){
 for(let attempt=0;attempt<8;attempt++){
  const state=call(`return JSON.stringify({count:[...document.querySelectorAll('.theme-arco-timepicker-container')].filter(e=>e.getBoundingClientRect().width>0).length});`);
  if(state.count===count)return;
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error('Time popup transition did not complete; inspect before retry');
}
for(const [index,side] of [[0,'start'],[1,'end']]){
 call(`const a=document.querySelectorAll('input[placeholder="选择时间"]');if(a.length!==2)throw Error('Time fields changed');a[${index}].click();return JSON.stringify({opened:${q(side)}});`);
 await waitTimePopup(1);
 const parts=plan[side+'Local'].split(' ')[1].split(':');
 for(let col=0;col<2;col++)call(`${visible}const a=[...p.querySelectorAll('.theme-arco-timepicker-list')[${col}].querySelectorAll('.theme-arco-timepicker-cell')].filter(e=>e.textContent===${q(parts[col])});if(a.length!==1||a[0].className.includes('disabled'))throw Error('Time unavailable');a[0].click();return JSON.stringify({selected:${q(parts[col])}});`);
 call(`${visible}const b=[...p.querySelectorAll('button')].find(b=>b.textContent==='确定');if(!b||b.disabled)throw Error('Time confirmation unavailable');b.click();return JSON.stringify({confirmed:${q(side)}});`);
 await waitTimePopup(0);
}
const result=call(`const t=document.querySelectorAll('input[placeholder="选择时间"]');const start=document.querySelector('input[placeholder="开始时间"]').value+' '+t[0].value,end=document.querySelector('input[placeholder="结束时间"]').value+' '+t[1].value;const errors=[...document.querySelectorAll('[class*="error"]')].filter(e=>e.textContent&&e.getBoundingClientRect().width>0).map(e=>e.textContent);if(start!==${q(plan.startLocal)}||end!==${q(plan.endLocal)}||errors.length||Date.now()>=${plan.start})throw Error('Final period mismatch '+JSON.stringify({start,end,errors}));return JSON.stringify({name:document.getElementById('firstRow-promotion_name_input').value,start,end,timezone:${q('GMT+'+offset)},duration_minutes:525599,errors,ready:true,now:new Date().toISOString()});`);
const file=process.argv[3];if(file)await fs.writeFile(file,JSON.stringify({market:job.market,...plan,...result},null,2));
console.log(JSON.stringify(result));
