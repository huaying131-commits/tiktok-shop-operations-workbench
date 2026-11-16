import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {intake,validatePackage} from '../lib/intake.mjs';
import {
 buildShortNameCatalog,loadApprovedShortNames,mergeApprovedNames,shortNameFor
} from '../lib/product-short-names.mjs';
import {State} from '../lib/state.mjs';

const mainProduct = '9000000000000000016';
const f14Sku = '9000000000000000020';
const tm43Product = '9000000000000000046';
const emptyCatalog = () => buildShortNameCatalog({rows:[]});

test('ordinary names resolve from the task, matching SKU, then approved product', () => {
 const catalog = mergeApprovedNames(emptyCatalog(), {
  by_sku:{'201':{product_id:'200',short_name:'SKU name'}},
  by_product:{'200':'Product name','300':'Other product name'}
 });
 assert.equal(shortNameFor({product_id:'200',sku_id:'201',short_product_name:'Task name'},catalog).value,'Task name');
 assert.equal(shortNameFor({product_id:'200',sku_id:'201'},catalog).value,'SKU name');
 assert.equal(shortNameFor({product_id:'200',sku_id:'202'},catalog).value,'Product name');
 assert.equal(shortNameFor({product_id:'300',sku_id:'201'},catalog).reason,'short_product_name_sku_mismatch');
});

test('aircraft main link accepts only the approved matching SKU and snapshots that association', () => {
 const f = fixture();
 try {
  const catalog = mergeApprovedNames(emptyCatalog(),loadApprovedShortNames());
  const pkg = {...f.pkg,product_id:mainProduct,sku_id:f14Sku};
  const options = {policy:f.policy,manifest:f.manifest,shortNames:catalog};
  const job = validatePackage(pkg,options);
  assert.equal(job.short_name,'Model Jet F-14 Kit DIY');
  assert.equal(job.short_name_source,'sku_catalog');
  assert.equal(validatePackage(pkg,{...options,shortNames:job.short_names_snapshot}).short_name,job.short_name);
  assert.equal(validatePackage({...pkg,sku_id:undefined,platform_sku_id:f14Sku},options).short_name,job.short_name);

  const state = new State(path.join(f.dir,'state'));
  try {
   const genericCatalog = {...catalog,by_product:{[mainProduct]:'Generic plane'}};
   for (const sku_id of [undefined,'999']) {
    fs.writeFileSync(f.manifest,JSON.stringify({...pkg,sku_id}));
    const result = intake({state,sourceDir:f.src,policy:f.policy,shortNames:genericCatalog});
    assert.equal(result.exit_code,20);
    assert(result.results[0].issues.includes('short_product_name_sku_unapproved'));
    assert.equal(result.accepted,0);
   }
  } finally { state.close(); }

  assert.throws(
   () => validatePackage({...pkg,platform_sku_id:'999'},options),
   error => error.code===20 && error.details.issues.includes('short_product_name_sku_mismatch')
  );
  const wrongAssociation = {...catalog,by_sku:{[f14Sku]:{product_id:'200',short_name:'Wrong parent'}}};
  assert.throws(
   () => validatePackage(pkg,{...options,shortNames:wrongAssociation}),
   error => error.code===20 && error.details.issues.includes('short_product_name_sku_mismatch')
  );
 } finally { f.cleanup(); }
});

test('approved names take precedence over a unique historical name, with conflicting history blocked', () => {
 const f = fixture();
 try {
  const legacyFile = path.join(f.dir,'legacy.json');
  fs.writeFileSync(legacyFile,JSON.stringify({names:{[tm43Product]:'Old name','200':'Legacy name'}}));
  const historical = buildShortNameCatalog({rows:[
   {published:true,product_id:tm43Product,short_name:'Historic TM43'},
   {published:true,product_id:'300',short_name:'Historic name',source:'ledger'},
   {published:true,product_id:'400',short_name:'Conflict A'},
   {published:true,product_id:'400',short_name:'Conflict B'},
   {published:true,product_id:mainProduct,short_name:'Historic plane'}
  ]});
  const catalog = mergeApprovedNames(historical,loadApprovedShortNames(legacyFile));
  assert.equal(shortNameFor({product_id:tm43Product},catalog).value,'Vakum Kayu Mini Kit DIY');
  assert.equal(shortNameFor({product_id:'200'},catalog).value,'Legacy name');
  assert.deepEqual(shortNameFor({product_id:'300'},catalog),{value:'Historic name',source:'historical_product_catalog'});
  assert.equal(catalog.evidence['300'][0].sources[0].source,'ledger');
  assert.equal(shortNameFor({product_id:'400'},catalog).reason,'product_short_name_conflict');
  assert.equal(shortNameFor({product_id:mainProduct},catalog).reason,'short_product_name_sku_unapproved');
 } finally { f.cleanup(); }
});

test('one invalid approved name rejects the whole catalogue', () => {
 const f = fixture();
 try {
  const file = path.join(f.dir,'approved.json');
  const invalidCatalogue = error => error.code===40 && error.reason==='invalid_product_short_name_catalog';
  for (const short_name of ['中文短名','A'.repeat(31)]) {
   fs.writeFileSync(file,JSON.stringify({by_sku:{[f14Sku]:{product_id:mainProduct,short_name}},by_product:{'200':'Good name'}}));
   assert.throws(() => loadApprovedShortNames(undefined,file),invalidCatalogue);
   fs.writeFileSync(file,JSON.stringify({names:{'200':'Good name','201':short_name}}));
   assert.throws(() => loadApprovedShortNames(file),invalidCatalogue);
  }
 } finally { f.cleanup(); }
});
