import test from 'node:test';import assert from 'node:assert/strict';
const core=await import('./cloud-audio-review-core.mjs').catch(()=>null);
const auth={enabled:true,provider:'openai_official',model:'gpt-audio-1.5',authorization:{direct_human:true,source_ref:'human-reply-123'},total_limit_usd:1,max_requests:10,reserve_per_request_usd:.1,expires_at:'2026-10-20T00:00:00Z',allowed_source_sha256:['a'.repeat(64)]};
test('no upload or paid request before explicit scoped human authorization',()=>{
 assert.equal(typeof core?.authorizeCloudReview,'function');
 for(const p of [{...auth,enabled:false},{...auth,authorization:{direct_human:false}},{...auth,provider:'unknown_proxy'},{...auth,model:'gpt-audio-mini'},{...auth,allowed_source_sha256:[]}])assert.throws(()=>core.authorizeCloudReview(p,[],'a'.repeat(64),new Date('2026-10-18')));
 assert.throws(()=>core.authorizeCloudReview(auth,[],'b'.repeat(64),new Date('2026-10-18')));
 assert.throws(()=>core.authorizeCloudReview(auth,[],'a'.repeat(64),new Date('2026-10-21')));
 assert.equal(core.authorizeCloudReview(auth,[],'a'.repeat(64),new Date('2026-10-18')).reservation_usd,.1);
});
test('unknown submissions retain their risk across dates and cannot be replayed',()=>{
 assert.equal(typeof core?.authorizeCloudReview,'function');
 const prior=Array.from({length:10},(_,i)=>({key:'different-'+i,reserved_usd:.1,status:'unknown',submitted_at:'2026-10-17T00:00:00Z'}));
 assert.throws(()=>core.authorizeCloudReview(auth,prior,'a'.repeat(64),new Date('2026-10-18')),/budget|limit/i);
 assert.throws(()=>core.authorizeCloudReview(auth,[{key:core.reviewKey('a'.repeat(64)),reserved_usd:.1,status:'unknown'}],'a'.repeat(64),new Date('2026-10-18')),/existing|replay/i);
});
test('payload contains actual audio, text-only output, no expected script and no storage request',()=>{
 assert.equal(typeof core?.buildCloudAudioRequest,'function');
 const request=core.buildCloudAudioRequest(Buffer.from('RIFF-test'),15.1);
 assert.equal(request.model,'gpt-audio-1.5');assert.deepEqual(request.modalities,['text']);assert.equal(request.store,false);
 assert.equal(request.messages[0].content[0].type,'input_audio');assert.ok(!request.audio);assert.ok(request.max_tokens<=600);
 assert.throws(()=>core.buildCloudAudioRequest(Buffer.from('x'),21));
});
test('actual billing remains unknown without a modality breakdown; mixed input tokens are not priced as text',()=>{
 assert.equal(typeof core?.calculateCloudCost,'function');
 assert.equal(core.calculateCloudCost({prompt_tokens:500,completion_tokens:300}),null);
 const cost=core.calculateCloudCost({prompt_tokens:500,completion_tokens:300,prompt_tokens_details:{audio_tokens:200}});
 assert.ok(Math.abs(cost-.01015)<1e-8);
 assert.equal(core.calculateCloudCost({prompt_tokens:5,completion_tokens:3,prompt_tokens_details:{audio_tokens:20}}),null);
});
