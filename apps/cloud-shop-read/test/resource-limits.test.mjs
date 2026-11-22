import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopReadAPI} from '../src/runtime.mjs';

const expectedShop={id:'1000000000000000001',name:'fixture-shop',region:'MY'};
const sku=index=>String(2000000000000000000n+BigInt(index));
const params=ids=>new URLSearchParams({sku_ids:ids.join(',')});
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const access={restore:async()=>({}),read:async(_,fn)=>fn('mock-token')};
const inventory=ids=>({requestId:'mock-request',data:{inventory:[{product_id:'2000000000000000030',skus:ids.map(id=>({id,total_available_quantity:1,warehouse_inventory:[]}))}]}});
function client(overrides={}){return {
 authorizedShops:async()=>[{...expectedShop,cipher:'mock-cipher'}],
 productsPage:async()=>({rows:[],totalCount:0,nextToken:''}),
 ordersPage:async()=>({rows:[],totalCount:0,nextToken:''}),
 inventoryBySku:async(_token,_shop,ids)=>inventory(ids),
 ...overrides,
};}

test('same inventory set shares a pending read and fresh cache regardless of SKU order',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});const calls=[];
 const api=createShopReadAPI({client:client({inventoryBySku:async(_token,_shop,ids)=>{calls.push(ids);await gate;return inventory(ids);}}),access,expectedShop});
 const first=api.query('/v1/inventory',params([sku(2),sku(1)]));
 const second=api.query('/v1/inventory',params([sku(1),sku(2)]));
 try{
  await nextTurn();assert.equal(calls.length,1,'equivalent sets must not start another upstream job');
  assert.deepEqual(calls[0],[sku(1),sku(2)]);
 }finally{release();}
 const [one,two]=await Promise.all([first,second]);assert.equal(one.status,200);assert.deepEqual(one,two);
 assert.equal((await api.query('/v1/inventory',params([sku(2),sku(1)]))).status,200);assert.equal(calls.length,1);
 assert.equal((await api.query('/v1/inventory',params([sku(1),sku(1)]))).status,400);
 assert.equal((await api.query('/v1/inventory',new URLSearchParams(`sku_ids=${sku(1)}&other=1`))).status,400);
 assert.equal(calls.length,1,'invalid queries must remain closed before canonicalization');
});

test('four distinct upstream jobs are allowed; overflow is rejected while cache hits and same-key joins work',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let calls=0,authorizationCalls=0;
 const api=createShopReadAPI({client:client({authorizedShops:async()=>{authorizationCalls++;return [{...expectedShop,cipher:'mock-cipher'}];},inventoryBySku:async(_token,_shop,ids)=>{calls++;await gate;return inventory(ids);}}),access,expectedShop});
 assert.equal((await api.query('/v1/shop',new URLSearchParams())).status,200);
 const running=[1,2,3,4].map(index=>api.query('/v1/inventory',params([sku(index)])));
 const same=api.query('/v1/inventory',params([sku(1)]));
 const overflow=api.query('/v1/inventory',params([sku(5)]));
 try{
  await nextTurn();
  const response=await Promise.race([overflow,nextTurn().then(()=>null)]);
  assert.equal(response?.status,429,'overflow must reject without waiting for an upstream job');
  assert.equal(calls,4,'rejected and equivalent queries must not add upstream work');
  assert.equal(authorizationCalls,5,'overflow must not even begin a platform authorization read');
  assert.equal((await api.query('/v1/shop',new URLSearchParams())).status,200,'cached read remains available at capacity');
 }finally{release();}
 const responses=await Promise.all([...running,same,overflow]);assert(responses.slice(0,5).every(result=>result.status===200));
 assert.equal((await api.query('/v1/inventory',params([sku(5)]))).status,200,'completion releases an upstream slot');assert.equal(calls,5);
});

test('successful inventory cache is bounded and LRU while core shop evidence is preserved',async()=>{
 let calls=0,platformDown=false;const failures=new Set();
 const api=createShopReadAPI({client:client({authorizedShops:async()=>{if(platformDown)throw new Error('mock platform unavailable');return [{...expectedShop,cipher:'mock-cipher'}];},inventoryBySku:async(_token,_shop,ids)=>{calls++;if(ids.some(id=>failures.has(id)))throw new Error('mock upstream failure');return inventory(ids);}}),access,expectedShop,cacheMs:600000});
 for(const path of ['/v1/shop','/v1/products','/v1/orders'])assert.equal((await api.query(path,new URLSearchParams())).status,200);
 for(let index=1;index<=61;index++)assert.equal((await api.query('/v1/inventory',params([sku(index)]))).status,200);
 assert.equal(calls,61);
 assert.equal((await api.query('/v1/inventory',params([sku(1)]))).status,200);assert.equal(calls,61,'cache access refreshes recency');
 assert.equal((await api.query('/v1/inventory',params([sku(62)]))).status,200);assert.equal(calls,62);
 failures.add(sku(2));const evicted=await api.query('/v1/inventory',params([sku(2)]));
 assert.equal(evicted.status,503);assert.equal(evicted.body.data,null,'oldest inventory evidence was evicted rather than accumulated');assert.equal(evicted.body.lastSuccessfulAt,null);
 assert.equal((await api.query('/v1/inventory',params([sku(1)]))).status,200,'recently used inventory remains cached');assert.equal(calls,63);
 platformDown=true;
 for(const path of ['/v1/shop','/v1/products','/v1/orders'])assert.equal((await api.query(path,new URLSearchParams())).status,200,'fixed core evidence survives inventory churn');
});
