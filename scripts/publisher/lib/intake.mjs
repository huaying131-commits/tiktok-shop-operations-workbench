import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import {readJSON,fileHash,fail,safeID,walk} from './common.mjs';
import {publicationIdentifiers} from './identifiers.mjs';
import {overlaps,unknowns} from './planner.mjs';
import {adaptLegacyPackage,DIMENSIONS} from './legacy-adapter.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {isValidShortName,shortNameFor,shortNameSnapshot,unresolvedProducts} from './product-short-names.mjs';
const require=createRequire(import.meta.url),{assertAccountScenePolicy}=require('../../video-publishing/account-scene-policy.cjs'),{assertAircraftLinkPolicy}=require('../../video-publishing/aircraft-link-policy.cjs');
const hashPattern=/^[a-f0-9]{64}$/;
const dimensionErrors={product_consistent:'semantic_product_consistency_missing',scene_appropriate:'semantic_scene_appropriateness_missing',caption_accurate:'semantic_caption_accuracy_missing',lineage_not_reused:'semantic_lineage_review_missing'};

export function validatePackage(p,{policy,manifest,verifyFile=true,shortNames={},runtimeConfig=loadRuntimeConfig()}={}){
 const issues=[],add=x=>{if(!issues.includes(x))issues.push(x);},base=path.dirname(path.resolve(manifest));
 try{safeID(p.video_id);}catch{add('invalid_job_id');}
 const account=p.target_account??p.account,sha=p.sha256??p.file?.sha256;
 let hold=p.publication_hold??null;
 if(hold?.active===true){
  const r=p.publication_hold_release,e=r?.evidence;
  const release=hold.id&&r?.hold_id===hold.id&&r.video_id===p.video_id&&r.account===account&&r.sha256===sha&&r.released===true&&['direct_human_confirmation','verified_owner_release'].includes(r.source_type)&&r.quote?.trim()&&Number.isFinite(Date.parse(r.recorded_at))&&Date.parse(r.recorded_at)<=Date.now()&&e?.path&&hashPattern.test(e.sha256??'')&&fs.existsSync(path.resolve(base,e.path))&&fileHash(path.resolve(base,e.path))===e.sha256;
  if(release)hold={...hold,active:false,release:r};else add('publication_hold');
 }
 if(p.ready_to_publish!==true&&(p.status!=='ready_to_publish'||p.ready_to_publish===false))add('not_ready');
 if(!hashPattern.test(sha??''))add('sha_missing');
 if(p.file?.sha256&&p.file.sha256!==sha)add('sha_mismatch');
 const file=p.file?.path??p.final_video??p.upload_file,resolved=file?path.resolve(base,file):null;
 if(!file)add('video_file_missing');
 else if(verifyFile&&(!fs.existsSync(resolved)||fileHash(resolved)!==sha))add('sha_mismatch');
 const market=p.market??p.region,sku=p.sku_id??p.platform_sku_id,content=p.content_type??p.content_code;
 if(market!=='MY'||!/^\d+$/.test(p.product_id??'')||!/^\d+$/.test(sku??''))add('product_or_market_missing');
 const target=policy.content_account_vertical_policy?.accounts?.find(x=>x.account===account);
 if(!target||target.code!==content)add('account_type_mismatch');
 const short=shortNameFor(p,shortNames);
 if(typeof short.value!=='string'||!short.value.trim())add(short.reason??'short_product_name_missing');
 else if(!isValidShortName(short.value))add('short_product_name_invalid');
 const description=p.description_ms??p.caption??p.description,tags=p.hashtags??p.tags;
 if(typeof description!=='string'||!description.trim()||description.length>3000||!Array.isArray(tags)||!tags.length||new Set(tags).size!==tags.length||tags.some(t=>typeof t!=='string'||!/^#[\p{L}\p{N}_]+$/u.test(t)))add('caption_or_tags_invalid');
 if(!Number.isFinite(p.duration_seconds)||p.duration_seconds<=0||!Number.isFinite(p.width)||!Number.isFinite(p.height)||Math.abs(p.width/p.height-9/16)>.01)add('video_metadata_missing');
 const adapted=adaptLegacyPackage({...p,sha256:sha},{base,target});for(const issue of adapted.issues)add(issue);
 for(const key of DIMENSIONS)if(adapted.semantic[key]!==true)add(dimensionErrors[key]);
 const scene=adapted.scene;
 if(scene.sha256!==sha||scene.account!==account)add('scene_review_sha_mismatch');
 if(scene.actual_category==='shop_visit')scene.actual_category='store_visit';
 try{assertAccountScenePolicy(p.video_id,{...p,sha256:sha,account_scene_review:scene},account,policy);}catch{add('account_scene_review_invalid');}
 let aircraft=false;try{aircraft=assertAircraftLinkPolicy(p.video_id,p,policy).aircraft;}catch{add('aircraft_main_link_required');}
 const fields=runtimeConfig.publishing_fields;
 if(!fields||fields.ai_disclosure!==true||fields.commercial_disclosure!==true||fields.own_brand!==true||fields.branded_content!==false||fields.music_agreement!==true)add('publishing_config_invalid');
 if(issues.length)fail(issues[0],issues.includes('invalid_job_id')||issues.includes('publishing_config_invalid')?40:20,{issues,semantic_mapping:adapted.mapping,short_name_source:short.source});
 return{video_id:p.video_id,account,sha256:sha,file:resolved,manifest:path.resolve(manifest),manifest_sha256:fileHash(manifest),product_id:p.product_id,sku_id:sku,market,description,tags,short_name:short.value,short_name_source:short.source,short_names_snapshot:shortNameSnapshot(p,short),duration_seconds:p.duration_seconds,content_type:content,aircraft,identifiers:publicationIdentifiers({...p,sha256:sha}),hold,semantic_review:adapted.semantic,semantic_mapping:adapted.mapping,scene_review:scene,fields,package:p};
}
export function intake({state,sourceDir,policy,history={rows:[],reservations:[]},shortNames={},runtimeConfig=loadRuntimeConfig()}){
 if(!fs.existsSync(sourceDir)||!fs.statSync(sourceDir).isDirectory())fail('source_directory_missing',40,{sourceDir});
 const files=walk(sourceDir).filter(f=>/^发布任务(?:_.*)?\.json$/.test(path.basename(f))),results=[];
 const pending=unknowns(history.rows??[]),stats={examined:0,explicit:0,legacy:0,mapped_dimensions:Object.fromEntries(DIMENSIONS.map(x=>[x,0])),fully_mapped:0};
 for(const manifest of files){
  let p;try{p=readJSON(manifest);}catch{const r={manifest,accepted:false,reason:'manifest_invalid',issues:['manifest_invalid'],exit_code:40};state.intakeResult(manifest,r);results.push(r);continue;}
  if(p.ready_to_publish!==true&&p.status!=='ready_to_publish')continue;
  const candidate={...p,identifiers:publicationIdentifiers(p)},account=p.target_account??p.account;
  if((history.rows??[]).some(x=>x.published&&overlaps(x,candidate))){
   const r={manifest,video_id:p.video_id,product_id:p.product_id,accepted:false,reason:'already_published',issues:['already_published'],exit_code:10};state.intakeResult(manifest,r);results.push(r);continue;
  }
  let job,error,issues=[],mapping;
  try{job=validatePackage(p,{policy,manifest,shortNames,runtimeConfig});mapping=job.semantic_mapping;}catch(e){error=e;issues=e.details?.issues??[e.reason??e.message];mapping=e.details?.semantic_mapping;}
  const protections=[];
  if(pending.some(x=>overlaps(x,candidate)))protections.push('unknown_operation');
  const original=(history.reservations??[]).filter(x=>(x.video_id??x.job_id)===p.video_id);
  if(original.some(x=>x.account!==account||x.sha256&&x.sha256!==p.sha256))protections.push('original_account_mismatch');
  if(original.some(x=>x.hold?.active||x.publication_hold?.active))protections.push('publication_hold');
  if([...(history.reservations??[]),...state.jobs()].some(x=>(x.video_id??x.job_id)!==p.video_id&&overlaps(x,candidate)))protections.push('lineage_collision');
  const prior=state.job(p.video_id);if(prior&&(prior.account!==account||prior.sha256!==p.sha256))protections.push('job_identity_changed');
  issues=[...new Set([...protections,...issues])];
  if(mapping){stats.examined++;stats[mapping.source==='legacy_sha_bound'?'legacy':'explicit']++;for(const dimension of mapping.mapped_dimensions)stats.mapped_dimensions[dimension]++;if(mapping.mapped_dimensions.length===DIMENSIONS.length)stats.fully_mapped++;}
  const r={manifest,video_id:p.video_id,product_id:p.product_id,account,accepted:issues.length===0,reason:issues[0]??'validated',issues,semantic_mapping:mapping??null,exit_code:issues.length?(error?.code===40?40:20):0};
  if(r.accepted)state.putJob(job);else if(prior)state.putJob({...prior,issues});
  state.intakeResult(manifest,r);results.push(r);
 }
 const distribution={},issueDistribution={};for(const r of results){distribution[r.reason]=(distribution[r.reason]??0)+1;for(const issue of r.issues)issueDistribution[issue]=(issueDistribution[issue]??0)+1;}
 return{results,accepted:results.filter(x=>x.accepted).length,rejected:results.filter(x=>!x.accepted).length,reason_distribution:distribution,issue_distribution:issueDistribution,semantic_mapping:stats,products_needing_short_names:unresolvedProducts(results),exit_code:results.some(x=>x.exit_code===40)?40:results.some(x=>x.exit_code===20)?20:results.some(x=>x.accepted)?0:10};
}
