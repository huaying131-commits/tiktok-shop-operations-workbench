import fs from 'node:fs/promises';
import path from 'node:path';
import {EcoGateway}from './ziniao-eco-gateway.mjs';
const [mode,sectionId,videoId]=process.argv.slice(2);
if(!['ui','rows','video','filter_state','filter_options','popup','calendar','pagination','search_structure'].includes(mode)||!/^[a-z0-9_-]{1,75}$/.test(sectionId??''))throw Error('FixedModeAndUniqueSectionRequired');
if(mode==='video'&&!/^\d{19}$/.test(videoId??''))throw Error('CompleteVideoIdRequired');
const out=await new EcoGateway().section({module:'ads',sectionId,waitMs:20000},async s=>{
 const values=[];
 for(const offset of ['rows','filter_state'].includes(mode)?[0,4,8]:[0]){const r=await s.adsRead('read-'+offset,{mode:mode==='rows'?'creative_rows':mode,offset,...(mode==='video'?{video_id:videoId}:{})});const x=r.value.result;if(x?.ok!==true)throw Error('OwnedProjectionRejected');values.push(x);}
 const first=values[0],result={observed_at:new Date().toISOString(),identity:first.identity,mode,dates:first.data.dates,coverage:'Current rendered page only',data:mode==='rows'?{...first.data,rows:values.flatMap(v=>v.data.rows),offset:0}:mode==='filter_state'?{...first.data,states:values.flatMap(v=>v.data.states),offset:0}:first.data};
 if(mode==='rows'){
  const after=(await s.adsRead('stable-read',{mode:'creative_rows',offset:0})).value.result;
  const signatures=x=>JSON.stringify({dates:x.data.dates,page:x.data.page,first:(x.data.rows??[]).slice(0,4).map(v=>[v.video_id,v.cost,v.orders,v.roi,v.platform_status])});
  if(values.some(v=>JSON.stringify(v.data.dates)!==JSON.stringify(first.data.dates)||v.data.page!==first.data.page)||signatures(first)!==signatures(after))throw Error('TableChangedDuringProjection_NoAggregation');
  const ids=result.data.rows.filter(v=>v.video_id).map(v=>v.video_id);if(new Set(ids).size!==ids.length)throw Error('DuplicateRenderedRows');result.stable_page_verified=true;
 }
 await s.store('store-fixed-projection',result);return result;
});
const dir=path.resolve('outputs/ads-monitoring/2026-10-19/recovery-1832/reads');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,sectionId+'.json'),JSON.stringify(out,null,2),{flag:'wx'});
console.log(JSON.stringify({sectionId,status:out.status,mode,identity:out.result.identity,dates:out.result.dates,data:out.result.data}));
