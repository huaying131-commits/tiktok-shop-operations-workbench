import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// One authorized M3080 calculation; the existing row-5 engine test stays separate.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectDir, 'outputs', 'flower-pilot-2026-10-03', 'M3080', 'pricing');
const runtimeDir = path.join(projectDir, 'outputs', 'pricing-engine-2026-10-03');
const extractedPath = path.join(projectDir, 'outputs', 'research-2026-10-03', 'pricing-extracted.json');
const sourceSheetName = '马来（跨境）老店+新店';
const logisticsSheetName = '物流价卡(更新时间1月27日）';
const expectedSourceSha256 = '3474e7a16b653683a12dbade9e8f31ecec715cc119481126591dbe537996cd7e';
const requireRuntime = createRequire(path.join(runtimeDir, 'package.json'));
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(requireRuntime.resolve('@oai/artifact-tool')).href);
const sourceUrl = 'https://en.yiwugo.com/product/detail/985676896.html';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function coordinates(address) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address);
  return { row: Number(digits), column: [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) };
}
function decodeCell(cell) {
  if (cell.value == null) return null;
  if (['s', 'str', 'inlineStr', 'e'].includes(cell.type)) return cell.value;
  if (cell.type === 'b') return cell.value === '1';
  const number = Number(cell.value);
  if (!Number.isFinite(number)) throw new Error(`Unsupported scalar: ${cell.cell}`);
  return number;
}
function populate(sheet, cells, rows, columns) {
  const values = Array.from({ length: rows }, () => Array(columns).fill(null));
  const formulas = [];
  for (const cell of cells) {
    const { row, column } = coordinates(cell.cell);
    if (row > rows || column > columns) continue;
    if (cell.formula) formulas.push(cell);
    else values[row - 1][column - 1] = decodeCell(cell);
  }
  sheet.getRangeByIndexes(0, 0, rows, columns).values = values;
  // Original cached formula values are deliberately not copied.
  for (const cell of formulas) sheet.getRange(cell.cell).formulas = [[`=${cell.formula}`]];
}
function numeric(sheet, address) {
  const value = sheet.getRange(address).values[0][0];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Non-numeric result at ${address}: ${value}`);
  return value;
}

const data = JSON.parse(await fs.readFile(extractedPath, 'utf8'));
const sourceHashBefore = await sha256(data.source);
if (sourceHashBefore !== expectedSourceSha256) throw new Error('Source workbook changed; audit the snapshot before reuse.');
const source = data.sheets.find(sheet => sheet.name === sourceSheetName);
const logistics = data.sheets.find(sheet => sheet.name === logisticsSheetName);
if (!source || !logistics) throw new Error('Required source sheets are missing.');
const sourceCells = source.cells.filter(cell => coordinates(cell.cell).row <= 5);
const logisticsCells = logistics.cells.filter(cell => /^D\d+$|^E\d+$/.test(cell.cell));
const logisticsRows = Math.max(...logisticsCells.map(cell => coordinates(cell.cell).row));

const workbook = Workbook.create();
const overview = workbook.worksheets.add('M3080算价');
const product = workbook.worksheets.add(sourceSheetName);
const rates = workbook.worksheets.add(logisticsSheetName);
populate(rates, logisticsCells, logisticsRows, 5);
populate(product, sourceCells, 5, 43);
// These four labels were updated in the source after the initial extraction.
product.getRange('I3:L3').values = [['勿改', '勿改', '勿改', '勿改']];
product.getRange('C5').values = [['M3080 粉瑰梦境（155颗粒，彩盒装）']];
product.getRange('D5').values = [[8.84]];
product.getRange('F5').values = [[1.50]];
product.getRange('G5').values = [[200]];
// Q5 was the old sample product's manual price; it is unrelated to M3080.
product.getRange('Q5:R5').values = [[null, null]];

const raw = Object.fromEntries(['D5','E5','F5','G5','H5','Y5','Z5','AJ5','N5','T5','K5'].map(cell => [cell, numeric(product, cell)]));
const executionOriginalCents = Math.ceil(raw.N5 * 50) * 2;
const executionOriginalMyr = executionOriginalCents / 100;
const executionPromotionMyr = executionOriginalCents / 200;
if (raw.Z5 !== 3 || Math.abs(raw.K5 - 0.5) > 1e-12 || executionOriginalMyr < raw.N5 || executionPromotionMyr < raw.T5) {
  throw new Error('Logistics, discount, or rounding check failed.');
}
console.log(JSON.stringify({stage: 'calculated', sku: 'M3080', raw, executionOriginalMyr, executionPromotionMyr, executionDiscount: 0.5}));

overview.getRange('A1:C1').merge();
overview.getRange('A1').values = [['M3080 单款算价']];
overview.getRange('A2:C2').merge();
overview.getRange('A2').values = [['粉瑰梦境 155颗粒 彩盒装｜马来（跨境）老店+新店｜2026-10-03']];
overview.getRange('A4:C12').values = [
  ['成本与试售设置', '数值', '单位与依据'],
  ['商品采购报价', 3.84, 'CNY/盒；义乌购所选 M3080 彩盒装公开报价，未含国内运费。'],
  ['到国内货代仓运费', 5, 'CNY/盒；用户授权估算，尚未取得商家确认报价。'],
  ['D：采购价＋国内运费', null, 'CNY/盒；3.84＋5.00，原表 E 列仍按原公式加计3%。'],
  ['F：货代打包送 TKL', 1.5, 'CNY/件；用户确认的国内货代处理费。'],
  ['G：含包装毛重', 200, '克/件；用户授权估算，已含包装，不再叠加30–50克。'],
  ['试售库存', 100, '件；用户授权试售设置，并非已核实的供应商实时库存。'],
  ['R：试售价输入', '空白', '保留用户原公式的空白输入方式。'],
  ['Z：物流价卡结果', null, 'MYR/件；保留原物流价卡，200克对应3.00 MYR。'],
];
overview.getRange('A14:C17').values = [
  ['原公式计算结果', 'MYR / 折扣', '说明'],
  ['N：原价', null, '原公式 N5=T5/0.5，保留未取整结果。'],
  ['T：50%目标价', null, '沿用原表 T5 的保本价口径，未另行调整费用或利润率。'],
  ['K：折扣', null, '原公式 K5=1−T5/N5。'],
];
overview.getRange('A19:C22').values = [
  ['本次两位小数执行价', 'MYR / 折扣', '说明'],
  ['建议上架原价', null, 'N 向上取至偶数分；仅本次执行取整，原表 N/T 公式不变。'],
  ['50%活动价', null, '等于执行原价的50%，整数分，且不低于原公式 T。'],
  ['执行折扣', null, '精确50%；价格计算本身不会创建店铺活动。'],
];
overview.getRange('A24:C29').values = [
  ['来源与边界', '来源', '说明'],
  ['采购报价', '义乌购 欧森百货', sourceUrl],
  ['定价模板', '【东南亚】玩具类目成本测算表 .xlsx', '马来（跨境）老店+新店，第5行公式及顶部参数；物流价卡保留 D:E 全部数据。'],
  ['计算方式', '@oai/artifact-tool', '公式引擎实际重算，未使用微软 Excel 重算；原工作簿未修改。'],
  ['未确认的输入', '国内运费、包装毛重', '运费和毛重为本次授权估算；确认真实数值后应再次计算。'],
  ['原表空白分母', 'X5 / AO5', 'R5 空白时，两项比率沿用原公式出现除零结果，N/T/K 核心结果为有效数值。'],
];
for (const [target, sourceCell] of [['B7','D5'], ['B12','Z5'], ['B15','N5'], ['B16','T5'], ['B17','K5']]) {
  overview.getRange(target).formulas = [[`='${sourceSheetName}'!${sourceCell}`]];
}
overview.getRange('B20').formulas = [['=ROUNDUP(B15*50,0)/50']];
overview.getRange('B21').formulas = [['=B20/2']];
overview.getRange('B22').formulas = [['=1-B21/B20']];
if (Math.abs(numeric(overview, 'B20') - executionOriginalMyr) > 1e-9
 || Math.abs(numeric(overview, 'B21') - executionPromotionMyr) > 1e-9
 || numeric(overview, 'B22') !== 0.5) throw new Error('Spreadsheet execution-price formulas disagree with integer-cent check.');

overview.getRange('A1:C29').format.font = { name: 'Arial', size: 11 };
overview.getRange('A1:C29').format.rowHeight = 38;
overview.getRange('A1:C29').format.wrapText = true;
overview.getRange('A1:A29').format.columnWidth = 30;
overview.getRange('B1:B29').format.columnWidth = 32;
overview.getRange('C1:C29').format.columnWidth = 90;
overview.getRange('A1:C1').format.font = { name: 'Arial', size: 18, bold: true, color: '#FFFFFF' };
overview.getRange('A1:C1').format.fill = '#174A58';
for (const row of [4, 14, 19, 24]) {
  overview.getRange(`A${row}:C${row}`).format.fill = '#E8EDF2';
  overview.getRange(`A${row}:C${row}`).format.font = { name: 'Arial', size: 11, bold: true };
}
overview.getRange('B5:B8').setNumberFormat('0.00');
overview.getRange('B9:B10').setNumberFormat('0');
overview.getRange('B12').setNumberFormat('0.00');
overview.getRange('B15:B16').setNumberFormat('0.00000000');
overview.getRange('B17').setNumberFormat('0.0%');
overview.getRange('B20:B21').setNumberFormat('0.00');
overview.getRange('B22').setNumberFormat('0.0%');
overview.getRange('A20:C22').format.fill = '#DDF1DD';
for (const row of [6, 9, 10]) overview.getRange(`B${row}`).format.fill = '#FFF1C2';
overview.freezePanes.freezeRows(4);

product.getRange('A1:AQ5').format.font = { name: 'Arial', size: 11 };
product.getRange('A1:AQ5').format.columnWidth = 16;
product.getRange('C1:C5').format.columnWidth = 42;
product.getRange('A1:AQ5').format.wrapText = true;
product.getRange('A1:AQ1').format.rowHeight = 54;
product.getRange('A4:AQ4').format.rowHeight = 80;
product.getRange('A5:AQ5').format.rowHeight = 48;
product.getRange('A2:AQ2').setNumberFormat('0.000000');
product.getRange('D5:F5').setNumberFormat('0.00');
product.getRange('G5').setNumberFormat('0');
product.getRange('H5:AQ5').setNumberFormat('0.000000');
product.getRange('I5:M5').setNumberFormat('0.0%');
product.getRange('A4:AQ4').format.fill = '#E8EDF2';
for (const cell of ['K5','T5']) product.getRange(cell).format.fill = '#DDF1DD';
product.getRange('N5').format.fill = '#FFF1C2';
product.getRange('A7:M7').merge();
product.getRange('A7').values = [['本次新品工作副本。运费5元、毛重200克为授权估算；详见“M3080算价”。R5空白，X5/AO5比率沿用原表除零结果。']];
product.getRange('A7:M7').format.font = { name: 'Arial', size: 11 };
product.getRange('A7:M7').format.wrapText = true;
product.getRange('A7:M7').format.rowHeight = 36;
product.freezePanes.freezeRows(4);
rates.getRange(`D2:E${logisticsRows}`).format.font = { name: 'Arial', size: 11 };
rates.getRange(`D2:E${logisticsRows}`).format.columnWidth = 18;
rates.getRange('D2:E3').format.fill = '#E8EDF2';
rates.getRange(`D4:D${logisticsRows}`).setNumberFormat('0');
rates.getRange(`E4:E${logisticsRows}`).setNumberFormat('0.00');
rates.getRange('D23:E23').format.fill = '#DDF1DD';
rates.freezePanes.freezeRows(3);

const originalFormulasPreserved = sourceCells.filter(cell => cell.formula).every(cell =>
  product.getRange(cell.cell).formulas[0][0] === `=${cell.formula}`);
const parametersPreserved = sourceCells.filter(cell => coordinates(cell.cell).row <= 2 && !cell.formula).every(cell =>
  product.getRange(cell.cell).values[0][0] === decodeCell(cell));
const logisticsPreserved = logisticsCells.every(cell =>
  rates.getRange(cell.cell).values[0][0] === decodeCell(cell));
if (!originalFormulasPreserved || !parametersPreserved || !logisticsPreserved) throw new Error('Original formula, parameter or logistics preservation failed.');
const inspected = await workbook.inspect({ kind: 'table', range: "'M3080算价'!A4:C22", include: 'values,formulas', tableMaxRows: 19, tableMaxCols: 3, maxChars: 10000 });
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 30 }, maxChars: 6000, summary: 'M3080 formula error scan' });
for (const record of errors.ndjson.split('\n').filter(Boolean).map(line => JSON.parse(line))) {
  if (record.kind === 'match' && (record.sheet !== sourceSheetName || !['X5','AO5'].includes(record.address))) throw new Error(`Unexpected formula error: ${JSON.stringify(record)}`);
}
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'inspection.ndjson'), inspected.ndjson, 'utf8');
await fs.writeFile(path.join(outputDir, 'formula-errors.ndjson'), errors.ndjson, 'utf8');
for (const [sheetName, range, filename] of [
  ['M3080算价', 'A1:C29', 'pricing-overview.png'],
  [sourceSheetName, 'C4:N7', 'original-formulas-inputs.png'],
  [sourceSheetName, 'N4:W5', 'original-formulas-prices.png'],
  [logisticsSheetName, 'D2:E23', 'logistics-200g.png'],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.4, format: 'png' });
  await fs.writeFile(path.join(outputDir, filename), new Uint8Array(await preview.arrayBuffer()));
}
const xlsxPath = path.join(outputDir, 'M3080-pricing.xlsx');
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(xlsxPath);
const sourceHashAfter = await sha256(data.source);
if (sourceHashAfter !== sourceHashBefore) throw new Error('Source workbook changed during this calculation.');
const evidence = {
  sku: 'M3080', product: '粉瑰梦境155颗粒（彩盒装）', market: 'MY', fulfillment: 'cross_border',
  calculation_date: '2026-10-03', mode: 'artifact_tool_formula_engine_actual_single_sku', engine: '@oai/artifact-tool',
  microsoft_excel_recalculated: false, formula_cache_seeded: false,
  source_workbook: data.source, source_sha256: sourceHashAfter, source_workbook_unchanged: true,
  source_sheet: sourceSheetName, source_row: 5, source_snapshot: extractedPath,
  original_formulas_preserved: originalFormulasPreserved, parameters_preserved: parametersPreserved,
  logistics_de_preserved: logisticsPreserved, logistics_max_row: logisticsRows,
  inputs: {
    procurement_price_cny: { value: 3.84, status: 'public_selected_variant_quote', source_url: sourceUrl },
    domestic_freight_per_unit_cny: { value: 5, status: 'user_authorized_estimate_not_supplier_confirmed' },
    D5_combined_cost_cny: 8.84, F5_handling_cny: 1.5,
    G5_package_gross_weight_grams: { value: 200, status: 'user_authorized_estimate_includes_packaging', extra_packaging_grams_added: 0 },
    R5: null, Q5: null, initial_stock: { value: 100, status: 'user_authorized_trial_setting_not_supplier_inventory' },
  },
  raw_formula_results: raw,
  execution_prices: { currency: 'MYR', original_price: executionOriginalMyr, promotion_price: executionPromotionMyr,
    discount_fraction: 0.5, original_price_integer_cents: executionOriginalCents,
    promotion_price_integer_cents: executionOriginalCents / 2,
    rounding: 'ceil(N5 * 50) / 50; round original price upward to even cents; exact 50% promotion price',
    rounding_changes_original_formulas: false, promotion_at_least_raw_T5: executionPromotionMyr >= raw.T5 },
  preserved_existing_ratio_errors: ['X5','AO5'].map(cell => ({cell, value: product.getRange(cell).values[0][0], reason: 'R5 remains blank'})),
  output_xlsx: xlsxPath,
  limitations: ['Domestic freight and final package gross weight are user-authorized estimates.', 'The original table rates and tariff were preserved; their current platform accuracy was not re-verified.', 'One SKU calculated in a reduced working copy; no batch interface or store operation is included.'],
};
await fs.writeFile(path.join(outputDir, 'pricing-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
console.log(JSON.stringify({stage: 'exported', xlsxPath, evidencePath: path.join(outputDir, 'pricing-evidence.json'), raw, executionOriginalMyr, executionPromotionMyr, sourceHashAfter, originalFormulasPreserved, parametersPreserved, logisticsPreserved}, null, 2));
