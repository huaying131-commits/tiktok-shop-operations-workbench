import {createServer} from 'node:https';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {FileStateStore,createOAuthHandler} from './oauth.mjs';
import {loadTLSMaterial,createTLSReloader} from './tls-reload.mjs';

export const TLS_CERT_FILE='/etc/huaying-shop-cloud/tls/server.crt';
export const TLS_KEY_FILE='/etc/huaying-shop-cloud/tls/server.key';

export function readConfig(env){
 if(env.CALLBACK_HOST_ENABLED!=='1')throw new Error('Callback host is disabled');
 let publicOrigin;
 try{const origin=new URL(env.PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==env.PUBLIC_ORIGIN||origin.port!=='8444')throw new Error();publicOrigin=origin.origin;}catch{throw new Error('Explicit HTTPS callback origin on the dedicated port required');}
 const port=Number(env.PORT??8444);
 if(port!==8444)throw new Error('Only the dedicated callback port is allowed');
 const bind=env.PUBLIC_BIND??'0.0.0.0';
 if(!['0.0.0.0','127.0.0.1'].includes(bind))throw new Error('Invalid bind address');
 if(env.OAUTH_DATA_DIR!=='/var/lib/huaying-business-callback')throw new Error('Dedicated callback data directory required');
 if((env.TLS_CERT_FILE&&env.TLS_CERT_FILE!==TLS_CERT_FILE)||(env.TLS_KEY_FILE&&env.TLS_KEY_FILE!==TLS_KEY_FILE))throw new Error('Dedicated copied TLS material required');
 return {publicOrigin,port,bind,directory:env.OAUTH_DATA_DIR,certFile:TLS_CERT_FILE,keyFile:TLS_KEY_FILE};
}

// Registration-stage receiver only. There is deliberately no provider-enable switch,
// application secret, token exchange adapter, or merchant sign-in bypass in this host.
export function createInactiveCallbackHost({tls,directory,publicOrigin,audit=()=>{}}){
 if(!tls?.cert||!tls?.key||!isAbsolute(directory??'')||typeof publicOrigin!=='string')throw new Error('Explicit TLS, public origin and data directory required');
 const handler=createOAuthHandler({
  publicOrigin,
  stateStore:new FileStateStore(directory),
  vault:{save:async()=>{throw new Error('Token persistence is disabled');}},
  providers:{},
  authenticate:async()=>null,
  audit,
 });
 const server=createServer({...tls,minVersion:'TLSv1.2'},handler);
 server.requestTimeout=15000;
 server.headersTimeout=10000;
 server.keepAliveTimeout=5000;
 server.maxRequestsPerSocket=100;
 server.maxConnections=64;
 return server;
}

export async function start(env=process.env){
 const config=readConfig(env);
 const server=createInactiveCallbackHost({tls:await loadTLSMaterial(config),directory:config.directory,publicOrigin:config.publicOrigin});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bind,resolve);});
 const reload=createTLSReloader({server,certFile:config.certFile,keyFile:config.keyFile,onEvent:event=>console.log(JSON.stringify(event))});
 reload.start();
 let closed=false;
 return {server,close:async()=>{if(closed)return;closed=true;reload.stop();await new Promise(resolve=>server.close(resolve));}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const runtime=await start();
  console.log(JSON.stringify({event:'business_callback_host_started',port:8444,configuredProviders:[],liveIntegrationVerified:false}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.close().then(()=>process.exit(0)));
 }catch{
  console.error(JSON.stringify({event:'business_callback_host_start_failed'}));
  process.exitCode=1;
 }
}
