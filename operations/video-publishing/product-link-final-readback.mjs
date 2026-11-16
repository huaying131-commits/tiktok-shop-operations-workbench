// The evidence producer must verify that the video's product is offered by the
// parent link. A copied job product_id alone is not evidence of membership.
// This is a readback validator only; it does not submit or modify old guards.
export function verifyProductLinkFinalReadback({job,membership,live,now=Date.now()}) {
  const fail=()=>{throw Error('VerifiedProductInAttachedLinkRequired')};
  const age=now-Date.parse(live?.at);
  const description=job?.description_ms??job?.caption??job?.description;
  const tags=job?.hashtags??job?.tags;
  if(!job?.product_id||!/^[a-f0-9]{64}$/i.test(job?.sha256??'')||
    !membership||membership.product_id!==job.product_id||membership.video_sha256!==job.sha256||
    membership.product_in_link!==true||typeof membership.product_description!=='string'||!membership.product_description.trim()||
    typeof membership.evidence_reference!=='string'||!membership.evidence_reference.trim()||
    !['official_product_information','verified_production_handoff','direct_user_confirmation'].includes(membership.source_type)||
    !Number.isFinite(Date.parse(membership.observed_at))||Date.parse(membership.observed_at)>now||
    !live||!Number.isFinite(age)||age<0||age>60000||live.market!=='MY'||
    live.source!=='official_owned_publish_form'||!live.owner||!live.target_id||
    live.owner!==job.publish_owner||live.target_id!==job.publish_target_id||live.account!==(job.target_account??job.account)||
    !Array.isArray(live.attached_products)||live.attached_products.length!==1||
    live.attached_products[0]?.observed_product_id!==job.product_id||
    live.attached_products[0]?.source!=='platform_attached_product_widget'||live.attached_products[0]?.observed_on_form!==true||
    live.upload_sha256_verified!==job.sha256||live.video_ready!==true||
    typeof description!=='string'||!description.trim()||live.description!==description||
    !Array.isArray(tags)||!tags.length||!Array.isArray(live.tags)||tags.length!==live.tags.length||
    tags.some((tag,i)=>typeof tag!=='string'||!tag.trim()||live.tags[i]!==tag)||
    live.ai_disclosure!==true||live.commercial_disclosure!==true||live.music_agreement!==true||
    live.own_brand!==true||live.branded_content!==false||!Array.isArray(live.errors)||live.errors.length||
    live.submit_already_attempted!==false) fail();
  return {account:live.account,product_id:job.product_id,product_in_link_verified:true,
    membership_source:membership.evidence_reference,membership_observed_at:membership.observed_at,
    attached_product_observed:true,sku_selection_required:false,stock_inspected:false,
    submit_authorized_by_this_function:false};
}
