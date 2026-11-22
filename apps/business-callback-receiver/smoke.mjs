// Run only after the root operator has actually deployed and enabled this host.
const parsedOrigin=new URL(process.env.CALLBACK_PUBLIC_ORIGIN??'');
if(parsedOrigin.protocol!=='https:'||parsedOrigin.username||parsedOrigin.password||parsedOrigin.pathname!=='/'||parsedOrigin.search||parsedOrigin.hash||parsedOrigin.port!=='8444')throw new Error('Set CALLBACK_PUBLIC_ORIGIN to the registered HTTPS origin on port 8444');
const origin=parsedOrigin.origin;
const call=async path=>{
 const response=await fetch(new URL(path,origin),{redirect:'error',signal:AbortSignal.timeout(20000)});
 return {status:response.status,body:await response.text()};
};
const health=await call('/healthz');
if(health.status!==200)throw new Error('HTTPS receiver health is not confirmed');
const parsed=JSON.parse(health.body);
if(parsed.service!=='huaying-business-oauth'||parsed.liveIntegrationVerified!==false||!Array.isArray(parsed.configuredProviders)||parsed.configuredProviders.length)throw new Error('Receiver configuration differs from the planned disabled host');
const checks={};
for(const provider of ['advertiser','account']){
 const response=await call(`/oauth/${provider}/callback`);
 if(response.status!==503||!response.body.includes('not configured'))throw new Error('Unconfigured OAuth callback must fail closed, rather than return 404 or claim success');
 checks[provider]={status:response.status,registrationStageOnly:true};
}
console.log(JSON.stringify({observedAt:new Date().toISOString(),origin,strictTLSValidation:true,health:health.status,checks,configuredProviders:[],liveIntegrationVerified:false}));
