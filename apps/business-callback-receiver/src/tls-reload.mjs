import {createHash,X509Certificate} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {createSecureContext} from 'node:tls';
import {isAbsolute} from 'node:path';

export async function loadTLSMaterial({certFile,keyFile}){
 if(!isAbsolute(certFile??'')||!isAbsolute(keyFile??''))throw new Error('Explicit TLS material paths required');
 for(const [file,isKey] of [[certFile,false],[keyFile,true]]){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>1048576||(isKey&&process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Invalid TLS file');
 }
 const [cert,key]=await Promise.all([readFile(certFile),readFile(keyFile)]);
 const certificate=new X509Certificate(cert);const now=Date.now();
 if(Date.parse(certificate.validFrom)>now||Date.parse(certificate.validTo)<=now)throw new Error('TLS certificate is outside validity window');
 createSecureContext({cert,key,minVersion:'TLSv1.2'});
 return {cert,key,minVersion:'TLSv1.2'};
}

export function createTLSReloader({server,certFile,keyFile,load=()=>loadTLSMaterial({certFile,keyFile}),onEvent=()=>{},intervalMs=60000}){
 let current,working=false,stopped=false,timer;
 const emit=event=>{try{onEvent({event});}catch{}};
 async function reload(){
  if(working||stopped)return false;working=true;
  try{
   const material=await load();const stamp=createHash('sha256').update(material.cert).update('\0').update(material.key).digest('hex');
   if(stopped||stamp===current)return false;
   server.setSecureContext({...material,minVersion:'TLSv1.2'});current=stamp;emit('tls_context_updated');return true;
  }catch{emit('tls_context_refresh_failed');return false;}finally{working=false;}
 }
 return {reload,start(){if(stopped||timer)return;timer=setInterval(()=>void reload(),Math.max(10000,intervalMs));timer.unref();},stop(){stopped=true;clearInterval(timer);}};
}
