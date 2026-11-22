import {readFile,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createVault} from './vault.mjs';
import {createShopReadAPI,createReadServer} from './runtime.mjs';
import {createTikTokClient} from './vendor/tiktok-shop-read.mjs';
import {createCloudAuthority} from './authority.mjs';
import {loadTLSMaterial,createTLSReloader} from './tls-reload.mjs';

async function privateRead(path){if(!isAbsolute(path??''))throw new Error('Private absolute configuration paths required');const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>1048576||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Private configuration permissions required');return readFile(path,'utf8');}
export async function start(env=process.env){
 if(env.SHOP_CLOUD_READ_ENABLED!=='1')throw new Error('Cloud read runtime is disabled until configured');
 const config=JSON.parse(await privateRead(env.SHOP_CLOUD_CONFIG));
 const key=Buffer.from((await privateRead(env.SHOP_CLOUD_KEY_FILE)).trim(),'base64');
 if(!isAbsolute(config.authorizationFile??''))throw new Error('Absolute encrypted authorization path required');
 const vault=createVault({file:resolve(config.authorizationFile),key});const initial=await vault.load();
 if(initial.serviceId!==config.serviceId||initial.tokens?.user_type!==0)throw new Error('Seller authorization mismatch');
 const client=createTikTokClient({appKey:initial.appKey,appSecret:initial.appSecret});
 const refreshOwner=env.SHOP_CLOUD_REFRESH_OWNER==='cloud'?'cloud':'disabled';
 if(config.refreshLedgerDirectory!==undefined&&!isAbsolute(config.refreshLedgerDirectory))throw new Error('Absolute private refresh ledger path required');
 const ledgerDirectory=resolve(config.refreshLedgerDirectory??resolve(config.authorizationFile,'../refresh-ledger'));
 const access=createCloudAuthority({serviceId:config.serviceId,expectedShop:config.expectedShop,client,vault,key,ledgerDirectory,refreshOwner});
 const tlsConfigured=Boolean(env.SHOP_CLOUD_TLS_CERT_FILE||env.SHOP_CLOUD_TLS_KEY_FILE);
 const tls=tlsConfigured?await loadTLSMaterial({certFile:env.SHOP_CLOUD_TLS_CERT_FILE,keyFile:env.SHOP_CLOUD_TLS_KEY_FILE}):undefined;
 const bind=tls?(env.SHOP_CLOUD_BIND??'127.0.0.1'):'127.0.0.1';if(!['127.0.0.1','0.0.0.0','::'].includes(bind))throw new Error('Invalid listen address');
 const background={backgroundSyncCompletedAt:null,backgroundSyncSucceededAt:null,backgroundSyncHealthy:null};
 const api=createShopReadAPI({client,access,expectedShop:config.expectedShop});
 const server=createReadServer({api,agents:config.agents,tls,authority:access,legacyBridge:config.legacyBridge,health:async()=>({...background,...await access.status()})});
 const port=Number(env.SHOP_CLOUD_PORT??(tls?'8443':'8731'));if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
 const tlsReloader=tls?createTLSReloader({server,certFile:env.SHOP_CLOUD_TLS_CERT_FILE,keyFile:env.SHOP_CLOUD_TLS_KEY_FILE,onEvent:event=>console.log(JSON.stringify(event))}):null;
 tlsReloader?.start();
 let stopped=false,timer;
 const sync=async()=>{try{const products=await api.query('/v1/products',new URLSearchParams());const orders=await api.query('/v1/orders',new URLSearchParams());background.backgroundSyncHealthy=products.status===200&&orders.status===200;background.backgroundSyncCompletedAt=new Date().toISOString();if(background.backgroundSyncHealthy)background.backgroundSyncSucceededAt=background.backgroundSyncCompletedAt;}finally{if(!stopped)timer=setTimeout(sync,Math.max(60000,Number(config.syncIntervalMs)||60000));}};
 if(config.backgroundSync===true)await sync();
 return {server,close:async()=>{stopped=true;clearTimeout(timer);tlsReloader?.stop();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const runtime=await start();console.log(JSON.stringify({service:'shop-cloud-read',state:'listening',businessWritesEnabled:false}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.close().then(()=>process.exit(0)));}catch{console.error('Cloud read service did not start; verify private configuration and encrypted seller authorization.');process.exitCode=1;}
}
