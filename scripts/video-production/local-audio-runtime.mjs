import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';

export function validateLocalRuntime(c,base){
 if(c.enabled===false)throw Error('Local audio runtime disabled after failed perceptual validation; do not silently start it');
 if(c.provider!=='local_llama_cpp'||c.paid_api!==false||c.media_upload!==false||c.listen_host!=='127.0.0.1'||!/^vp-audio-[a-z0-9-]+$/.test(c.model_alias??'')||!Number.isInteger(c.max_threads)||c.max_threads<1||c.max_threads>2)throw Error('Only isolated local low-resource audio runtime is allowed');
 for(const key of ['bin_dir','server','model','projector','api_key_file']){if(typeof c[key]!=='string'||!c[key])throw Error('Missing local runtime path');const rel=path.relative(path.resolve(base),path.resolve(c[key]));if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Audio runtime path escapes its own installation');}
 return true;
}

export async function ensureLocalAudioRuntime(c,root=process.cwd()){
 const base=path.join(root,'.tools/audio-understanding');validateLocalRuntime(c,base);
 for(const p of [c.server,c.model,c.projector,c.api_key_file])if(!fs.existsSync(p))throw Error('Local audio runtime file is missing');
 const headers={Authorization:'Bearer '+fs.readFileSync(c.api_key_file,'utf8').trim()},url='http://127.0.0.1:18819';
 const probe=async()=>{try{const r=await fetch(url+'/health',{headers,signal:AbortSignal.timeout(1800)});if([401,403].includes(r.status))throw Error('Local audio port belongs to a different credential context');if(r.status===503)return 'loading';if(!r.ok)throw Error('Unexpected local audio status '+r.status);const mr=await fetch(url+'/v1/models',{headers,signal:AbortSignal.timeout(3000)});if(!mr.ok)return 'loading';const v=await mr.json();if(!v.data?.some(x=>x.id===c.model_alias))throw Error('Local port has a different model; do not borrow or reset it');return 'ready';}catch(e){if(e.cause?.code==='ECONNREFUSED')return 'absent';throw e;}};
 let state=await probe();if(state==='ready')return {ready:true,reused:true,modelAlias:c.model_alias};
 const lock=path.join(base,'service-start.lock');let fd;
 try{
  fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString(),modelAlias:c.model_alias}));
  state=await probe();
  if(state==='absent'){
   const logs=path.join(base,'logs');fs.mkdirSync(logs,{recursive:true});const tag=new Date().toISOString().replace(/[:.]/g,'-'),stdout=path.join(logs,tag+'.stdout.log'),stderr=path.join(logs,tag+'.stderr.log');
   const args=['-m',path.relative(c.bin_dir,c.model),'--mmproj',path.relative(c.bin_dir,c.projector),'--alias',c.model_alias,'--host','127.0.0.1','--port','18819','--api-key-file',path.relative(c.bin_dir,c.api_key_file),'--device','Vulkan0','--no-webui','--no-warmup','--image-min-tokens','64','--image-max-tokens','256','--jinja','-np','1','-c',String(c.max_context??2048),'-t','2','-tb','2','-ngl','99','--reasoning','off','--reasoning-budget','0','--flash-attn','off','--sleep-idle-seconds','120'];
   const ofd=fs.openSync(stdout,'wx'),efd=fs.openSync(stderr,'wx');let child;
   try{child=spawn(c.server,args,{cwd:c.bin_dir,windowsHide:true,detached:true,stdio:['ignore',ofd,efd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}finally{fs.closeSync(ofd);fs.closeSync(efd);}
   try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
   fs.writeFileSync(path.join(base,'service.json'),JSON.stringify({at:new Date().toISOString(),pid:child.pid,owner_thread:'00000000-0000-4000-8000-000000000004',server:c.server,model_alias:c.model_alias,model_sha256:c.model_sha256,projector_sha256:c.projector_sha256,loopback_only:true,api_key_required:true,device:'Vulkan0',threads:2,sleep_idle_seconds:120,stdout,stderr},null,2)+'\n');child.unref();
  }else if(state==='loading'){
   const p=path.join(base,'service.json');if(!fs.existsSync(p)||JSON.parse(fs.readFileSync(p,'utf8')).model_alias!==c.model_alias)throw Error('Unknown loading service; preserve it without attaching');
  }
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,1500));state=await probe();if(state==='ready')return {ready:true,modelAlias:c.model_alias,onDemand:true,sleepIdleSeconds:120};if(state==='absent'){const own=JSON.parse(fs.readFileSync(path.join(base,'service.json'),'utf8'));if(own.model_alias!==c.model_alias)throw Error('Audio startup identity changed');try{process.kill(own.pid,0);}catch{throw Error('Own audio service stopped during loading; inspect its retained log');}}}
  throw Error('Own audio runtime still loading; preserve current process and logs');
 }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
