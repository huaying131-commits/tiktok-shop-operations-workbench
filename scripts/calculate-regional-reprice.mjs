import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'outputs/reprice-sg-vn-2026-10-04');
const req=createRequire(path.join(root,'outputs/pricing-engine-2026-10-03/package.json'));
const {Workbook,SpreadsheetFile,FileBlob}=await import(pathToFileURL(req.resolve('@oai/artifact-tool')).href);
const extract=JSON.parse(await fs.readFile(path.join(out,'pricing-extracted.json'),'utf8'));
const visibility=JSON.parse(await fs.readFile(path.join(out,'pricing-visible-catalog.json'),'utf8'));
const logisticsName='物流价卡(更新时间1月27日）';
const rowOf=a=>Number(a.match(/\d+$/)[0]);
const colOf=a=>a.match(/^[A-Z]+/)[0].split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const decode=c=>c.value==null?null:['s','str','inlineStr','e'].includes(c.type)?c.value:c.type==='b'?c.value==='1':Number(c.value);
function populate(sheet,cells,height,width){
 const vals=Array.from({length:height},()=>Array(width).fill(null));
 for(const c of cells) if(!c.formula)vals[rowOf(c.cell)-1][colOf(c.cell)-1]=decode(c);
 sheet.getRangeByIndexes(0,0,height,width).values=vals;
 // Load consecutive column runs together; cell-by-cell remote assignments are costly.
 const columns=new Map();
 for(const c of cells)if(c.formula){const k=c.cell.replace(/\d+$/,'');if(!columns.has(k))columns.set(k,[]);columns.get(k).push(c);}
 for(const [col,list] of columns){
  list.sort((a,b)=>rowOf(a.cell)-rowOf(b.cell));let group=[];
  const flush=()=>{if(group.length){sheet.getRange(col+rowOf(group[0].cell)+':'+col+rowOf(group.at(-1).cell)).formulas=group.map(c=>['='+c.formula]);group=[];}};
  for(const c of list){if(group.length&&rowOf(c.cell)!==rowOf(group.at(-1).cell)+1)flush();group.push(c);}flush();
 }
}
function numeric(s,a){const v=s.getRange(a).values[0][0];if(typeof v!=='number'||!Number.isFinite(v))throw Error(`${a}: ${v}`);return v;}
const outputEvidence=[];
for(const m of ['SG','VN']){
 const sn=m==='SG'?'新加坡（跨境）':'越南（跨境）';
 const priceCol=m==='SG'?'N':'M',targetCol=m==='SG'?'T':'S',logCol=m==='SG'?'Z':'Y',width=m==='SG'?42:41;
 const source=extract.sheets.find(s=>s.name===sn);
 const visibleRows=new Set(visibility.sheets[sn].visible_product_rows.map(r=>r.row));
 const selected=source.cells.filter(c=>rowOf(c.cell)<=4||visibleRows.has(rowOf(c.cell)));
 const logistics=extract.sheets.find(s=>s.name===logisticsName).cells.filter(c=>(m==='SG'?['M','N']:['J','K']).includes(c.cell.replace(/\d+$/,'')));
 const wb=Workbook.create(),s=wb.worksheets.add(sn),rates=wb.worksheets.add(logisticsName);
 populate(rates,logistics,Math.max(...logistics.map(c=>rowOf(c.cell))),Math.max(...logistics.map(c=>colOf(c.cell))));
 console.log(JSON.stringify({market:m,stage:'logistics_loaded'}));
 populate(s,selected,Math.max(...visibleRows),width);
 console.log(JSON.stringify({market:m,stage:'visible_formulas_loaded'}));
 const items=JSON.parse(await fs.readFile(path.join(out,m.toLowerCase()+'-mapping.json'),'utf8'));
 const fallbackRows=new Map();let nextFallback=300;
 for(const i of items.filter(i=>i.status==='mapped'&&i.source_market!==m)){
  const key=[i.source_market,i.source_row].join(':');if(fallbackRows.has(key))continue;
  const row=nextFallback++;fallbackRows.set(key,row);
  s.getRangeByIndexes(row-1,0,1,width).copyFrom(s.getRangeByIndexes(4,0,1,width),'all');
  s.getRange('D'+row).values=[[i.input_cost_cny]];
  s.getRange('F'+row+':G'+row).values=[[i.input_handling_cny,i.input_gross_grams]];
  s.getRange((m==='SG'?'Q':'P')+row+':'+(m==='SG'?'R':'Q')+row).values=[[null,null]];
 }
 const calculated=s.getRangeByIndexes(0,0,nextFallback,width).values;
 const n=a=>{const v=calculated[rowOf(a)-1][colOf(a)-1];if(typeof v!=='number'||!Number.isFinite(v))throw Error(`${m} ${a}: ${v}`);return v;};
 console.log(JSON.stringify({market:m,stage:'calculated_once',fallback_rows:fallbackRows.size}));
 // Verify every visible source original/half-price against the untouched workbook cache.
 const checks=[];
 for(const row of visibleRows){
  for(const col of [priceCol,targetCol,logCol]){
   const addr=col+row,c=selected.find(c=>c.cell===addr);if(!c?.formula)continue;
   const expected=decode(c),actual=n(addr),tol=Math.max(1e-7,Math.abs(expected)*1e-10);
   const match=Math.abs(actual-expected)<=tol;
   checks.push({cell:addr,expected,actual,match});
   if(!match)throw Error(`Visible source cache mismatch ${m} ${JSON.stringify(checks.at(-1))}`);
  }
 }
 const cache=new Map();
 for(const item of items){
  if(item.status!=='mapped'){item.target_price=Number(item.price);continue;}
  const key=[item.source_market,item.source_row].join(':');
  if(!cache.has(key)){
   let row=item.source_row;
   if(item.source_market!==m){
    row=fallbackRows.get(key);
   }
   const original=n(priceCol+row),half=n(targetCol+row),logisticsPrice=n(logCol+row);
   if(Math.abs(original/2-half)>Math.max(1e-8,half*1e-10))throw Error(`Not a 50% row ${m} ${key}`);
   // Same upward even-minor-unit convention used for the successful M3080 pilot.
   const rounded=m==='SG'?Math.ceil(original*50-1e-10)/50:Math.ceil(original/2-1e-10)*2;
   if(rounded<original-1e-8||rounded/2<half-1e-8)throw Error('Rounding undercuts source');
   cache.set(key,{raw_original:original,raw_half:half,target_price:rounded,target_half:rounded/2,
                 formula_row:row,formula_sheet:sn,logistics_price:logisticsPrice,formula:s.getRange(priceCol+row).formulas[0][0],
                 rounding:m==='SG'?'upward to even cents':'upward to even whole VND'});
  }
  Object.assign(item,cache.get(key));
  item.change=Math.abs(item.target_price-Number(item.price))>(m==='SG'?0.00001:0.1);
 }
 await fs.writeFile(path.join(out,m.toLowerCase()+'-price-plan.json'),JSON.stringify(items,null,2));
 console.log(JSON.stringify({market:m,stage:'price_plan_saved'}));
 const input=await SpreadsheetFile.importXlsx(await FileBlob.load(path.join(out,m+'-sales-working.xlsx')));
 console.log(JSON.stringify({market:m,stage:'bounded_template_imported'}));
 const t=input.worksheets.getItem('Template');
 const imported=t.getRange('A6:G'+items.at(-1).excel_row).values;
 // Exported platform sheet dimensions say five rows, but actual row IDs must survive import.
 for(const i of items){
  const a=imported[i.excel_row-6];
  if(a[0]!==i.product_id||a[3]!==i.sku_id||String(a[5])!==i.price)throw Error(`Template import identity/price mismatch ${m} row${i.excel_row}: ${JSON.stringify(a)}`);
 }
 const before=await input.render({sheetName:'Template',range:'D3:G12',scale:1,format:'png'});
 console.log(JSON.stringify({market:m,stage:'before_preview_rendered'}));
 await fs.writeFile(path.join(out,m+'-template-before.png'),new Uint8Array(await before.arrayBuffer()));
 // Only price column F is authored; no formulas, stock, seller SKU, or other fields are written.
 t.getRange('F6:F'+items.at(-1).excel_row).values=items.map(i=>[i.target_price]);
 const check=await input.inspect({kind:'table',range:"'Template'!D6:G12",include:'values',tableMaxRows:7,tableMaxCols:4,maxChars:3000});
 await fs.writeFile(path.join(out,m+'-template-check.ndjson'),check.ndjson);
 const preview=await input.render({sheetName:'Template',range:'D3:G12',scale:1,format:'png'});
 await fs.writeFile(path.join(out,m+'-template-after.png'),new Uint8Array(await preview.arrayBuffer()));
 await (await SpreadsheetFile.exportXlsx(input)).save(path.join(out,m+'-sales-artifact.xlsx'));
 const evidence={market:m,source_sha256:visibility.sha256,visible_rows_verified:visibleRows.size,checks,
  sku_count:items.length,mapped:items.filter(i=>i.status==='mapped').length,changed:items.filter(i=>i.change).length,
  pending:items.filter(i=>i.status==='needs_input').length,calculation:'artifact_tool_actual_formulas_no_cache_seed',
  source_workbook_modified:false,website_modified:false};
 outputEvidence.push(evidence);
 console.log(JSON.stringify({...evidence,checks:checks.length}));
}
await fs.writeFile(path.join(out,'calculation-verification.json'),JSON.stringify(outputEvidence,null,2));
