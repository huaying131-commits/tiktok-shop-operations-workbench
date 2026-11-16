import fs from 'node:fs';import path from 'node:path';
import {fileHash,readJSON} from './common.mjs';
const pass=v=>typeof v==='string'&&/^pass(?:$|_)/i.test(v);
export const DIMENSIONS=['product_consistent','scene_appropriate','caption_accurate','lineage_not_reused'];
const get=(obj,key)=>key.split('.').reduce((o,k)=>o?.[k],obj);
function evidence(ref,base){
 if(!ref?.path||!/^[a-f0-9]{64}$/.test(ref.sha256??''))return{error:'semantic_evidence_missing'};
 const candidates=[ref.package_path,ref.path].filter(Boolean).map(p=>path.resolve(base,p));
 const file=candidates.find(p=>fs.existsSync(p)&&fileHash(p)===ref.sha256);
 if(!file)return{error:'semantic_evidence_changed'};
 try{return{reference:{...ref,path:file},data:readJSON(file)};}catch{return{error:'semantic_evidence_invalid'};}
}
export function adaptLegacyPackage(pkg,{base,target}={}){
 const sha=pkg.sha256??pkg.file?.sha256,scene={...pkg.account_scene_review},issues=[],mapping={source:pkg.semantic_review?'explicit_semantic_review':'legacy_sha_bound',mapped_dimensions:[],unmapped_dimensions:[],rules:{},evidence:[]};
 const sceneProof=evidence(scene.evidence,base),primary=evidence(pkg.qa?.primary_current_final_QA??scene.evidence,base);
 const explicit=pkg.semantic_review;
 if(explicit){
  const proof=evidence(explicit.evidence,base);if(proof.error)issues.push(proof.error);
  if(explicit.sha256!==sha)issues.push('semantic_review_sha_mismatch');
  const semantic={...explicit,evidence:proof.reference??explicit.evidence};
  for(const key of DIMENSIONS){if(explicit[key]===true&&explicit.sha256===sha&&!proof.error)mapping.mapped_dimensions.push(key);else mapping.unmapped_dimensions.push(key);}
  if(sceneProof.error)issues.push(sceneProof.error);else scene.evidence=sceneProof.reference;
  return{semantic,scene,mapping,issues,review:primary.data};
 }
 const q=primary.data??{},qa=pkg.qa??{},qsha=q.final?.sha256??q.final_sha256??q.sha256;
 const bound=!primary.error&&qsha===sha&&(!q.task||q.task===pkg.video_id)&&(!q.video_id||q.video_id===pkg.video_id)&&(!q.targetAccount||q.targetAccount===(pkg.target_account??pkg.account));
 if(primary.error)issues.push(primary.error);
 else if(!bound)issues.push('semantic_review_sha_mismatch');
 const result={sha256:sha,evidence:primary.reference??null,link_title_terms:pkg.product_link?.verified_title_terms??[]};
 const record=(key,value,rule)=>{result[key]=bound&&value===true?true:null;if(result[key]){mapping.mapped_dimensions.push(key);mapping.rules[key]=rule;}else mapping.unmapped_dimensions.push(key);};
 const product= q.product_consistent===true||pass(qa.product_truth_and_intended_sku)||pass(q.picture?.exactSourcePhysicalReview)||
   typeof qa.picture==='string'&&/^pass_(?:actual_)?source(?:_|$)/.test(qa.picture);
 record('product_consistent',product,q.product_consistent===true?'review.product_consistent':pass(qa.product_truth_and_intended_sku)?'qa.product_truth_and_intended_sku':'qa.picture or review.picture.exactSourcePhysicalReview');
 const visualPaths=['picture.actualNativeAndFinal30FrameContactsViewed','picture.actualNativeContactAndSourceAndFinalFramesViewed','picture.sampledNative2fpsAndFinal2fpsContactActuallyViewed','picture.actualFinalContactViewed','reviewed_from_actual_final_frames'];
 const visual=scene.reviewed_from_actual_final_frames===true||visualPaths.some(k=>get(q,k)===true)||Array.isArray(q.actual_final_frames_viewed)&&q.actual_final_frames_viewed.length>0;
 const category=scene.actual_category==='shop_visit'?'store_visit':scene.actual_category;
 const sceneMatches=scene.sha256===sha&&scene.account===(pkg.target_account??pkg.account)&&!sceneProof.error&&
   (category?category===target?.category:scene.status==='pass_production_scope'&&scene.type===target?.code)&&visual;
 record('scene_appropriate',sceneMatches,'account_scene_review + bound final-frame review');
 if(sceneMatches){scene.actual_category=target.category;scene.reviewed_from_actual_final_frames=true;scene.evidence=sceneProof.reference;}
 const captionPaths=['caption_accurate','caption.accurate','description_accurate','audio.otherNecessaryFactsAccurateTextAndCaption'];
 const captionPath=captionPaths.find(k=>get(q,k)===true);
 record('caption_accurate',!!captionPath||pass(qa.caption)||pass(qa.description),captionPath??'qa.caption or qa.description');
 const noReusePaths=['lineage_not_reused','picture.noSlowLoopFreezePhotoOrReusedOtherClip','picture.noFreezeSlowLoopPhotoPanOrBorrowedFootage','picture.noSlowFreezeLoopPhotoPanOrBorrowedFootage','picture.noSlowFreezeLoopPhotoOrBorrowedFootage','picture.noFreezeSlowLoopPhotoOrReusedClip'];
 const noReusePath=noReusePaths.find(k=>get(q,k)===true),dedup=q.dedup,identifiers=dedup?.identifiers??dedup?.ids??dedup?.allLineageIDs??dedup?.exact_native_ids;
 const zeroDedup=(dedup?.hits===0||dedup?.matched_rows===0)&&Array.isArray(identifiers)&&identifiers.includes(sha);
 record('lineage_not_reused',!!noReusePath||zeroDedup,noReusePath??'review.dedup zero hits including exact final SHA');
 if(primary.reference)mapping.evidence.push(primary.reference);
 if(sceneProof.error)issues.push(sceneProof.error);
 return{semantic:result,scene,mapping,issues,review:q};
}
