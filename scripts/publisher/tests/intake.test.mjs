import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,hash} from './support.mjs';
import {State} from '../lib/state.mjs';
let api;try{api=await import('../lib/intake.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('intake is idempotent, preserves sources, rejects holds, SHA and lineage conflicts',()=>{
 assert.equal(typeof api?.intake,'function');
 const f=fixture(),s=new State(path.join(f.dir,'state'));
 try{
  const before=fs.readFileSync(f.manifest),baseline=fs.readdirSync(f.src);
  const input={state:s,sourceDir:f.src,policy:f.policy,history:{rows:[],reservations:[]}};
  const a=api.intake(input),b=api.intake(input);assert.deepEqual(a,b);assert.equal(s.jobs().length,1);assert.deepEqual(fs.readFileSync(f.manifest),before);assert.deepEqual(fs.readdirSync(f.src),baseline);
  let p={...f.pkg,publication_hold:{active:true}};fs.writeFileSync(f.manifest,JSON.stringify(p));
  assert.equal(api.intake(input).results[0].reason,'publication_hold');
  p={...f.pkg,sha256:'a'.repeat(64)};fs.writeFileSync(f.manifest,JSON.stringify(p));assert.equal(api.intake(input).results[0].accepted,false);
  fs.writeFileSync(f.manifest,before);input.history.rows=[{published:true,account:'example-creator-4',sha256:'b'.repeat(64),identifiers:['source-1']}];
  assert.equal(api.intake(input).results[0].reason,'already_published');
 }finally{s.close();f.cleanup();}
});
test('missing short name, semantic evidence or mismatching review SHA returns 20',()=>{
 assert.equal(typeof api?.validatePackage,'function');const f=fixture();
 try{
  const {short_product_name,...p}=f.pkg;assert.throws(()=>api.validatePackage(p,{policy:f.policy,manifest:f.manifest}),e=>e.code===20&&e.reason==='short_product_name_missing');
  assert.throws(()=>api.validatePackage({...f.pkg,semantic_review:null},{policy:f.policy,manifest:f.manifest}),e=>e.code===20);
  assert.throws(()=>api.validatePackage({...f.pkg,semantic_review:{...f.pkg.semantic_review,sha256:'b'.repeat(64)}},{policy:f.policy,manifest:f.manifest}),e=>e.code===20);
 }finally{f.cleanup();}
});
test('known published lineage is recognized even after original media was removed',()=>{
 assert.equal(typeof api?.intake,'function');const f=fixture(),s=new State(path.join(f.dir,'state'));
 try{
  fs.unlinkSync(f.file);
  const r=api.intake({state:s,sourceDir:f.src,policy:f.policy,history:{rows:[{published:true,account:'example-creator-4',sha256:f.pkg.sha256}],reservations:[]}});
  assert.equal(r.results[0].reason,'already_published');assert.equal(r.exit_code,10);assert.equal(s.jobs().length,0);
 }finally{s.close();f.cleanup();}
});
