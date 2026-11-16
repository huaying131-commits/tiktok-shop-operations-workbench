import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Read-only pricing analysis in temporary formula-engine workbooks.
// No source workbook, platform workbook or shop data is written.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const prior=path.join(root,'outputs/reprice-sg-vn-2026-10-04');
const out=path.join(root,'outputs/official-campaigns-2026-10-07');
const req=createRequire(path.join(root,'outputs/pricing-engine-2026-10-03/package.json'));
const {Workbook}=await import(pathToFileURL(req.resolve('@oai/artifact-tool')).href);
const extract=JSON.parse(await fs.readFile(path.join(prior,'pricing-extracted.json'),'utf8'));
const visibility=JSON.parse(await fs.readFile(path.join(prior,'pricing-visible-catalog.json'),'utf8'));
const checkpoint=JSON.parse(await fs.readFile(path.join(out,'checkpoint.json'),'utf8'));
if(!checkpoint.source_hash_verified_this_run||checkpoint.source_sha256!==visibility.sha256)throw Error('Current source hash verification required');
const logisticsName='物流价卡(更新时间1月27日）';
const rowOf=a=>Number(a.match(/\d+$/)[0]);
const colOf=a=>a.match(/^[A-Z]+/)[0].split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const decode=c=>c.value==null?null:['s','str','inlineStr','e'].includes(c.type)?c.value:c.type==='b'?c.value==='1':Number(c.value);
function populate(sheet,cells,height,width){
 const vals=Array.from({length:height},()=>Array(width).fill(null));
 for(const c of cells)if(!c.formula)vals[rowOf(c.cell)-1][colOf(c.cell)-1]=decode(c);
 sheet.getRangeByIndexes(0,0,height,width).values=vals;
 const columns=new Map();
 for(const c of cells)if(c.formula){const k=c.cell.replace(/\d+$/,'');if(!columns.has(k))columns.set(k,[]);columns.get(k).push(c);}
 for(const [col,list] of columns){
  list.sort((a,b)=>rowOf(a.cell)-rowOf(b.cell));let group=[];
  const flush=()=>{if(group.length){sheet.getRange(col+rowOf(group[0].cell)+':'+col+rowOf(group.at(-1).cell)).formulas=group.map(c=>['='+c.formula]);group=[];}};
  for(const c of list){if(group.length&&rowOf(c.cell)!==rowOf(group.at(-1).cell)+1)flush();group.push(c);}flush();
 }
}
const regions=[
 {market:'MY',sheet:'马来（跨境）老店+新店',original:'N',half:'T',floor:'P',log:'Z',cols:['D','E'],width:43,scale:100,trial:['Q','R']},
 {market:'SG',sheet:'新加坡（跨境）',original:'N',half:'T',floor:'P',log:'Z',cols:['M','N'],width:42,scale:100,trial:['Q','R']},
 {market:'VN',sheet:'越南（跨境）',original:'M',half:'S',floor:'O',log:'Y',cols:['J','K'],width:41,scale:1,trial:['P','Q']}
];
const all=[];
for(const cfg of regions){
 const {market,sheet:sn}=cfg;
 const source=extract.sheets.find(s=>s.name===sn);
 const visible=visibility.sheets[sn].visible_product_rows;
 const visibleRows=new Set(visible.map(r=>r.row));
 const selected=source.cells.filter(c=>rowOf(c.cell)<=4||visibleRows.has(rowOf(c.cell)));
 const logistics=extract.sheets.find(s=>s.name===logisticsName).cells.filter(c=>cfg.cols.includes(c.cell.replace(/\d+$/,'')));
 const wb=Workbook.create(),s=wb.worksheets.add(sn),rates=wb.worksheets.add(logisticsName);
 populate(rates,logistics,Math.max(...logistics.map(c=>rowOf(c.cell))),Math.max(...logistics.map(c=>colOf(c.cell))));
 populate(s,selected,Math.max(...visibleRows),cfg.width);
 const items=market==='MY'?[]:JSON.parse(await fs.readFile(path.join(prior,market.toLowerCase()+'-price-plan.json'),'utf8'));
 const fallbackRows=new Map();let nextRow=Math.max(300,Math.max(...visibleRows)+1);
 const makeRow=(key,cost,handling,grams)=>{
  if(fallbackRows.has(key))return fallbackRows.get(key);
  const row=nextRow++;fallbackRows.set(key,row);
  s.getRangeByIndexes(row-1,0,1,cfg.width).copyFrom(s.getRangeByIndexes(4,0,1,cfg.width),'all');
  s.getRange('D'+row).values=[[cost]];
  s.getRange('F'+row+':G'+row).values=[[handling,grams]];
  s.getRange(cfg.trial[0]+row+':'+cfg.trial[1]+row).values=[[null,null]];
  return row;
 };
 for(const i of items.filter(i=>i.status==='mapped'&&i.source_market!==market))makeRow(i.source_market+':'+i.source_row,i.input_cost_cny,i.input_handling_cny,i.input_gross_grams);
 const pilotRow=makeRow('M3080',8.84,1.5,200);
 const values=s.getRangeByIndexes(0,0,nextRow,cfg.width).values;
 const n=a=>{const v=values[rowOf(a)-1][colOf(a)-1];if(typeof v!=='number'||!Number.isFinite(v))throw Error(market+' '+a+': '+v);return v;};
 const checks=[];
 for(const row of visibleRows)for(const col of [cfg.original,cfg.half,cfg.floor,cfg.log]){
  const addr=col+row,c=selected.find(c=>c.cell===addr);if(!c?.formula)continue;
  const expected=decode(c),actual=n(addr),tol=Math.max(1e-7,Math.abs(expected)*1e-10);
  const match=typeof expected==='number'&&Math.abs(actual-expected)<=tol;
  checks.push({cell:addr,expected,actual,match});if(!match)throw Error('Source cache mismatch '+market+' '+JSON.stringify(checks.at(-1)));
 }
 const prices=row=>{
  const original=n(cfg.original+row),half=n(cfg.half+row),floor=n(cfg.floor+row);
  if(!(original>0&&half>0&&floor>0&&floor<=half&&Math.abs(original/2-half)<Math.max(1e-7,half*1e-10)))throw Error('Unexpected price relationship '+market+':'+row);
  const floorRounded=Math.ceil(floor*cfg.scale-1e-9)/cfg.scale;
  if(floorRounded+1e-8<floor)throw Error('Floor rounded down');
  return {formula_row:row,raw_original:original,raw_half:half,raw_affiliate_8pct_floor:floor,minimum_price:floorRounded,original_cell:cfg.original+row,half_cell:cfg.half+row,floor_cell:cfg.floor+row,floor_formula:s.getRange(cfg.floor+row).formulas[0][0],logistics_price:n(cfg.log+row)};
 };
 const rows=visible.map(r=>({source_sheet:sn,source_row:r.row,source_name:r.C,product_id:r.A,input_cost_cny:Number(r.D),input_handling_cny:Number(r.F),input_gross_grams:Number(r.G),...prices(r.row)}));
 const skuFloors=items.map(i=>{
  if(i.status==='mapped'){
   const row=i.source_market===market?i.source_row:fallbackRows.get(i.source_market+':'+i.source_row);
   const p=prices(row);
   if(Math.abs(p.raw_original-i.raw_original)>Math.max(1e-7,p.raw_original*1e-10))throw Error('Prior original mismatch '+i.sku_id);
   return {...i,...p,standard_price:i.target_price/2,commission_8pct_verified:false,ready_for_enrollment:false};
  }
  if(i.status==='pilot_verified_keep')return {...i,...prices(pilotRow),standard_price:i.target_price/2,commission_8pct_verified:false,ready_for_enrollment:false};
  return {...i,ready_for_enrollment:false};
 });
 const evidence={market,source_sha256:checkpoint.source_sha256,source_sheet:sn,method:'artifact_tool_actual_formulas_no_cache_seed',read_only_analysis:true,source_modified:false,current_platform_fees_verified:false,commission_8pct_verified:false,visible_source_checks:checks,visible_rows:rows,sku_floors:skuFloors,pilot:prices(pilotRow)};
 await fs.writeFile(path.join(out,market.toLowerCase()+'-price-floors.json'),JSON.stringify(evidence,null,2));
 all.push({market,visible_rows:rows.length,checks:checks.length,sku_count:skuFloors.length,pilot:evidence.pilot});
 console.log(JSON.stringify(all.at(-1)));
}
await fs.writeFile(path.join(out,'price-floor-calculation-summary.json'),JSON.stringify(all,null,2));
