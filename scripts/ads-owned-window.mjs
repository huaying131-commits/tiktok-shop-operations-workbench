// DOM-only read scope. Does not patch the vendor service or authorize business writes.
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
 return {ok:true,identity:{...identity,ownerName:owner.name,ownerUrl:href,shop:shop.slice(0,120)},data:read(owner,document,owner.location)};
}
function fixedProjection(window,document,location){
 const all=s=>Array.from(document.querySelectorAll?.(s)??[]);
 const attr=(e,a)=>(e.getAttribute?.(a)??'').slice(0,240);
 return {actual:window.name,title:document.title??'',text:document.body?.innerText?.slice(0,16000)??'',
  dates:all('input').filter(e=>e.type!=='hidden'&&e.type!=='password'&&(/date|日期/i.test(e.placeholder??'')||/^\d{4}-\d{2}-\d{2}$/.test(e.value??''))).map(e=>({placeholder:e.placeholder??'',value:e.value??''})).slice(0,12),
  videoLinks:all('a[href]').filter(e=>/\/video\/\d+(?:[/?#]|$)/.test(e.href??'')).slice(0,300).map(e=>({text:e.innerText?.slice(0,160)??'',href:e.href})),
  rows:all('tr,[role=row]').slice(0,100).map(e=>({text:e.innerText?.slice(0,1000)??'',links:Array.from(e.querySelectorAll?.('a[href]')??[]).map(a=>({text:a.innerText?.slice(0,100)??'',href:a.href})).slice(0,12)})),
  controls:all('button,[role=button],[role=combobox]').slice(0,120).map(e=>({tag:e.tagName,text:e.innerText?.slice(0,100)??'',role:attr(e,'role'),tid:attr(e,'data-tid'),aria:attr(e,'aria-label'),disabled:e.disabled===true})),
  coverage:'Visible document DOM only; not proof of full pagination, complete report or effective dates.'};
}
export function buildOwnedRead(expected){
 if(arguments.length!==1)throw Error('FixedReadOnlyProjection');
 if(expected.windowName!=='codex-ads-20261019')throw Error('Unregistered owner');
 if(expected.requireCampaign===false||expected.requireProduct===false)throw Error('StrictScopeRequired');
 return `(${ownedRead.toString()})(window,${JSON.stringify({windowName:expected.windowName,inventory:expected.inventory})},${fixedProjection.toString()})`;
}
export function buildOwnedReadArgs(expected){return {action:'evaluate',params:{js:buildOwnedRead(expected),download:false}};}
