import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('missing authorization stays closed; unauthorized request makes no upstream call',async()=>{
 const {createReadServer}=await import('../src/runtime.mjs');
 let calls=0;const server=createReadServer({api:{query:async()=>{calls++;return {}; }},agents:[{name:'test',sha256:createHash('sha256').update('x'.repeat(40)).digest('hex')}]});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const base=`http://127.0.0.1:${server.address().port}`;assert.equal((await fetch(base+'/v1/products')).status,401);assert.equal((await fetch(base+'/v1/products',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(40)}})).status,405);assert.equal(calls,0);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('live read checks exact shop, completes pages, and does not leak credentials',async()=>{
 const {createShopReadAPI}=await import('../src/runtime.mjs');
 const calls=[];const client={authorizedShops:async()=>[{id:'1000000000000000001',name:'fixture-shop',region:'MY',cipher:'cipher-private'}],productsPage:async(token,shop,size,cursor)=>{calls.push(cursor);assert.equal(token,'private-token');return cursor?{rows:[{id:'2000000000000000031',title:'Second',skus:[]}],totalCount:2,nextToken:''}:{rows:[{id:'2000000000000000030',title:'First',skus:[]}],totalCount:2,nextToken:'next'};}};
 const access={restore:async()=>({}),read:async(_,fn)=>fn('private-token')};
 const api=createShopReadAPI({client,access,expectedShop:{id:'1000000000000000001',name:'fixture-shop',region:'MY'},now:()=>1780000000000});
 const result=await api.query('/v1/products',new URLSearchParams());assert.equal(result.status,200);assert.equal(result.body.data.rows.length,2);assert.equal(result.body.stale,false);assert.deepEqual(calls,[undefined,'next']);assert(!JSON.stringify(result).includes('private-token'));assert(!JSON.stringify(result).includes('cipher-private'));
});

test('wrong shop refuses read; previous successful data remains explicit stale evidence on failure',async()=>{
 const {createShopReadAPI}=await import('../src/runtime.mjs');
 let fail=false;const client={authorizedShops:async()=>{if(fail)throw new Error('SECRET');return [{id:'1000000000000000001',name:'fixture-shop',region:'MY',cipher:'x'}];},productsPage:async()=>({rows:[],totalCount:0,nextToken:''})};
 const access={restore:async()=>({}),read:async(_,fn)=>fn('token')};let now=1780000000000;
 const api=createShopReadAPI({client,access,expectedShop:{id:'1000000000000000001',name:'fixture-shop',region:'MY'},now:()=>now,cacheMs:0});
 await api.query('/v1/products',new URLSearchParams());fail=true;now+=1000;const response=await api.query('/v1/products',new URLSearchParams());assert.equal(response.status,503);assert.equal(response.body.stale,true);assert.equal(response.body.lastSuccessfulAt,'2026-05-28T20:26:40.000Z');assert(!JSON.stringify(response).includes('SECRET'));
 const wrong=createShopReadAPI({client:{...client,authorizedShops:async()=>[{id:'1000000000000000002',name:'fixture-shop',region:'MY',cipher:'x'}]},access,expectedShop:{id:'1000000000000000001',name:'fixture-shop',region:'MY'}});assert.equal((await wrong.query('/v1/products',new URLSearchParams())).status,503);
});

test('inventory preserves unknown, requires requested IDs and rejects arbitrary routes',async()=>{
 const {createShopReadAPI}=await import('../src/runtime.mjs');
 const client={authorizedShops:async()=>[{id:'1000000000000000001',name:'fixture-shop',region:'MY',cipher:'x'}],inventoryBySku:async()=>({requestId:'req-1',data:{inventory:[{product_id:'2000000000000000030',skus:[{id:'2000000000000000031',seller_sku:'A',total_available_quantity:null,warehouse_inventory:[]}]}]}})};
 const api=createShopReadAPI({client,access:{restore:async()=>({}),read:async(_,fn)=>fn('t')},expectedShop:{id:'1000000000000000001',name:'fixture-shop',region:'MY'}});
 assert.equal((await api.query('/v1/inventory',new URLSearchParams('sku_ids=2000000000000000031'))).body.data.rows[0].available,null);assert.equal((await api.query('/v1/inventory',new URLSearchParams('sku_ids=bad'))).status,400);assert.equal((await api.query('/v1/ship',new URLSearchParams())).status,404);
});

test('portable vault uses authenticated ciphertext and rejects wrong key',async()=>{
 const {createVault}=await import('../src/vault.mjs');const dir=await mkdtemp(join(tmpdir(),'shop-read-'));try{const file=join(dir,'record.enc');const vault=createVault({file,key:randomBytes(32)});const value={serviceId:'s',appKey:'key',appSecret:'secret-value',tokens:{access_token:'private-token',user_type:0}};await vault.save(value);assert.deepEqual(await vault.load(),value);const text=await readFile(file,'utf8');assert(!text.includes('secret-value'));assert(!text.includes('private-token'));await assert.rejects(()=>createVault({file,key:randomBytes(32)}).load());}finally{await rm(dir,{recursive:true,force:true});}
});

test('TLS refresh only installs complete changed material and retains context on failure',async()=>{
 const {createTLSReloader}=await import('../src/tls-reload.mjs');let calls=0,material={cert:'cert1',key:'key1'},fail=false;const events=[];
 const loader=createTLSReloader({server:{setSecureContext:value=>{calls++;assert.equal(value.minVersion,'TLSv1.2');}},load:async()=>{if(fail)throw new Error('secret private key');return material;},onEvent:value=>events.push(value)});
 assert.equal(await loader.reload(),true);assert.equal(await loader.reload(),false);material={cert:'cert2',key:'key2'};assert.equal(await loader.reload(),true);fail=true;assert.equal(await loader.reload(),false);assert.equal(calls,2);assert(!JSON.stringify(events).includes('secret'));loader.stop();
});
