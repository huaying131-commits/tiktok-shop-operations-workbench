import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Regional single-SKU calculation. Does not alter the MY workbook or its builder.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectDir, 'outputs', 'flower-pilot-2026-10-03', 'M3080', 'pricing');
const snapshotPath = path.join(outputRoot, 'sg-vn-source-extract.json');
const requireRuntime = createRequire(path.join(projectDir, 'outputs', 'pricing-engine-2026-10-03', 'package.json'));
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(requireRuntime.resolve('@oai/artifact-tool')).href);
const logisticsSheetName = '物流价卡(更新时间1月27日）';
const sourceUrl = 'https://en.yiwugo.com/product/detail/985676896.html';
const regions = [
  {code:'SG', sheet:'新加坡（跨境）', currency:'SGD', nameCell:'B5', original:'N5', target:'T5', equalTarget:'V5', discount:'L5', trial:'R5', oldPrice:'Q5', logistics:'Z5', logisticsColumns:['M','N'], logisticsExpected:3.38, ratioError:'AN5', maxColumns:42, roundingScale:50, unitDecimals:2},
  {code:'VN', sheet:'越南（跨境）', currency:'VND', nameCell:'C5', original:'M5', target:'S5', equalTarget:'U5', discount:'K5', trial:'Q5', oldPrice:'P5', logistics:'Y5', logisticsColumns:['J','K'], logisticsExpected:28000, ratioError:'AM5', maxColumns:41, roundingScale:0.5, unitDecimals:0},
];
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function coordinates(address) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address);
  return {row:Number(digits), column:[...letters].reduce((sum,char)=>sum*26+char.charCodeAt(0)-64,0)};
}
function decode(cell) {
  if (cell.value == null) return null;
  if (['s','str','inlineStr','e'].includes(cell.type)) return cell.value;
  if (cell.type === 'b') return cell.value === '1';
  const n = Number(cell.value);
  if (!Number.isFinite(n)) throw new Error(`Unsupported cell ${cell.cell}`);
  return n;
}
function populate(sheet, cells, rows, columns) {
  const values = Array.from({length:rows},()=>Array(columns).fill(null));
  for (const cell of cells) {
    const {row,column} = coordinates(cell.cell);
    if (!cell.formula) values[row-1][column-1] = decode(cell);
  }
  sheet.getRangeByIndexes(0,0,rows,columns).values = values;
  for (const cell of cells.filter(cell=>cell.formula)) sheet.getRange(cell.cell).formulas = [[`=${cell.formula}`]];
}
function numeric(sheet,address) {
  const n=sheet.getRange(address).values[0][0];
  if(typeof n!=='number'||!Number.isFinite(n)) throw new Error(`Non-numeric ${address}: ${n}`);
  return n;
}
const snapshot = JSON.parse(await fs.readFile(snapshotPath,'utf8'));
const hashBefore = await sha256(snapshot.source);
if (hashBefore !== snapshot.source_sha256) throw new Error('Source no longer matches the regional extraction.');
const allLogistics = snapshot.sheets.find(sheet=>sheet.name===logisticsSheetName);

for (const region of regions) {
  const outputDir = path.join(outputRoot,region.code);
  const source = snapshot.sheets.find(sheet=>sheet.name===region.sheet);
  const logisticsCells = allLogistics.cells.filter(cell=>region.logisticsColumns.includes(cell.cell.replace(/\d+$/,'')));
  const logisticsRows = Math.max(...logisticsCells.map(cell=>coordinates(cell.cell).row));
  const logisticsWidth = Math.max(...logisticsCells.map(cell=>coordinates(cell.cell).column));
  const workbook=Workbook.create();
  const overview=workbook.worksheets.add(`M3080-${region.code}算价`);
  const product=workbook.worksheets.add(region.sheet);
  const rates=workbook.worksheets.add(logisticsSheetName);
  populate(rates,logisticsCells,logisticsRows,logisticsWidth);
  populate(product,source.cells,5,region.maxColumns);
  const comparisons=source.cells.filter(cell=>cell.formula).map(cell=>{
    const expected=decode(cell), actual=product.getRange(cell.cell).values[0][0];
    const tolerance=typeof expected==='number'?Math.max(1e-9,Math.abs(expected)*1e-12):null;
    const match=typeof expected==='number'?typeof actual==='number'&&Math.abs(actual-expected)<=tolerance
      :expected===actual||((expected===null||expected==='')&&(actual===null||actual===''));
    return {cell:cell.cell,source_cached:expected,engine:actual,tolerance,match};
  });
  if(comparisons.some(item=>!item.match)) throw new Error(`${region.code} sample mismatch: ${JSON.stringify(comparisons.filter(item=>!item.match))}`);
  // Use each country's exact input columns: VN R5 is an output formula, not an input.
  product.getRange('A5:C5').values=[[null,null,null]];
  product.getRange(region.nameCell).values=[['M3080 粉瑰梦境（155颗粒，彩盒装）']];
  product.getRange('D5').values=[[8.84]];
  product.getRange('F5').values=[[1.5]];
  product.getRange('G5').values=[[200]];
  product.getRange(region.trial).values=[[null]];
  product.getRange(region.oldPrice).values=[[null]];
  const rawOriginal=numeric(product,region.original), rawTarget=numeric(product,region.target);
  const rawDiscount=numeric(product,region.discount), logistics=numeric(product,region.logistics);
  const originalPrice=Math.ceil(rawOriginal*region.roundingScale)/region.roundingScale;
  const promotionPrice=originalPrice/2;
  if(logistics!==region.logisticsExpected||rawDiscount!==0.5||numeric(product,region.equalTarget)!==rawTarget
    ||originalPrice<rawOriginal||promotionPrice<rawTarget
    ||Math.abs(promotionPrice*10**region.unitDecimals-Math.round(promotionPrice*10**region.unitDecimals))>1e-9) {
    throw new Error(`${region.code}: logistics/discount/rounding validation failed.`);
  }
  console.log(JSON.stringify({stage:'calculated',market:region.code,currency:region.currency,rawOriginal,rawTarget,rawDiscount,logistics,originalPrice,promotionPrice}));

  const ratioNote=`${region.trial}空白，${region.ratioError}沿用原公式的除零结果；核心定价结果有效。`;
  const roundingNote=region.code==='SG'?'原价向上取至偶数分，50%参考价精确到分。':'原价向上取至偶数整数盾，50%参考价为整数盾。';
  overview.getRange('A1:C1').merge();
  overview.getRange('A1').values=[[`M3080 ${region.code==='SG'?'新加坡':'越南'}跨境算价`]];
  overview.getRange('A2:C2').merge();
  overview.getRange('A2').values=[['粉瑰梦境155颗粒 彩盒装；2026-10-03；单款独立计算']];
  overview.getRange('A4:C12').values=[
    ['成本输入','数值','单位与依据'],
    ['商品采购报价',3.84,'CNY/盒；义乌购M3080彩盒装公开报价，未含国内运费。'],
    ['国内采购运费',5,'CNY/盒；用户授权估算，未取得商家确认报价。'],
    ['D：采购价＋国内运费',null,'CNY/盒；3.84＋5.00。E列保留原公式D×1.03。'],
    ['F：货代打包送TKL',1.5,'CNY/件；沿用用户确认设置。'],
    ['G：最终含包装毛重',200,'克/件；用户授权估算，已含包装，不再加30–50克。'],
    [`${region.trial}：试算输入`,'空白','保留该国原样例的空白试算输入。'],
    ['表内汇率参数A2',null,`CNY/${region.currency}；原表参数，不是本次更新的市场汇率。`],
    [`${region.logistics}：跨境物流`,null,`${region.currency}/件；200克，按该国原物流价卡查询。`],
  ];
  overview.getRange('A14:C17').values=[
    ['原公式结果',region.currency+' / 折扣','依据'],
    [`${region.original}：原价`,null,`原公式：${source.cells.find(cell=>cell.cell===region.original).formula}`],
    [`${region.target}：五折目标价`,null,`该国原表保本公式；${region.equalTarget}为同值参照。`],
    [`${region.discount}：对应折扣`,null,'保留该国原折扣公式，50%。'],
  ];
  overview.getRange('A19:C22').values=[
    ['本次取整建议',region.currency+' / 折扣','执行依据'],
    ['建议上架原价',null,roundingNote],
    ['50%活动参考价',null,'等于建议原价的50%，且不低于原表五折目标价。'],
    ['参考折扣',null,'精确50%；本表只计算价格，不创建或启用活动。'],
  ];
  overview.getRange('A24:C30').values=[
    ['来源与边界','来源','说明'],
    ['采购报价','义乌购 欧森百货',sourceUrl],
    ['定价模板','【东南亚】玩具类目成本测算表 .xlsx',`${region.sheet}；第5行及原顶部参数；保留物流${region.logisticsColumns.join(':')}列。`],
    ['计算方式','公式引擎实际重算','@oai/artifact-tool；先通过该国原样例对照，再代入M3080。未用微软Excel重算。'],
    ['取整依据','本次执行策略','保留原价与五折的精确关系，并使参考价不低于原公式目标；未将此策略当作TikTok平台精度规则。'],
    ['待核实项','运费、毛重、平台录入精度','运费5元、毛重200克为授权估算；费率与价卡沿用原表，实际后台校验由上架流程完成。'],
    ['保留原表行为',region.ratioError,ratioNote],
  ];
  for(const [dest,src] of [['B7','D5'],['B11','A2'],['B12',region.logistics],['B15',region.original],['B16',region.target],['B17',region.discount]]) {
    overview.getRange(dest).formulas=[[`='${region.sheet}'!${src}`]];
  }
  overview.getRange('B20').formulas=[[`=ROUNDUP(B15*${region.roundingScale},0)/${region.roundingScale}`]];
  overview.getRange('B21').formulas=[['=B20/2']];
  overview.getRange('B22').formulas=[['=1-B21/B20']];
  if(numeric(overview,'B20')!==originalPrice||numeric(overview,'B21')!==promotionPrice) throw new Error('Rounded summary does not match independent calculation.');
  overview.getRange('A1:C30').format.font={name:'Arial',size:11};
  overview.getRange('A1:C30').format.wrapText=true;
  overview.getRange('A1:C30').format.rowHeight=42;
  overview.getRange('A1:A30').format.columnWidth=30;
  overview.getRange('B1:B30').format.columnWidth=34;
  overview.getRange('C1:C30').format.columnWidth=100;
  overview.getRange('A1:C1').format.font={name:'Arial',size:18,bold:true,color:'#FFFFFF'};
  overview.getRange('A1:C1').format.fill='#174A58';
  for(const row of [4,14,19,24]) {
    overview.getRange(`A${row}:C${row}`).format.fill='#E8EDF2';
    overview.getRange(`A${row}:C${row}`).format.font={name:'Arial',size:11,bold:true};
  }
  overview.getRange('B5:B8').setNumberFormat('0.00');
  overview.getRange('B9').setNumberFormat('0');
  overview.getRange('B11').setNumberFormat('0.00000000');
  overview.getRange('B12').setNumberFormat(region.code==='VN'?'#,##0':'0.00');
  overview.getRange('B15:B16').setNumberFormat('#,##0.00000000');
  overview.getRange('B17').setNumberFormat('0.0%');
  overview.getRange('B20:B21').setNumberFormat(region.code==='VN'?'#,##0':'0.00');
  overview.getRange('B22').setNumberFormat('0.0%');
  overview.getRange('A20:C22').format.fill='#DDF1DD';
  for(const address of ['B6','B9']) overview.getRange(address).format.fill='#FFF1C2';
  overview.freezePanes.freezeRows(4);

  const lastColumn=region.code==='SG'?'AP':'AO';
  product.getRange(`A1:${lastColumn}5`).format.font={name:'Arial',size:11};
  product.getRange(`A1:${lastColumn}5`).format.columnWidth=17;
  const nameColumn=region.nameCell.replace(/\d+$/,'');
  product.getRange(`${nameColumn}1:${nameColumn}5`).format.columnWidth=42;
  product.getRange(`A1:${lastColumn}5`).format.wrapText=true;
  product.getRange(`A1:${lastColumn}1`).format.rowHeight=60;
  product.getRange(`A4:${lastColumn}4`).format.rowHeight=82;
  product.getRange(`A5:${lastColumn}5`).format.rowHeight=48;
  product.getRange(`A2:${lastColumn}2`).setNumberFormat('0.00000000');
  product.getRange('D5:F5').setNumberFormat('0.00');
  product.getRange('G5').setNumberFormat('0');
  product.getRange(`H5:${lastColumn}5`).setNumberFormat('#,##0.000000');
  product.getRange(region.code==='SG'?'J5:M5':'I5:L5').setNumberFormat('0.0%');
  if(region.code==='SG') {product.getRange('K4').setNumberFormat('0%');product.getRange('M4').setNumberFormat('0%');}
  product.getRange(`A4:${lastColumn}4`).format.fill='#E8EDF2';
  product.getRange(region.original).format.fill='#FFF1C2';
  product.getRange(region.target).format.fill='#DDF1DD';
  product.getRange(region.discount).format.fill='#DDF1DD';
  product.getRange('A7:N7').merge();
  product.getRange('A7').values=[[`M3080工作副本；成本D=8.84元，F=1.50元，最终毛重G=200克。${ratioNote}`]];
  product.getRange('A7:N7').format.font={name:'Arial',size:11};
  product.getRange('A7:N7').format.wrapText=true;
  product.getRange('A7:N7').format.rowHeight=36;
  product.freezePanes.freezeRows(4);
  const [lc,rc]=region.logisticsColumns;
  rates.getRange(`${lc}2:${rc}${logisticsRows}`).format.font={name:'Arial',size:11};
  rates.getRange(`${lc}2:${rc}${logisticsRows}`).format.columnWidth=20;
  rates.getRange(`${lc}2:${rc}3`).format.fill='#E8EDF2';
  rates.getRange(`${lc}4:${lc}${logisticsRows}`).setNumberFormat('0');
  rates.getRange(`${rc}4:${rc}${logisticsRows}`).setNumberFormat(region.code==='VN'?'#,##0':'0.00');
  rates.getRange(`${lc}23:${rc}23`).format.fill='#DDF1DD';
  rates.freezePanes.freezeRows(3);

  const formulasPreserved=source.cells.filter(cell=>cell.formula).every(cell=>product.getRange(cell.cell).formulas[0][0]===`=${cell.formula}`);
  const parametersPreserved=source.cells.filter(cell=>coordinates(cell.cell).row<=2&&!cell.formula).every(cell=>product.getRange(cell.cell).values[0][0]===decode(cell));
  const logisticsPreserved=logisticsCells.every(cell=>rates.getRange(cell.cell).values[0][0]===decode(cell));
  if(!formulasPreserved||!parametersPreserved||!logisticsPreserved) throw new Error(`${region.code} scope preservation failed.`);
  const inspection=await workbook.inspect({kind:'table',range:`'${overview.name}'!A4:C22`,include:'values,formulas',tableMaxRows:19,tableMaxCols:3,maxChars:10000});
  const errors=await workbook.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},maxChars:6000,summary:region.code+' formula errors'});
  for(const record of errors.ndjson.split('\n').filter(Boolean).map(line=>JSON.parse(line))) {
    if(record.kind==='match'&&(record.sheet!==region.sheet||record.address!==region.ratioError)) throw new Error(`${region.code}: unexpected formula error ${JSON.stringify(record)}`);
  }
  await fs.mkdir(outputDir,{recursive:true});
  await fs.writeFile(path.join(outputDir,'inspection.ndjson'),inspection.ndjson,'utf8');
  await fs.writeFile(path.join(outputDir,'formula-errors.ndjson'),errors.ndjson,'utf8');
  for(const [sheetName,range,filename] of [
    [overview.name,'A1:C30','pricing-overview.png'],
    [region.sheet,`${nameColumn}4:${region.code==='SG'?'N':'M'}5`,'original-inputs.png'],
    [region.sheet,`${region.code==='SG'?'N':'M'}4:W5`,'original-prices.png'],
    [logisticsSheetName,`${lc}2:${rc}23`,'logistics-200g.png'],
  ]) {
    const png=await workbook.render({sheetName,range,scale:1.4,format:'png'});
    await fs.writeFile(path.join(outputDir,filename),new Uint8Array(await png.arrayBuffer()));
  }
  const xlsxPath=path.join(outputDir,`M3080-${region.code}-pricing.xlsx`);
  await (await SpreadsheetFile.exportXlsx(workbook)).save(xlsxPath);
  const hashAfter=await sha256(snapshot.source);
  if(hashAfter!==hashBefore) throw new Error('Source changed during calculation.');
  const evidence={
    sku:'M3080',market:region.code,currency:region.currency,fulfillment:'cross_border',calculation_date:'2026-10-03',
    mode:'artifact_tool_formula_engine_actual_single_sku',engine:'@oai/artifact-tool',microsoft_excel_recalculated:false,formula_cache_seeded:false,
    source_workbook:snapshot.source,source_sha256:hashAfter,source_workbook_unchanged:true,source_sheet:region.sheet,source_row:5,source_snapshot:snapshotPath,
    mapping:{original_price:region.original,fifty_percent_target:region.target,equal_target:region.equalTarget,discount:region.discount,trial_input:region.trial,logistics:region.logistics,logistics_columns:region.logisticsColumns},
    original_formulas_preserved:formulasPreserved,parameters_preserved:parametersPreserved,logistics_preserved:logisticsPreserved,
    original_sample_verification:{passed:true,comparisons},
    inputs:{procurement_price_cny:3.84,procurement_quote_source:sourceUrl,domestic_freight_per_unit_cny:{value:5,status:'user_authorized_estimate_not_supplier_confirmed'},D5_combined_cost_cny:8.84,F5_handling_cny:1.5,G5_package_gross_weight_grams:{value:200,status:'user_authorized_estimate_includes_packaging',extra_packaging_grams_added:0},trial_input:null,old_sample_price_cleared:true},
    raw_formula_results:{original_price:rawOriginal,fifty_percent_target:rawTarget,discount:rawDiscount,logistics,table_exchange_cny_per_currency:numeric(product,'A2'),tax_adjusted_cost_cny:numeric(product,'E5')},
    execution_prices:{original_price:originalPrice,promotion_price:promotionPrice,discount_fraction:0.5,rounding:region.code==='SG'?'ceil(original*50)/50; original upward to even cents':'ceil(original/2)*2; original upward to even whole VND',rounding_basis:'Task-specific execution choice preserving exact 50% in selected currency precision and not falling below original target; not verified as a TikTok platform precision rule',rounding_changes_original_formulas:false,promotion_at_least_raw_target:promotionPrice>=rawTarget},
    preserved_existing_ratio_errors:[{cell:region.ratioError,value:product.getRange(region.ratioError).values[0][0],reason:region.trial+' remains blank'}],
    output_xlsx:xlsxPath,
    limitations:['Domestic freight and package gross weight are user-authorized estimates.','Country-specific original parameters and tariff are preserved, not updated from current platform fees.','Platform input precision has not been tested by this calculation.','No inventory allocation, listing, promotion, or browser action is performed.'],
  };
  await fs.writeFile(path.join(outputDir,'pricing-evidence.json'),JSON.stringify(evidence,null,2),'utf8');
  console.log(JSON.stringify({stage:'exported',market:region.code,xlsxPath,evidencePath:path.join(outputDir,'pricing-evidence.json'),rawOriginal,rawTarget,originalPrice,promotionPrice,sampleFormulaComparisons:comparisons.length,hashAfter}));
}
