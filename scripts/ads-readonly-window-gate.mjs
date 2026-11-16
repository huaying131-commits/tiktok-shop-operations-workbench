import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export function validateReadonlyWindow(g,now=Date.now()){
 const start=Date.parse(g.window_start),end=Date.parse(g.window_end);
 if(g.id!=='ADS-PAGE-20261019-1406'||g.environment_id!=='90000000000001'||g.repair_owner_thread_id!=='00000000-0000-4000-8000-000000000008'||g.live_verification_ready!==true||!Number.isFinite(start)||!Number.isFinite(end)||now<start||now>=end||end-start>300000||typeof g.window_id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(g.window_id))throw Error('NoCurrentReadyBoundedWindow');
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now));if(hour<9||hour>=23)throw Error('Outside09To23');
 return {windowId:g.window_id,start:g.window_start,end:g.window_end,maxCalls:6};
}
export function reserveWindowCall(base,windowId,id,intent){
 if(!/^[a-z0-9-]+$/.test(id))throw Error('InvalidIntentId');
 fs.mkdirSync(base,{recursive:true});const prefix=crypto.createHash('sha256').update(windowId).digest('hex')+'-';
 const file=path.join(base,prefix+id+'.intent.json');
 const lock=path.join(base,prefix+'counter.lock');
 try{fs.mkdirSync(lock);}catch(e){if(e.code==='EEXIST')throw Error('WindowCounterBusy');throw e;}
 try{
  if(fs.existsSync(file))throw Error('IntentAlreadyExists');
  const count=fs.readdirSync(base).filter(f=>f.startsWith(prefix)&&f.endsWith('.intent.json')).length;
  if(count>=6)throw Error('WindowCallLimit');
  fs.writeFileSync(file,JSON.stringify({...intent,window_id:windowId,id,ordinal:count+1},null,2),{flag:'wx'});
 }finally{fs.rmdirSync(lock);}
 return file;
}
