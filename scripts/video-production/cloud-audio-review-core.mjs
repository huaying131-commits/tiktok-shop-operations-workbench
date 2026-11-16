import {buildRawAudioContent} from './audio-understanding-core.mjs';import crypto from 'node:crypto';
export const CLOUD_AUDIO_MODEL='gpt-audio-1.5';
export const CLOUD_AUDIO_PROMPT_VERSION='blind-acoustic-v1';
export function reviewKey(sha){return CLOUD_AUDIO_MODEL+':'+CLOUD_AUDIO_PROMPT_VERSION+':'+sha;}
export function authorizeCloudReview(policy,records,sourceSha,now=new Date()){
 if(policy?.enabled!==true||policy.provider!=='openai_official'||policy.model!==CLOUD_AUDIO_MODEL||policy.authorization?.direct_human!==true||!policy.authorization.source_ref)throw Error('Explicit human authorization for this external audio service and its fees is required');
 if(!Array.isArray(policy.allowed_source_sha256)||!policy.allowed_source_sha256.includes(sourceSha))throw Error('Source SHA is outside the authorized material scope');
 if(!(new Date(policy.expires_at)>now))throw Error('Scoped audio authorization has expired');
 if(!Number.isFinite(policy.total_limit_usd)||policy.total_limit_usd<=0||policy.total_limit_usd>1||!Number.isInteger(policy.max_requests)||policy.max_requests<1||policy.max_requests>10||policy.reserve_per_request_usd!==.1)throw Error('Calibration budget limit must stay at or below1USD/10requests with0.10USD risk per request');
 if(records.some(r=>r.key===reviewKey(sourceSha)))throw Error('Existing request must be read/reconciled; no replay');
 const committed=records.reduce((s,r)=>s+(r.conservative_cost_ceiling_usd??r.reserved_usd??.1),0);
 if(records.length>=policy.max_requests||committed+.1>policy.total_limit_usd+1e-9)throw Error('External audio calibration budget or request limit exhausted; unknown prior risk stays reserved');
 return {key:reviewKey(sourceSha),reservation_usd:.1,prior_committed_usd:committed,total_limit_usd:policy.total_limit_usd};
}
export function buildCloudAudioRequest(wav,duration){
 if(!Number.isFinite(duration)||duration<=0||duration>20.1)throw Error('This scoped calibration accepts clips up to20.1seconds only');
 const sha=crypto.createHash('sha256').update(wav).digest('hex'),content=buildRawAudioContent(wav,sha);
 content[1].text='Listen to this actual recording. Do not infer from a filename or a script. Return a JSON object: speech_present, speech_clear, speech_natural, speech_complete, language, observed_transcript, music_present, music_overpowers_speech, severe_distortion, intrusive_noise, observations. Use true/false/"unknown" for every sound criterion. Complete means the audible speech ends naturally, not mid-word or mid-sentence. Distinguish intelligible voice from gibberish or reversed sounds. Never invent speech during silence or tones. Give brief audible evidence; do not guess timestamps. There is no required answer and no expected script.';
 return {model:CLOUD_AUDIO_MODEL,modalities:['text'],messages:[{role:'user',content}],temperature:0,max_tokens:600,store:false};
}
export function calculateCloudCost(usage){
 const total=usage?.prompt_tokens,output=usage?.completion_tokens,audio=usage?.prompt_tokens_details?.audio_tokens;
 if(!Number.isFinite(total)||!Number.isFinite(output)||!Number.isFinite(audio)||audio<0||audio>total||output<0)return null;
 // Official uncached rates at2026-10-18. This is a conservative usage-based ceiling, not an invoice or account-balance proof.
 return (audio*32+(total-audio)*2.5+output*10)/1e6;
}
