// Executes the required offline suite and records its complete, unfiltered output.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJSON,writeJSON} from '../lib/common.mjs';
import {plan} from '../lib/planner.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const started=new Date().toISOString();
const result=spawnSync(process.execPath,['--test','tests/'],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
const output=(result.stdout??'')+(result.stderr?'\n[stderr]\n'+result.stderr:'')+(result.error?'\n[runner error]\n'+result.error.stack:'');
const log=path.join(root,'evidence/final-tests.txt');fs.mkdirSync(path.dirname(log),{recursive:true});fs.writeFileSync(log,output,'utf8');
const f=readJSON(path.join(root,'tests/fixtures/history-2026-11-08.json'));
const rows=f.records.map((record,index)=>{
 const snapshot={policy:f.policy,jobs:[record.job],rows:f.records.slice(0,index).map(r=>r.success),ledgerDays:['2026-11-07','2026-11-08'],coverages:[],reservations:[]};
 const chosen=plan(snapshot,record.success.published_at).accounts.find(a=>a.account===record.job.account);
 const prev=f.records.slice(0,index).filter(r=>r.job.account===record.job.account).at(-1);
 const gap=prev?((Date.parse(record.success.published_at)-Date.parse(prev.success.published_at))/1000).toFixed(3):'当日首条';
 const shanghai=new Date(Date.parse(record.success.published_at)+28800000).toISOString().slice(11,23);
 return{video_id:record.job.video_id,account:record.job.account,shanghai_time:shanghai,interval_seconds:gap,decision:chosen.decision,reason:chosen.reason};
});
writeJSON(path.join(root,'evidence/replay-result.json'),{at:new Date().toISOString(),scope:'historical timing/quota/lineage planner replay, not full intake approval',rows});
const table=['| 原视频 | 原账号 | 上海实际观察时间 | 距本号上条秒 | plan |','|---|---|---|---:|---|',...rows.map(r=>`| ${r.video_id} | ${r.account} | ${r.shanghai_time} | ${r.interval_seconds} | ${r.decision} (${r.reason}) |`)].join('\n');
let report=fs.readFileSync(path.join(root,'REPORT.md'),'utf8');
function replaceBlock(text,name,content){const start=`<!-- ${name} -->`,end=`<!-- ${name}_END -->`,a=text.indexOf(start);if(a<0)throw Error('Report marker missing: '+name);const b=text.indexOf(end,a);return text.slice(0,a)+start+'\n\n'+content+'\n\n'+end+text.slice(b<0?a+start.length:b+end.length);}
report=replaceBlock(report,'REPLAY_TABLE',table);
const tests=output.match(/^# tests (\d+)/m)?.[1]??'UNKNOWN',passed=output.match(/^# pass (\d+)/m)?.[1]??'UNKNOWN',failed=output.match(/^# fail (\d+)/m)?.[1]??'UNKNOWN';
const summary=`运行开始：${started}；结束：${new Date().toISOString()}；Node ${process.version}；退出码 ${result.status??'UNKNOWN'}。\n\n测试数 ${tests}；通过 ${passed}；失败 ${failed}。以下为完整 stdout 和 stderr（如有）：\n\n\`\`\`text\n${output.trimEnd()}\n\`\`\``;
report=replaceBlock(report,'TEST_RESULTS',summary);fs.writeFileSync(path.join(root,'REPORT.md'),report,'utf8');
process.stdout.write(output);console.log(JSON.stringify({command:'node --test tests/',exit_code:result.status,tests,passed,failed,report:path.join(root,'REPORT.md')}));
process.exitCode=result.status??1;
