// Local extraction: imports localized; unrelated hardcoded title probes removed where applicable.
import assert from 'node:assert/strict';
export function assertCompleteNormalJSON(raw,decoded){
 const walk=(v,where)=>{
  if(typeof v==='string'){
   const t=v.trim();
   if(/^[\[{]/.test(t)){
    let parsed,parsedOK=false;try{parsed=JSON.parse(t);parsedOK=true;}catch{}
    if(parsedOK){walk(parsed,where+'.JSON');return;}
    if(/(?:^|\.)(?:output|result|text|_rawText)$/.test(where))throw Error('Incomplete JSON envelope text at '+where);
   }
   assert(!/\[(?:truncated|incomplete|data_omitted)(?:\]|:| )|<omitted>|^data_omitted$|\b(?:data|content)\s+omitted due to\b/i.test(t),'Incomplete marker text at '+where);
   return;
  }
  if(!v||typeof v!=='object')return;
  for(const [k,x] of Object.entries(v)){
   if(['truncated','partial','incomplete','is_error','verification_pending','data_omitted','content_omitted','is_truncated','isTruncated'].includes(k))assert(x===false||x===null,'Incomplete normal JSON flag '+where+'.'+k);
   if(['error','exceptionDetails','required_verification_call','pending_stage'].includes(k))assert(x===false||x===null,'Required/error conflict '+where+'.'+k);
   if(['complete','is_complete','isComplete'].includes(k))assert.equal(x,true,'Explicit incomplete result '+where+'.'+k);
   walk(x,where+'.'+k);
  }
 };
 walk(raw,'raw');walk(decoded,'decoded');assert.equal(decoded?._parsedJSON,true,'Normal complete parsed JSON required');
}
