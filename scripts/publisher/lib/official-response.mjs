// Local extraction: imports localized; unrelated hardcoded title probes removed where applicable.
export function decodeOfficial(r){
 const text=(r.output?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
 const match=text.match(/<interaction_verification>\s*([\s\S]*?)\s*<\/interaction_verification>/);
 let value,parsed=false;
 if(match){try{value=JSON.parse(match[1]);parsed=true}catch{throw Error('MalformedOfficialVerificationEnvelope')}}
 else{try{value=JSON.parse(text);parsed=true}catch{value={snapshot:text}}}
 if(!value||typeof value!=='object')throw Error('UnexpectedOfficialResponse');
 return {...value,_parsedJSON:parsed,_verificationEnvelope:Boolean(match),_rawText:text};
}
export function verificationDecision(v,isVerification){
 if(v.verification_pending===true){if(!v.required_verification_call||typeof v.required_verification_call!=='object')throw Error('ExactRequiredVerificationMissing');return {pending:true,required:v.required_verification_call};}
 if(v.verification_pending===false)return {pending:false,explicitComplete:true};
 if(isVerification)return {pending:true,unproven:true};
 if(!v._parsedJSON)return {pending:true,unproven:true};
 return {pending:false,ordinaryJSONRead:true};
}
