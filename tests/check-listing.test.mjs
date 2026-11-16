import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { checkListing, toCents } from '../skills/dalei-tiktok-shop-ops/scripts/check-listing.mjs';

// Build complete, CRC-valid PNGs with real compressed pixel data; no file-existence mocks.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height) {
  const chunk = (type, content) => {
    const data = Buffer.concat([Buffer.from(type), content]);
    const header = Buffer.alloc(4); header.writeUInt32BE(content.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalei-listing-test-'));
const fixtureFiles = [];
function writeFixture(name, bytes) {
  fs.writeFileSync(path.join(fixtureDir, name), bytes);
  fixtureFiles.push(name);
}
after(() => {
  for (const name of fixtureFiles) fs.unlinkSync(path.join(fixtureDir, name));
  fs.rmdirSync(fixtureDir);
});
writeFixture('square.png', png(600, 600));
writeFixture('portrait.png', png(600, 900));
writeFixture('small.png', png(599, 599));
writeFixture('fake.png', Buffer.from('This is plain text, not a PNG image.'));
writeFixture('truncated.png', png(600, 600).subarray(0, 20));
writeFixture('oversize.png', Buffer.concat([png(600, 600), Buffer.alloc(10 * 1024 * 1024)]));
// Complete 1×1 white JPEG/WebP generated with Pillow, kept inline to avoid test dependencies.
writeFixture('tiny.jpg', Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==', 'base64'));
writeFixture('tiny.webp', Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64'));
writeFixture('unsupported.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
const mainImages = count => Array.from({length: count}, (_, index) => ({
  id: index === 0 ? 'main' : `main-${index + 1}`, path: 'square.png', reviewed: true,
  role: index === 0 ? 'hero' : index === count - 1 ? 'white_background' : 'feature',
  ...(index === count - 1 ? {white_background_reviewed: true} : {})
}));
const fixture = () => ({
  schema_version: 1,
  target: {market: 'MY', currency: 'MYR', browser: 'ziniao', profile_ref: 'test-profile', shop_ref: 'test-shop'},
  product: {
    title: '测试资料，不是实际商品', description: '测试', category_ref: 'test-category', warehouse_ref: 'test-warehouse',
    images: mainImages(5),
    detail_images: [{id: 'detail-1', path: 'portrait.png', reviewed: true}],
    variants: [{seller_sku: 'A', options: {}, price_myr: '19.90', stock: 0, image_id: 'main'}],
    package: {weight_kg: '0.2', length_cm: 10, width_cm: 10, height_cm: 5},
    facts_reviewed: true, category_requirements_reviewed: true
  },
  pricing: {source: 'test.xlsx', sheet: 'test', revision: 'fixture', formula_reviewed: true,
    results: [{seller_sku: 'A', price_myr: '19.9', output_cell: 'F2'}]}
});
const run = data => checkListing(data, {baseDir: fixtureDir});

test('合法资料与等价小数只通过本地检查，不表示发生线上操作', () => {
  const result = run(fixture());
  assert.equal(result.local_checks_passed, true);
  assert.equal(result.live_action_performed, false);
});
test('一分钱价差阻止上架资料继续流转', () => {
  const data = fixture(); data.product.variants[0].price_myr = '19.89';
  assert.equal(run(data).local_checks_passed, false);
});
test('不接受浮点数、指数金额、负数和超两位小数', () => {
  for (const value of [19.9, '1e2', '-2', '19.999', '0.00', '', null]) assert.equal(toCents(value), null);
  assert.equal(toCents('0.01'), 1n);
});
test('跨店资料缺少环境或误用USD/普通浏览器时阻止', () => {
  for (const [key, value] of [['profile_ref',''], ['shop_ref',''], ['currency','USD'], ['market','US'], ['browser','chrome']]) {
    const data = fixture(); data.target[key] = value;
    assert.equal(run(data).local_checks_passed, false);
  }
});
test('定价表未复核或SKU对应缺失时不能用默认价格', () => {
  const data = fixture(); data.pricing.formula_reviewed = false;
  assert.equal(run(data).local_checks_passed, false);
  data.pricing.formula_reviewed = true; data.pricing.results[0].seller_sku = 'B';
  assert.equal(run(data).local_checks_passed, false);
});
test('图片丢失或SKU指向其他图片会阻止', () => {
  const missing = fixture(); missing.product.images[0].path = 'missing.png';
  assert.equal(run(missing).local_checks_passed, false);
  const data = fixture(); data.product.variants[0].image_id = 'other';
  assert.equal(run(data).local_checks_passed, false);
});

test('主图组必须5至9张，4张和10张均失败', () => {
  for (const [count, expected] of [[4, false], [5, true], [9, true], [10, false]]) {
    const data = fixture(); data.product.images = mainImages(count);
    assert.equal(run(data).local_checks_passed, expected, `主图数量 ${count}`);
  }
});

test('首张必须为头图，末张必须为已人工确认的白底图', () => {
  for (const change of [
    data => { data.product.images[0].role = 'feature'; },
    data => { data.product.images.at(-1).role = 'feature'; },
    data => { data.product.images.at(-1).white_background_reviewed = false; },
    data => { [data.product.images[3], data.product.images[4]] = [data.product.images[4], data.product.images[3]]; }
  ]) {
    const data = fixture(); change(data);
    assert.equal(run(data).local_checks_passed, false);
  }
});

test('详情图必须另外提供，且每张图片都完成实物复核', () => {
  for (const change of [
    data => { delete data.product.detail_images; },
    data => { data.product.detail_images = []; },
    data => { data.product.detail_images[0].reviewed = false; },
    data => { data.product.images[2].reviewed = false; },
    data => { data.product.detail_images[0].path = 'missing.png'; }
  ]) {
    const data = fixture(); change(data);
    assert.equal(run(data).local_checks_passed, false);
  }
});

test('读取真实主图尺寸，主图1:1且至少600像素，详情图可为长图', () => {
  assert.equal(run(fixture()).local_checks_passed, true);
  for (const filename of ['portrait.png', 'small.png']) {
    const data = fixture();
    Object.assign(data.product.images[0], {path: filename, width: 1024, height: 1024});
    assert.equal(run(data).local_checks_passed, false, filename);
  }
});

test('伪装文本和不完整图片头不能靠文件扩展名或元数据通过', () => {
  for (const filename of ['fake.png', 'truncated.png']) {
    const data = fixture(); data.product.images[0].path = filename;
    const result = run(data);
    assert.equal(result.local_checks_passed, false);
    assert.match(result.blockers.join('\n'), /图片|格式/);
  }
});

test('真实文件超过10MB时阻止，不信任填报字节数', () => {
  const data = fixture(); Object.assign(data.product.detail_images[0], {path: 'oversize.png', bytes: 100});
  assert.equal(run(data).local_checks_passed, false);
});

test('支持真实JPEG和WebP图片头，明确拒绝不支持的格式', () => {
  for (const filename of ['tiny.jpg', 'tiny.webp']) {
    const data = fixture(); data.product.detail_images[0].path = filename;
    const result = run(data);
    assert.equal(result.local_checks_passed, true, result.blockers.join('\n'));
    data.product.images[0].path = filename;
    assert.equal(run(data).local_checks_passed, false, '小图不能充当600像素主图');
  }
  const data = fixture(); data.product.detail_images[0].path = 'unsupported.gif';
  const result = run(data);
  assert.equal(result.local_checks_passed, false);
  assert.match(result.blockers.join('\n'), /PNG.*JPEG.*WebP/);
});

test('图片ID跨主图和详情图保持唯一，SKU只引用主图组', () => {
  const duplicate = fixture(); duplicate.product.detail_images[0].id = 'main';
  assert.equal(run(duplicate).local_checks_passed, false);
  const data = fixture(); data.product.variants[0].image_id = 'detail-1';
  assert.equal(run(data).local_checks_passed, false);
});
test('库存零合法，未知负数小数非法', () => {
  for (const stock of [null, -1, 0.5, '5']) {
    const data = fixture(); data.product.variants[0].stock = stock;
    assert.equal(run(data).local_checks_passed, false);
  }
});
test('多SKU规格维度一致，重复组合或重复SKU失败', () => {
  const data = fixture(); data.product.variants[0].options = {color: 'red'};
  data.product.variants.push({seller_sku:'B', options:{color:'blue'}, price_myr:'20', stock:3, image_id:'main'});
  data.pricing.results.push({seller_sku:'B', price_myr:'20.00', output_cell:'F3'});
  assert.equal(run(data).local_checks_passed, true);
  data.product.variants[1].options = {color:'red'};
  assert.equal(run(data).local_checks_passed, false);
  data.product.variants[1].options = {size:'large'};
  assert.equal(run(data).local_checks_passed, false);
  data.product.variants[1].options = {color:'blue'}; data.product.variants[1].seller_sku = 'A';
  assert.equal(run(data).local_checks_passed, false);
});
test('空输入和未填模板不会被判为可用', () => {
  for (const input of [null, [], {}, {schema_version:1}]) assert.equal(run(input).local_checks_passed, false);
});
test('单SKU不允许已提供但无效的规格值', () => {
  for (const value of [null, 42, '', 'red ']) {
    const data = fixture(); data.product.variants[0].options = {color: value};
    assert.equal(run(data).local_checks_passed, false);
  }
});
test('SKU与规格首尾空格不能混入不同价格', () => {
  const data = fixture(); data.product.variants[0].options = {color: 'red'};
  data.product.variants.push({seller_sku:'A ', options:{color:'red '}, price_myr:'29.90', stock:3, image_id:'main'});
  data.pricing.results.push({seller_sku:'A ', price_myr:'29.90', output_cell:'F3'});
  assert.equal(run(data).local_checks_passed, false);
  const single = fixture(); single.product.variants[0].seller_sku = ' A'; single.pricing.results[0].seller_sku = ' A';
  assert.equal(run(single).local_checks_passed, false);
});
