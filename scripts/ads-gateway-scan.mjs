// Fixed paginated report review. No paid exclusion or arbitrary browser command.
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {EcoGateway}from './ziniao-eco-gateway.mjs';
const [prefix,maxArg='40']=process.argv.slice(2),maxPages=Number(maxArg);
if(!/^[a-z0-9_-]{1,65}$/.test(prefix??'')||!Number.isInteger(maxPages)||maxPages<1||maxPages>60)throw Error('UniquePrefixAndBoundedPagesRequired');
const matrix=JSON.parse(await fs.readFile('operations/controller/2026-10-19/eco-gateway-integration/validation-matrix.json'));
if(matrix.live_cross_window_verified!==true)throw Error('LiveCrossWindowReviewNotYetAccepted');
const release=JSON.parse(await fs.readFile('outputs/ads-monitoring/2026-10-19/recovery-1832/release-readonly-v7.json'));
const expected=release.files.find(f=>f.path==='scripts/ziniao-eco-gateway.mjs').sha256;
if(crypto.createHash('sha256').update(await fs.readFile('scripts/ziniao-eco-gateway.mjs')).digest('hex')!==expected)throw Error('ReviewedGatewayChanged');
const outDir=path.resolve('outputs/ads-monitoring/2026-10-19/recovery-1832/scans',prefix);await fs.mkdir(outDir,{recursive:true});
const gateway=new EcoGateway({allowReportUi:true}),pages=[];let expectedScope,total;
for(let n=1;n<=maxPages;n++){
 const out=await gateway.section({module:'ads',sectionId:prefix+'-p'+n,waitMs:20000},async s=>{
  const chunks=[];for(const offset of [0,4,8]){const x=(await s.adsRead('rows-'+offset,{mode:'creative_rows',offset})).value.result;if(!x?.ok||!x.data.available)throw Error('OwnedCreativeTableRequired');chunks.push(x);}
  const first=chunks[0],after=(await s.adsRead('stable',{mode:'creative_rows',offset:0})).value.result;
  const sign=x=>JSON.stringify({dates:x.data.dates,page:x.data.page,rows:x.data.rows.map(r=>[r.video_id,r.cost,r.orders,r.roi,r.platform_status])});
  if(sign(first)!==sign(after)||chunks.some(x=>x.data.page!==first.data.page||JSON.stringify(x.data.dates)!==JSON.stringify(first.data.dates)))throw Error('TableChanged_NoAggregate');
  if(Number(first.data.page)!==n)throw Error('StartAtFirstPageAndNoPageSkipsRequired');
  const u=new URL(first.identity.ownerUrl);u.searchParams.delete('creative_page');const scope=JSON.stringify({url:u.href,dates:first.data.dates});if(expectedScope&&scope!==expectedScope)throw Error('FilterOrDateChangedDuringScan');expectedScope=scope;
  const count=Number(first.data.tail.match(/Total rows:\s*(\d+)/)?.[1]);if(!Number.isFinite(count))throw Error('TotalRowsNotObserved');if(total!==undefined&&total!==count)throw Error('TotalRowsChanged_NoCompleteClaim');total=count;
  if(!/10\s*\/\s*Page/.test(first.data.tail)||first.data.row_count_dom!==Math.min(10,Math.max(0,count-(n-1)*10)))throw Error('ObservedTenRowPageSizeRequired');
  const rows=chunks.flatMap(x=>x.data.rows),page={at:new Date().toISOString(),page:n,identity:first.identity,dates:first.data.dates,total_rows:count,rows,sort:first.data.sort_evidence,current_filter_only:true};
  if(rows.some(r=>!r.column_alignment))throw Error('ColumnAlignmentRequired');
  await s.store('store-page',page);
  const more=n*10<count;if(more&&n<maxPages){const d=first.data.dates;const changed=(await s.adsUi('next-page',{kind:'next-page',expected_start:d.start,expected_end:d.end,expected_pairs:d.pair_count,expected_search:''})).value.result;if(!changed?.ok||!changed.data.dispatched)throw Error('NextPageNotDispatched');}
  return {...page,more};
 });
 pages.push(out.result);await fs.writeFile(path.join(outDir,'page-'+n+'.json'),JSON.stringify(out,null,2),{flag:'wx'});
 console.log(JSON.stringify({page:n,rows:out.result.rows.length,total,poor:out.result.rows.filter(r=>/表现欠佳|不活跃/.test(r.platform_status??'')).map(r=>r.video_id)}));
 if(!out.result.more)break;
}
const all=pages.flatMap(p=>p.rows),ids=all.filter(r=>r.video_id).map(r=>r.video_id),complete=pages.at(-1)?.more===false&&all.length===total&&new Set(ids).size===ids.length;
const unknown=all.filter(r=>r.row_kind==='unknown');
const result={at:new Date().toISOString(),pages:pages.length,rows:all.length,total,complete_current_filter:complete,complete_video_classification:complete&&unknown.length===0,known_video_rows:all.filter(r=>r.row_kind==='video').length,product_card_rows:all.filter(r=>r.row_kind==='product_card').length,unknown_row_count:unknown.length,unknown_rows:unknown,scope:expectedScope,candidates:all.filter(r=>r.row_kind==='video'&&/表现欠佳|不活跃/.test(r.platform_status??'')&&!/已排除/.test(r.platform_status)),excellent:all.filter(r=>r.row_kind==='video'&&/表现出色/.test(r.platform_status??'')),paid_actions:0,coverage:'Current actual filter only; no claim beyond selected range/statuses or unknown row kinds.'};
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({summary:path.join(outDir,'summary.json'),complete_current_filter:complete,candidates:result.candidates.length,paid_actions:0}));
