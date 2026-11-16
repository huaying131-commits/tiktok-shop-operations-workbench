import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await fs.readFile(path.join(root, 'pricing/price-registry.json'), 'utf8'));
const outputDir = path.join(root, 'outputs/pricing-ledger');
await fs.mkdir(outputDir, { recursive: true });
const records = registry.confirmed_records;
const matches = registry.shop_matches;
if (new Set(records.map(r => r.price_id)).size !== records.length) throw Error('Duplicate cost version ID');
const recordById = new Map(records.map(r => [r.price_id, r]));
const wb = Workbook.create();
const price = wb.worksheets.add('核价台账');
const sku = wb.worksheets.add('店铺规格');
const first = 8, end = first + records.length - 1, skuEnd = first + matches.length - 1;
const day = s => new Date(`${s}T00:00:00Z`);
const headerStyle = { fill: '#243E58', font: { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true };

for (const [sh, last, lastCol] of [[price,end,'M'],[sku,skuEnd,'L']]) {
  sh.showGridLines = false;
  sh.getRange(`A1:${lastCol}${last}`).format = { font: { name: 'Arial', size: 10, color: '#243746' }, rowHeight: 23, verticalAlignment: 'center', wrapText: false };
  sh.getRange('A2').format.font = { name: 'Arial', size: 14, bold: true, color: '#243E58' };
  sh.getRange(`A2:${lastCol}2`).format.borders = { bottom: { style: 'thin', color: '#A6B5C3' } };
  sh.getRange(`A7:${lastCol}7`).format = headerStyle;
  sh.getRange(`A7:${lastCol}7`).format.rowHeight = 34;
  sh.freezePanes.freezeRows(7);
  sh.freezePanes.freezeColumns(sh === price ? 3 : 2);
}
price.tabColor = '#243E58';
sku.tabColor = '#73899E';
price.getRange('A2').values = [['运营核价台账']];
price.getRange('A3').values = [[`已核准 ${records.length} 条成本版本 · ${matches.length} 条店铺规格对应关系 · MY / SG / VN`]];
price.getRange('A4').values = [['跨境1减价']]; price.getRange('B4').values = [[registry.discount_points['跨境1']/100]];
price.getRange('D4').values = [['跨境10减价']]; price.getRange('E4').values = [[registry.discount_points['跨境10']/100]];
for (const cell of ['B4','E4']) {
  price.getRange(cell).setNumberFormat('0%');
  price.getRange(cell).format = { fill: '#FFF1C7', font: { name: 'Arial', size: 10, color: '#243746' }, horizontalAlignment: 'right' };
  price.getRange(cell).dataValidation = { rule: { type: 'decimal', operator: 'between', formula1: 0, formula2: 1 } };
}
price.getRange('G4').values = [['成本变更后，按原表公式重新核价再更新；折扣比例可直接调整。']];
price.getRange('A5').values = [['原价：原表半价向上取整后 × 2。MY / SG 到分，VN 到整数盾。']];
price.getRange('A6').values = [['依据：用户跨境算价表及逐项确认；未重新查询平台费率。']];
price.getRange('A5:M6').format.font = { name: 'Arial', size: 10, italic: true, color: '#657687' };
price.getRange(`A7:M${end}`).values = [
  ['核价ID','国家 / 币种','商品 / 成本版本','采购成本\nCNY','摊销\nCNY','毛重\ng','共同原价\n当地币','跨境1折后价\n当地币','跨境10折后价\n当地币','达人8%保本价\n当地币','51%价格核对','核价依据','确认日期'],
  ...records.map(r => [r.price_id,`${r.market} · ${r.currency}`,r.name,r.cost_cny,r.handling_cny,r.gross_grams,r.original,null,null,r.minimum_8pct,null,r.user_confirmed_override ? '用户确认；MY表第7行重算' : `${r.source_market}表 · ${r.source_row === 'M3080' ? 'M3080商品资料' : `第${r.source_row}行`}`,day(r.confirmed_date)])
];
const formulas = row => [
  `=ROUND(G${row}*(1-$B$4),IF(LEFT(B${row},2)="VN",0,2))`,
  `=ROUND(G${row}*(1-$E$4),IF(LEFT(B${row},2)="VN",0,2))`
];
price.getRange(`H${first}:I${end}`).formulas = records.map((_,i) => formulas(first+i));
price.getRange(`K${first}:K${end}`).formulas = records.map((_,i) => [`=IF(I${first+i}>=J${first+i},"≥8%档","低于8%档")`]);
price.getRange(`D${first}:E${end}`).setNumberFormat('0.00');
price.getRange(`F${first}:F${end}`).setNumberFormat('#,##0');
price.getRange(`G${first}:J${end}`).setNumberFormat('#,##0.00');
price.getRange(`M${first}:M${end}`).setNumberFormat('yyyy-mm-dd');
price.getRange(`D${first}:J${end}`).format.horizontalAlignment = 'right';
price.getRange(`K${first}:K${end}`).conditionalFormats.addCustom(`$I${first}<$J${first}`, { fill: '#FCE4E4', font: { color: '#9C2632', bold: true } });
price.getRange(`H${first}:I${end}`).format.fill = '#F0F5F9';
price.getRange(`A${first}:A${end}`).setNumberFormat('@');
for (const [col,width] of Object.entries({A:21,B:15,C:36,D:14,E:12,F:12,G:16,H:18,I:18,J:19,K:17,L:31,M:18})) price.getRange(`${col}1:${col}${end}`).format.columnWidth = width;
for (let i=0;i<records.length;i++) if (records[i].market === 'VN') price.getRange(`G${first+i}:J${first+i}`).setNumberFormat('#,##0');
price.tables.add(`A7:M${end}`, true, 'ConfirmedPriceTable');

sku.getRange('A2').values = [['店铺规格与后台回读']];
sku.getRange('A3').values = [['同一核价ID共用原价；商品ID、SKU ID按文本保存。']];
sku.getRange('A4').values = [['跨境1 SG 回读日期为2026-10-04；其余当前记录为2026-10-08。']];
sku.getRange('A5').values = [['跨境10 SG 暂停商品尚未写入；成本未确认和已删除规格不计入台账。']];
sku.getRange('A6').values = [['回读一致仅表示对应日期的原价一致；清仓活动例外另列备注。']];
sku.getRange('A4:L6').format.font = { name: 'Arial', size: 10, italic: true, color: '#657687' };
sku.getRange(`A7:L${skuEnd}`).values = [
  ['店铺','国家','商品ID','SKU ID','规格','商家SKU','核价ID','目标原价\n当地币','后台回读原价\n当地币','原价对照','回读日期','备注'],
  ...matches.map(m => [m.shop,m.market,m.product_id,m.sku_id,m.variant,m.seller_sku,m.price_id,null,m.observed_original,null,day(m.observed_date),m.note])
];
const lookup = row => `=INDEX('核价台账'!$G$${first}:$G$${end+1},MATCH(G${row},'核价台账'!$A$${first}:$A$${end+1},0))`;
sku.getRange(`H${first}:H${skuEnd}`).formulas = matches.map((_,i) => [lookup(first+i)]);
sku.getRange(`J${first}:J${skuEnd}`).formulas = matches.map((_,i) => [`=IF(ABS(H${first+i}-I${first+i})<0.000001,"回读一致","待同步")`]);
sku.getRange(`C${first}:G${skuEnd}`).setNumberFormat('@');
sku.getRange(`H${first}:I${skuEnd}`).setNumberFormat('#,##0.00');
sku.getRange(`K${first}:K${skuEnd}`).setNumberFormat('yyyy-mm-dd');
sku.getRange(`H${first}:I${skuEnd}`).format.horizontalAlignment = 'right';
sku.getRange(`H${first}:H${skuEnd}`).format.fill = '#F0F5F9';
sku.getRange(`J${first}:J${skuEnd}`).conditionalFormats.addCustom(`ABS($H${first}-$I${first})>=0.000001`, { fill: '#FCE4E4', font: { color: '#9C2632', bold: true } });
for (const [col,width] of Object.entries({A:12,B:9,C:28,D:28,E:43,F:37,G:21,H:18,I:20,J:15,K:18,L:54})) sku.getRange(`${col}1:${col}${skuEnd}`).format.columnWidth = width;
for (let i=0;i<matches.length;i++) if (matches[i].market === 'VN') sku.getRange(`H${first+i}:I${first+i}`).setNumberFormat('#,##0');
sku.tables.add(`A7:L${skuEnd}`, true, 'ShopSkuBindingsTable');

// Check an actual input, its two discount outputs and an ID-based shop lookup.
const firstMatch = matches.findIndex(m => m.price_id === records[0].price_id);
price.getRange(`G${first}`).values = [[39.66]];
if (Math.abs(Number(price.getRange(`H${first}`).values[0][0])-19.83)>1e-6 || Math.abs(Number(price.getRange(`I${first}`).values[0][0])-19.43)>1e-6 || Number(sku.getRange(`H${first+firstMatch}`).values[0][0])!==39.66) throw Error('Discount/lookup input recalculation failed');
price.getRange(`G${first}`).values = [[records[0].original]];
// Test the next appended cost version and an exact lookup, then remove the trial.
const next=end+1, nextSku=skuEnd+1;
price.getRange(`A${next}:J${next}`).values = [['TRIAL-NEXT-ID','MY · MYR','Temporary next-record validation',8.2,2,130,37.66,null,null,16.28]];
price.getRange(`H${next}:I${next}`).formulas=[formulas(next)];
sku.getRange(`G${nextSku}`).values=[['TRIAL-NEXT-ID']];
sku.getRange(`H${nextSku}`).formulas=[[lookup(nextSku)]];
if (Number(sku.getRange(`H${nextSku}`).values[0][0])!==37.66 || Math.abs(Number(price.getRange(`I${next}`).values[0][0])-18.45)>1e-6) throw Error('Next cost record lookup failed');
sku.getRange(`G${nextSku}`).values=[['UNKNOWN-KEY-TRIAL']];
if (!String(sku.getRange(`H${nextSku}`).values[0][0]).startsWith('#')) throw Error('Missing key must expose an error');
price.getRange(`A${next}:M${next}`).clear({applyTo:'all'});
sku.getRange(`A${nextSku}:L${nextSku}`).clear({applyTo:'all'});
wb.recalculate();

const evaluated = price.getRange(`H${first}:K${end}`).values;
const priceRound=(amount,discount,market) => {
  const scale=market==='VN'?1:100;
  return Math.round(Math.round(amount*scale)*(100-discount)/100)/scale;
};
for (let i=0;i<records.length;i++) {
  const r=records[i], v=evaluated[i];
  if (Math.abs(Number(v[0])-priceRound(r.original,registry.discount_points['跨境1'],r.market))>1e-6 || Math.abs(Number(v[1])-priceRound(r.original,registry.discount_points['跨境10'],r.market))>1e-6 || Number(v[2])!==r.minimum_8pct || String(v[3])!==(Number(v[1])>=r.minimum_8pct?'≥8%档':'低于8%档')) throw Error(`Cost record formula mismatch: ${r.price_id}`);
}
const skuValues=sku.getRange(`H${first}:J${skuEnd}`).values;
for (let i=0;i<matches.length;i++) {
  const m=matches[i], v=skuValues[i];
  if (Number(v[0])!==recordById.get(m.price_id).original || Number(v[1])!==m.observed_original || v[2] !== (Math.abs(m.target_original-m.observed_original)<1e-6?'回读一致':'待同步')) throw Error(`Shop binding mismatch: ${m.shop}/${m.market}/${m.sku_id}`);
}
const inspections=[];
for (const range of ['核价台账!A2:M10',`核价台账!G${end-1}:M${end}`,'店铺规格!G8:L10',`店铺规格!G${skuEnd-1}:L${skuEnd}`]) {
  const check=await wb.inspect({kind:'table',range,include:'values,formulas',tableMaxRows:9,tableMaxCols:13,maxChars:2500});
  inspections.push({range,result:check.ndjson});
}
const errorScan=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},maxChars:1800,summary:'Final price ledger formula error scan'});
await fs.writeFile(path.join(outputDir,'formula-inspection.json'),JSON.stringify({inspections,errors:errorScan.ndjson},null,2));
for (const [sheetName,range,file] of [
  ['核价台账','A1:M14','price-ledger-preview.png'],
  ['店铺规格','A1:H13','sku-bindings-preview.png'],
  ['店铺规格','H7:L13','sku-verification-preview.png']
]) {
  const png=await wb.render({sheetName,range,scale:1,format:'png'});
  await fs.writeFile(path.join(outputDir,file),new Uint8Array(await png.arrayBuffer()));
}
const target=path.join(outputDir,'运营核价台账.xlsx');
try { await fs.copyFile(target,path.join(outputDir,`运营核价台账-${new Date().toISOString().replace(/[:.]/g,'-')}.bak.xlsx`)); } catch(e) { if(e.code!=='ENOENT')throw e; }
await (await SpreadsheetFile.exportXlsx(wb)).save(target);
const proof={created_at:new Date().toISOString(),file:target,cost_records:records.length,shop_sku_bindings:matches.length,
  original_source_unchanged:registry.source_workbook_changed===false,cost_record_formulas_verified:records.length,sku_id_lookups_verified:matches.length,
  discount_input_recalculation_verified:true,next_record_lookup_verified:true,missing_key_exposes_error:true,
  historical_observations_dated:true,previews_rendered:3,source_formula_recalculation_in_ledger:false,
  scope:'Costs and canonical originals are confirmed records. Discount formulas and exact ID lookups are live; cost changes require original workbook formula recalculation.'};
await fs.writeFile(path.join(outputDir,'verification.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof));
