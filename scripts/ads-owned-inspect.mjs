// Same-call owned DOM scope; fixed projections and listed filter/date UI only.
// Does not authorize paid exclusions or patch the vendor service.
function ownedRead(caller,expected,read){
 let owner=caller;
 const identity={callerName:caller.name,callerUrl:caller.location.href};
 if(owner.name!==expected.windowName){
  const inventory=expected.inventory,age=Date.now()-Number(inventory?.observedAt);
  const urls=inventory?.urls;
  if(!Array.isArray(urls)||!Number.isFinite(age)||age<0||age>60000||urls.some(u=>u.startsWith('about:blank'))||urls.filter(u=>{try{const x=new URL(u);return x.protocol==='https:'&&x.hostname==='seller.tiktokshopglobalselling.com'&&x.pathname==='/ads-creation/dashboard'&&x.searchParams.getAll('campaign_id').length===1&&x.searchParams.get('campaign_id')==='9000000000000003'&&x.searchParams.getAll('product_id').length===1&&x.searchParams.get('product_id')==='9000000000000000016'&&x.searchParams.getAll('shop_region').length===1&&x.searchParams.get('shop_region')==='MY';}catch{return false;}}).length!==1)return {ok:false,reason:'fresh_unique_inventory_required',identity};
  try{owner=caller.open('',expected.windowName);}catch{return {ok:false,reason:'owned_window_not_accessible',identity};}
  if(!owner||owner.closed)return {ok:false,reason:'owned_window_missing',identity};
  try{
   if(owner.location.href==='about:blank'){
    let cleanedNewBlank=false;
    // Fresh inventory had no blank; close only this empty named child created by lookup.
    if(owner!==caller&&owner.name===expected.windowName&&owner.opener===caller&&owner.document.body?.childElementCount===0){owner.close();cleanedNewBlank=owner.closed===true;}
    return {ok:false,reason:'owned_window_missing',identity,cleanedNewBlank};
   }
  }catch{return {ok:false,reason:'owned_window_not_accessible',identity};}
 }
 let href,document;
 try{if(!owner||owner.closed)return {ok:false,reason:'owned_window_missing',identity};href=owner.location.href;document=owner.document;}
 catch{return {ok:false,reason:'owned_window_not_accessible',identity};}
 identity.ownerName=owner.name;identity.ownerUrl=href;
 const url=new URL(href);
 if(owner.name!==expected.windowName||url.protocol!=='https:'||url.hostname!=='seller.tiktokshopglobalselling.com'||url.pathname!=='/ads-creation/dashboard')return {ok:false,reason:'owned_route_mismatch',identity};
 const shop=document.body?.innerText?.slice(0,900)??'';
 if(!/(^|\n)MY(\n|$)/.test(shop)||!shop.includes('Malaysia')||!shop.includes('(example-shop-my)'))return {ok:false,reason:'shop_mismatch',identity};
 if(url.searchParams.getAll('campaign_id').length!==1||url.searchParams.get('campaign_id')!=='9000000000000003')return {ok:false,reason:'campaign_mismatch',identity};
 if(url.searchParams.getAll('product_id').length!==1||url.searchParams.get('product_id')!=='9000000000000000016')return {ok:false,reason:'product_mismatch',identity};
 if(url.searchParams.getAll('shop_region').length!==1||url.searchParams.get('shop_region')!=='MY')return {ok:false,reason:'market_mismatch',identity};
 return {ok:true,identity:{...identity,ownerName:owner.name,ownerUrl:href,shop:shop.slice(0,120)},data:read(owner,document,owner.location,expected.inspection)};
}
function inspect(window,document,location,spec){
 const all=(s,root=document)=>Array.from(root.querySelectorAll?.(s)??[]);
 const norm=x=>(x??'').replace(/\s+/g,'').trim();
 const visible=e=>!e.hidden&&(typeof e.getClientRects!=='function'||e.getClientRects().length>0);
 const attr=(e,k)=>(e.getAttribute?.(k)??'').slice(0,200);
 const meta=e=>e?{tag:e.tagName,placeholder:e.placeholder??'',value:e.type==='password'?'':e.value??'',text:e.innerText?.slice(0,140)??'',class:typeof e.className==='string'?e.className:attr(e,'class'),role:attr(e,'role'),tid:attr(e,'data-tid'),disabled:e.disabled===true,ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].filter(Boolean).map(a=>({tag:a.tagName,class:typeof a.className==='string'?a.className:attr(a,'class'),role:attr(a,'role')}))}:null;
 const starts=all('input[placeholder="开始日期"]').filter(visible),ends=all('input[placeholder="结束日期"]').filter(visible);
 const dates={start:starts.at(-1)?.value??null,end:ends.at(-1)?.value??null,pair_count:starts.length,scope:'Last visible creative date pair; verify its drawer context before decisions.'};
 const tables=all('table');const table=tables.find(t=>{const h=all('thead th',t).map(x=>norm(x.innerText));return h.includes('作品ID')&&h.includes('创意素材');});
 if(spec.mode==='filter_options'){
  const heading=all('div,span').filter(visible).find(e=>e.innerText?.trim()==='筛选条件'&&!Array.from(e.children??[]).some(c=>c.innerText?.trim()==='筛选条件'));
  const parent=heading?.parentElement,root=parent?.parentElement;
  return {dates,heading:meta(heading),parent:parent?{class:parent.className,text:parent.innerText?.slice(0,1800),html:parent.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,3000)}:null,root:root?{class:root.className,text:root.innerText?.slice(0,1800),html:root.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,3300)}:null};
 }
 if(spec.mode==='filter_state'){
  const roots=all('.popup-panel-GoHK').filter(visible).filter(e=>e.innerText.startsWith('探索状态')&&e.innerText.includes('包含任一项')&&e.innerText.includes('取消')&&e.innerText.includes('应用'));
  const root=roots.length===1?roots[0]:null;
  const tree=root?.querySelector('ks-tree-view-1-1-28'),shadow=tree?.shadowRoot;
  const states=shadow?all('li',shadow).map(li=>{const c=li.querySelector('[role="checkbox"]');return {label:li.textContent.trim(),checked:c?.getAttribute('aria-checked'),checkbox_shadow:c?.shadowRoot?.innerHTML?.replace(/<style\b[^]*?<\/style>/g,'').replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,1200)??null};}):[];
  return {dates,root_count:roots.length,root:root?{text:root.innerText,html:root.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,3400)}:null,tree:tree?{tag:tree.tagName,shadow_open:!!shadow,registered:!!window.customElements?.get?.(tree.tagName.toLowerCase())}:null,state_count:states.length,selected_states:states.filter(s=>s.checked==='true').map(s=>s.label),excluded:states.find(s=>s.label==='已排除')??null,states:states.slice(spec.offset,spec.offset+4),inputs:root?all('input',root).slice(0,4).map(meta):[],buttons:root?all('button',root).slice(0,4).map(meta):[]};
 }
 if(spec.mode==='search_structure'){
  const field=all('input[placeholder="输入 [/] 进行搜索和筛选"]').filter(visible).at(-1),wrapper=field?.closest?.('.theme-arco-input-group-wrapper');
  return {dates,input:meta(field),wrapper_class:wrapper?.className??null,wrapper_html:wrapper?.outerHTML?.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]')?.slice(0,2200)??null,parent_html:wrapper?.parentElement?.outerHTML?.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]')?.slice(0,3200)??null,parent2_text:wrapper?.parentElement?.parentElement?.innerText?.slice(0,1200)??null};
 }
 if(spec.mode==='calendar'){
  const headers=all('[class*="picker-header"]').filter(visible).filter(e=>(e.innerText??'').trim());
  const cells=all('.theme-arco-picker-cell').filter(visible).filter(e=>[3,12,16,18,19].includes(Number(e.innerText?.trim()))&&e.className.includes('in-view'));
  return {dates,headers:headers.slice(-4).map(e=>({text:e.innerText,class:e.className,html:e.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,1800)})),cell_count:cells.length,offset:spec.offset,cells:cells.slice(spec.offset,spec.offset+4).map(e=>({day:e.innerText?.trim(),class:e.className,title:attr(e,'title'),data_date:attr(e,'data-date'),html:e.outerHTML.slice(0,1000),ancestry:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement?.parentElement?.parentElement].filter(Boolean).map(a=>({class:a.className,text:a.innerText?.slice(0,100)}))}))};
 }
 if(spec.mode==='popup'){
  const popups=all('[class*="popup-panel"],[class*="trigger-popup"],[role="listbox"],[role="menu"],[class*="select-popup"]').filter(visible).filter(e=>(e.innerText??'').trim().length>0&&!e.closest?.('aside,.sidebar-root'));
  const items=all('[role="option"],[role="menuitem"],[class*="select-option"],[class*="dropdown-menu-item"],label.theme-arco-checkbox').filter(visible).filter(e=>!e.closest?.('aside,.sidebar-root'));
  return {dates,popup_count:popups.length,popups:popups.slice(-4).map(e=>({...meta(e),text:e.innerText.slice(0,2200)})),item_count:items.length,offset:spec.offset,items:items.slice(spec.offset,spec.offset+4).map(meta)};
 }
 if(spec.mode==='pagination'){
  const deep=(root)=>all('*',root).flatMap(e=>[e,...(e.shadowRoot?deep(e.shadowRoot):[])]);
  const items=deep(document).filter(e=>visible(e)&&e.tagName==='LI'&&/Page |Next|Previous/.test((e.getAttribute('aria-label')??'')+' '+(e.getAttribute('title')??'')));
  return {dates,item_count:items.length,items:items.slice(spec.offset,spec.offset+4).map(e=>({...meta(e),title:attr(e,'title'),label:attr(e,'aria-label'),html:e.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,1600)}))};
 }
 if(spec.mode==='ui'){
  const controls=all('button,[role=button],[role=combobox]').filter(visible).filter(e=>/应用|排除|探索|加热|创意|上一页|下一页|筛选/.test(e.innerText??''));
  return {dates,date_start:meta(starts.at(-1)),date_end:meta(ends.at(-1)),controls_total:controls.length,offset:spec.offset,controls:controls.slice(spec.offset,spec.offset+4).map(meta),search_inputs:all('input').filter(e=>visible(e)&&/搜索|筛选/.test(e.placeholder??'')).slice(-2).map(meta),tail:document.body?.innerText?.slice(-1800)??''};
 }
 if(!table)return {available:false,reason:'creative_table_not_found',dates,orders:null};
 const headers=all('thead th',table).map(e=>norm(e.innerText));
 const rows=all('tbody tr',table).filter(visible);
 const value=(cells,name)=>{const n=headers.indexOf(name);return n>=0?cells[n]??null:null;};
 const mapped=rows.map(r=>{
  const cells=all('td',r).map(e=>e.innerText?.trim()??'');
  const id=value(cells,'作品ID'),title=value(cells,'创意素材');const fullId=id?.match(/(?:^|\D)(\d{19})(?:\D|$)/)?.[1]??null;
  return {video_id:fullId,row_kind:fullId?'video':/商品卡|product card/i.test(title??'')?'product_card':'unknown',creative:title,account:value(cells,'TikTok账号'),authorization:value(cells,'授权类型'),platform_status:value(cells,'探索状态'),published_at:value(cells,'发布时间'),cost:value(cells,'成本'),orders:value(cells,'SKU订单数'),roi:value(cells,'投资回报率(ROI)'),revenue:value(cells,'总收入'),impressions:value(cells,'商品广告曝光数'),clicks:value(cells,'商品广告点击数'),column_alignment:cells.length===headers.length,cell_count:cells.length,raw_text:r.innerText?.slice(0,1000)??''};
 });
 const costHeader=all('thead th',table).find(e=>norm(e.innerText)==='成本');
 const common={available:true,dates,page:new URL(location.href).searchParams.get('creative_page'),row_count_dom:rows.length,sort_evidence:costHeader?{text:costHeader.innerText,aria_sort:attr(costHeader,'aria-sort'),sorter_html:costHeader.querySelector('.core-table-sorter')?.outerHTML.slice(0,1800)??null,html:costHeader.outerHTML.replace(/<svg\b[^]*?<\/svg>/g,'[SVG]').slice(0,2000)}:null,headers:Object.fromEntries(headers.map((h,i)=>['column_'+i,h])),coverage:'Current rendered page only; no inference of full pagination or no orders from absence.'};
 if(spec.mode==='video'){const row=mapped.find(r=>r.video_id===spec.video_id);return {...common,requested_video_id:spec.video_id,found_on_current_page:!!row,row:row??null};}
 return {...common,offset:spec.offset,rows:mapped.slice(spec.offset,spec.offset+4),tail:document.body?.innerText?.slice(-900)??''};
}
export function buildOwnedInspectArgs(expected,spec){
 if(expected.windowName!=='codex-ads-20261019'||!spec||Object.keys(spec).some(k=>!['mode','offset','video_id'].includes(k))||!['creative_rows','ui','video','popup','search_structure','calendar','filter_options','filter_state','pagination'].includes(spec.mode))throw Error('FixedInspectionRequired');
 const offset=spec.offset??0;if(!Number.isInteger(offset)||offset<0||offset>1000)throw Error('BoundedOffsetRequired');
 if(spec.mode==='video'&&!/^\d{19}$/.test(spec.video_id??''))throw Error('CompleteVideoIdRequired');
 const scope={windowName:expected.windowName,inventory:expected.inventory,inspection:{mode:spec.mode,offset,...(spec.mode==='video'?{video_id:spec.video_id}:{})}};
 return {action:'evaluate',params:{js:`(${ownedRead.toString()})(window,${JSON.stringify(scope)},${inspect.toString()})`,download:false}};
}
function listedUi(window,document,location,spec){
 const all=(s,root=document)=>Array.from(root.querySelectorAll?.(s)??[]),visible=e=>!e.hidden&&(typeof e.getClientRects!=='function'||e.getClientRects().length>0);
 const starts=all('input[placeholder="开始日期"]').filter(visible),ends=all('input[placeholder="结束日期"]').filter(visible);
 if(starts.length!==spec.expected_pairs||starts.at(-1)?.value!==spec.expected_start||ends.at(-1)?.value!==spec.expected_end)return {dispatched:false,reason:'date_state_changed'};
 const table=all('table').find(t=>{const h=all('thead th',t).map(x=>(x.innerText??'').replace(/\s+/g,''));return h.includes('作品ID')&&h.includes('创意素材');});
 if(!table)return {dispatched:false,reason:'creative_context_missing'};
 if(all('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]',table).length)return {dispatched:false,reason:'uncommitted_creative_selection_present'};
 let target;
 if(spec.kind==='open-search'||spec.kind==='filter-menu'||spec.kind==='clear-slash'){
  target=all('input[placeholder="输入 [/] 进行搜索和筛选"]').filter(visible).at(-1);
  if(!target||target.value!==spec.expected_search)return {dispatched:false,reason:'search_state_changed'};
 }else if(spec.kind==='open-date')target=starts.at(-1);
 else if(spec.kind==='choose-date'){
  const panels=all('.theme-arco-panel-date').filter(visible).filter(p=>(p.querySelector('.theme-arco-picker-header-value')?.innerText??'').replace(/\s/g,'')===spec.date.slice(0,7));
  if(panels.length!==1)return {dispatched:false,reason:'calendar_month_missing_or_ambiguous'};
  const cells=all('.theme-arco-picker-cell-in-view',panels[0]).filter(visible).filter(c=>!c.className.includes('disabled')&&c.innerText.trim()===String(Number(spec.date.slice(8))));
  if(cells.length!==1)return {dispatched:false,reason:'calendar_day_missing_or_ambiguous'};
  target=cells[0].querySelector('.theme-arco-picker-date-value')??cells[0];
 }
 else if(spec.kind==='remove-excluded-filter'){
  const tags=all('[data-uid="filtertag:div:3bb9b"]').filter(visible).filter(e=>e.innerText.replace(/\s/g,'')==='探索状态包含任一项:已排除');
  if(tags.length!==1)return {dispatched:false,reason:'exact_excluded_tag_missing'};
  target=tags[0].querySelector('[data-uid="filtertag:div:92328"]');
 }
 else if(spec.kind==='first-page'){
  const candidates=all('li[aria-label="Page 1"]').filter(visible).filter(e=>e.closest('.pulse-pagination'));
  if(candidates.length!==1||candidates[0].className.includes('disabled')||candidates[0].getAttribute('aria-current')==='true')return {dispatched:false,reason:'first_page_missing_ambiguous_disabled_or_current'};
  target=candidates[0];
 }
 else if(spec.kind==='next-page'){
  const candidates=all('li[aria-label="Next"]').filter(visible).filter(e=>e.closest('.pulse-pagination'));
  if(candidates.length!==1||candidates[0].className.includes('disabled'))return {dispatched:false,reason:'next_page_missing_or_disabled'};
  target=candidates[0];
 }
 else if(spec.kind==='filter-exploration'){
  const roots=all('[data-uid="searchpanel:div:0774a"]').filter(visible).filter(p=>p.innerText.includes('筛选条件')&&p.innerText.includes('作品 ID'));
  if(roots.length!==1)return {dispatched:false,reason:'creative_filter_menu_missing'};
  const labels=all('.filter-item-title-text-lb7B',roots[0]).filter(e=>e.innerText.trim()==='探索状态');
  if(labels.length!==1)return {dispatched:false,reason:'exploration_filter_category_ambiguous'};
  target=labels[0];
 }
 else if(spec.kind==='filter-check-excluded'||spec.kind==='filter-apply-excluded'){
  const roots=all('[data-uid="filterpanel:div:000fe"]').filter(visible).filter(p=>p.querySelector('.filter-panel-header-title-kvTw')?.innerText.trim()==='探索状态');
  if(roots.length!==1)return {dispatched:false,reason:'exploration_filter_panel_missing'};
  const root=roots[0],tree=root.querySelector('ks-tree-view-1-1-28')?.shadowRoot;
  if(!tree)return {dispatched:false,reason:'filter_tree_not_accessible'};
  const nodes=all('li',tree),selected=nodes.filter(li=>li.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')==='true');
  if(selected.some(li=>li.textContent.trim()!=='已排除'))return {dispatched:false,reason:'other_filter_selection_present'};
  if(spec.kind==='filter-check-excluded'){
   const rows=nodes.filter(li=>li.textContent.trim()==='已排除');if(rows.length!==1)return {dispatched:false,reason:'excluded_filter_option_missing'};
   const host=rows[0].querySelector('[role="checkbox"]');if(host.getAttribute('aria-checked')==='true')return {dispatched:false,reason:'excluded_already_selected'};
   target=host.shadowRoot?.querySelector('input[type="checkbox"]');if(!target||target.checked)return {dispatched:false,reason:'filter_checkbox_state_uncertain'};
   rows[0].scrollIntoView?.({block:'nearest'});
  }else{
   if(selected.length!==1||selected[0].textContent.trim()!=='已排除')return {dispatched:false,reason:'excluded_only_filter_required'};
   const buttons=all('button',root).filter(b=>b.innerText.trim()==='应用');if(buttons.length!==1)return {dispatched:false,reason:'filter_apply_missing'};target=buttons[0];
  }
 }
 else return {dispatched:false,reason:'unsupported_ui_action'};
 if(!target||target.disabled)return {dispatched:false,reason:'ui_target_unavailable'};
 if(spec.kind==='filter-menu'||spec.kind==='clear-slash'){
  if(spec.kind==='clear-slash'&&target.value!=='/')return {dispatched:false,reason:'not_our_slash_query'};
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
  if(!setter)return {dispatched:false,reason:'input_setter_unavailable'};
  target.focus();setter.call(target,spec.kind==='clear-slash'?'':'/');target.dispatchEvent(new window.Event('input',{bubbles:true}));target.dispatchEvent(new window.Event('change',{bubbles:true}));
  return {dispatched:true,kind:spec.kind,input_value:target.value,paid_write:false};
 }
 target.focus?.();target.click();return {dispatched:true,kind:spec.kind,...(spec.date?{requested_date:spec.date}:{}),date_before:{start:spec.expected_start,end:spec.expected_end},paid_write:false};
}
export function buildOwnedUiArgs(expected,spec){
 if(expected.windowName!=='codex-ads-20261019'||!spec||Object.keys(spec).some(k=>!['kind','expected_start','expected_end','expected_pairs','expected_search','date'].includes(k))||!['open-search','open-date','filter-menu','clear-slash','choose-date','filter-exploration','filter-check-excluded','filter-apply-excluded','remove-excluded-filter','next-page','first-page'].includes(spec.kind)||!/^\d{4}-\d{2}-\d{2}$/.test(spec.expected_start??'')||(!/^\d{4}-\d{2}-\d{2}$/.test(spec.expected_end??'')&&!(spec.kind==='choose-date'&&spec.expected_end===''))||!Number.isInteger(spec.expected_pairs)||spec.expected_pairs<1||spec.expected_pairs>5)throw Error('ListedFilterDateUiOnly');
 if(spec.kind==='choose-date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(spec.date??'')||!Number.isFinite(Date.parse(spec.date))||new Date(spec.date+'T00:00:00Z').toISOString().slice(0,10)!==spec.date))throw Error('InvalidCalendarDay');
 const scope={windowName:expected.windowName,inventory:expected.inventory,inspection:spec};
 return {action:'evaluate',params:{js:`(${ownedRead.toString()})(window,${JSON.stringify(scope)},${listedUi.toString()})`,download:false}};
}

