// Offline-tested adapter only. Construction never loads or starts the official CLI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Protocol} from './protocol.mjs';
import {readJSON,fail} from './common.mjs';
import {verifyOwnedPageReceipt} from './owned-page-receipt.mjs';

export class OfficialDriver {
 constructor({root,stateDir,runtime,transport,pause=ms=>new Promise(r=>setTimeout(r,ms)),selectors=readJSON(new URL('../selectors.json',import.meta.url))}){
  runtime=structuredClone(runtime);Object.assign(this,{root,stateDir,runtime,transport,selectors,pause});this.page=null;this.productPage=null;this.created=new Set();
  if(!runtime?.task_id||!runtime.environment_id||!/^codex-content-[a-z0-9_-]{6,100}$/.test(runtime.owner??'')||!runtime.product_owner||!runtime.publish_url||!runtime.product_edit_url)fail('browser_runtime_configuration_missing',20);
  this.configDir=process.env.ZINIAO_CLI_CONFIG_DIR??path.join(os.homedir(),'.ziniao-cli');
 }
 async init(){
  if(!this.transport){
   const {createCliTransport}=await import('../../ziniao-eco-gateway.mjs');
   this.transport=createCliTransport({root:this.root,spawnImpl:(binary,args,options)=>spawn(binary,args,{...options,env:{...options.env,ZINIAO_CLI_CONFIG_DIR:this.configDir}})});
  }
  this.protocol??=new Protocol({transport:this.transport,environment:this.runtime.environment_id,taskId:this.runtime.task_id,activeFile:path.join(this.root,'operations/browser-runtime/eco-gateway/active.json'),receipts:path.join(this.stateDir,'requests')});
 }
 async raw(args,readOnly=false,expectedURL=this.page?.url){await this.init();return this.protocol.call(args,{readOnly,expectedURL});}
 script(body,page=this.page){
  const s=JSON.stringify(this.selectors),p=JSON.stringify(page??{});
  return `(async()=>{const S=${s},P=${p};const visible=e=>!!e?.getClientRects?.().length;const all=s=>[...document.querySelectorAll(s)].filter(visible);const one=s=>{const a=all(s);if(a.length!==1)throw Error('UniqueSelectorRequired:'+s);return a[0]};const txt=e=>(e.innerText??'').trim();const identity=()=>{const a=all(S.shop),shop=a.length===1?txt(a[0]):'',text=document.body?.innerText??'',inputs=[...document.querySelectorAll(S.inputs)];return{owner:window.name,url:location.href,shop,captcha:all(S.captcha).length>0,login:S.anchors.login.some(t=>text.includes(t)),dialogs:all(S.dialog).length,progress:all(S.progress).length>0||text.includes(S.anchors.uploading),selectedFiles:inputs.filter(e=>e.type==='file').reduce((n,e)=>n+(e.files?.length??0),0),media:all(S.video).length,dirty:inputs.some(e=>e.type==='checkbox'||e.type==='radio'?e.checked!==e.defaultChecked:e.type!=='file'&&!e.disabled&&!e.readOnly&&String(e.value??e.innerText??'').trim()),text:text.slice(-3500)}};const identityNow=identity();if(identityNow.captcha||identityNow.login)return identityNow;if(P.owner&&(window.name!==P.owner||location.href!==P.url||!identityNow.shop.includes(S.anchors.country)||!identityNow.shop.includes(S.anchors.shop)))throw Error('OwnedIdentityChanged');${body}})()`;
 }
 async evaluate(body,page=this.page){const r=await this.raw({action:'evaluate',params:{download:false,js:this.script(body,page)}},true,page?.url);if(r.value?.captcha||r.value?.login)fail(r.value.login?'login_required':'captcha_required',30);return r.value;}
 async mutate(body,page=this.page){const r=await this.raw({action:'evaluate',params:{download:false,js:this.script(body,page)}},false,page?.url);if(r.value?.captcha||r.value?.login)fail(r.value.login?'login_required':'captcha_required',30);return r.value?{...r.value,original_request_id:r.requestId??null,tool_call_id:r.toolCallId??null}:r.value;}
 async inventory(){const r=await this.raw({action:'tabs',params:{action:'list'}},true);if(!Array.isArray(r.tabs))fail('fresh_tab_inventory_missing');return r.tabs;}
 async selectFresh(tab){
  const fresh=await this.inventory(),matches=fresh.filter(t=>t.index===tab.index&&t.url===tab.url);if(matches.length!==1)fail('fresh_tab_changed');
  await this.raw({action:'tabs',params:{action:'select',index:matches[0].index}});
  const p=await this.evaluate(`return identityNow;`,{});
  const target=matches[0].target_id??matches[0].id;if(!target)fail('current_target_id_unavailable');
  const page={...p,target_id:String(target),created:this.created.has(p.owner)},at=new Date().toISOString();
  const receipt={target_id:page.target_id,url:page.url,window_name:page.owner,shop:page.shop,observed_at:at};
  if(page.owner){verifyOwnedPageReceipt(page,receipt,at);page.owned_page_receipt=receipt;}
  return page;
 }
 async findOwned(owner,url){
  const list=(await this.inventory()).filter(t=>t.url===url);if(list.length>8)fail('ambiguous_role_inventory');const found=[];
  for(const tab of list){const p=await this.selectFresh(tab);if(p.owner===owner)found.push(p);}
  if(found.length>1)fail('duplicate_owned_page_name');
  if(found.length){const candidate=(await this.inventory()).filter(t=>t.url===url);for(const t of candidate){const p=await this.selectFresh(t);if(p.owner===owner)return p;}}
  return{missing:true};
 }
 async bind(page){const p=await this.findOwned(page.owner,page.url);if(p.missing)fail('original_owned_page_missing');return p;}
 async uiClick(selector){
  const state=await this.evaluate(`const e=one(${JSON.stringify(selector)});return{disabled:!!e.disabled||e.getAttribute('aria-disabled')==='true'};`);
  if(state.disabled)fail('disabled_control');
  // Unique selector is checked in the same guarded page just before dispatch.
  const r=await this.raw({action:'click',params:{ref:selector,expect_file_chooser:false,download:false}});return{ok:true,original_request_id:r.requestId??null,tool_call_id:r.toolCallId??null};
 }
 async uiType(selector,text,enter=false){await this.evaluate(`one(${JSON.stringify(selector)});return{unique:true};`);await this.raw({action:'type',params:{ref:selector,text,enter}});return{ok:true};}
 async form(){return this.evaluate(`
  const d=one(S.form),a=one(S.account),v=one(S.video),b=all(S.attachedProduct),submit=all(S.submit),tags=one(S.tags);
  return{account:txt(a).split(/\\s+/)[0],description:one(S.description).value,short_name:one(S.short_name).value,tags:txt(tags).split('\\n').map(x=>x.trim()).filter(Boolean),ai_disclosure:one(S.ai_disclosure).getAttribute('aria-checked')==='true',commercial_disclosure:one(S.commercial_disclosure).getAttribute('aria-checked')==='true',own_brand:one(S.own_brand).checked,branded_content:one(S.branded_content).checked,music_agreement:one(S.music_agreement).checked,product_count:b.length,product_text:b.length===1?txt(b[0].parentElement.parentElement.parentElement):null,ready:v.readyState>=2,duration:Number.isFinite(v.duration)?v.duration:null,src:v.currentSrc||v.src||null,errors:all(S.errors).map(txt).filter(Boolean),submit_count:submit.length,submit_disabled:submit.length===1?submit[0].disabled:null,uploading:document.body.innerText.includes(S.anchors.uploading),success:document.body.innerText.includes(S.anchors.success)};`);}
 async call(kind,op,data={}){
  const job=data.job,r=this.runtime,S=this.selectors;
  if(op==='connection'){await this.init();return this.transport.preflight();}
  if(op==='owned_page'||op==='resume_page'){
   if(data.readonly){const p=await this.evaluate('return identityNow;',{});return{...p,target_id:'current-observation-only',created:false};}
   this.page=await this.findOwned(r.owner,r.publish_url);return this.page;
  }
  if(op==='create_owned_page'){
   if(data.occupied_page){
    if(data.occupied_page.owner!==r.owner||!data.occupied_page.dialogs&&!data.occupied_page.progress)fail('occupied_page_identity_required');
    const originalOwner=r.owner;r.owner=originalOwner.slice(0,70)+'-'+crypto.randomBytes(8).toString('hex');
    delete r.owned_page_receipt;
    if(r.source?.owner===originalOwner&&r.source.url===data.occupied_page.url)fail('separate_clean_creation_source_required');
   }
   const inventory=await this.inventory();
   if(inventory.length===0){
    let u;try{u=new URL(r.source?.url);}catch{fail('known_my_homepage_required');}
    if(r.source.owner!==''||u.origin!=='https://seller.tiktokshopglobalselling.com'||u.pathname!=='/homepage'||u.searchParams.getAll('shop_region').length!==1||u.searchParams.get('shop_region')!=='MY')fail('known_my_homepage_required');
    // The outer exclusive create-owned-page intent bounds this navigation to one dispatch.
    await this.raw({action:'navigate',params:{url:r.source.url}},false,r.source.url);
   }
   const source=await this.findOwned(r.source?.owner??'',r.source?.url);if(source.missing)fail('clean_source_page_missing');
   await this.mutate(`if(identityNow.dialogs||identityNow.progress||all(S.inputs).some(e=>e.type==='file'?e.files?.length:e.type==='checkbox'||e.type==='radio'?e.checked!==e.defaultChecked:String(e.value??e.innerText??'').trim())||all(S.video).length)throw Error('SourceProtected');const w=window.open(${JSON.stringify(r.publish_url)},${JSON.stringify(r.owner)});return{ok:!!w};`,source);
   this.created.add(r.owner);return{ok:true};
  }
  if(op==='open_product_page'){
   const exists=await this.findOwned(r.product_owner,r.product_edit_url);
   if(!exists.missing){this.productPage=exists;return{ok:true};}
   this.page=await this.bind(data.context.page??this.page);
   await this.mutate(`if(all(S.video).length||all(S.file).some(e=>e.files?.length))throw Error('SourceProtected');const w=window.open(${JSON.stringify(r.product_edit_url)},${JSON.stringify(r.product_owner)});return{ok:!!w};`);
   this.created.add(r.product_owner);return{ok:true};
  }
  if(op==='product_heading'){
   const p=await this.findOwned(r.product_owner,r.product_edit_url);if(p.missing)fail('current_product_page_missing');this.productPage=p;
   const v=await this.evaluate(`return{...identityNow,heading:all(S.headings).map(txt).filter(Boolean).slice(0,4).join(' | '),at:new Date().toISOString()};`,p);
   this.page=await this.bind(data.context.page??this.page);
   return{...v,session_id:data.session_id,product_id:job.product_id};
  }
  if(op==='reconcile'){
   await this.init();if(fs.existsSync(this.protocol.activeFile))return this.protocol.readOriginal();
   const page=await this.findOwned(r.owner,r.publish_url);if(page.missing)return{conclusion:'unknown',reason:'original_page_missing',read_only:true};
   this.page=page;const value=await this.evaluate(`return{...identityNow,success:document.body.innerText.includes(S.anchors.success),at:new Date().toISOString()};`);
   return{conclusion:value.success?'success_observed_requires_exact_original_correlation':'unknown',read_only:true,observation:value};
  }
  if(op==='product_cleanup_state'){
   const p=await this.findOwned(r.product_owner,r.product_edit_url);
   if(p.missing)return{missing:true,created:false};
   this.productPage=p;return{...p,created:this.created.has(p.owner),unknown:false};
  }
  if(op==='close_product_page'){
   const p=await this.findOwned(r.product_owner,r.product_edit_url);
   if(p.missing)return{ok:true,already_absent:true};
   if(!this.created.has(p.owner)||p.dirty||p.selectedFiles||p.media)fail('product_helper_preserved');
   await this.mutate(`if(identityNow.dirty||identityNow.selectedFiles||identityNow.media)throw Error('ProductHelperProtected');window.close();return{ok:true};`,p);
   if(!(await this.findOwned(r.product_owner,r.product_edit_url)).missing)fail('product_helper_close_unverified');
   return{ok:true};
  }
  this.page=await this.bind(data.context.page??this.page);
  if(op==='buffer')return this.mutate(`if(document.querySelectorAll(S.buffer).length||document.querySelectorAll(S.video).length)throw Error('OriginalEmptyRequired');const a=[...document.querySelectorAll(S.videoInput)];if(a.length!==1||a[0].files.length)throw Error('UniqueEmptyVideoInputRequired');const i=document.createElement('input');i.type='file';i.id=S.bufferId;i.style.display='none';document.body.appendChild(i);return{ok:true};`);
  if(op==='transfer'){await this.raw({action:'upload_file',params:{path:job.file,selector:S.buffer}});return{ok:true};}
  if(op==='buffer_hash')return this.evaluate(`const a=[...document.querySelectorAll(S.buffer)];if(a.length!==1||a[0].files.length!==1)throw Error('UniqueBufferFileRequired');const f=a[0].files[0],h=await crypto.subtle.digest('SHA-256',await f.arrayBuffer());return{sha256:[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join(''),bytes:f.size};`);
  if(op==='assign')return this.mutate(`const bs=[...document.querySelectorAll(S.buffer)],as=[...document.querySelectorAll(S.videoInput)];if(bs.length!==1||bs[0].files.length!==1||as.length!==1||as[0].files.length||document.querySelectorAll(S.video).length)throw Error('OriginalEmptyInputRequired');const f=bs[0].files[0],h=await crypto.subtle.digest('SHA-256',await f.arrayBuffer()),sha=[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');if(sha!==${JSON.stringify(job.sha256)})throw Error('ExactSHAMismatch');const dt=new DataTransfer();dt.items.add(new File([f],f.name,{type:'video/mp4',lastModified:f.lastModified}));as[0].files=dt.files;bs[0].remove();as[0].dispatchEvent(new Event('input',{bubbles:true}));as[0].dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,sha256:sha};`);
  if(op==='preview'){
   let p;for(let n=0;n<8;n++){p=await this.evaluate(`const vs=all(S.video);if(vs.length>1)throw Error('UniquePreviewRequired');const v=vs[0];return{ready:!!v&&v.readyState>=2,duration:Number.isFinite(v?.duration)?v.duration:null,src:v?.currentSrc||v?.src||null};`);if(p.ready&&p.src)break;}
   return p;
  }
  if(op==='select_account'){
   const a=await this.evaluate(`const a=one(S.account);return{account:txt(a).split(/\\s+/)[0],expanded:a.getAttribute('aria-expanded')};`);
   if(a.account===job.account)return{ok:true};if(a.account)fail('unexpected_existing_account');
   if(a.expanded!=='true')await this.uiClick(S.account);
   await this.mutate(`const allOptions=all(S.accountOptions),a=allOptions.filter(e=>txt(e).split('\\n')[0].trim()===${JSON.stringify(job.account)});if(a.length!==1||a[0].getAttribute('aria-disabled')==='true')throw Error('UniqueAccountOptionRequired');a[0].setAttribute(S.targetAttribute,'account');return{ok:true};`);
   return this.uiClick(S.accountTarget);
  }
  if(op==='read_account')return this.evaluate(`return{account:txt(one(S.account)).split(/\\s+/)[0]};`);
  if(op==='attach_product'){
   await this.mutate(`const a=all(S.addProduct).filter(e=>S.anchors.addProduct.some(t=>txt(e).includes(t)));if(a.length!==1||a[0].disabled)throw Error('UniqueAddProductRequired');a[0].setAttribute(S.targetAttribute,'product');return{ok:true};`);
   await this.uiClick(S.productTarget);await this.uiType(S.productSearch,job.product_id,true);
   await this.mutate(`const a=all(S.productRadio).filter(e=>e.value===${JSON.stringify(job.product_id)});if(a.length!==1||a[0].disabled||a[0].checked)throw Error('UniqueExactParentRadioRequired');a[0].setAttribute(S.targetAttribute,'radio');return{ok:true};`);
   await this.uiClick(S.radioTarget);
   await this.evaluate(`const a=one(S.radioTarget),b=one(S.productConfirm);if(!a.checked||txt(b)!==S.anchors.confirm||b.disabled)throw Error('ParentNotConfirmed');return{ok:true};`);
   await this.uiClick(S.productConfirm);return{ok:true,selected_product_id:job.product_id};
  }
  if(op==='read_product'){
   const p=await this.form();if(data.selected_product_id!==job.product_id||p.product_count!==1||job.semantic_review.link_title_terms.some(t=>!p.product_text?.toLowerCase().includes(t.toLowerCase())))fail('parent_attachment_unknown');
   return{count:p.product_count,product_id:job.product_id,text:p.product_text};
  }
  if(op==='fill_description'||op==='fill_short_name')return this.uiType(S[data.field],data.value,false);
  if(op==='fill_tags'){
   let p=await this.form(),old=p.tags;
   for(let n=0;n<old.length;n++){
    await this.mutate(`const a=all(S.removeTag),tags=txt(one(S.tags)).split('\\n').map(x=>x.trim()).filter(Boolean);if(a.length!==${old.length-n}||JSON.stringify(tags)!==${JSON.stringify(JSON.stringify(old.slice(n)))})throw Error('TagListChanged');a[0].setAttribute(S.targetAttribute,'tag');return{ok:true};`);
    await this.uiClick(S.tagTarget);p=await this.form();if(JSON.stringify(p.tags)!==JSON.stringify(old.slice(n+1)))fail('tag_removal_readback_mismatch');
   }
   for(let n=0;n<data.value.length;n++){await this.uiType(S.tagInput,data.value[n].slice(1),true);p=await this.form();if(JSON.stringify(p.tags)!==JSON.stringify(data.value.slice(0,n+1)))fail('tag_addition_readback_mismatch');}
   return{ok:true};
  }
  if(op==='fill_commercial_disclosure'||op==='fill_ai_disclosure'){
   const p=await this.form();if(p[data.field]!==data.value)await this.uiClick(S[data.field]);return{ok:true};
  }
  if(op==='read_fields')return this.form();
  if(op==='final_readback'){
   const p=await this.form(),prior=data.context?.attached;
   const same=prior?.product_id===job.product_id&&[prior.text,prior.text+'\n'+S.anchors.edit].includes(p.product_text);
   return{...p,product_id:p.product_count===1&&same?prior.product_id:null};
  }
  if(op==='submit')return this.uiClick(S.submit);
  if(op==='confirm'){
   let p;for(let n=0;n<4;n++){if(n)await this.pause(3000);p=await this.evaluate(`return{...identityNow,success:document.body.innerText.includes(S.anchors.success),message:document.body.innerText.includes(S.anchors.success)?S.anchors.success:'',at:new Date().toISOString()};`);if(p.success)break;}
   return p;
  }
  if(op==='cleanup_state'){
   const p=await this.evaluate(`return{...identityNow,dirty:all(S.inputs).some(e=>e.type==='file'?e.files?.length:e.type==='checkbox'||e.type==='radio'?e.checked!==e.defaultChecked:!e.disabled&&!e.readOnly&&String(e.value??e.innerText??'').trim()),media:all(S.video).length};`);
   return{...p,target_id:this.page.target_id,created:this.created.has(p.owner),unknown:false};
  }
  if(op==='close_owned_page'){
   if(!this.created.has(this.page.owner))fail('page_not_created_by_this_session');
   const owner=this.page.owner,url=this.page.url;await this.mutate(`if(all(S.inputs).some(e=>e.type==='file'?e.files?.length:e.type==='checkbox'||e.type==='radio'?e.checked!==e.defaultChecked:String(e.value??e.innerText??'').trim()))throw Error('DirtyPagePreserved');window.close();return{ok:true};`);
   const left=await this.findOwned(owner,url);if(!left.missing)fail('owned_page_close_unverified');return{ok:true};
  }
  fail('unsupported_browser_operation',40,{op,kind});
 }
}
