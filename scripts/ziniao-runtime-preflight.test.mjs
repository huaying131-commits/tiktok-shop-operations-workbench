import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EcoGateway} from './ziniao-eco-gateway.mjs';
const config={ads:{taskId:'ads-original',windowName:'ads-own',market:'MY',shopLabel:'(example-shop-my)',path:'/ads',query:{}}};
test('running manual original instance with disconnected Agent blocks before any page SDK or manifest',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ziniao-preflight-')),calls=[];
 const transport={preflight:async()=>({ready:false,code:'MANUAL_INSTANCE_AGENT_DISCONNECTED',environment:'90000000000001',storeRunning:true,serviceHealthy:true,connected:false,automaticLifecycleAllowed:false}),manifest:async()=>{calls.push('manifest');return{};},submit:async()=>{calls.push('submit');return{error:{code:'BROWSER_NOT_CONNECTED'}};},status:async()=>{calls.push('status');return{error:{code:'BROWSER_NOT_CONNECTED'}};}};
 await assert.rejects(new EcoGateway({root,configs:config,transport,clock:()=>new Date('2026-10-19T14:00:00Z')}).section({module:'ads',sectionId:'manual-original'}),/ConnectionPreflight:MANUAL_INSTANCE_AGENT_DISCONNECTED/);
 assert.deepEqual(calls,[]);
 const base=path.join(root,'operations/browser-runtime/eco-gateway/sections/ads/manual-original');
 const report=JSON.parse(await fs.readFile(path.join(base,'connection-preflight.json')));
 assert.equal(report.storeRunning,true);assert.equal(report.connected,false);assert.equal(report.automaticLifecycleAllowed,false);
});
test('disconnected preflight preserves previous unknown call and exact ID without retry or context switch',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ziniao-preflight-')),p=path.join(root,'operations/browser-runtime/eco-gateway/active.json'),original={module:'content',taskId:'original-content',toolCallId:'original-unknown-upload',kind:'verification',effect:'business'};
 await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(original));let calls=0;
 const transport={preflight:async()=>({ready:false,code:'MANUAL_INSTANCE_AGENT_DISCONNECTED',storeRunning:true,connected:false}),manifest:async()=>{calls++;return{};},submit:async()=>{calls++;return{error:{code:'BROWSER_NOT_CONNECTED'}};},status:async()=>{calls++;return{error:{code:'BROWSER_NOT_CONNECTED'}};}};
 await assert.rejects(new EcoGateway({root,configs:config,transport,clock:()=>new Date('2026-10-19T14:00:00Z')}).section({module:'ads',sectionId:'preserve-unknown'}),/ConnectionPreflight/);
 assert.deepEqual(JSON.parse(await fs.readFile(p)),original);assert.equal(calls,0);
});

import * as preflightModule from './ziniao-eco-gateway.mjs';
import {EventEmitter} from 'node:events';
const ENV='90000000000001',NAME='马来西亚示例店（玩具）';
function metadata(){return{environmentId:ENV,expectedStoreName:NAME,health:{status:'ok',service:'ziniao-eco-tools',server_instance_id:'service-a'},online:{success:true,data:{items:[{store_id:ENV,store_name:NAME,platform_id:'92'}]}},connection:{success:true,data:{store_id:ENV,connected:false,status:'disconnected'}},healthAfter:{status:'ok',service:'ziniao-eco-tools',server_instance_id:'service-a'}};}
function assess(v){assert.equal(typeof preflightModule.assessConnectionState,'function');return preflightModule.assessConnectionState(v);}
test('online is not connected and disconnected normal instance is never labeled a test window',()=>{const v=assess(metadata());assert.equal(v.code,'MANUAL_INSTANCE_AGENT_DISCONNECTED');assert.equal(v.storeRunning,true);assert.equal(v.ready,false);assert.equal(v.requestManualStoreStart,false);assert.equal(v.automaticLifecycleAllowed,false);assert.equal(v.testWindowProven,false);});
test('unknown local service is not diagnosed as store offline',()=>{const m=metadata();m.health={error:{code:'LOCAL_SERVICE_UNAVAILABLE'}};assert.equal(assess(m).code,'LOCAL_AGENT_SERVICE_UNAVAILABLE');});
test('online other account or renamed wrong exact identity is blocked',()=>{const m=metadata();m.online.data.items[0].store_name='子账号'+NAME;assert.equal(assess(m).code,'EXACT_STORE_IDENTITY_MISMATCH');});
test('missing expected online store is distinct from an open but disconnected store',()=>{const m=metadata();m.online.data.items=[];const v=assess(m);assert.equal(v.code,'STORE_NOT_RUNNING');assert.equal(v.requestManualStoreStart,true);});
test('status for the wrong environment cannot grant ready',()=>{const m=metadata();m.connection.data={store_id:'90000000000002',connected:true,status:'connected'};assert.equal(assess(m).code,'CONNECTION_TARGET_MISMATCH');});
test('service replacement during metadata sample invalidates readiness',()=>{const m=metadata();m.connection.data.connected=true;m.healthAfter.server_instance_id='service-b';assert.equal(assess(m).code,'LOCAL_AGENT_REPLACED_DURING_CHECK');});
test('actual connected permits only next own-page verification and grants no business success',()=>{const m=metadata();m.connection.data.connected=true;m.connection.data.status='connected';const v=assess(m);assert.equal(v.ready,true);assert.equal(v.code,'READY_FOR_OWNED_PAGE_VERIFICATION');assert.equal(v.businessReady,false);assert.equal(v.automaticLifecycleAllowed,false);});
test('unavailable status remains unknown rather than zero or offline',()=>{const m=metadata();m.connection={error:{code:'AUTH_REQUIRED'}};const v=assess(m);assert.equal(v.code,'CONNECTION_STATUS_UNAVAILABLE');assert.equal(v.requestManualStoreStart,false);});
test('default official transport metadata checks never run legacy page/open/close or a page tool',async()=>{const args=[],spawnImpl=(binary,argv)=>{args.push(argv);const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();queueMicrotask(()=>{const m=metadata();const v=argv[1]==='health'?m.health:argv[1]==='list-online'?m.online:m.connection;c.stdout.emit('data',Buffer.from(JSON.stringify(v)));c.emit('close',0);});return c;};const t=preflightModule.createCliTransport({root:path.resolve('.'),spawnImpl});assert.equal(typeof t.preflight,'function');const v=await t.preflight();assert.equal(v.code,'MANUAL_INSTANCE_AGENT_DISCONNECTED');assert(args.length>=3);assert(args.every(a=>a[0]==='browser'&&['health','list-online','connection-status'].includes(a[1])));assert.equal(args.find(a=>a[1]==='connection-status').at(-1),ENV);});
test('explicit alternate legacy browser executable is rejected without invocation',()=>{assert.throws(()=>preflightModule.createCliTransport({root:path.resolve('.'),binary:'ziniao-cli'}),/OnlyApprovedNativeEcoTransport/);});
