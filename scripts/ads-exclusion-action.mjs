// Typed exact-video paid-use exclusion. Not imported by readonly v6.
const protectedIds=['9000000000000000119','9000000000000000109','9000000000000000120','9000000000000000117','9000000000000000113','9000000000000000116','9000000000000000110','9000000000000000118','9000000000000000112'];
function exactAction(window,spec){
 const document=window.document,u=new URL(window.location.href),text=document.body?.innerText??'',all=(s,r=document)=>Array.from(r.querySelectorAll?.(s)??[]),visible=e=>!e.hidden&&(typeof e.getClientRects!=='function'||e.getClientRects().length>0),norm=x=>(x??'').replace(/\s/g,'');
 if(window.name!=='codex-ads-20261019'||u.protocol!=='https:'||u.hostname!=='seller.tiktokshopglobalselling.com'||u.pathname!=='/ads-creation/dashboard'||u.searchParams.getAll('shop_region').length!==1||u.searchParams.get('shop_region')!=='MY'||u.searchParams.getAll('campaign_id').length!==1||u.searchParams.get('campaign_id')!=='9000000000000003'||u.searchParams.getAll('product_id').length!==1||u.searchParams.get('product_id')!=='9000000000000000016'||!/(^|\n)MY(\n|$)/.test(text)||!text.includes('Malaysia')||!text.includes('(example-shop-my)'))throw Error('ExactAdsOwnerScopeRequired');
 const starts=all('input[placeholder="开始日期"]').filter(visible),ends=all('input[placeholder="结束日期"]').filter(visible);
 if(starts.length!==spec.expected_pairs||starts.at(-1)?.value!==spec.expected_start||ends.at(-1)?.value!==spec.expected_end)throw Error('ExactObservedDatesRequired');
 const tables=all('table').filter(t=>{const h=all('thead th',t).map(e=>norm(e.innerText));return h.includes('作品ID')&&h.includes('创意素材');});if(tables.length!==1)throw Error('UniqueCreativeTableRequired');
 const table=tables[0],headers=all('thead th',table).map(e=>norm(e.innerText)),value=(cells,k)=>{const i=headers.indexOf(k);return i>=0?cells[i]:null;},rows=all('tbody tr',table).map(e=>{const cells=all('td',e).map(x=>x.innerText?.trim()??'');return{element:e,video_id:value(cells,'作品ID'),platform_status:value(cells,'探索状态'),cost:value(cells,'成本'),orders:value(cells,'SKU订单数'),roi:value(cells,'投资回报率(ROI)'),revenue:value(cells,'总收入'),column_alignment:cells.length===headers.length};});
 const boxes=all('tbody input[type="checkbox"]',table),checked=boxes.filter(e=>e.checked).map(e=>e.value),same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
 const modes=all('input[placeholder="选择批量操作"]').filter(visible),mode=modes.length===1?modes[0].closest('.theme-arco-select'):null,modeText=mode?.innerText.trim()??null;
 const dialogs=all('[role="dialog"]').filter(visible),buttons=all('button').filter(visible).filter(e=>e.innerText?.trim()==='应用'&&!e.disabled);
 if(spec.phase==='inspect')return {inspected:true,identity:{name:window.name,url:window.location.href,market:'MY'},dates:{start:starts.at(-1).value,end:ends.at(-1).value,pair_count:starts.length},checked_ids:checked,mode_count:modes.length,mode_text:modeText,mode_html:mode?.outerHTML?.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,2600)??null,enabled_apply_count:buttons.length,dialogs:dialogs.map(d=>({text:d.innerText,buttons:all('button',d).map(b=>({text:b.innerText.trim(),disabled:b.disabled}))})),rows:rows.filter(r=>spec.video_ids.includes(r.video_id)).map(({element,...r})=>({...r,checkboxes:all('input[type="checkbox"]',element).map(b=>({value:b.value,checked:b.checked,disabled:b.disabled}))})),action_marker:window.__daleiTypedAdsExclusions?.[spec.action_key]??null,paid_dispatched:false};
 const targets=spec.video_ids.map(id=>{const matches=rows.filter(r=>r.video_id===id),before=spec.expected_rows.find(r=>r.video_id===id);if(matches.length!==1||!before)throw Error('ExactVideoNotPresent:'+id);const row=matches[0];if(!row.column_alignment||!/表现欠佳|不活跃/.test(row.platform_status??'')||/已排除/.test(row.platform_status))throw Error('FreshPoorInactiveStateRequired:'+id);for(const k of ['platform_status','cost','orders','roi','revenue'])if(row[k]!==before[k])throw Error('BeforeSnapshotChanged:'+id+':'+k);const b=all('input[type="checkbox"]',row.element).filter(x=>x.value===id);if(b.length!==1||b[0].disabled)throw Error('ExactSelectableVideoRequired:'+id);return b[0];});
 const ledger=window.__daleiTypedAdsExclusions??(window.__daleiTypedAdsExclusions={}),marker=ledger[spec.action_key];
 if(spec.phase==='select'){
  if(marker||checked.length)throw Error('PreexistingSelectionOrAction_NoReplay');
  for(const b of targets)if(!b.closest('label'))throw Error('ObservedRowCheckboxLabelRequired');
  ledger[spec.action_key]={phase:'selection_requested',ids:[...spec.video_ids],at:new Date().toISOString()};for(const b of targets)b.closest('label').click();ledger[spec.action_key].phase='selected';return{dispatched:true,phase:'select',ids:spec.video_ids,paid_dispatched:false};
 }
 if(!marker||!same(marker.ids,spec.video_ids)||!same(checked,spec.video_ids))throw Error('ExactOwnedSelectionAndMarkerRequired');
 if(spec.phase==='open-mode'){
  if(marker.phase!=='selected')throw Error('WrongSelectionPhase_NoReplay');if(modeText==='排除')return{dispatched:false,phase:'open-mode',reason:'already_exclude_mode',paid_dispatched:false};if(!mode||modes.length!==1)throw Error('UniqueBulkOperationModeRequired');mode.click();marker.modeOpened=true;return{dispatched:true,phase:'open-mode',paid_dispatched:false};
 }
 if(spec.phase==='choose-exclude'){
  if(marker.phase!=='selected'||!marker.modeOpened)throw Error('ModeNotOpened');const options=all('li[role="option"]').filter(visible).filter(e=>e.innerText.trim()==='排除');if(options.length!==1)throw Error('ExactExcludeOptionRequired');options[0].click();marker.modeChosen=true;return{dispatched:true,phase:'choose-exclude',paid_dispatched:false};
 }
 if(spec.phase==='apply'){
  if(marker.phase!=='selected'||modeText!=='排除'||buttons.length!==1||dialogs.length)throw Error('ExactExcludeModeUniqueApplyNoDialogRequired');marker.phase='apply_requested';marker.applyAt=new Date().toISOString();buttons[0].click();return{dispatched:true,phase:'apply',ids:spec.video_ids,confirmation_required:true,paid_outcome_verified:false};
 }
 if(spec.phase==='confirm'){
  if(marker.phase!=='apply_requested'||modeText!=='排除'||dialogs.length!==1)throw Error('ExactExclusionConfirmationPhaseRequired');const d=dialogs[0],warning=d.innerText;if(warning!==spec.expected_warning||!warning.includes('要移除视频吗？')||/删除公开|删除作品|删除视频/.test(warning))throw Error('FreshExactAdExclusionWarningRequired');const confirm=all('button',d).filter(visible).filter(b=>b.innerText.trim()==='确认'&&!b.disabled);if(confirm.length!==1)throw Error('UniqueExclusionConfirmRequired');marker.phase='confirm_requested';marker.confirmAt=new Date().toISOString();confirm[0].click();return{dispatched:true,phase:'confirm',ids:spec.video_ids,warning,paid_outcome_verified:false,independent_excluded_ID_readback_required:true};
 }
 throw Error('UnsupportedExactExclusionPhase');
}
export function buildAdsExclusionArgs(spec){
 const keys=['phase','action_key','video_ids','expected_start','expected_end','expected_pairs','expected_rows','expected_warning'];
 if(!spec||Object.keys(spec).some(k=>!keys.includes(k))||!['inspect','select','open-mode','choose-exclude','apply','confirm'].includes(spec.phase)||!/^ADS-MY-20261019-EXCLUDE-[A-Z0-9_-]{1,60}$/.test(spec.action_key??'')||!Array.isArray(spec.video_ids)||spec.video_ids.length<1||spec.video_ids.length>10||new Set(spec.video_ids).size!==spec.video_ids.length||spec.video_ids.some(id=>!/^\d{19}$/.test(id)||protectedIds.includes(id)))throw Error('TypedExactNewVideoExclusionRequired');
 if(spec.expected_start!=='2026-10-03'||spec.expected_end!=='2026-10-19'||!Number.isInteger(spec.expected_pairs)||spec.expected_pairs<1||spec.expected_pairs>5)throw Error('ExactCampaignToCurrentWindowRequired');
 if(!Array.isArray(spec.expected_rows)||spec.expected_rows.length!==spec.video_ids.length||spec.expected_rows.some(r=>!spec.video_ids.includes(r.video_id)||['platform_status','cost','orders','roi','revenue'].some(k=>typeof r[k]!=='string')||!/表现欠佳|不活跃/.test(r.platform_status)||/已排除/.test(r.platform_status)))throw Error('ExactPoorInactiveBeforeRowsRequired');
 if(spec.phase==='confirm'&&(typeof spec.expected_warning!=='string'||!spec.expected_warning.includes('要移除视频吗？')))throw Error('ExactObservedWarningRequired');
 return{action:'evaluate',params:{download:false,js:`(${exactAction.toString()})(window,${JSON.stringify(spec)})`}};
}
