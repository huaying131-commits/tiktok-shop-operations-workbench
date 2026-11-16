import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
const feature=await import('./audio-understanding-core.mjs').catch(()=>null);
const localRuntime=await import('./local-audio-runtime.mjs').catch(()=>null);
const bytes=Buffer.from('RIFF-test-audio-bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
test('raw audio content is required instead of an ASR transcript masquerading as hearing',()=>{
 assert.equal(typeof feature?.buildRawAudioContent,'function','Missing real raw-audio input builder');
 const content=feature.buildRawAudioContent(bytes,sha);
 assert.equal(content[0].type,'input_audio');assert.equal(content[0].input_audio.format,'wav');
 assert.deepEqual(Buffer.from(content[0].input_audio.data,'base64'),bytes);
 assert.throws(()=>feature.buildRawAudioContent(Buffer.alloc(0),sha),/audio|empty/i);
 assert.throws(()=>feature.buildRawAudioContent(Buffer.from('different file'),sha),/SHA|identity/i);
});
test('text-only evidence or uncalibrated model cannot approve audio',()=>{
 assert.equal(typeof feature?.judgeAudioEvidence,'function','Missing actual-audio evidence gate');
 const assessment={speech_present:true,language:'Malay',speech_complete:true,speech_natural:true,music_present:true,music_overpowers_speech:false,severe_distortion:false,intrusive_noise:false};
 const base={assessment,rawAudioProvided:false,expectedAudioSha256:sha,actualAudioSha256:sha,calibration:{validated:true}};
 assert.equal(feature.judgeAudioEvidence(base).pass,false);
 assert.equal(feature.judgeAudioEvidence({...base,rawAudioProvided:true,calibration:{validated:false}}).pass,false);
 assert.equal(feature.judgeAudioEvidence({...base,rawAudioProvided:true,actualAudioSha256:'0'.repeat(64)}).pass,false);
});
test('silence, incomplete words, overpowering music, distortion or uncertainty stay blocked',()=>{
 assert.equal(typeof feature?.judgeAudioEvidence,'function');
 const assessment={speech_present:true,language:'Malay',speech_complete:true,speech_natural:true,music_present:true,music_overpowers_speech:false,severe_distortion:false,intrusive_noise:false};
 const base={assessment,rawAudioProvided:true,expectedAudioSha256:sha,actualAudioSha256:sha,calibration:{validated:true},signal:{decoded_sample_count:16000,blockers:[],review_flags:[]}};
 assert.equal(feature.judgeAudioEvidence(base).pass,true);
 for(const [key,value] of Object.entries({speech_present:false,speech_complete:false,speech_natural:'unknown',music_present:'unknown',music_overpowers_speech:true,severe_distortion:true,intrusive_noise:true}))assert.equal(feature.judgeAudioEvidence({...base,assessment:{...assessment,[key]:value}}).pass,false,key);
 assert.equal(feature.judgeAudioEvidence(base).human_listening,false);
 assert.equal(feature.judgeAudioEvidence(base).auto_publish_approval,false);
});

test('actual signal analysis catches silence and severe clipping even if a model calls them clear',()=>{
 assert.equal(typeof feature?.analyzePcmSignal,'function','Missing independent audible-signal guard');
 const silent=feature.analyzePcmSignal(new Float32Array(16000),16000);
 assert.ok(silent.blockers.includes('silent_audio'));
 const clipped=feature.analyzePcmSignal(Float32Array.from({length:16000},(_,i)=>i%2?1:-1),16000);
 assert.ok(clipped.blockers.includes('severe_clipping'));
 const healthy=feature.analyzePcmSignal(Float32Array.from({length:16000},(_,i)=>0.1*Math.sin(2*Math.PI*440*i/16000)),16000);
 assert.deepEqual(healthy.blockers,[]);
 const assessment={speech_present:true,language:'Malay',speech_complete:true,speech_natural:true,music_present:true,music_overpowers_speech:false,severe_distortion:false,intrusive_noise:false};
 const result=feature.judgeAudioEvidence({assessment,rawAudioProvided:true,expectedAudioSha256:sha,actualAudioSha256:sha,calibration:{validated:true},signal:clipped});
 assert.equal(result.pass,false);assert.ok(result.blockers.includes('severe_clipping'));
});

test('a long silent tail remains reviewable rather than being silently called complete',()=>{
 assert.equal(typeof feature?.analyzePcmSignal,'function');
 const samples=new Float32Array(16000*8);for(let i=0;i<16000;i++)samples[i]=0.1*Math.sin(2*Math.PI*440*i/16000);
 const signal=feature.analyzePcmSignal(samples,16000);assert.ok(signal.review_flags.includes('long_silent_tail'));
});

test('audio service remains local, isolated, and bound to its own verified model alias',()=>{
 assert.equal(typeof localRuntime?.validateLocalRuntime,'function','Missing isolated on-demand audio runtime');
 const base='D:/workspace/.tools/audio-understanding',config={provider:'local_llama_cpp',paid_api:false,media_upload:false,listen_host:'127.0.0.1',model_alias:'vp-audio-qwen-test',bin_dir:base+'/bin/runtime',server:base+'/bin/runtime/llama-server.exe',model:base+'/models/model.gguf',projector:base+'/models/projector.gguf',api_key_file:base+'/local-api-key.txt',max_threads:2};
 assert.equal(localRuntime.validateLocalRuntime(config,base),true);
 assert.throws(()=>localRuntime.validateLocalRuntime({...config,listen_host:'0.0.0.0'},base));
 assert.throws(()=>localRuntime.validateLocalRuntime({...config,model:'C:/other-work/model.gguf'},base));
 assert.throws(()=>localRuntime.validateLocalRuntime({...config,model_alias:'another-service'},base));
 assert.throws(()=>localRuntime.validateLocalRuntime({...config,enabled:false},base),/disabled|validation/i);
});

test('native stereo remains distinct and decoder overshoot is not mislabeled hard clipping',()=>{
 assert.equal(typeof feature?.analyzePcmSignal,'function');
 const sr=44100,stereo=Float32Array.from({length:sr*2},(_,i)=>1.12*Math.sin(2*Math.PI*440*Math.floor(i/2)/sr)*(i%2?-1:1));
 const signal=feature.analyzePcmSignal(stereo,sr,{channels:2});
 assert.equal(signal.channels,2);assert.equal(signal.duration_seconds,1);
 assert.ok(signal.peak>1);assert.ok(!signal.blockers.includes('severe_clipping'));
 assert.ok(signal.advisories.includes('decoded_peak_above_fullscale'));
 const clamped=Float32Array.from(stereo,x=>Math.min(.900000000000002,Math.max(-1,x)));
 assert.ok(feature.analyzePcmSignal(clamped,sr,{channels:2}).blockers.includes('severe_clipping'));
 assert.throws(()=>feature.analyzePcmSignal(stereo,sr,{channels:0}));
});
