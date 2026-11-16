// Only the three documented, read-only connection metadata GETs are retried.
// Agent tools, status queries, page operations and browser lifecycle never enter here.
export async function connectionMetadataPreflight({invoke,assessConnectionState,environmentId,expectedStoreName,retryDelayMs=750}){
 if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>2000)throw Error('BoundedMetadataRetryDelayRequired');
 const attempts=[],timings=[];
 const read=async argv=>{
  const start=Date.now();
  for(let attempt=1;attempt<=2;attempt++){
   const entry={command:argv[1],attempt,startedAt:new Date().toISOString()};
   let value;
   try{
    value=await invoke(argv);entry.finishedAt=new Date().toISOString();entry.errorCode=value?.error?.code??null;
    entry.retryable=value?.error?.code==='AUTH_SERVICE_UNAVAILABLE'&&value.error.retryable===true;
    attempts.push(entry);
   }catch(error){
    // These exact native CLI failures affect only the metadata GETs above.
    // Nonempty unknown output and all business/tool requests remain unretried.
    let native;try{native=JSON.parse(error.message.slice(error.message.indexOf(':')+1));}catch{}
    entry.finishedAt=new Date().toISOString();entry.error=error.message;
    const localDiscoveryFailure=/unable to connect to the local Ziniao App/.test(native?.stderr??'');
    const metadataDeadline=/^Error: local ECO request timed out: context deadline exceeded(?:\r?\n|$)/.test(native?.stderr??'');
    entry.retryable=error.message.startsWith('CLIResponseUnknown:')&&native?.code===1&&native?.stdout===''&&(localDiscoveryFailure||metadataDeadline);
    attempts.push(entry);
    if(!entry.retryable||attempt===2){
     const failure=new Error('MetadataReadFailed:'+JSON.stringify({attempts,cause:error.message}));
     failure.metadataAttempts=attempts;throw failure;
    }
   }
   if(!entry.retryable||attempt===2){timings.push(Date.now()-start);return value;}
   if(retryDelayMs)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
  }
 };
 const health=await read(['browser','health']);
 const online=await read(['browser','list-online']);
 const connection=await read(['browser','connection-status','--store-id',environmentId]);
 const healthAfter=await read(['browser','health']);
 return {...assessConnectionState({environmentId,expectedStoreName,health,online,connection,healthAfter}),
  preflight_order:'strict_serial_all_original_gates_retained',
  evidence:{health,online,connection,healthAfter,timings_ms:timings,metadataAttempts:attempts}};
}
