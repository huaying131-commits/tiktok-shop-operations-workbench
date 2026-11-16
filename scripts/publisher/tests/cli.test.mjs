import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './support.mjs';
const cli=new URL('../cli.mjs',import.meta.url);
function invoke(args){return spawnSync(process.execPath,[decodeURIComponent(cli.pathname).replace(/^\/(?:([A-Za-z]:))/, '$1'),...args],{encoding:'utf8',windowsHide:true});}
test('CLI status and plan do not create state or any root files',()=>{
 const f=fixture();try{
  fs.mkdirSync(path.join(f.dir,'operations'));fs.writeFileSync(path.join(f.dir,'operations','module-execution-policy.json'),JSON.stringify(f.policy));
  const state=path.join(f.dir,'nonexistent');
  for(const command of ['status','plan']){
   const r=invoke([command,'--root',f.dir,'--state-dir',state,'--at',f.at]);
   assert([0,10,20].includes(r.status),r.stderr+r.stdout);assert(!fs.existsSync(state));assert.doesNotThrow(()=>JSON.parse(r.stdout));
  }
 }finally{f.cleanup();}
});
test('CLI intake records cases; dry and invalid live never import a real browser transport',()=>{
 const f=fixture();try{
  fs.mkdirSync(path.join(f.dir,'operations'));fs.writeFileSync(path.join(f.dir,'operations','module-execution-policy.json'),JSON.stringify(f.policy));
  const out=path.join(f.dir,'outputs','video-publishing-2026-11-07');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'发布记录.jsonl'),'');
  const common=['--root',f.dir,'--state-dir',path.join(f.dir,'state'),'--at',f.at];
  let r=invoke(['intake','--source-dir',f.src,...common]);assert.equal(r.status,0,r.stderr+r.stdout);
  r=invoke(['run','--job',f.pkg.video_id,...common]);assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(JSON.parse(r.stdout).browser_validated,false);
  r=invoke(['run','--job',f.pkg.video_id,'--mode','live',...common]);assert.equal(r.status,40);assert.match(r.stdout,/approval/);
 }finally{f.cleanup();}
});
test('CLI dry run records a history gap before closing the state database', () => {
 const f = fixture();
 try {
  fs.mkdirSync(path.join(f.dir, 'operations'));
  fs.writeFileSync(path.join(f.dir, 'operations', 'module-execution-policy.json'), JSON.stringify(f.policy));
  const common = ['--root', f.dir, '--state-dir', path.join(f.dir, 'state'), '--at', f.at];
  const intake = invoke(['intake', '--source-dir', f.src, ...common]);
  assert.equal(intake.status, 0, intake.stderr + intake.stdout);
  const run = invoke(['run', '--job', f.pkg.video_id, '--mode', 'dry', ...common]);
  assert.equal(run.status, 20, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.reason, 'history_gap');
  assert.equal(JSON.parse(fs.readFileSync(report.case_file, 'utf8')).submit_intent_exists, false);
 } finally {
  f.cleanup();
 }
});
