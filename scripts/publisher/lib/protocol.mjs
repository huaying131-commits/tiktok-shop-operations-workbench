import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeJSON,readJSON,fail} from './common.mjs';
import {decodeOfficial,verificationDecision,completeMYTextSnapshot} from './official-response-v5.mjs';
import {assertCompleteNormalJSON} from './complete-json.mjs';

export class Protocol {
 constructor({transport,environment,taskId,activeFile,receipts,maxPolls=24,clock=()=>new Date().toISOString()}){Object.assign(this,{transport,environment,taskId,activeFile,receipts,maxPolls,clock});}
 async readOriginal(){
  if(!fs.existsSync(this.activeFile))return{conclusion:'no_inflight',read_only:true};
  const original=readJSON(this.activeFile);
  if(original.taskId!==this.taskId||!original.toolCallId)fail('original_request_owner_mismatch');
  if(!/^[\x21-\x7e]{1,64}$/.test(original.toolCallId))return{conclusion:'unknown',reason:'legacy_tool_call_id_not_routable',original,read_only:true,gate_preserved:true};
  const r=await this.transport.status({toolCallId:original.toolCallId});
  if(r?.tool_call_id!==original.toolCallId||r?.browser_id!==this.environment||original.requestId&&r.request_id!==original.requestId)fail('original_request_correlation_unknown');
  return{conclusion:['succeeded','failed','cancelled'].includes(r.status)?'original_terminal_result_requires_effect_readback':'unknown',original,observation:r,read_only:true,gate_preserved:true};
 }
 async call(args,{readOnly=false,expectedURL,depth=0,verification=false,basis=null}={}) {
  if(depth>=4)fail('required_verification_unresolved');
  if(fs.existsSync(this.activeFile))fail('inflight_request_preserved');
  if(readOnly&&!['evaluate','snapshot','visible_dom','tabs'].includes(args.action))fail('read_only_protocol_violation',40);
  if(readOnly&&args.action==='tabs'&&args.params?.action!=='list')fail('read_only_tab_selection_forbidden',40);
  const id='publisher-'+crypto.randomUUID(),request={taskId:this.taskId,toolCallId:id,name:'browser',args};
  if(!/^[\x21-\x7e]{1,64}$/.test(id))fail('invalid_tool_call_id',40);
  this.lastRequest={tool_call_id:id,request_id:null};
  const dir=path.join(this.receipts,id);fs.mkdirSync(dir,{recursive:true});writeJSON(path.join(dir,'request.json'),request,true);
  writeJSON(this.activeFile,{module:'content',at:this.clock(),...request},true);
  let response=await this.transport.submit(request);writeJSON(path.join(dir,'submit.json'),response??null,true);
  const rid=response?.request_id;
  this.lastRequest={tool_call_id:id,request_id:rid??null};
  if(typeof rid!=='string'||!rid)fail('request_correlation_unknown');
  if(response.tool_call_id!==id||response.browser_id!==this.environment)fail('request_correlation_unknown');
  const current=readJSON(this.activeFile);if(current.toolCallId!==id)fail('original_active_gate_changed');
  writeJSON(this.activeFile,{...current,requestId:rid});
  for(let n=0;!['succeeded','failed','cancelled'].includes(response?.status)&&n<this.maxPolls;n++){
   response=await this.transport.status({toolCallId:id});writeJSON(path.join(dir,'status-'+n+'.json'),response??null,true);
   if(response?.request_id!==rid||response?.tool_call_id!==id||response?.browser_id!==this.environment)fail('request_correlation_unknown');
  }
  if(response?.request_id!==rid||response?.tool_call_id!==id||response?.browser_id!==this.environment)fail('request_correlation_unknown');
  if(!['succeeded','failed','cancelled'].includes(response.status))fail('original_result_unknown');
  if(response.status!=='succeeded'||response.error){fs.renameSync(this.activeFile,path.join(dir,'terminal-active.json'));fail('original_call_failed_no_replay',20,{response});}
  const decoded=decodeOfficial(response);
  if(decoded.error||decoded.exceptionDetails)fail('native_evaluation_unknown',20,{decoded});
  const complete=args.action==='snapshot'&&completeMYTextSnapshot(decoded,expectedURL)&&decoded.verification_pending!==true&&!decoded.required_verification_call;
  const decision=complete?{pending:false}:verificationDecision(decoded,verification,basis,expectedURL);
  if(decision.pending){
   // Only an exact official read-only verification is permitted. No caller-supplied mutation/retry.
   if(!decision.required||!['snapshot','visible_dom'].includes(decision.required.action))fail('required_read_verification_missing');
   fs.renameSync(this.activeFile,path.join(dir,'verification-parent-active.json'));
   await this.call(decision.required,{readOnly:true,expectedURL,depth:depth+1,verification:true,basis:decision.basis});
  }else{
   if(args.action==='evaluate')assertCompleteNormalJSON(response,decoded);
   fs.renameSync(this.activeFile,path.join(dir,'terminal-active.json'));
  }
  let value=decoded.result;if(typeof value==='string'){try{value=JSON.parse(value);}catch{}}
  value=value?.parsed_json_preview??value;
  if(value!==undefined)assertCompleteNormalJSON({result:value},{_parsedJSON:true,result:value});
  return{value,tabs:decoded.tabs,decoded,toolCallId:id,requestId:rid};
 }
}

// Serialized guard is also tested with an independent tiny DOM. Selector text is supplied by selectors.json.
export function uniqueScript({selector,effect='read',owner,url,value,property='value'}) {
 return `(()=>{if(window.name!==${JSON.stringify(owner)}||location.href!==${JSON.stringify(url)})throw Error('OwnedPageChanged');const all=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length);if(all.length!==1)throw Error('UniqueSelectorRequired');const e=all[0];if(e.disabled||e.getAttribute?.('aria-disabled')==='true')throw Error('DisabledControl');${effect==='click'?"e.click();return{ok:true};":effect==='type'?`e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,value:e.value};`:`return{value:e[${JSON.stringify(property)}]};`}})()`;
}
