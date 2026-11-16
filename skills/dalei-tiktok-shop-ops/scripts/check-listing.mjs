import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectImage } from './inspect-image.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const cleanText = value => nonempty(value) && value === value.trim();
const positive = value => (typeof value === 'number' || typeof value === 'string') &&
  String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0;

export function toCents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n ? cents : null;
}

export function checkListing(data, { baseDir = process.cwd() } = {}) {
  const blockers = [];
  const require = (condition, message) => { if (!condition) blockers.push(message); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { local_checks_passed: false, blockers: ['商品资料必须是JSON对象。'], live_action_performed: false };
  }
  const target = data.target ?? {};
  const product = data.product ?? {};
  const pricing = data.pricing ?? {};
  require(data.schema_version === 1, '不支持的商品资料版本。');
  require(target.market === 'MY' && target.currency === 'MYR', '目标必须为MY店铺，价格币种必须为MYR。');
  require(target.browser === 'ziniao', '店铺操作环境必须是紫鸟。');
  for (const key of ['profile_ref', 'shop_ref']) require(nonempty(target[key]), `缺少目标 ${key}。`);
  for (const key of ['title', 'description', 'category_ref', 'warehouse_ref'])
    require(nonempty(product[key]), `缺少商品 ${key}。`);
  for (const key of ['weight_kg', 'length_cm', 'width_cm', 'height_cm'])
    require(positive(product.package?.[key]), `包装 ${key} 必须为已知的正数。`);
  require(product.facts_reviewed === true, '商品事实尚未核对。');
  require(product.category_requirements_reviewed === true, '实时类目必填要求尚未核对。');
  for (const key of ['source', 'sheet', 'revision']) require(nonempty(pricing[key]), `缺少定价表 ${key}。`);
  require(pricing.formula_reviewed === true, '尚未实际核对用户定价表公式，禁止用默认公式替代。');

  const images = Array.isArray(product.images) ? product.images : [];
  const detailImages = Array.isArray(product.detail_images) ? product.detail_images : [];
  require(images.length >= 5 && images.length <= 9, '主图组数量必须为5至9张（详情图另计）。');
  require(images[0]?.role === 'hero', '主图组第1张必须是头图（role=hero）。');
  require(images.at(-1)?.role === 'white_background', '主图组最后1张必须是白底图（role=white_background）。');
  require(images.at(-1)?.white_background_reviewed === true, '最后1张白底图尚未实际人工确认（white_background_reviewed=true）。');
  require(detailImages.length >= 1, '必须另外提供至少1张详情图（detail_images）。');
  const imageIds = new Set();
  const allImageIds = new Set();
  const imageChecks = [];
  for (const [group, entries] of [['main', images], ['detail', detailImages]]) {
    for (const [index, image] of entries.entries()) {
      require(cleanText(image?.id) && !allImageIds.has(image?.id), '图片ID为空、有首尾空白或重复（主图与详情图须各有唯一ID）。');
      allImageIds.add(image?.id);
      if (group === 'main') imageIds.add(image?.id);
      require(image?.reviewed === true, `图片尚未对照实物复核：${image?.id ?? '未知'}。`);
      if (group === 'main') {
        require(image?.role !== 'hero' || index === 0, '头图role=hero只能位于主图组第1张。');
        require(image?.role !== 'white_background' || index === images.length - 1, '白底图role=white_background只能位于主图组最后1张。');
      }
      const localPath = nonempty(image?.path) && !/^[a-z]+:\/\//i.test(image.path);
      require(localPath, `图片必须提供本地文件路径：${image?.id ?? '未知'}。`);
      if (!localPath) continue;
      try {
        const info = inspectImage(path.resolve(baseDir, image.path));
        imageChecks.push({id: image.id, group, ...info});
        if (group === 'main') {
          require(info.width === info.height, `主图必须为1:1：${image.id}（实际${info.width}×${info.height}）。`);
          require(info.width >= 600 && info.height >= 600, `主图至少600×600像素：${image.id}（实际${info.width}×${info.height}）。`);
        }
      } catch (error) {
        blockers.push(`图片技术检查失败：${image?.id ?? '未知'}；${error.message}`);
      }
    }
  }
  const results = Array.isArray(pricing.results) ? pricing.results : [];
  const priceBySku = new Map();
  for (const row of results) {
    require(cleanText(row?.seller_sku) && !priceBySku.has(row?.seller_sku), '定价结果SKU为空、有首尾空白或重复。');
    require(nonempty(row?.output_cell), `定价结果缺少输出单元格：${row?.seller_sku ?? '未知'}。`);
    require(toCents(row?.price_myr) !== null, `定价结果不是有效MYR金额：${row?.seller_sku ?? '未知'}。`);
    priceBySku.set(row?.seller_sku, row);
  }
  const variants = Array.isArray(product.variants) ? product.variants : [];
  require(variants.length > 0, '没有商品SKU。');
  const seenSku = new Set();
  const seenOptions = new Set();
  let expectedOptionKeys;
  for (const variant of variants) {
    const sku = variant?.seller_sku;
    require(cleanText(sku) && !seenSku.has(sku), '商品SKU为空、有首尾空白或重复。');
    seenSku.add(sku);
    const amount = toCents(variant?.price_myr);
    require(amount !== null, `售价必须为正数且最多两位小数的MYR字符串：${sku ?? '未知'}。`);
    const calculated = priceBySku.get(sku);
    require(calculated && amount !== null && amount === toCents(calculated.price_myr), `售价与用户原表结果不一致或没有对应结果：${sku ?? '未知'}。`);
    require(Number.isSafeInteger(variant?.stock) && variant.stock >= 0, `库存必须为明确的非负整数：${sku ?? '未知'}。`);
    require(imageIds.has(variant?.image_id) && nonempty(variant?.image_id), `SKU未关联有效图片：${sku ?? '未知'}。`);
    const options = variant?.options;
    const validOptions = options && typeof options === 'object' && !Array.isArray(options);
    require(Boolean(validOptions), `SKU规格必须是对象：${sku ?? '未知'}。`);
    if (validOptions) {
      const keys = Object.keys(options).sort();
      require(keys.every(key => cleanText(key) && cleanText(options[key])), `规格名称/值必须是无首尾空白的非空文本：${sku}。`);
      if (variants.length <= 1) continue;
      require(keys.length > 0, `多SKU规格不能为空：${sku}。`);
      const signature = JSON.stringify(keys.map(key => [key, options[key]]));
      const keySignature = JSON.stringify(keys);
      expectedOptionKeys ??= keySignature;
      require(expectedOptionKeys === keySignature, `多SKU规格维度不一致：${sku}。`);
      require(!seenOptions.has(signature), `出现重复规格组合：${sku}。`);
      seenOptions.add(signature);
    }
  }
  for (const sku of priceBySku.keys()) require(seenSku.has(sku), `定价结果存在不属于本商品的SKU：${sku}。`);
  return {
    local_checks_passed: blockers.length === 0,
    blockers,
    image_checks: imageChecks,
    live_action_performed: false,
    limitations: ['未执行表格公式；仅比较提供的结果。', '图片只检查实际文件大小、格式及图片头中的像素尺寸，未完整解码或验证图像内容；reviewed与white_background_reviewed须由实际人工复核产生，程序不识别白底。', '未连接紫鸟、核验实时店铺或确认发布授权。'],
    next_step: blockers.length ? '补齐资料或修正不一致项。' : '核实原表计算、图片与实时紫鸟店铺，再按授权操作。'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：node check-listing.mjs <listing.json>');
    const filename = path.resolve(process.argv[2]);
    const data = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    const result = checkListing(data, { baseDir: path.dirname(filename) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.local_checks_passed ? 0 : 2;
  } catch (error) {
    console.error(`无法预检：${error.message}`);
    process.exitCode = 1;
  }
}
