import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createReadServer} from '../src/runtime.mjs';
import {loadTLSMaterial,createTLSReloader} from '../src/tls-reload.mjs';

test('real local HTTPS rotates certificates and retains previous context for mismatched pair',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'huaying-read-tls-'));
 let server,loader;
 try{
  const openssl=process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  const paths=[];
  for(const name of ['a','b']){
   const certFile=join(folder,name+'.crt'),keyFile=join(folder,name+'.key');
   const result=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-days','1'],{stdio:'pipe'});
   assert.equal(result.status,0,'Local OpenSSL test fixture generation failed');await chmod(keyFile,0o600);paths.push({certFile,keyFile});
  }
  const [certA,certB]=await Promise.all(paths.map(row=>readFile(row.certFile)));
  const trust=Buffer.concat([certA,certB]);let selected=paths[0];
  server=createReadServer({api:{query:async()=>({status:200,body:{}})},agents:[{name:'test',sha256:createHash('sha256').update('x'.repeat(40)).digest('hex')}],tls:await loadTLSMaterial(selected)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const fingerprint=()=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/healthz',servername:'localhost',ca:trust,agent:false,rejectUnauthorized:true},res=>{const fingerprint=res.socket.getPeerCertificate().fingerprint256;res.resume();res.on('end',()=>resolve(fingerprint));});req.once('error',reject);req.end();});
  assert.equal(await fingerprint(),new X509Certificate(certA).fingerprint256);
  loader=createTLSReloader({server,load:()=>loadTLSMaterial(selected)});assert.equal(await loader.reload(),true);
  selected=paths[1];assert.equal(await loader.reload(),true);assert.equal(await fingerprint(),new X509Certificate(certB).fingerprint256);
  selected={certFile:paths[0].certFile,keyFile:paths[1].keyFile};assert.equal(await loader.reload(),false);assert.equal(await fingerprint(),new X509Certificate(certB).fingerprint256);
 }finally{
  loader?.stop();if(server?.listening)await new Promise(resolve=>server.close(resolve));
  const checked=relative(resolve(tmpdir()),resolve(folder));assert(!checked.startsWith('..')&&!checked.includes(':')&&checked.startsWith('huaying-read-tls-'));
  await rm(folder,{recursive:true,force:true});
 }
});
