// Local extraction: imports localized; unrelated hardcoded title probes removed where applicable.
export {decodeOfficial} from './official-response.mjs';
const instruction='Before any new interaction, inspect a successful complete snapshot, visible_dom, or screenshot. This result did not clear the pending verification.';
function incomplete(v,depth=0){if(depth>12)return true;if(!v||typeof v!=='object')return false;for(const[k,x]of Object.entries(v)){if(['truncated','data_omitted','incomplete','is_truncated','isTruncated','partial'].includes(k)&&x===true)return true;if(['complete','is_complete','isComplete'].includes(k)&&x===false)return true;if(x&&typeof x==='object'&&incomplete(x,depth+1))return true;}return false;}
function exactMYURL(s){try{const u=new URL(s);if(u.origin!=='https://seller.tiktokshopglobalselling.com'||u.username||u.password)return null;const rr=u.searchParams.getAll('shop_region');if(rr.length!==1||rr[0]!=='MY')return null;return u;}catch{return null;}}
function canonical(u){const q=[...u.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));return u.origin+u.pathname+'?'+JSON.stringify(q)+u.hash;}
export function completeMYTextSnapshot(v,expectedURL){const s=v.snapshot??'';if(incomplete(v)||typeof s!=='string'||!expectedURL||/\[truncated|\[incomplete|data_omitted|truncated\s*[=:]\s*true/i.test(s))return false;const first=s.split('\n')[0],m=first.match(/^url:\s*(https:\/\/\S+)\s*$/);if(!m)return false;const actual=exactMYURL(m[1]),expected=exactMYURL(expectedURL);if(!actual||!expected||canonical(actual)!==canonical(expected))return false;return /MYMalaysia\(example-shop-my\)/.test(s)&&/interactive: \d+ \| iframes: \d+ \(processed: \d+, same-origin: \d+, cross-origin: \d+, blocked: \d+\)\s*$/.test(s);}
export function verificationDecision(v,isVerification,basis=null,expectedURL=null){
 if(v.verification_pending===true){
  if(v.required_verification_call&&typeof v.required_verification_call==='object'){
   const r=v.required_verification_call,exactSnapshot=r.action==='snapshot'&&Object.keys(r).every(k=>['action','params'].includes(k))&&r.params&&Object.keys(r.params).length===0;
   return {pending:true,required:r,...exactSnapshot&&v.pending_stage==='semantic'?{basis:{kind:'native_exact_required_snapshot_call',required:r,expected_url:expectedURL}}:{}};
  }
  if(v.verification_instruction===instruction&&v.pending_stage==='semantic'&&Array.isArray(v.supplemental_only_actions)&&v.supplemental_only_actions.includes('truncated, failed, or otherwise incomplete observation results'))return {pending:true,required:{action:'snapshot',params:{}},basis:{kind:'native_explicit_successful_complete_observation_instruction',instruction,expected_url:expectedURL}};
  throw Error('ExactRequiredVerificationMissing');
 }
 if(v.verification_pending===false)return incomplete(v)?{pending:true,unproven:true,conflicting_incomplete_flag:true}:{pending:false,explicitComplete:true};
 if(isVerification){
  const permitted=basis?.kind==='native_explicit_successful_complete_observation_instruction'&&basis.instruction===instruction||basis?.kind==='native_exact_required_snapshot_call'&&basis.required?.action==='snapshot'&&basis.required.params&&Object.keys(basis.required.params).length===0;
  if(permitted&&completeMYTextSnapshot(v,basis.expected_url))return {pending:false,complete_observation_contract_satisfied:true,expected_url:basis.expected_url,tool_explicit_false_flag:null,not_a_fabricated_backend_flag:true};
  return {pending:true,unproven:true};
 }
 if(!v._parsedJSON)return {pending:true,unproven:true};
 return {pending:false,ordinaryJSONRead:true};
}

