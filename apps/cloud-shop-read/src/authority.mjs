import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,open,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {createVault} from './vault.mjs';
import {isExpiredAccessToken} from './vendor/tiktok-shop-read.mjs';

export class AuthorityUnavailable extends Error {
  constructor(reason){super('Seller access is unavailable');this.reason=reason;}
}

const digest=value=>createHash('sha256').update(value).digest('hex');
const generation=record=>digest(JSON.stringify([record.serviceId,record.tokens.open_id,record.tokens.access_token,record.tokens.access_token_expire_in]));
const validId=value=>typeof value==='string'&&/^\d{8,30}$/.test(value);

// One local queue coalesces callers; the durable exclusive lock also prevents a
// second process or a restarted process from replaying an uncertain refresh.
export function createCloudAuthority({serviceId,expectedShop,client,vault,key,ledgerDirectory,refreshOwner='disabled',now=Date.now,marginSeconds=300,identityCacheMs=30000}){
  if(!validId(serviceId)||!validId(expectedShop?.id)||expectedShop.region!=='MY'||!expectedShop.name||!isAbsolute(ledgerDirectory??'')||!Buffer.isBuffer(key)||key.length!==32)throw new Error('Explicit private seller authority configuration required');
  if(!['disabled','cloud'].includes(refreshOwner))throw new Error('Invalid refresh owner');
  const lockFile=join(ledgerDirectory,'refresh.lock.json');
  const handle={authority:'cloud-seller-access'};
  let queue=Promise.resolve(),activeClaim=null,verified=null,verification=null;
  const serialize=action=>{const next=queue.then(action);queue=next.catch(()=>{});return next;};

  async function privateDirectory(){
    const created=await mkdir(ledgerDirectory,{recursive:true,mode:0o700});
    const info=await lstat(ledgerDirectory);
    if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&(info.mode&0o077)))throw new AuthorityUnavailable('ledger_unavailable');
    // Persist every newly created directory entry through the first existing
    // parent, before any refresh claim can be dispatched.
    if(created&&process.platform!=='win32'){let current=ledgerDirectory;const stop=dirname(created);for(;;){await syncDirectory(current);if(current===stop)break;const parent=dirname(current);if(parent===current)throw new AuthorityUnavailable('ledger_unavailable');current=parent;}}
  }
  async function readPrivateJson(file){
    const info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>65536||(process.platform!=='win32'&&(info.mode&0o077)))throw new AuthorityUnavailable('ledger_unavailable');
    return JSON.parse(await readFile(file,'utf8'));
  }
  async function inspectLock(){
    try{return await readPrivateJson(lockFile);}catch(error){if(error.code==='ENOENT')return null;throw new AuthorityUnavailable('ledger_unavailable');}
  }
  async function syncDirectory(path=ledgerDirectory){
    if(process.platform==='win32')return;
    const directory=await open(path,'r');
    try{await directory.sync();}finally{await directory.close();}
  }
  async function exclusiveJson(file,value){
    const output=await open(file,'wx',0o600);
    try{await output.writeFile(JSON.stringify(value));await output.sync();}finally{await output.close();}
    await syncDirectory();
  }
  async function atomicJson(file,value){
    const pending=file+'.'+randomUUID()+'.tmp';
    try{await exclusiveJson(pending,value);await rename(pending,file);await syncDirectory();}finally{await unlink(pending).catch(()=>{});}
  }
  function validRecord(record){
    const tokens=record?.tokens;
    if(record?.serviceId!==serviceId||typeof record.appKey!=='string'||!record.appKey||typeof record.appSecret!=='string'||!record.appSecret||tokens?.user_type!==0||typeof tokens.access_token!=='string'||!tokens.access_token||typeof tokens.open_id!=='string'||!tokens.open_id||tokens.open_id.length>256||!Number.isSafeInteger(tokens.access_token_expire_in)||tokens.access_token_expire_in<=0||!Array.isArray(tokens.granted_scopes)||tokens.granted_scopes.some(scope=>typeof scope!=='string'))throw new AuthorityUnavailable('seller_identity_invalid');
    return record;
  }
  const loadRecord=async()=>validRecord(await vault.load());
  function usable(record,rejectedToken){return record.tokens.access_token_expire_in>Math.floor(now()/1000)&&record.tokens.access_token!==rejectedToken;}
  function needsRefresh(record,rejectedToken){return record.tokens.access_token_expire_in<=Math.floor(now()/1000)+marginSeconds||record.tokens.access_token===rejectedToken;}

  async function markUnknown(claim,intentFile,reason){
    let existing;
    try{existing=await readPrivateJson(intentFile);}catch{}
    const ours=existing?.id===claim.id;
    const value={...claim,...(ours?existing:{}),state:'UNKNOWN',updatedAt:new Date(now()).toISOString(),reason};
    // If the storage failure also prevents this update, the original pending
    // lock remains. It is equally closed across restart and is never stolen.
    if(ours)await atomicJson(intentFile,value).catch(()=>{});
    await atomicJson(lockFile,value).catch(()=>{});
  }

  async function obtainRecord(rejectedToken){
    return serialize(async()=>{
      let record=await loadRecord();
      if(!needsRefresh(record,rejectedToken))return record;
      if(refreshOwner!=='cloud'){
        if(usable(record,rejectedToken))return record;
        throw new AuthorityUnavailable('refresh_disabled');
      }
      const existing=await inspectLock();
      if(existing){
        if(usable(record,rejectedToken))return record;
        throw new AuthorityUnavailable('refresh_reconciliation_required');
      }
      await privateDirectory();
      let claim={schema:'huaying-seller-refresh/v1',id:randomUUID(),generation:generation(record),serviceId,shopId:expectedShop.id,state:'pending',createdAt:new Date(now()).toISOString()};
      try{await exclusiveJson(lockFile,claim);}
      catch(error){if(error.code==='EEXIST'){record=await loadRecord();if(usable(record,rejectedToken))return record;throw new AuthorityUnavailable('refresh_reconciliation_required');}throw new AuthorityUnavailable('ledger_unavailable');}
      activeClaim=claim.id;
      const intentFile=join(ledgerDirectory,'refresh-'+claim.generation+'.json');
      try{
        // Another process may have committed a new generation immediately
        // before this process acquired the now-free global lock.
        const latest=await loadRecord();
        if(generation(latest)!==claim.generation){await unlink(lockFile);return latest;}
        record=latest;
        if(!record.tokens.refresh_token||(Number.isSafeInteger(record.tokens.refresh_token_expire_in)&&record.tokens.refresh_token_expire_in<=Math.floor(now()/1000))){
          await atomicJson(lockFile,{...claim,state:'blocked',reason:'refresh_authorization_unavailable',providerRequestDispatched:false});
          throw new AuthorityUnavailable('refresh_authorization_unavailable');
        }
        await exclusiveJson(intentFile,claim);
        let tokens;
        try{tokens=await client.refresh(record.tokens.refresh_token);}
        catch{await markUnknown(claim,intentFile,'refresh_result_unknown');throw new AuthorityUnavailable('refresh_reconciliation_required');}
        const current=Math.floor(now()/1000);
        if(tokens?.user_type!==0||tokens.open_id!==record.tokens.open_id||typeof tokens.access_token!=='string'||!tokens.access_token||typeof tokens.refresh_token!=='string'||!tokens.refresh_token||!Number.isSafeInteger(tokens.access_token_expire_in)||tokens.access_token_expire_in<=current+marginSeconds||!Number.isSafeInteger(tokens.refresh_token_expire_in)||tokens.refresh_token_expire_in<=current||!Array.isArray(tokens.granted_scopes)||tokens.granted_scopes.some(scope=>typeof scope!=='string')){
          await markUnknown(claim,intentFile,'refresh_response_identity_invalid');throw new AuthorityUnavailable('refresh_reconciliation_required');
        }
        const updated={...record,tokens};
        if(generation(updated)===claim.generation){await markUnknown(claim,intentFile,'refresh_response_generation_unchanged');throw new AuthorityUnavailable('refresh_reconciliation_required');}
        try{
          // Retain a recoverable encrypted response before replacing the active
          // vault. A later save failure never discards a returned refresh token.
          const recoveryFile=join(ledgerDirectory,'response-'+claim.id+'.enc');
          await createVault({file:recoveryFile,key}).save(updated);
          await vault.save(updated);
          const committed={...claim,state:'committed',resultGeneration:generation(updated),responseFile:'response-'+claim.id+'.enc',committedAt:new Date(now()).toISOString()};
          await atomicJson(intentFile,committed);
          await atomicJson(lockFile,committed);
          await unlink(lockFile);
          await syncDirectory();
        }catch{
          await markUnknown(claim,intentFile,'refresh_persistence_unknown');throw new AuthorityUnavailable('refresh_reconciliation_required');
        }
        verified=null;
        return updated;
      }catch(error){
        // Anything after claiming but before a known committed state is closed.
        // A duplicate intent is not permission to issue a second provider call.
        if(!(error instanceof AuthorityUnavailable))await markUnknown(claim,intentFile,'refresh_generation_requires_reconciliation');
        if(error instanceof AuthorityUnavailable&&usable(record,rejectedToken))return record;
        throw error instanceof AuthorityUnavailable?error:new AuthorityUnavailable('refresh_reconciliation_required');
      }finally{activeClaim=null;}
    });
  }

  async function verifyShop(record){
    const version=generation(record);
    if(verified?.version===version&&now()-verified.at<identityCacheMs)return;
    if(verification?.version===version)return verification.promise;
    const promise=(async()=>{
      const shops=await client.authorizedShops(record.tokens.access_token);
      const matches=Array.isArray(shops)?shops.filter(shop=>shop.id===expectedShop.id&&shop.name===expectedShop.name&&shop.region===expectedShop.region&&typeof shop.cipher==='string'&&shop.cipher):[];
      if(matches.length!==1)throw new AuthorityUnavailable('shop_identity_invalid');
      verified={version,at:now()};
    })();
    verification={version,promise};
    try{return await promise;}finally{if(verification?.promise===promise)verification=null;}
  }

  return {
    async restore(){await loadRecord();return handle;},
    async read(authorization,action){
      if(authorization!==handle)throw new AuthorityUnavailable('authorization_changed');
      const record=await obtainRecord();
      try{return await action(record.tokens.access_token);}
      catch(error){if(!isExpiredAccessToken(error))throw error;const updated=await obtainRecord(record.tokens.access_token);return action(updated.tokens.access_token);}
    },
    async lease(){
      const record=await obtainRecord();await verifyShop(record);
      const tokens=record.tokens;
      return {serviceId,shop:{id:expectedShop.id,name:expectedShop.name,region:expectedShop.region},refreshOwner,version:generation(record).slice(0,24),tokens:{access_token:tokens.access_token,access_token_expire_in:tokens.access_token_expire_in,user_type:tokens.user_type,open_id:tokens.open_id,granted_scopes:[...tokens.granted_scopes]}};
    },
    async status(){
      let lock;
      try{lock=await inspectLock();}catch{return {refreshOwner,needReconcile:true,refreshState:'storage_unavailable'};}
      const refreshing=lock?.state==='pending'&&lock.id===activeClaim;
      return {refreshOwner,needReconcile:Boolean(lock&&!refreshing),refreshState:refreshing?'refreshing':lock?'reconciliation_required':'idle'};
    },
  };
}
