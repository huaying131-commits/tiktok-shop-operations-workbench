import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,hash} from './support.mjs';import {State} from '../lib/state.mjs';import {intake,validatePackage} from '../lib/intake.mjs';
let short;try{short=await import('../lib/product-short-names.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('intake reports all independent missing fields in one result',()=>{
 const f=fixture(),s=new State(path.join(f.dir,'state'));try{
  const p={...f.pkg,short_product_name:undefined,semantic_review:undefined,hashtags:undefined,description_ms:undefined,duration_seconds:undefined};fs.writeFileSync(f.manifest,JSON.stringify(p));
  const r=intake({state:s,sourceDir:f.src,policy:f.policy,history:{rows:[],reservations:[]}}).results[0];
  assert(r.issues.includes('short_product_name_missing'));assert(r.issues.includes('caption_or_tags_invalid'));assert(r.issues.includes('video_metadata_missing'));assert(r.issues.some(x=>x.startsWith('semantic_')));
 }finally{s.close();f.cleanup();}
});
test('product-level historical short-name candidates are unique or explicit conflicts, never guessed',()=>{
 assert.equal(typeof short?.buildShortNameCatalog,'function');
 const c=short.buildShortNameCatalog({rows:[{published:true,product_id:'100',short_name:'Name A',source:'ledger1'},{published:true,product_id:'100',short_name:'Name B',source:'archive2'},{published:true,product_id:'200',product_name:'Kit DIY',source:'ledger3'},{published:false,product_id:'300',short_name:'Not actually posted'}]});
 assert.equal(c.names['100'],undefined);assert.deepEqual(c.conflicts['100'].map(x=>x.name),['Name A','Name B']);assert.equal(c.names['200'],'Kit DIY');assert.equal(c.names['300'],undefined);
});
test('explicit package short name takes precedence; fallback is by product and publishing switches are config',()=>{
 const f=fixture();try{
  const p={...f.pkg,publishing_fields:undefined,short_product_name:undefined};
  const j=validatePackage(p,{policy:f.policy,manifest:f.manifest,shortNames:{names:{'200':'Historical Kit'}}});
  assert.equal(j.short_name,'Historical Kit');assert.equal(j.fields.ai_disclosure,true);assert.equal(j.fields.commercial_disclosure,true);
  assert.equal(validatePackage({...p,short_product_name:'Task choice'},{policy:f.policy,manifest:f.manifest,shortNames:{names:{'200':'Historical Kit'}}}).short_name,'Task choice');
  assert.equal(validatePackage({...f.pkg,publishing_fields:{ai_disclosure:false}},{policy:f.policy,manifest:f.manifest}).fields.ai_disclosure,true);
 }finally{f.cleanup();}
});
test('legacy explicit SHA-bound conclusions can map; generic qualified flag cannot invent missing semantics',()=>{
 const f=fixture();try{
  const review={final:{sha256:f.pkg.sha256},task:f.pkg.video_id,targetAccount:f.pkg.target_account,product_consistent:true,caption_accurate:true,lineage_not_reused:true,qualified:true,picture:{actualNativeAndFinal30FrameContactsViewed:true}};
  fs.writeFileSync(f.evidence,JSON.stringify(review));const evidence={path:f.evidence,sha256:hash(fs.readFileSync(f.evidence))};
  const p={...f.pkg,semantic_review:undefined,qa:{picture:'pass_source_physical_and_scene_review',malay_footer:'pass',primary_current_final_QA:evidence},account_scene_review:{...f.pkg.account_scene_review,evidence}};
  const j=validatePackage(p,{policy:f.policy,manifest:f.manifest});assert.equal(j.semantic_review.caption_accurate,true);assert.equal(j.semantic_mapping.source,'legacy_sha_bound');
  delete review.caption_accurate;fs.writeFileSync(f.evidence,JSON.stringify(review));evidence.sha256=hash(fs.readFileSync(f.evidence));
  assert.throws(()=>validatePackage(p,{policy:f.policy,manifest:f.manifest}),e=>e.details.issues.includes('semantic_caption_accuracy_missing'));
  review.caption_accurate=true;review.final.sha256='b'.repeat(64);fs.writeFileSync(f.evidence,JSON.stringify(review));evidence.sha256=hash(fs.readFileSync(f.evidence));
  assert.throws(()=>validatePackage(p,{policy:f.policy,manifest:f.manifest}),e=>e.details.issues.includes('semantic_review_sha_mismatch'));
 }finally{f.cleanup();}
});
