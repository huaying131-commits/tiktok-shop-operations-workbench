import {createHash,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as createHTTPSServer} from 'node:https';
import {collectPages} from './vendor/tiktok-shop-sync.mjs';

const iso=now=>new Date(now()).toISOString();
const validId=value=>typeof value==='string'&&/^\d{8,30}$/.test(value);
const qty=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const maxCacheEntries=64,maxInflightReads=4;
const coreCacheKeys=new Set(['/v1/shop?','/v1/products?','/v1/orders?']);
export function createShopReadAPI({client,access,expectedShop,now=Date.now,cacheMs=30000}){
 if(!validId(expectedShop?.id)||expectedShop.region!=='MY'||!expectedShop.name)throw new Error('Exact MY shop required');
 const cache=new Map(),inflight=new Map();
 function cached(key){const value=cache.get(key);if(value){cache.delete(key);cache.set(key,value);}return value;}
 function remember(key,value){
  cache.delete(key);cache.set(key,value);
  while(cache.size>maxCacheEntries){
   const victim=[...cache.keys()].find(candidate=>!coreCacheKeys.has(candidate));
   cache.delete(victim??cache.keys().next().value);
  }
 }
 async function execute(path,params){
  const auth=await access.restore();const read=fn=>access.read(auth,fn);
  const matches=(await read(token=>client.authorizedShops(token))).filter(shop=>shop.id===expectedShop.id&&shop.region===expectedShop.region&&shop.name===expectedShop.name&&typeof shop.cipher==='string'&&shop.cipher);
  if(matches.length!==1)throw new Error('Shop identity mismatch');
  const shop=matches[0],deadline=Date.now()+150000;
  if(path==='/v1/shop')return {...expectedShop};
  if(path==='/v1/products')return collectPages(cursor=>read(token=>client.productsPage(token,shop,100,cursor)),deadline);
  if(path==='/v1/orders'){
   const end=Math.floor(now()/1000),start=end-7*86400;
   return {window:{startInclusive:start,endExclusive:end},...await collectPages(cursor=>read(token=>client.ordersPage(token,shop,100,cursor,start,end)),deadline)};
  }
  const ids=params.get('sku_ids').split(',');
  const {data,requestId}=await read(token=>client.inventoryBySku(token,shop,ids));
  if(!requestId||!Array.isArray(data?.inventory)||data.inventory.some(product=>!Array.isArray(product.skus)))throw new Error('Inventory incomplete');
  const rows=[];const seen=new Set();
  for(const product of data.inventory)for(const sku of product.skus){
   if(!ids.includes(sku?.id)||seen.has(sku.id)||!validId(product.product_id))throw new Error('Inventory identity mismatch');
   seen.add(sku.id);rows.push({productId:product.product_id,skuId:sku.id,sellerSku:typeof sku.seller_sku==='string'?sku.seller_sku:null,available:qty(sku.total_available_quantity),committed:qty(sku.total_committed_quantity),warehouses:Array.isArray(sku.warehouse_inventory)?sku.warehouse_inventory.map(row=>({id:validId(row.warehouse_id)?row.warehouse_id:null,available:qty(row.available_quantity),committed:qty(row.committed_quantity)})):null});
  }
  return {requestId,rows,missingSkuIds:ids.filter(id=>!seen.has(id))};
 }
 async function query(path,params){
  if(!['/v1/shop','/v1/products','/v1/orders','/v1/inventory'].includes(path))return {status:404,body:{error:'not_found'}};
  let canonicalParams=params;
  if(path==='/v1/inventory'){
   const ids=params.get('sku_ids')?.split(',');
   if(!ids?.length||ids.length>600||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||[...params.keys()].some(key=>key!=='sku_ids')||params.getAll('sku_ids').length!==1)return {status:400,body:{error:'invalid_sku_ids'}};
   canonicalParams=new URLSearchParams({sku_ids:ids.sort().join(',')});
  }else if([...params.keys()].length)return {status:400,body:{error:'unsupported_query'}};
  const key=path+'?'+canonicalParams.toString(),prior=cached(key);
  if(prior&&now()-Date.parse(prior.observedAt)<cacheMs)return {status:200,body:{...prior,cacheAgeMs:now()-Date.parse(prior.observedAt)}};
  if(inflight.has(key))return inflight.get(key);
  if(inflight.size>=maxInflightReads)return {status:429,body:{error:'upstream_busy',source:'TikTok Shop Open API',shop:{...expectedShop},stale:true,lastSuccessfulAt:prior?.observedAt??null,data:prior?.data??null}};
  const work=(async()=>{try{
   const data=await execute(path,canonicalParams);const body={source:'TikTok Shop Open API',shop:{...expectedShop},observedAt:iso(now),stale:false,data};remember(key,body);return {status:200,body};
  }catch{return {status:503,body:{error:'upstream_unavailable',source:'TikTok Shop Open API',shop:{...expectedShop},stale:true,lastSuccessfulAt:prior?.observedAt??null,data:prior?.data??null}};}
  finally{inflight.delete(key);}})();
  inflight.set(key,work);return work;
 }
 return {query};
}

export function createReadServer({api,agents,tls,authority,legacyBridge,health=async()=>({})}){
 if(!Array.isArray(agents)||!agents.length||agents.length>32||agents.some(row=>!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(row.name)||!(/^[a-f0-9]{64}$/.test(row.sha256)))||new Set(agents.map(row=>row.sha256)).size!==agents.length)throw new Error('Distinct agent token SHA256 hashes required');
 const digests=agents.map(row=>Buffer.from(row.sha256,'hex'));
 if(legacyBridge&&(!/^[a-f0-9]{64}$/.test(legacyBridge.sha256??'')||agents.some(row=>row.sha256===legacyBridge.sha256)))throw new Error('Separate legacy bridge credential required');
 const bridgeDigest=legacyBridge?Buffer.from(legacyBridge.sha256,'hex'):null;
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(JSON.stringify(body));};
 const handler=async(req,res)=>{
  if(req.method!=='GET'){json(res,405,{error:'read_only'});return;}
  let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{json(res,400,{error:'invalid_request'});return;}
  if(url.pathname==='/healthz'){
   try{const status=await health();json(res,200,{service:'shop-cloud-read',state:'process_running',businessWritesEnabled:false,...status});}
   catch{json(res,503,{service:'shop-cloud-read',state:'health_unavailable',businessWritesEnabled:false});}
   return;
  }
  const token=/^Bearer ([A-Za-z0-9_.~-]{32,128})$/.exec(req.headers.authorization??'')?.[1];
  const digest=createHash('sha256').update(token??'').digest();let match=0;for(const item of digests)match|=Number(timingSafeEqual(item,digest));
  const bridgeMatch=Boolean(bridgeDigest&&timingSafeEqual(bridgeDigest,digest));
  if(url.pathname==='/internal/access-lease'){
   if(!token||(!match&&!bridgeMatch)){json(res,401,{error:'unauthorized'});return;}
   if(match||!bridgeMatch){json(res,403,{error:'bridge_credential_required'});return;}
   if([...url.searchParams.keys()].length){json(res,400,{error:'unsupported_query'});return;}
   if(!authority){json(res,503,{error:'authority_unavailable'});return;}
   try{json(res,200,await authority.lease());}catch{json(res,503,{error:'seller_access_unavailable'});}
   return;
  }
  if(!token||(!match&&!bridgeMatch)){json(res,401,{error:'unauthorized'});return;}
  if(!match){json(res,403,{error:'business_credential_required'});return;}
  try{const result=await api.query(url.pathname,url.searchParams);json(res,result.status,result.body);}catch{json(res,503,{error:'service_unavailable'});}
 };
 return tls?createHTTPSServer({...tls,minVersion:'TLSv1.2'},handler):createServer(handler);
}
