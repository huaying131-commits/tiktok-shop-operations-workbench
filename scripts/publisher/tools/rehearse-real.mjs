// No browser imports: only invoke intake and readonly plan against a fresh temporary database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJSON,writeJSON,fileHash} from '../lib/common.mjs';
const publisher=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(publisher,'../..');
const [label='round2-rehearsal']=process.argv.slice(2);if(!/^[a-z0-9-]+$/.test(label))throw Error('safe label required');
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-'+label+'-'));
const source='C:/Users/Operator/Workspace/我的产品/产品视频/未发布视频';
const before=readJSON(path.join(publisher,'evidence/ready-metadata.json')).records.map(r=>({path:r.manifest,sha256:fileHash(r.manifest)}));
const run=command=>{const args=[path.join(publisher,'cli.mjs'),command,'--state-dir',stateDir,...command==='intake'?['--source-dir',source]:[]];const r=spawnSync(process.execPath,args,{cwd:publisher,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});let result;try{result=JSON.parse(r.stdout);}catch{throw Error(r.stderr+r.stdout);}return{command:['node',...args],exit_code:r.status,result,stderr:r.stderr};};
const intake=run('intake'),db=path.join(stateDir,'state.db'),dbBefore=fs.existsSync(db)?fileHash(db):null,plan=run('plan');
const sourceUnchanged=before.every(r=>fileHash(r.path)===r.sha256),planUnchanged=!dbBefore||fileHash(db)===dbBefore;
const distribution={};for(const row of intake.result.results??[])distribution[row.reason]=(distribution[row.reason]??0)+1;
const summary={at:new Date().toISOString(),label,state_dir:stateDir,source_unchanged:sourceUnchanged,plan_database_unchanged:planUnchanged,intake_exit:intake.exit_code,accepted:intake.result.accepted,rejected:intake.result.rejected,distribution,accounts:plan.result.accounts?.map(a=>({account:a.account,decision:a.decision,reason:a.reason,video_id:a.video_id,missing_days:a.missing_days})),unknown_submissions:plan.result.unknown_submissions?.length,unknown_uploads:plan.result.unknown_uploads?.length,history_warnings:plan.result.history_warnings};
writeJSON(path.join(publisher,'evidence',label+'.json'),{summary,intake,plan});console.log(JSON.stringify(summary,null,2));
if(!sourceUnchanged||!planUnchanged)process.exitCode=1;
