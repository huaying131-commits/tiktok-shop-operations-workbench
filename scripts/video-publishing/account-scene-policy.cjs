const fs=require('node:fs'),crypto=require('node:crypto');
function assertAccountScenePolicy(id,pkg,account,policy){
 const p=policy?.content_account_vertical_policy;if(p?.actual_final_scene_review_required!==true)return {required:false};
 const target=p.accounts.find(x=>x.account===account);if(!target)throw Error('OriginalAccountVerticalMissing:'+account);
 const r=pkg.account_scene_review;
 if(!r||r.sha256!==pkg.sha256||r.account!==account||r.actual_category!==target.category||r.reviewed_from_actual_final_frames!==true||!r.evidence?.path||!r.evidence.sha256)throw Error('ACCOUNT_SCENE_REVIEW_REQUIRED: '+id+' '+account+' requires actual '+target.category+' scene, filename/code not sufficient');
 if(crypto.createHash('sha256').update(fs.readFileSync(r.evidence.path)).digest('hex')!==r.evidence.sha256)throw Error('AccountSceneReviewEvidenceChanged');
 return {required:true,account,category:target.category};
}
module.exports={assertAccountScenePolicy};
