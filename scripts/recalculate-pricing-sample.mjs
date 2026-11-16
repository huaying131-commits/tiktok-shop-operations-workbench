import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Engine verification only: the original row 5 is not the new product's price.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectDir, 'outputs', 'pricing-engine-2026-10-03');
const extractedPath = path.join(projectDir, 'outputs', 'research-2026-10-03', 'pricing-extracted.json');
const sourceSheetName = '马来（跨境）老店+新店';
const logisticsSheetName = '物流价卡(更新时间1月27日）';
// Refreshed after a read-only comparison: sample formulas, numeric inputs and
// all Malaysia shipping lookup rows match; only labels and tiny cache deltas changed.
const expectedSourceSha256 = '3474e7a16b653683a12dbade9e8f31ecec715cc119481126591dbe537996cd7e';
const requireRuntime = createRequire(path.join(outputDir, 'package.json'));
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(requireRuntime.resolve('@oai/artifact-tool')).href);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function decodeCell(cell) {
  if (cell.value == null) return null;
  if (['s', 'str', 'inlineStr', 'e'].includes(cell.type)) return cell.value;
  if (cell.type === 'b') return cell.value === '1';
  const number = Number(cell.value);
  if (!Number.isFinite(number)) throw new Error(`Unsupported scalar: ${cell.cell}`);
  return number;
}

function coordinates(address) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address);
  const column = [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  return { row: Number(digits), column };
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
  // Leave calculated cells uncached, requiring the engine to evaluate formulas.
  for (const cell of formulas) sheet.getRange(cell.cell).formulas = [[`=${cell.formula}`]];
}

const data = JSON.parse(await fs.readFile(extractedPath, 'utf8'));
const sourceHashBefore = await sha256(data.source);
if (sourceHashBefore !== expectedSourceSha256) throw new Error('Source workbook changed; refresh and audit the extraction before reuse.');
const source = data.sheets.find(sheet => sheet.name === sourceSheetName);
const logistics = data.sheets.find(sheet => sheet.name === logisticsSheetName);
if (!source || !logistics) throw new Error('Required source sheets are missing.');
const sourceCells = source.cells.filter(cell => coordinates(cell.cell).row <= 5);
const logisticsCells = logistics.cells.filter(cell => /^D\d+$|^E\d+$/.test(cell.cell));
const logisticsRows = Math.max(...logisticsCells.map(cell => coordinates(cell.cell).row));
if (source.cells.some(cell => cell.cell === 'R5' && (cell.value != null || cell.formula))) {
  throw new Error('The audited sample requires R5 to remain blank.');
}

const workbook = Workbook.create();
const sample = workbook.worksheets.add(sourceSheetName);
const rates = workbook.worksheets.add(logisticsSheetName);
populate(rates, logisticsCells, logisticsRows, 5);
populate(sample, sourceCells, 5, 43);

sample.getRange('A1:AQ5').format.font = { name: 'Arial', size: 11 };
sample.getRange('A1:AQ5').format.columnWidth = 15;
sample.getRange('C1:C5').format.columnWidth = 28;
sample.getRange('A1:AQ4').format.wrapText = true;
sample.getRange('A1:AQ1').format.rowHeight = 54;
sample.getRange('A4:AQ4').format.rowHeight = 72;
sample.getRange('A2:AQ2').setNumberFormat('0.000000');
sample.getRange('D5:F5').setNumberFormat('0.00');
sample.getRange('G5').setNumberFormat('0');
sample.getRange('H5:AQ5').setNumberFormat('0.000000');
sample.getRange('I5:M5').setNumberFormat('0.0%');
sample.getRange('A4:AQ4').format.fill = '#E8EDF2';
sample.getRange('K5').format.fill = '#DDF1DD';
sample.getRange('N5').format.fill = '#FFF1C2';
sample.getRange('T5').format.fill = '#DDF1DD';
sample.getRange('A7').values = [['第5行为既有商品校验样例，不是本次新品售价。']];
sample.getRange('A7:H7').merge();
sample.getRange('A7:H7').format.rowHeight = 28;
sample.getRange('A7:H7').format.font = { name: 'Arial', size: 11 };
sample.freezePanes.freezeRows(4);
rates.getRange(`D2:E${logisticsRows}`).format.font = { name: 'Arial', size: 11 };
rates.getRange(`D2:E${logisticsRows}`).format.columnWidth = 18;
rates.getRange('D2:E3').format.fill = '#E8EDF2';
rates.getRange(`D4:D${logisticsRows}`).setNumberFormat('0');
rates.getRange(`E4:E${logisticsRows}`).setNumberFormat('0.00');
rates.freezePanes.freezeRows(3);

const sampleInspection = await workbook.inspect({
  kind: 'table', range: `'${sourceSheetName}'!D4:AO5`, include: 'values,formulas',
  tableMaxRows: 2, tableMaxCols: 38, maxChars: 10000,
});
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'engine-inspection.ndjson'), sampleInspection.ndjson, 'utf8');

const keys = ['E5','H5','Y5','Z5','AA5','AB5','AC5','AD5','AE5','AF5','AG5','AH5','AI5','AJ5','T5','N5','K5'];
const comparisons = keys.map(address => {
  const expected = Number(source.cells.find(cell => cell.cell === address).value);
  const actual = sample.getRange(address).values[0][0];
  return { cell: address, cached: expected, engine: actual,
    match: typeof actual === 'number' && Math.abs(actual - expected) <= 1e-9 };
});
if (comparisons.some(item => !item.match)) {
  await fs.writeFile(path.join(outputDir, 'engine-verification.json'), JSON.stringify({
    mode: 'artifact_tool_formula_engine_sample', passed: false, comparisons,
    actual_new_sku_calculated: false,
  }, null, 2), 'utf8');
  throw new Error(`Engine differs from the source sample: ${JSON.stringify(comparisons.filter(item => !item.match))}`);
}

// Temporary engine tests only; restore the audited 100 g input before exporting.
const scenarioChecks = [];
const exchange = sample.getRange('A2').values[0][0];
const breakEvenFactor = sample.getRange('T2').values[0][0];
const baselineN = sample.getRange('N5').values[0][0];
for (const [weightGrams, expectedLogisticsMyr] of [[101, 1.65], [130, 1.95], [150, 2.25]]) {
  sample.getRange('G5').values = [[weightGrams]];
  const actualLogisticsMyr = sample.getRange('Z5').values[0][0];
  const actualN = sample.getRange('N5').values[0][0];
  const expectedN = baselineN + (expectedLogisticsMyr - 1.5) * exchange * breakEvenFactor / 0.5;
  const match = Math.abs(actualLogisticsMyr - expectedLogisticsMyr) <= 1e-9
    && Math.abs(actualN - expectedN) <= 1e-9;
  scenarioChecks.push({ weightGrams, expectedLogisticsMyr, engineLogisticsMyr: actualLogisticsMyr,
    expectedN, engineN: actualN, match });
  if (!match) throw new Error(`Engine input-change test failed at ${weightGrams} grams.`);
}
sample.getRange('G5').values = [[100]];
if (Math.abs(sample.getRange('N5').values[0][0] - baselineN) > 1e-9) {
  throw new Error('Restoring the sample input did not restore its calculated result.');
}

const errors = await workbook.inspect({
  kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options: { useRegex: true, maxResults: 20 }, maxChars: 6000,
  summary: 'Original sample formula error scan',
});
await fs.writeFile(path.join(outputDir, 'engine-errors.ndjson'), errors.ndjson, 'utf8');
for (const record of errors.ndjson.split('\n').filter(Boolean).map(line => JSON.parse(line))) {
  if (record.kind === 'match' && (record.sheet !== sourceSheetName || !['X5', 'AO5'].includes(record.address))) {
    throw new Error(`Unexpected formula error: ${JSON.stringify(record)}`);
  }
}
// X5 and AO5 are original zero-denominator ratios when R5 is blank; preserve them.
const knownRatioErrors = ['X5', 'AO5'].map(cell => ({ cell, value: sample.getRange(cell).values[0][0] }));
for (const [sheetName, range, filename] of [
  [sourceSheetName, 'C4:N7', 'sample-inputs-preview.png'],
  [sourceSheetName, 'N4:AO5', 'sample-outputs-preview.png'],
  [logisticsSheetName, 'D2:E18', 'logistics-preview.png'],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.4, format: 'png' });
  await fs.writeFile(path.join(outputDir, filename), new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
const outputPath = path.join(outputDir, 'pricing-row5-engine-check.xlsx');
await xlsx.save(outputPath);
const sourceHashAfter = await sha256(data.source);
if (sourceHashAfter !== sourceHashBefore) throw new Error('Source hash changed during verification.');
const report = {
  mode: 'artifact_tool_formula_engine_sample', passed: true,
  engine: '@oai/artifact-tool', microsoft_excel_recalculated: false,
  source_workbook_unchanged: true, source_sha256: sourceHashAfter,
  source_sheet: sourceSheetName, source_row: 5,
  original_formulas_preserved: sourceCells.filter(cell => cell.formula).every(cell =>
    sample.getRange(cell.cell).formulas[0][0] === `=${cell.formula}`),
  formula_cache_seeded: false, source_r5_blank: true,
  preserved_existing_ratio_errors: knownRatioErrors,
  comparisons, scenarioChecks, logistics_rows_preserved: logisticsRows,
  actual_new_sku_calculated: false,
  limitations: [
    'Only the original row 5 and its original parameter/lookup dependencies were tested.',
    'The workbook is a reduced working copy; original product images and formatting were not imported.',
    'No current platform fee, shipping tariff or actual product procurement input was re-verified.',
    'No new-product listing price, promotion or inventory is authorized by this sample result.',
  ],
};
await fs.writeFile(path.join(outputDir, 'engine-verification.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
