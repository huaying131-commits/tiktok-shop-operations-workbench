// Verify the compatibility command using real readonly sources and a fresh temporary output.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {readJSON,writeJSON,fileHash} from '../lib/common.mjs';
const rehearsal=readJSON('evidence/round2-final.json'),stateDir=rehearsal.summary.state_dir;
const out=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-compat-round2-'));
const result=spawnSync(process.execPath,['cli.mjs','export-compat','--state-dir',stateDir,'--out',out],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
const parsed=JSON.parse(result.stdout),manifest=result.status===0?readJSON(path.join(out,'export-manifest.json')):null;
const sourcesUnchanged=manifest?.source_files.every(r=>fileHash(r.file)===r.sha256)??false;
const outputsVerified=manifest?.outputs.every(r=>fileHash(path.join(out,r.name))===r.sha256)??false;
const worker=manifest?readJSON(path.join(out,'eco-worker-state.json')):null;
const summary={at:new Date().toISOString(),command:['node','cli.mjs','export-compat','--state-dir',stateDir,'--out',out],exit_code:result.status,out_dir:out,production_sources_unchanged:sourcesUnchanged,outputs_verified:outputsVerified,files:parsed.files,unknown_submissions:worker?.unknown_submissions,unknown_uploads:worker?.unknown_uploads?.length,counts_verified:worker?.counts_verified,today_successes:worker?.today_successes};
writeJSON('evidence/real-compat-export.json',{summary,result:parsed,manifest,stderr:result.stderr});console.log(JSON.stringify(summary,null,2));
if(result.status!==0||!sourcesUnchanged||!outputsVerified)process.exitCode=1;
