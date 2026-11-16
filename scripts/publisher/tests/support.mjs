import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export const policy={
 publishing_target:{natural_day_cap_per_account:4,daily_total_target:20,minimum_real_success_interval_seconds:3600,minimum_aircraft_successes_per_actual_day:5},
 content_account_vertical_policy:{actual_final_scene_review_required:true,accounts:[{account:'example-creator-1',code:'WH',category:'warehouse'},{account:'example-creator-4',code:'EX',category:'exhibition_visit'}]},
 content_aircraft_product_link_policy:{main_product_id:'100',new_individual_links_currently_paused:true,known_aircraft_product_ids:['100']},
};
export function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-fixture-')),src=path.join(dir,'source');fs.mkdirSync(src);
 const file=path.join(src,'video.mp4');fs.writeFileSync(file,'offline video bytes');const sha=hash(fs.readFileSync(file));
 const evidence=path.join(src,'review.json');fs.writeFileSync(evidence,JSON.stringify({qualified:true,final:{sha256:sha}}));
 const pkg={video_id:'TEST-01',ready_to_publish:true,status:'ready_to_publish',market:'MY',product_id:'200',sku_id:'201',target_account:'example-creator-1',content_type:'WH',file:{path:file,sha256:sha,bytes:19},sha256:sha,duration_seconds:15.04,width:720,height:1280,
 description_ms:'Kit DIY. Visual AI.',hashtags:['#KitDIY'],short_product_name:'Kit DIY',production_lineage:{all_lineage_identifiers:[sha,'source-1']},
 account_scene_review:{sha256:sha,account:'example-creator-1',actual_category:'warehouse',reviewed_from_actual_final_frames:true,evidence:{path:evidence,sha256:hash(fs.readFileSync(evidence))}},
 semantic_review:{sha256:sha,product_consistent:true,scene_appropriate:true,caption_accurate:true,lineage_not_reused:true,evidence:{path:evidence,sha256:hash(fs.readFileSync(evidence))},link_title_terms:['Kit','DIY']},
 publishing_fields:{ai_disclosure:true,commercial_disclosure:true,own_brand:true,branded_content:false,music_agreement:true}};
 const manifest=path.join(src,'发布任务.json');fs.writeFileSync(manifest,JSON.stringify(pkg));
 const automationFile=path.join(dir,'automation.toml');fs.writeFileSync(automationFile,'status = "PAUSED"\n');
 return{dir,src,file,evidence,pkg,manifest,automationFile,policy,at:'2026-11-08T10:00:00Z',cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
export class FakeDriver {
 constructor(f,options={}){this.f=f;this.options=options;this.calls=[];this.fields={};this.success=false;}
 async call(kind,op,data={}){
   this.calls.push({kind,op,data});
   if(this.options.fail===op)throw Error('timeout:'+op);
   if(this.options.empty===op)return null;
   const j=data.job??this.f.job??this.f.pkg;
   switch(op){
    case 'connection':return{ready:true,serverInstanceId:'fake-generation'};
    case 'owned_page':case 'resume_page':return{owner:'codex-content-offline-test',target_id:'fresh-fake-target',url:'https://seller.tiktokshopglobalselling.com/shoppable-videos/inspiration/videos?shop_region=MY&scene_type=1',shop:'MY Malaysia (example-shop-my)',captcha:!!this.options.captcha,login:!!this.options.login,dirty:false,created:true};
    case 'product_heading':return{at:this.f.at,session_id:data.session_id,product_id:j.product_id,url:`https://seller.tiktokshopglobalselling.com/product/edit/${j.product_id}?shop_region=MY`,heading:'Kit DIY',owner:'codex-content-link-offline',shop:'MY Malaysia (example-shop-my)'};
    case 'buffer_hash':return{sha256:j.sha256};
    case 'preview':return{ready:true,duration:j.duration_seconds,src:'blob:original',sha256:j.sha256};
    case 'read_account':return{account:this.fields.account??j.account};
    case 'read_product':return{product_id:j.product_id,text:'Kit DIY',count:1};
    case 'read_fields':return{...this.fields,...j.fields};
    case 'final_readback':return{account:j.account,description:j.description,short_name:j.short_name,tags:j.tags,product_id:j.product_id,product_count:1,ready:true,duration:j.duration_seconds,src:'blob:original',ai_disclosure:true,commercial_disclosure:true,own_brand:true,branded_content:false,music_agreement:true,errors:[],submit_count:this.options.submitCount??1,submit_disabled:false};
    case 'submit':this.success=true;return{clicked:true};
    case 'confirm':return{success:this.success,message:this.success?'Your video has been posted!':'',at:this.f.at,owner:'codex-content-offline-test',shop:'MY Malaysia (example-shop-my)'};
    case 'cleanup_state':return{dirty:!!this.options.dirty,unknown:false,owner:'codex-content-offline-test',target_id:'fresh-fake-target',created:true};
    case 'reconcile':return{conclusion:'unknown',read_only:true};
    default: if(kind==='read')return{ok:true}; if(op==='select_account')this.fields.account=j.account;if(op.startsWith('fill_'))this.fields[data.field]=data.value;return{ok:true};
   }
 }
}
