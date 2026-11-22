import {readFile} from 'node:fs/promises';
const base=new URL(process.env.SHOP_READ_BASE_URL??'');
if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname)))throw new Error('HTTPS or local smoke endpoint required');
if(base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('An origin without credentials, path or query is required');
const configured=process.env.SHOP_READ_CONFIG?JSON.parse(await readFile(process.env.SHOP_READ_CONFIG,'utf8')).expectedShop:null;
const expectedShop=configured??{id:process.env.SHOP_READ_EXPECTED_SHOP_ID,name:process.env.SHOP_READ_EXPECTED_SHOP_NAME,region:'MY'};
if(!/^\d{8,30}$/.test(expectedShop?.id??'')||typeof expectedShop.name!=='string'||!expectedShop.name||expectedShop.region!=='MY')throw new Error('Provide SHOP_READ_CONFIG or exact SHOP_READ_EXPECTED_SHOP_ID and SHOP_READ_EXPECTED_SHOP_NAME');
const token=(await readFile(process.env.SHOP_READ_TOKEN_FILE,'utf8')).trim();
const request=async(path,options={})=>fetch(new URL(path,base),{redirect:'error',signal:AbortSignal.timeout(180000),...options});
const denied=await request('/v1/products');if(denied.status!==401)throw new Error('Unauthenticated read must be denied');
const headers={authorization:'Bearer '+token};
const write=await request('/v1/products',{method:'POST',headers});if(write.status!==405)throw new Error('Business write method not rejected');
const summary={observedAt:new Date().toISOString(),unauthenticated:denied.status,writeRejected:write.status,reads:{}};
let sku;
for(const path of ['/v1/shop','/v1/products','/v1/orders']){
 const response=await request(path,{headers});const body=await response.json();
 if(response.status!==200||body.stale!==false||body.shop?.id!==expectedShop.id||body.shop.name!==expectedShop.name||body.shop.region!==expectedShop.region||!body.observedAt||JSON.stringify(body).includes(token))throw new Error('Fresh expected-shop read failed');
 summary.reads[path]={status:response.status,observedAt:body.observedAt,count:body.data?.rows?.length??null};
 if(path==='/v1/products')sku=body.data.rows.flatMap(row=>row.skus??[]).find(row=>/^\d{8,30}$/.test(row.id))?.id;
}
if(sku){const response=await request('/v1/inventory?sku_ids='+sku,{headers});const body=await response.json();if(response.status!==200||body.stale!==false||!body.data.requestId||body.data.rows.some(row=>row.skuId!==sku))throw new Error('Inventory read not verified');summary.reads.inventory={status:response.status,observedAt:body.observedAt,returnedRows:body.data.rows.length,missingRequestedSkus:body.data.missingSkuIds.length};}
else summary.reads.inventory={state:'not_tested_no_sku_available'};
console.log(JSON.stringify(summary,null,2));
