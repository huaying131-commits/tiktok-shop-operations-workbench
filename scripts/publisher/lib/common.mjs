import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class PublisherError extends Error {
  constructor(reason, code = 20, details = {}) { super(reason); this.name='PublisherError'; Object.assign(this,{reason,code,details}); }
}
export const fail = (reason, code=20, details={}) => { throw new PublisherError(reason,code,details); };
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const fileHash = file => digest(fs.readFileSync(file));
export const readJSON = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export const day = value => new Date(new Date(value).getTime()+28800000).toISOString().slice(0,10);
export function instant(value) {
  if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value))) fail('explicit_iso_time_required',40);
  return Date.parse(value);
}
export function safeID(id) { if(typeof id!=='string'||!/^[-A-Za-z0-9_]{1,160}$/.test(id)) fail('invalid_job_id',40); return id; }
export function writeJSON(file, value, exclusive=false) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const data=JSON.stringify(value,null,2)+'\n';
  if(exclusive) { const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return; }
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  writeJSON(tmp,value,true);fs.renameSync(tmp,file);
}
export function appendJSON(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'a');
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function walk(root) {
  if(!fs.existsSync(root)) return [];
  const out=[];
  for(const e of fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(e.isSymbolicLink()) continue;
    const p=path.join(root,e.name);if(e.isDirectory())out.push(...walk(p));else if(e.isFile())out.push(p);
  }
  return out;
}
export function acquireLock(file, metadata={}) {
  try{writeJSON(file,{pid:process.pid,at:new Date().toISOString(),token:crypto.randomUUID(),...metadata},true);}
  catch(e){if(e.code==='EEXIST')fail('global_lock_busy',20,{file,preserve:true});throw e;}
  const own=fs.readFileSync(file,'utf8');
  return ()=>{if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===own)fs.unlinkSync(file);};
}
