import test from 'node:test';
import assert from 'node:assert/strict';
import {withinWorkWindow} from '../scripts/ziniao-cdp.mjs';
import {planCatchup} from '../scripts/video-publishing/catchup-plan.mjs';
const argv=['--module','content','--environment','90000000000001'];
test('authorized pending content only may continue overnight',()=>{
 for(const at of ['2026-10-16T23:30:00+08:00','2026-10-17T01:00:00+08:00']){
  assert.equal(withinWorkWindow(new Date(at),argv,'','',true),true);
  assert.equal(withinWorkWindow(new Date(at),argv,'','',false),false);
  assert.equal(withinWorkWindow(new Date(at),['--module','ads','--environment','90000000000001'],'','',true),false);
  assert.equal(withinWorkWindow(new Date(at),['--module','content','--environment','90000000000002'],'','',true),false);
 }
});
const account='example-creator-1',history={date:'2026-10-17',accounts:{[account]:{count:0,last_post_at:null}}};
const plan=(records,at='2026-10-17T00:30:00+08:00')=>planCatchup({account,records,history,at,continuation:true});
test('cross-midnight continuation keeps last success interval',()=>{
 const records=[{account,sha256:'a',published:true,published_at:'2026-10-16T23:45:00+08:00'}];
 assert.equal(plan(records).status,'waiting_interval');
 assert.equal(plan(records,'2026-10-17T00:45:00+08:00').can_publish,true);
 assert.equal(plan(records).count,0);
});
test('overnight continuation retains calendar cap and unknown submission barrier',()=>{
 const posts=[0,1,2,3].map(i=>({account,sha256:String(i),published:true,published_at:`2026-10-17T0${i}:00:00+08:00`}));
 assert.equal(plan(posts.slice(0,3),'2026-10-17T03:00:00+08:00').can_publish,true);
 assert.equal(plan(posts,'2026-10-17T04:00:00+08:00').status,'daily_limit_reached');
 assert.equal(plan([{account,sha256:'unknown',status:'unknown_after_submit'}]).status,'query_unknown_submission_first');
 assert.equal(planCatchup({account,records:[],history:{...history,date:'2026-10-16'},at:'2026-10-17T00:30:00+08:00',continuation:true}).status,'history_requires_reconciliation');
});
