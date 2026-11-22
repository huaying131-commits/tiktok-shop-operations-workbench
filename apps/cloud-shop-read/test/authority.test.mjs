import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCloudAuthority} from '../src/authority.mjs';
import {createVault} from '../src/vault.mjs';
import {createReadServer} from '../src/runtime.mjs';

const shop={id:'9999999999999999999',name:'fixture-shop',region:'MY'};
const serviceId='8888888888888888888';
const baseNow=1795000000000;
const baseRecord=()=>({serviceId,appKey:'mock-app-key',appSecret:'mock-app-secret',tokens:{user_type:0,open_id:'fixture-owner',access_token:'fixture-old-access',access_token_expire_in:Math.floor(baseNow/1000)+7200,refresh_token:'fixture-old-refresh',refresh_token_expire_in:Math.floor(baseNow/1000)+720000,granted_scopes:['seller.product.basic']}});
const nextTokens=()=>({...baseRecord().tokens,access_token:'fixture-new-access',refresh_token:'fixture-new-refresh',access_token_expire_in:Math.floor(baseNow/1000)+14400});
async function fixture({owner='cloud',expiry,refresh,save}={}){
 const directory=await mkdtemp(join(tmpdir(),'authority-v3-'));const key=randomBytes(32);let record=baseRecord(),clock=baseNow,refreshCalls=0,identityCalls=0;
 if(expiry!==undefined)record.tokens.access_token_expire_in=Math.floor(baseNow/1000)+expiry;
 const vault={load:async()=>structuredClone(record),save:async value=>{if(save)return save(value);record=structuredClone(value);}};
 const client={refresh:async token=>{refreshCalls++;assert.equal(token,'fixture-old-refresh');return refresh?refresh():nextTokens();},authorizedShops:async()=>{identityCalls++;return [{...shop,cipher:'fixture-cipher'}];}};
 const make=(expectedShop=shop)=>createCloudAuthority({serviceId,expectedShop,client,vault,key,ledgerDirectory:join(directory,'ledger'),refreshOwner:owner,now:()=>clock});
 return {directory,key,vault,client,make,get record(){return record;},set record(value){record=structuredClone(value);},get refreshCalls(){return refreshCalls;},get identityCalls(){return identityCalls;},advance(ms){clock+=ms;},async close(){const full=resolve(directory);assert.equal(dirname(full),resolve(tmpdir()));assert(basename(full).startsWith('authority-v3-'));await rm(full,{recursive:true,force:true});}};
}

test('disabled mirror supplies only an exact-shop access lease, coalesces identity reads and never refreshes',async()=>{
 const f=await fixture({owner:'disabled',expiry:60});
 try{
  const authority=f.make({...shop,privateConfiguration:'never-return'});const values=await Promise.all(Array.from({length:16},()=>authority.lease()));
  assert.equal(f.refreshCalls,0);assert.equal(f.identityCalls,1);assert.equal(values[0].refreshOwner,'disabled');assert.deepEqual(values[0].shop,shop);
  assert.deepEqual(Object.keys(values[0].tokens).sort(),['access_token','access_token_expire_in','granted_scopes','open_id','user_type']);
  assert.match(values[0].version,/^[a-f0-9]{24}$/);assert.deepEqual(Object.keys(values[0]).sort(),['refreshOwner','serviceId','shop','tokens','version']);assert(!JSON.stringify(values).includes('never-return'));
  assert(!JSON.stringify(values).includes('fixture-old-refresh'));assert(!JSON.stringify(values).includes('mock-app-secret'));assert(!JSON.stringify(values).includes('fixture-cipher'));
  f.advance(61000);await assert.rejects(()=>authority.lease(),error=>error.reason==='refresh_disabled');assert.equal(f.refreshCalls,0);
 }finally{await f.close();}
});

test('a lease refuses a different MY shop or owner type before returning any access token',async()=>{
 const f=await fixture();
 try{f.client.authorizedShops=async()=>[{...shop,id:'9999999999999999998',cipher:'fixture-cipher'}];await assert.rejects(()=>f.make().lease(),error=>error.reason==='shop_identity_invalid');f.record={...f.record,tokens:{...f.record.tokens,user_type:1}};await assert.rejects(()=>f.make().restore(),error=>error.reason==='seller_identity_invalid');assert.equal(f.refreshCalls,0);}finally{await f.close();}
});

test('concurrent expired reads refresh once, save an encrypted recovery response and commit before releasing the lock',async()=>{
 const f=await fixture({expiry:-1});
 try{
  const authority=f.make(),handle=await authority.restore();const values=await Promise.all(Array.from({length:20},()=>authority.read(handle,token=>token)));
  assert(values.every(value=>value==='fixture-new-access'));assert.equal(f.refreshCalls,1);assert.equal(f.record.tokens.refresh_token,'fixture-new-refresh');assert.equal((await authority.status()).needReconcile,false);
  const files=await readdir(join(f.directory,'ledger'));assert(!files.includes('refresh.lock.json'));
  const ledger=JSON.parse(await readFile(join(f.directory,'ledger',files.find(name=>name.startsWith('refresh-'))),'utf8'));assert.equal(ledger.state,'committed');
  const responseFile=join(f.directory,'ledger',ledger.responseFile);const encrypted=await readFile(responseFile,'utf8');assert(!encrypted.includes('fixture-new-refresh'));assert(!encrypted.includes('mock-app-secret'));assert.equal((await createVault({file:responseFile,key:f.key}).load()).tokens.refresh_token,'fixture-new-refresh');
 }finally{await f.close();}
});

test('independent authority instances do not dispatch a second refresh while a durable claim is pending',async()=>{
 let release,started;const begin=new Promise(resolve=>started=resolve);const wait=new Promise(resolve=>release=resolve);
 const f=await fixture({expiry:-1,refresh:async()=>{started();await wait;return nextTokens();}});
 try{
  const a=f.make(),ha=await a.restore();const first=a.read(ha,token=>token);await begin;
  const b=f.make(),hb=await b.restore();await assert.rejects(()=>b.read(hb,token=>token),error=>error.reason==='refresh_reconciliation_required');assert.equal(f.refreshCalls,1);
  assert.deepEqual(await a.status(),{refreshOwner:'cloud',needReconcile:false,refreshState:'refreshing'});
  assert.equal((await b.status()).needReconcile,true);release();assert.equal(await first,'fixture-new-access');assert.equal(await b.read(hb,token=>token),'fixture-new-access');assert.equal(f.refreshCalls,1);
 }finally{release?.();await f.close();}
});

test('an unknown refresh result keeps still-valid access usable, then blocks retry across recreated authority',async()=>{
 const f=await fixture({expiry:60,refresh:async()=>{throw new Error('private refresh URL and credentials');}});
 try{
  const a=f.make(),h=await a.restore();assert.equal(await a.read(h,token=>token),'fixture-old-access');assert.equal(f.refreshCalls,1);
  assert.equal((await a.status()).needReconcile,true);const lockText=await readFile(join(f.directory,'ledger/refresh.lock.json'),'utf8');assert.equal(JSON.parse(lockText).state,'UNKNOWN');assert(!lockText.includes('private refresh URL'));assert(!lockText.includes('fixture-old-refresh'));
  const b=f.make(),hb=await b.restore();assert.equal(await b.read(hb,token=>token),'fixture-old-access');f.advance(61000);await assert.rejects(()=>b.read(hb,token=>token),error=>error.reason==='refresh_reconciliation_required');assert.equal(f.refreshCalls,1);
 }finally{await f.close();}
});

test('a failed primary vault save retains encrypted returned tokens and prohibits subsequent refresh',async()=>{
 const f=await fixture({expiry:60,save:async()=>{throw new Error('disk not writable');}});
 try{
  const a=f.make(),h=await a.restore();assert.equal(await a.read(h,token=>token),'fixture-old-access');assert.equal(f.refreshCalls,1);assert.equal(f.record.tokens.access_token,'fixture-old-access');
  const files=await readdir(join(f.directory,'ledger'));const response=files.find(name=>name.startsWith('response-'));assert(response);assert.equal((await createVault({file:join(f.directory,'ledger',response),key:f.key}).load()).tokens.access_token,'fixture-new-access');
  const b=f.make(),hb=await b.restore();assert.equal(await b.read(hb,token=>token),'fixture-old-access');f.advance(61000);await assert.rejects(()=>b.read(hb,token=>token));assert.equal(f.refreshCalls,1);assert.equal((await b.status()).needReconcile,true);
 }finally{await f.close();}
});

test('a refresh response for another seller is not installed or returned',async()=>{
 const f=await fixture({expiry:-1,refresh:async()=>({...nextTokens(),open_id:'another-owner'})});
 try{const a=f.make(),h=await a.restore();await assert.rejects(()=>a.read(h,token=>token),error=>error.reason==='refresh_reconciliation_required');assert.equal(f.record.tokens.access_token,'fixture-old-access');assert.equal((await a.status()).needReconcile,true);assert.equal(f.refreshCalls,1);}finally{await f.close();}
});

test('refresh expiry must be an absolute future Unix timestamp before returned tokens can be installed',async()=>{
 for(const refreshExpiry of [undefined,7200,Math.floor(baseNow/1000)-1]){
  const f=await fixture({expiry:-1,refresh:async()=>({...nextTokens(),refresh_token_expire_in:refreshExpiry})});
  try{const a=f.make(),h=await a.restore();await assert.rejects(()=>a.read(h,token=>token),error=>error.reason==='refresh_reconciliation_required');assert.equal(f.record.tokens.access_token,'fixture-old-access');assert.equal(f.refreshCalls,1);assert.equal((await a.status()).needReconcile,true);}finally{await f.close();}
 }
});

test('rolling the vault back to an already committed generation cannot replay its refresh or overwrite its ledger',async()=>{
 const f=await fixture({expiry:-1});
 try{const original=structuredClone(f.record);const a=f.make(),h=await a.restore();await a.read(h,token=>token);const file=(await readdir(join(f.directory,'ledger'))).find(name=>name.startsWith('refresh-'));const originalLedger=await readFile(join(f.directory,'ledger',file),'utf8');f.record=original;const b=f.make(),hb=await b.restore();await assert.rejects(()=>b.read(hb,token=>token));assert.equal(f.refreshCalls,1);assert.equal(await readFile(join(f.directory,'ledger',file),'utf8'),originalLedger);assert.equal((await b.status()).needReconcile,true);}finally{await f.close();}
});

test('an actual new Node process observes the UNKNOWN latch and issues zero mock provider requests',async()=>{
 const f=await fixture({expiry:-1});
 try{
  const authFile=join(f.directory,'auth.enc'),keyFile=join(f.directory,'key.txt');await writeFile(keyFile,f.key.toString('base64'),{mode:0o600});const vault=createVault({file:authFile,key:f.key});await vault.save(f.record);
  const authority=createCloudAuthority({serviceId,expectedShop:shop,client:{...f.client,refresh:async()=>{throw new Error('network unknown');}},vault,key:f.key,ledgerDirectory:join(f.directory,'ledger'),refreshOwner:'cloud',now:()=>baseNow});const h=await authority.restore();await assert.rejects(()=>authority.read(h,token=>token));
  const authorityURL=new URL('../src/authority.mjs',import.meta.url).href,vaultURL=new URL('../src/vault.mjs',import.meta.url).href;
  const script=`import {readFile} from 'node:fs/promises';import {createCloudAuthority} from ${JSON.stringify(authorityURL)};import {createVault} from ${JSON.stringify(vaultURL)};const key=Buffer.from(await readFile(${JSON.stringify(keyFile)},'utf8'),'base64');let calls=0;const authority=createCloudAuthority({serviceId:${JSON.stringify(serviceId)},expectedShop:${JSON.stringify(shop)},client:{refresh:async()=>{calls++;throw Error('must not run');}},vault:createVault({file:${JSON.stringify(authFile)},key}),key,ledgerDirectory:${JSON.stringify(join(f.directory,'ledger'))},refreshOwner:'cloud',now:()=>${baseNow}});let reason;try{await authority.read(await authority.restore(),()=>null);}catch(error){reason=error.reason;}console.log(JSON.stringify({calls,reason,status:await authority.status()}));`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,timeout:10000}));assert.equal(result.calls,0);assert.equal(result.reason,'refresh_reconciliation_required');assert.equal(result.status.needReconcile,true);
 }finally{await f.close();}
});

test('only a separate bridge credential can read the lease; business agents cannot receive provider tokens',async()=>{
 const business='a'.repeat(40),bridge='b'.repeat(40),sha=value=>createHash('sha256').update(value).digest('hex');let leases=0,queries=0;
 const lease={serviceId,shop,refreshOwner:'disabled',version:'fixture-version',tokens:{access_token:'fixture-access',access_token_expire_in:1796000000,user_type:0,open_id:'fixture-owner',granted_scopes:['scope']}};
 const server=createReadServer({api:{query:async()=>{queries++;return {status:200,body:{data:'business-only'}};}},agents:[{name:'business',sha256:sha(business)}],legacyBridge:{sha256:sha(bridge)},authority:{lease:async()=>{leases++;return lease;}},health:async()=>({refreshOwner:'disabled',needReconcile:false,backgroundSyncCompletedAt:null})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base='http://127.0.0.1:'+server.address().port,auth=token=>({headers:{authorization:'Bearer '+token}});
  assert.equal((await fetch(base+'/internal/access-lease')).status,401);assert.equal((await fetch(base+'/internal/access-lease',auth('z'.repeat(40)))).status,401);assert.equal((await fetch(base+'/internal/access-lease',auth(business))).status,403);assert.equal(leases,0);
  const response=await fetch(base+'/internal/access-lease',auth(bridge));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),lease);assert.equal(leases,1);
  assert.equal((await fetch(base+'/v1/products',auth(bridge))).status,403);assert.equal(queries,0);assert.equal((await fetch(base+'/internal/access-lease?token=bad',auth(bridge))).status,400);assert.equal((await fetch(base+'/internal/access-lease',{...auth(bridge),method:'POST'})).status,405);
  const health=await(await fetch(base+'/healthz')).json();assert.equal(health.refreshOwner,'disabled');assert(!JSON.stringify(health).includes('fixture-access'));assert(!JSON.stringify(health).includes('fixture-owner'));
  assert.throws(()=>createReadServer({api:{},agents:[{name:'a',sha256:sha(business)}],legacyBridge:{sha256:sha(business)}}),/Separate/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
