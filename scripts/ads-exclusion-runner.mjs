// One explicitly reviewed paid-use canary. No generic browser command or batch loop.
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import{pathToFileURL,fileURLToPath}from'node:url';
import{reserveCanary,getBatch,assertResources,recordPhase,verifyExcludedCanary}from'./ads-exclusion-ledger.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const candidate='outputs/ads-monitoring/2026-10-19/recovery-1832/typed-exclusion-candidate/ziniao-eco-gateway.mjs';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
export function validateAdmission(a,{actionKey,videoId,releaseSha,now=new Date()}){
 if(a.status!=='approved_single_canary'||a.action_key!==actionKey||a.video_ids?.length!==1||a.video_ids[0]!==videoId||a.release_sha256!==releaseSha||a.environment_id!=='90000000000001'||a.campaign_id!=='9000000000000003'||a.product_id!=='9000000000000000016'||a.main_budget_usd!==20||a.target_roi!==9.8||a.max_new_paid_videos!==1||a.public_delete_allowed!==false)throw Error('ExactControllerCanaryAdmissionRequired');
 const t=Date.parse(a.approved_at);if(!Number.isFinite(t)||now.getTime()<t||now.getTime()-t>4*3600000||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now)!=='2026-10-19')throw Error('CurrentDatedCanaryAdmissionRequired');return true;
}
export async function phaseCallEvidence(root,sectionId,phase){
 const dir=path.resolve(root,'operations/browser-runtime/eco-gateway/sections/ads',sectionId);let names;try{names=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')return{parent:null,verification:null};throw e;}
 const requests=[];for(const n of names.filter(n=>n.endsWith('.request.json'))){const r=await read(path.join(dir,n));if(r.args?.action==='evaluate'&&r.args.params?.js?.startsWith('(function exactAction(')&&r.args.params.js.includes('"phase":'+JSON.stringify(phase)))requests.push({...r,requestFile:n});}
 if(requests.length>1)throw Error('MultipleBusinessParents_NoGuess');const parent=requests[0]?.toolCallId??null;
 const child=parent?names.filter(n=>n.endsWith('.request.json')).find(n=>n===requests[0].requestFile.replace('.request.json','-verify.request.json')):null;
 let verification=null;if(child)verification=(await read(path.join(dir,child))).toolCallId;
 const active=await read(path.resolve(root,'operations/browser-runtime/eco-gateway/active.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(active?.parentToolCallId===parent)verification=active.verificationToolCallId??verification;
 return{parent,verification,section_dir:path.relative(root,dir),active_queue:active};
}
export async function runCanary(argv,{root=process.cwd()}={}){
 const[command,key,id,receiptFile,releaseFile,...rest]=argv;
 if(!['prepare','inspect','select','open-mode','choose-exclude','apply','confirm','verify'].includes(command)||!/^ADS-MY-20261019-EXCLUDE-[A-Z0-9_-]{1,60}$/.test(key??'')||!/^\d{19}$/.test(id??'')||!receiptFile||!releaseFile)throw Error('FixedCanaryCommandRequired');
 const bytes=await fs.readFile(path.resolve(root,releaseFile)),release=JSON.parse(bytes);validateAdmission(await read(path.resolve(root,receiptFile)),{actionKey:key,videoId:id,releaseSha:hash(bytes)});
 for(const f of release.files){if(hash(await fs.readFile(path.resolve(root,f.path)))!==f.sha256)throw Error('ReviewedCanaryFileChanged:'+f.path);}
 if(command==='prepare'){if(rest.length!==2)throw Error('FreshSourceAndDirectPolicyRequired');return reserveCanary({root,actionKey:key,videoId:id,sourceEvidence:rest[0],policyEvidence:rest[1]});}
 const a=await assertResources(root,key);if(a.video_ids.length!==1||a.video_ids[0]!==id)throw Error('OriginalSingleVideoLedgerRequired');
 if(command==='verify'){if(rest.length!==2)throw Error('FreshExcludedRowsAndFilterRequired');return verifyExcludedCanary({root,actionKey:key,rowEvidence:rest[0],filterEvidence:rest[1]});}
 const[sectionId]=rest;if(rest.length!==1||!/^[a-z0-9_-]{1,75}$/.test(sectionId??''))throw Error('UniqueOriginalSectionRequired');
 const {EcoGateway}=await import(pathToFileURL(path.resolve(root,candidate)));const gateway=new EcoGateway({root,allowAdsExclusion:true});
 const actionDir=path.resolve(root,'outputs/ads-monitoring/2026-10-19/exclusions',key);let businessAcknowledged=null,intent=false;
 try{return await gateway.section({module:'ads',sectionId,waitMs:20000},async s=>{
  await assertResources(root,key);const current=(await s.adsRead('current-canary',{mode:'video',video_id:id})).value.result;if(!current?.ok)throw Error('FreshOwnedCanaryRequired');const d=current.data.dates,row=current.data.row;
  if(d?.start!=='2026-10-03'||d.end!=='2026-10-19')throw Error('ExactCumulativeDatesRequired');
  if(command!=='inspect'&&(!current.data.found_on_current_page||row?.video_id!==id||row.row_kind!=='video'||!row.column_alignment||!/表现欠佳|不活跃/.test(row.platform_status)||/已排除/.test(row.platform_status)||row.orders!=='0'||Number.parseFloat(row.revenue)!==0||Number(row.roi)!==0))throw Error('CanaryChangedOrNotPresent_StopBeforeWrite');
  const spec={phase:command,action_key:key,video_ids:[id],expected_start:d.start,expected_end:d.end,expected_pairs:d.pair_count,expected_rows:command==='inspect'?a.before.rows:[row]};
  const pre=(await s.adsExclusion('canary-inspect',{...spec,phase:'inspect'})).value.result;if(!pre?.inspected)throw Error('ExactTypedPreflightRequired');
  const preFile=path.join(actionDir,sectionId+'-preflight.json');await fs.writeFile(preFile,JSON.stringify({at:new Date().toISOString(),identity:s.identity,dates:d,row,typed:pre},null,2),{flag:'wx'});
  if(command==='inspect')return{inspection:pre,paid_dispatched:false,ledger_status:(await getBatch(root,key)).status};
  if(command==='confirm'){if(pre.dialogs?.length!==1)throw Error('OneFreshExclusionDialogRequired');spec.expected_warning=pre.dialogs[0].text;}
  await recordPhase(root,key,{phase:command,stage:'intent',sectionId,evidence:path.relative(root,preFile)});intent=true;
  const r=await s.adsExclusion('canary-'+command,spec);businessAcknowledged={toolCallId:r.toolCallId,value:r.value.result};
  await recordPhase(root,key,{phase:command,stage:'sdk_completed',sectionId,toolCallId:r.toolCallId,evidence:businessAcknowledged});
  const after=(await s.adsExclusion('canary-after-inspect',{...spec,phase:'inspect'})).value.result;await fs.writeFile(path.join(actionDir,sectionId+'-after.json'),JSON.stringify(after,null,2),{flag:'wx'});
  return{original_parent:r.toolCallId,result:r.value.result,after,paid_outcome_verified:false,requires_independent_excluded_ID:true};
 });}catch(e){
  const calls=await phaseCallEvidence(root,sectionId,command);await fs.writeFile(path.join(actionDir,sectionId+'-failure.json'),JSON.stringify({at:new Date().toISOString(),error:e.message,calls,business_acknowledged:businessAcknowledged,safe_ending:'Retain only this owned page selection/dialog/checkpoint. Never replay apply/confirm, clear other selections, restore or roll back an unknown confirmation.'},null,2),{flag:'wx'});
  if(intent)await recordPhase(root,key,{phase:command,stage:'unknown',sectionId,toolCallId:calls.parent,verificationToolCallId:calls.verification,evidence:{business_acknowledged:businessAcknowledged,section:calls.section_dir},error:e.message});throw e;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await runCanary(process.argv.slice(2))));}catch(e){console.error(JSON.stringify({ok:false,error:e.message,paid_success_claim:false}));process.exitCode=1;}}
