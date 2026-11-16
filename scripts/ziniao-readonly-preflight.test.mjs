import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createCliTransport} from './ziniao-eco-gateway.mjs';

const store='90000000000001';
const health=id=>({status:'ok',service:'ziniao-eco-tools',server_instance_id:id});
const online={success:true,data:{items:[{store_id:store,store_name:'马来西亚示例店（玩具）',platform_id:'92'}]}};
const connected={success:true,data:{store_id:store,connected:true}};
const unavailable={code:1,stderr:'Error: unable to connect to the local Ziniao App\n'};
const metadataDeadline={code:1,stderr:'Error: local ECO request timed out: context deadline exceeded\nHint: retry the request.\n'};
function fixture(respond,factory=createCliTransport){
 const seen=[];let inflight=0,maxInflight=0;
 const spawnImpl=(binary,args,options)=>{
  const child=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();
  seen.push({args:[...args],options});inflight++;maxInflight=Math.max(maxInflight,inflight);
  setImmediate(()=>{const result=respond(args,seen)??{value:args[1]==='health'?health('same'):args[1]==='list-online'?online:connected};
   child.stdout.end(result.stdout??(result.value===undefined?'':JSON.stringify(result.value)));child.stderr.end(result.stderr??'');inflight--;child.emit('close',result.code??0);});
  return child;
 };
 return {seen,max:()=>maxInflight,transport:factory({spawnImpl,metadataRetryDelayMs:0})};
}
test('a transient health read is retried once without skipping any admission gate',async()=>{
 let healthCount=0;const f=fixture(args=>args[1]==='health'&&++healthCount===1?unavailable:undefined);
 const result=await f.transport.preflight();assert.equal(result.ready,true);
 assert.deepEqual(f.seen.map(x=>x.args[1]),['health','health','list-online','connection-status','health']);
 assert.equal(result.evidence.metadataAttempts.filter(x=>x.command==='health').length,3);
});
test('retryable authentication service failure on metadata can recover',async()=>{
 let count=0;const f=fixture(args=>args[1]==='list-online'&&++count===1?{value:{error:{code:'AUTH_SERVICE_UNAVAILABLE',retryable:true}},code:1}:undefined);
 const result=await f.transport.preflight();assert.equal(result.ready,true);assert.equal(count,2);
 assert.equal(result.evidence.metadataAttempts.some(x=>x.errorCode==='AUTH_SERVICE_UNAVAILABLE'),true);
});
test('invalid credentials are not retried and never admit business work',async()=>{
 let count=0;const f=fixture(args=>args[1]==='list-online'?(count++,{value:{error:{code:'INVALID_API_KEY',retryable:false}},code:1}):undefined);
 const result=await f.transport.preflight();assert.equal(result.ready,false);assert.equal(count,1);
});
test('a persistent local connection fault stops after two metadata reads',async()=>{
 const f=fixture(()=>unavailable);await assert.rejects(f.transport.preflight(),/unable to connect|MetadataReadFailed/);
 assert.equal(f.seen.length,2);assert.equal(f.max(),1);
});
test('server replacement across the checks still blocks admission',async()=>{
 let n=0;const f=fixture(args=>args[1]==='health'?{value:health(++n===1?'before':'after')}:undefined);
 const result=await f.transport.preflight();assert.equal(result.ready,false);assert.equal(result.code,'LOCAL_AGENT_REPLACED_DURING_CHECK');
});
test('an uncertain agent submission retains exact IDs and is never retried',async()=>{
 const f=fixture(()=>unavailable),request={taskId:'original-task',toolCallId:'original-once-id',args:{action:'tabs',params:{action:'list'}}};
 await assert.rejects(f.transport.submit(request));assert.equal(f.seen.length,1);
 assert.deepEqual(f.seen[0].args.slice(0,3),['agent','tool','--browser-id']);assert.ok(f.seen[0].args.includes('original-task'));assert.ok(f.seen[0].args.includes('original-once-id'));
});
test('an unrecognized malformed response is not hidden by retry',async()=>{
 const f=fixture(()=>({stdout:'unexpected response',code:1}));await assert.rejects(f.transport.preflight());assert.equal(f.seen.length,1);
});
test('all connection metadata commands are strictly serial and background only',async()=>{
 const f=fixture(()=>undefined);assert.equal((await f.transport.preflight()).ready,true);assert.equal(f.max(),1);
 for(const item of f.seen){assert.equal(item.options.windowsHide,true);assert.equal(item.args[0],'browser');assert.ok(['health','list-online','connection-status'].includes(item.args[1]));assert.equal(item.options.env.NO_PROXY,'localhost,127.0.0.1,::1');}
});
test('the existing actor compatibility entry receives the same bounded metadata fix',async()=>{
 const {createCliTransport:actorFactory}=await import('./ziniao-serial-cli-preflight.mjs');
 let n=0;const f=fixture(args=>args[1]==='health'&&++n===1?unavailable:undefined,actorFactory);
 assert.equal((await f.transport.preflight()).ready,true);assert.equal(f.seen.length,5);assert.equal(f.max(),1);
});
test('a local ECO metadata deadline is retried once while preserving every serial gate',async()=>{
 let count=0;const f=fixture(args=>args[1]==='list-online'&&++count===1?metadataDeadline:undefined);
 const result=await f.transport.preflight();assert.equal(result.ready,true);
 assert.deepEqual(f.seen.map(x=>x.args[1]),['health','list-online','list-online','connection-status','health']);
 assert.equal(result.evidence.metadataAttempts[1].retryable,true);assert.equal(f.max(),1);
 assert.deepEqual(f.seen[3].args,['browser','connection-status','--store-id',store]);
});
test('persistent local ECO metadata deadlines stop after two list reads before later gates',async()=>{
 const f=fixture(args=>args[1]==='list-online'?metadataDeadline:undefined);
 await assert.rejects(f.transport.preflight(),/MetadataReadFailed/);
 assert.deepEqual(f.seen.map(x=>x.args[1]),['health','list-online','list-online']);assert.equal(f.max(),1);
});
test('deadline responses with nonempty unknown stdout are never retried',async()=>{
 const f=fixture(()=>({...metadataDeadline,stdout:'partial unknown response'}));
 await assert.rejects(f.transport.preflight(),/MetadataReadFailed/);assert.equal(f.seen.length,1);
});
test('an agent deadline retains the original request and is never retried',async()=>{
 const f=fixture(()=>metadataDeadline),request={taskId:'original-task',toolCallId:'original-once-id',args:{action:'evaluate',params:{download:false,js:'document.title'}}};
 await assert.rejects(f.transport.submit(request));assert.equal(f.seen.length,1);
 assert.ok(f.seen[0].args.includes('original-once-id'));assert.deepEqual(f.seen[0].args.slice(0,2),['agent','tool']);
});

test('an unknown submission identifies its stage without logging page arguments or retrying',async()=>{
 const f=fixture(()=>unavailable),privateBody='private-page-value-not-for-error-output';
 await assert.rejects(f.transport.submit({taskId:'original-task',toolCallId:'original-once-id',args:{action:'evaluate',params:{download:false,js:privateBody}}}),error=>{
  const native=JSON.parse(error.message.slice('CLIResponseUnknown:'.length));
  assert.equal(native.operation,'agent.tool.submit');assert.equal(native.code,1);
  assert.equal(error.message.includes(privateBody),false);assert.equal(error.message.includes('original-once-id'),false);return true;
 });
 assert.equal(f.seen.length,1);
});

test('an unknown status read is distinguishable from a submission and never redispatches it',async()=>{
 const f=fixture(()=>unavailable);
 await assert.rejects(f.transport.status({toolCallId:'protected-original-id'}),error=>{
  const native=JSON.parse(error.message.slice('CLIResponseUnknown:'.length));assert.equal(native.operation,'agent.tool.status');return true;
 });
 assert.equal(f.seen.length,1);assert.deepEqual(f.seen[0].args.slice(0,3),['agent','tool','status']);
});

test('an unknown manifest read is reported as manifest rather than a page operation',async()=>{
 const f=fixture(()=>unavailable);
 await assert.rejects(f.transport.manifest(),error=>{
  const native=JSON.parse(error.message.slice('CLIResponseUnknown:'.length));assert.equal(native.operation,'agent.manifest');return true;
 });
 assert.equal(f.seen.length,1);
});

test('a failed metadata read retains its precise stage and the existing two-attempt bound',async()=>{
 const f=fixture(()=>unavailable);
 await assert.rejects(f.transport.preflight(),error=>{
  assert.equal(error.metadataAttempts.length,2);
  for(const attempt of error.metadataAttempts){const native=JSON.parse(attempt.error.slice('CLIResponseUnknown:'.length));assert.equal(native.operation,'browser.health');}
  return true;
 });
 assert.equal(f.seen.length,2);assert.equal(f.max(),1);
});
