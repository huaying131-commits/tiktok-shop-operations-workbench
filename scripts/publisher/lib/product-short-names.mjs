import fs from 'node:fs';
import {readJSON,fail} from './common.mjs';

const AIRCRAFT_MAIN_PRODUCT_ID = '9000000000000000016';
const registryFile = new URL('../data/product-short-names.json', import.meta.url);
const idPattern = /^\d+$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const isValidShortName = name => typeof name === 'string' && name.trim() === name &&
  name.length > 0 && name.length <= 30 && !/[\r\n\p{Script=Han}]/u.test(name);
export function buildShortNameCatalog(history){
 const groups=new Map();
 for(const row of history.rows??[]){
  if(row.published!==true||!row.product_id)continue;
  for(const field of ['short_product_name','short_name','product_short_name','product_name']){
   const name=row[field];if(!isValidShortName(name))continue;
   const id=String(row.product_id);if(!groups.has(id))groups.set(id,new Map());const names=groups.get(id);
   if(!names.has(name))names.set(name,[]);
   const evidence={source:row.source??'state',field,job_id:row.job_id??row.video_id??null,account:row.account??null};
   if(!names.get(name).some(x=>JSON.stringify(x)===JSON.stringify(evidence)))names.get(name).push(evidence);
  }
 }
 const names={},conflicts={},evidence={};
 for(const [id,values] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const candidates=[...values].sort(([a],[b])=>a.localeCompare(b)).map(([name,sources])=>({name,sources}));
  evidence[id]=candidates;
  if(candidates.length===1)names[id]=candidates[0].name;else conflicts[id]=candidates;
 }
 return{schema:'publisher-product-short-names/v1',names,conflicts,evidence};
}
export function shortNameFor(pkg, catalog = {}) {
 const productId = String(pkg.product_id);
 const skuId = pkg.sku_id ?? pkg.platform_sku_id;
 const sku = catalog.by_sku?.[skuId];
 const matchingSku = sku && sku.product_id === productId;

 if (productId === AIRCRAFT_MAIN_PRODUCT_ID) {
  if (pkg.sku_id != null && pkg.platform_sku_id != null && pkg.sku_id !== pkg.platform_sku_id) {
   return {value:null, reason:'short_product_name_sku_mismatch', source:null};
  }
  if (!matchingSku) {
   return {value:null, reason:sku ? 'short_product_name_sku_mismatch' : 'short_product_name_sku_unapproved', source:null};
  }
  return {value:sku.short_name, source:'sku_catalog'};
 }

 if (pkg.short_product_name !== undefined) return {value:pkg.short_product_name, source:'task_package'};
 if (matchingSku) return {value:sku.short_name, source:'sku_catalog'};
 if (sku) return {value:null, reason:'short_product_name_sku_mismatch', source:null};

 const value = (catalog.by_product ?? catalog.names ?? catalog)[productId];
 if (value !== undefined) return {value, source:'product_catalog'};
 if (catalog.conflicts?.[productId]) {
  return {value:null, reason:'product_short_name_conflict', source:'historical_conflict'};
 }
 const historicalName = catalog.historical_names?.[productId];
 if (historicalName !== undefined) return {value:historicalName, source:'historical_product_catalog'};
 return {value:null, reason:'short_product_name_missing', source:null};
}

function validateApprovedNames(data) {
 if (!isRecord(data)) fail('invalid_product_short_name_catalog', 40);
 const hasSkuSchema = Object.hasOwn(data, 'by_sku') || Object.hasOwn(data, 'by_product');
 const sourceSkus = hasSkuSchema ? data.by_sku : {};
 const sourceProducts = hasSkuSchema ? data.by_product : Object.hasOwn(data, 'names') ? data.names : data;
 if (!isRecord(sourceSkus) || !isRecord(sourceProducts)) fail('invalid_product_short_name_catalog', 40);

 const by_sku = {};
 for (const [skuId, row] of Object.entries(sourceSkus)) {
  if (!idPattern.test(skuId) || !isRecord(row) || typeof row.product_id !== 'string' ||
      !idPattern.test(row.product_id) || !isValidShortName(row.short_name)) {
   fail('invalid_product_short_name_catalog', 40, {sku_id:skuId});
  }
  by_sku[skuId] = {product_id:row.product_id, short_name:row.short_name};
 }

 const by_product = {};
 for (const [productId, row] of Object.entries(sourceProducts)) {
  const name = isRecord(row) ? row.short_name : row;
  if (!idPattern.test(productId) || !isValidShortName(name)) {
   fail('invalid_product_short_name_catalog', 40, {product_id:productId});
  }
  by_product[productId] = name;
 }
 return {by_sku, by_product};
}

export function loadApprovedShortNames(legacyFile, file = registryFile) {
 const current = validateApprovedNames(readJSON(file));
 if (!legacyFile || !fs.existsSync(legacyFile)) return current;
 const legacy = validateApprovedNames(readJSON(legacyFile));
 return {
  by_sku: {...legacy.by_sku, ...current.by_sku},
  by_product: {...legacy.by_product, ...current.by_product}
 };
}

export function mergeApprovedNames(candidate, approved) {
 const {by_sku, by_product} = validateApprovedNames(approved);
 const result = structuredClone(candidate);
 result.schema = 'publisher-product-short-names/v2';
 result.historical_names = result.names;
 result.names = {...result.historical_names, ...by_product};
 result.by_sku = by_sku;
 result.by_product = by_product;
 for (const [id, name] of Object.entries(by_product)) {
  delete result.conflicts[id];
  result.evidence[id] = [{name, sources:[{source:'approved_product_short_names_file'}]}];
 }
 return result;
}

export function shortNameSnapshot(pkg, short) {
 if (short.source === 'sku_catalog') {
  const skuId = pkg.sku_id ?? pkg.platform_sku_id;
  return {by_sku:{[skuId]:{product_id:String(pkg.product_id), short_name:short.value}}};
 }
 return {names:{[pkg.product_id]:short.value}};
}
export function unresolvedProducts(results){
 const products=new Map();
 for(const row of results){if(!row.issues?.some(x=>['short_product_name_missing','short_product_name_sku_unapproved','short_product_name_sku_mismatch','product_short_name_conflict'].includes(x))||!row.product_id)continue;
  const id=String(row.product_id);if(!products.has(id))products.set(id,{product_id:id,reasons:[],video_ids:[],manifests:[]});
  const item=products.get(id);item.reasons=[...new Set([...item.reasons,...row.issues.filter(x=>/short_name|short_product_name/.test(x))])];item.video_ids=[...new Set([...item.video_ids,row.video_id])];item.manifests.push(row.manifest);
 }
 return [...products.values()].sort((a,b)=>a.product_id.localeCompare(b.product_id));
}
