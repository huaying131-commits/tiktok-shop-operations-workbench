import crypto from 'node:crypto';

export function buildRawAudioContent(bytes,expectedSha256){
  if(!Buffer.isBuffer(bytes)||bytes.length===0)throw Error('Nonempty raw audio bytes required');
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(expectedSha256??'')||sha!==expectedSha256)throw Error('Audio SHA identity mismatch');
  return [{type:'input_audio',input_audio:{data:bytes.toString('base64'),format:'wav'}},{type:'text',text:'Listen to the actual audio, without guessing from a script or filename. Report audible evidence only. Return one JSON object with: speech_present (true/false/"unknown"), language (string or "unknown"), observed_transcript (actual audible words, empty if none), speech_complete (true/false/"unknown"; false if speech is audibly chopped or cuts off mid word or sentence), speech_natural (true/false/"unknown"), music_present (true/false/"unknown"), music_overpowers_speech (true/false/"unknown"), severe_distortion (true/false/"unknown"), intrusive_noise (true/false/"unknown"), observations (short audible evidence and approximate times). Do not invent speech during silence or tones. If any criterion cannot be determined, use "unknown". Assess the complete clip.'}];
}

export function analyzePcmSignal(samples,sampleRate,{channels=1}={}){
  if(!(samples instanceof Float32Array)||!samples.length||!Number.isFinite(sampleRate)||sampleRate<=0||!Number.isInteger(channels)||channels<1||channels>32||samples.length%channels)throw Error('Native decoded PCM, valid channels and positive sample rate required');
  let peak=0,sum=0,clipped=0,silentFrames=0,tailFrames=0;
  const frame=Math.max(channels,Math.round(sampleRate*.02)*channels);let frameCount=0;
  for(let start=0;start<samples.length;start+=frame){let energy=0;const end=Math.min(samples.length,start+frame);for(let i=start;i<end;i++){const x=samples[i];if(!Number.isFinite(x))throw Error('Nonfinite decoded PCM');const a=Math.abs(x);peak=Math.max(peak,a);sum+=x*x;energy+=x*x;if(Math.abs(a-1)<=1.05/32768)clipped++;}frameCount++;if(Math.sqrt(energy/(end-start))<1e-5){silentFrames++;tailFrames++;}else tailFrames=0;}
  const fraction=clipped/samples.length,rms=Math.sqrt(sum/samples.length),blockers=[],review_flags=[],advisories=[];
  if(peak<1e-5)blockers.push('silent_audio');
  if(fraction>.001)blockers.push('severe_clipping');
  if(peak>=1e-5&&rms<.001)review_flags.push('very_low_signal');
  if(tailFrames*.02>4)review_flags.push('long_silent_tail');
  if(peak>1.0001)advisories.push('decoded_peak_above_fullscale');
  return {method:'native_PCM_signal_not_a_listening_substitute',decoded_sample_count:samples.length,sample_rate:sampleRate,channels,duration_seconds:samples.length/sampleRate/channels,peak,rms,near_fullscale_fraction:fraction,hard_saturation_measure:'abs(abs(sample)-1)<=1.05/32768; decoder overshoots counted separately',silent_frame_fraction:silentFrames/frameCount,trailing_silence_seconds:tailFrames*.02,blockers,review_flags,advisories};
}

export function judgeAudioEvidence({assessment,rawAudioProvided,expectedAudioSha256,actualAudioSha256,calibration,signal}){
  const blockers=[];
  if(rawAudioProvided!==true)blockers.push('raw_audio_not_provided_ASR_is_not_listening');
  if(!/^[a-f0-9]{64}$/.test(expectedAudioSha256??'')||expectedAudioSha256!==actualAudioSha256)blockers.push('audio_identity_mismatch');
  if(calibration?.validated!==true)blockers.push('audio_model_not_validated_on_control_clips');
  if(!signal?.decoded_sample_count)blockers.push('actual_signal_not_checked');
  if(signal)blockers.push(...(signal.blockers??[]),...(signal.review_flags??[]));
  const a=assessment??{};
  for(const key of ['speech_present','speech_complete','speech_natural','music_present'])if(a[key]!==true)blockers.push(key+'_'+String(a[key]??'unknown'));
  for(const key of ['music_overpowers_speech','severe_distortion','intrusive_noise'])if(a[key]!==false)blockers.push(key+'_'+String(a[key]??'unknown'));
  if(!/^(Malay|Bahasa Melayu|Bahasa Malaysia|ms)$/i.test(a.language??''))blockers.push('Malay_language_not_confirmed');
  return {status:blockers.length?'audio_not_passed':'pass_local_model_audio_review',pass:blockers.length===0,blockers,model_audio_reasoning:rawAudioProvided===true,human_listening:false,auto_publish_approval:false};
}
