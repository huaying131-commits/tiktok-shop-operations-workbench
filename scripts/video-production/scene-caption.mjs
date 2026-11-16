import fs from 'node:fs';
import crypto from 'node:crypto';
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export function validateSceneCaption(card, expected){
  if(card.status!=='reviewed_against_exact_final'||card.video_id!==expected.video_id||card.final_sha256!==expected.final_sha256||card.target_account!==expected.target_account)throw Error('CAPTION_EXACT_VIDEO_VERSION_ACCOUNT_REQUIRED');
  for(const k of ['description_ms','reference_zh','scene_fit_reason'])if(typeof card[k]!=='string'||!card[k].trim())throw Error('CAPTION_MISSING_'+k);
  if(!Array.isArray(card.scene_observations)||!card.scene_observations.length||!Array.isArray(card.scene_evidence)||!card.scene_evidence.length)throw Error('CAPTION_ACTUAL_SCENE_REVIEW_REQUIRED');
  for(const e of card.scene_evidence)if(!e.path||!e.sha256||!fs.existsSync(e.path)||sha(e.path)!==e.sha256)throw Error('CAPTION_SCENE_EVIDENCE_CHANGED');
  if(!Array.isArray(card.tags)||card.tags.some(t=>typeof t!=='string'||!/^#[^\s#]+$/.test(t)))throw Error('CAPTION_RELATED_TAGS_REQUIRED');
  if(card.tag_basis!=='content_related_not_verified_trending'&&(!card.trend_evidence?.market||!card.trend_evidence?.checked_at||!card.trend_evidence?.source_url))throw Error('CAPTION_TREND_SOURCE_REQUIRED');
  if(!Array.isArray(card.required_disclosures_ms)||card.required_disclosures_ms.some(x=>!card.description_ms.includes(x)))throw Error('CAPTION_REQUIRED_FACT_OR_DISCLOSURE_MISSING');
  if(expected.requiredVideoEffectDisclosure&&!card.description_ms.includes(expected.requiredVideoEffectDisclosure))throw Error('CAPTION_VIDEO_EFFECT_DISCLOSURE_REQUIRED');
  if(card.actual_buyer_experience_claim!==false||card.cross_video_template_reuse!==false)throw Error('CAPTION_NO_INVENTED_BUYER_OR_DEFAULT_TEMPLATE');
  return {description_ms:card.description_ms,reference_zh:card.reference_zh,tags:card.tags,style:card.style??null,video_id:card.video_id,final_sha256:card.final_sha256,target_account:card.target_account};
}

export function loadSceneCaption(file,expected){
  if(!fs.existsSync(file))throw Error('CAPTION_PER_VIDEO_CARD_REQUIRED_NO_PRODUCT_ARRAY_FALLBACK');
  return validateSceneCaption(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),expected);
}
