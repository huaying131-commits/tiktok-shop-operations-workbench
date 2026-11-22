import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {request} from 'node:https';
import {X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,rm,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfig,createInactiveCallbackHost,TLS_CERT_FILE,TLS_KEY_FILE} from '../src/main.mjs';
import {loadTLSMaterial,createTLSReloader} from '../src/tls-reload.mjs';

const PUBLIC_ORIGIN='https://callbacks.example.test:8444';
const approvedEnv={CALLBACK_HOST_ENABLED:'1',PUBLIC_ORIGIN,PORT:'8444',PUBLIC_BIND:'0.0.0.0',OAUTH_DATA_DIR:'/var/lib/huaying-business-callback'};
test('production config requires explicit HTTPS origin, unprivileged port, copied TLS paths and data directory',()=>{
 assert.deepEqual(readConfig(approvedEnv),{publicOrigin:PUBLIC_ORIGIN,port:8444,bind:'0.0.0.0',directory:'/var/lib/huaying-business-callback',certFile:TLS_CERT_FILE,keyFile:TLS_KEY_FILE});
 for(const override of [{CALLBACK_HOST_ENABLED:''},{PUBLIC_ORIGIN:undefined},{PUBLIC_ORIGIN:'http://callbacks.example.test:8444'},{PUBLIC_ORIGIN:'https://user:password@callbacks.example.test:8444'},{PUBLIC_ORIGIN:'https://callbacks.example.test:8444/path'},{PUBLIC_ORIGIN:'https://callbacks.example.test:8444?query=1'},{PUBLIC_ORIGIN:'https://callbacks.example.test:8444#fragment'},{PUBLIC_ORIGIN:'https://callbacks.example.test:443'},{PORT:'443'},{PUBLIC_BIND:'::'},{OAUTH_DATA_DIR:'/tmp/shared'},{TLS_CERT_FILE:'/var/lib/naiveproxy/private.crt'},{TLS_KEY_FILE:'/var/lib/naiveproxy/private.key'}])assert.throws(()=>readConfig({...approvedEnv,...override}));
});

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'huaying-callback-host-'));
 const openssl=process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
 const materials=[];
 for(const name of ['a','b']){
  const certFile=join(directory,name+'.crt'),keyFile=join(directory,name+'.key');
  const result=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-days','1'],{stdio:'pipe'});
  assert.equal(result.status,0,'Local test certificate generation failed');
  await chmod(keyFile,0o600);materials.push({certFile,keyFile});
 }
 const certs=await Promise.all(materials.map(item=>readFile(item.certFile)));
 const trust=Buffer.concat(certs),audit=[];
 const dataDirectory=join(directory,'disabled-state');
 const server=createInactiveCallbackHost({tls:await loadTLSMaterial(materials[0]),directory:dataDirectory,publicOrigin:PUBLIC_ORIGIN,audit:event=>audit.push(event)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(path,method='GET')=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:server.address().port,path,method,servername:'localhost',ca:trust,rejectUnauthorized:true,agent:false},res=>{
   let body='';const fingerprint=res.socket.getPeerCertificate().fingerprint256;
   res.setEncoding('utf8');res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body,fingerprint}));
  });req.once('error',reject);req.end();
 });
 t.after(async()=>{
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  const checked=relative(resolve(tmpdir()),resolve(directory));
  assert(!checked.startsWith('..')&&!checked.includes(':')&&checked.startsWith('huaying-callback-host-'));
  await rm(directory,{recursive:true,force:true});
 });
 return {directory,dataDirectory,server,call,materials,certs,audit};
}

test('strict local HTTPS exposes truthful health, routes callbacks and never processes an input authorization',async t=>{
 const f=await fixture(t);
 const health=await f.call('/healthz');assert.equal(health.status,200);
 assert.deepEqual(JSON.parse(health.body),{service:'huaying-business-oauth',configuredProviders:[],liveIntegrationVerified:false});
 assert.equal(health.fingerprint,new X509Certificate(f.certs[0]).fingerprint256);
 const marker='NEVER-PROCESS-AUTH-CODE';
 for(const provider of ['advertiser','account']){
  for(const [path,method] of [[`/oauth/${provider}/callback?state=not-registered&auth_code=${marker}`,'GET'],[`/oauth/${provider}/start`,'POST']]){
   const result=await f.call(path,method);assert.equal(result.status,503);
   assert.match(result.body,/not configured/);assert.equal(result.body.includes(marker),false);
   assert.match(result.headers['cache-control'],/no-store/);assert.equal(result.headers['referrer-policy'],'no-referrer');
  }
 }
 assert.equal((await f.call('/not-a-route')).status,404);
 assert.deepEqual(f.audit,[]);
 await assert.rejects(readdir(f.dataDirectory),error=>error.code==='ENOENT');
});

test('HTTPS callback host hot reloads a valid copied pair and retains previous context after a mismatch',async t=>{
 const f=await fixture(t);let selected=f.materials[0];const events=[];
 const reloader=createTLSReloader({server:f.server,load:()=>loadTLSMaterial(selected),onEvent:event=>events.push(event)});
 t.after(()=>reloader.stop());
 assert.equal(await reloader.reload(),true);
 selected=f.materials[1];assert.equal(await reloader.reload(),true);
 assert.equal((await f.call('/healthz')).fingerprint,new X509Certificate(f.certs[1]).fingerprint256);
 selected={certFile:f.materials[0].certFile,keyFile:f.materials[1].keyFile};
 assert.equal(await reloader.reload(),false);
 assert.equal((await f.call('/healthz')).fingerprint,new X509Certificate(f.certs[1]).fingerprint256);
 assert.deepEqual(events.map(item=>item.event),['tls_context_updated','tls_context_updated','tls_context_refresh_failed']);
});

test('CLI fails closed without approved runtime configuration and does not print raw errors or supplied secrets',()=>{
 const secret='DO-NOT-ECHO-SECRET';
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/main.mjs',import.meta.url))],{encoding:'utf8',env:{...process.env,CALLBACK_HOST_ENABLED:'',TIKTOK_APP_SECRET:secret,PUBLIC_ORIGIN:'https://wrong.invalid'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.equal(result.stderr.trim(),JSON.stringify({event:'business_callback_host_start_failed'}));
 assert.equal(result.stderr.includes(secret),false);
});
