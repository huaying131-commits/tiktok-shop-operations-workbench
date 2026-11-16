import fs from 'node:fs/promises';import path from 'node:path';
import {EcoGateway}from './ziniao-eco-gateway.mjs';
const[kind,id]=process.argv.slice(2);
if(!['inspect','open-search','filter-menu','clear-slash','filter-exploration','filter-check-excluded','filter-apply-excluded','remove-excluded-filter'].includes(kind)||!/^[a-z0-9_-]{1,75}$/.test(id??''))throw Error('FixedFilterActionAndUniqueIDRequired');
const out=await new EcoGateway({allowReportUi:true}).section({module:'ads',sectionId:id,waitMs:20000},async s=>{
 const before=(await s.adsRead('before-search',{mode:'search_structure'})).value.result;if(!before?.ok)throw Error('OwnFilterProjectionRequired');const d=before.data.dates;
 let action=null;if(kind!=='inspect'){action=(await s.adsUi('fixed-'+kind,{kind,expected_start:d.start,expected_end:d.end,expected_pairs:d.pair_count,expected_search:before.data.input?.value??''})).value.result;if(!action?.ok||!action.data.dispatched)throw Error('FilterNotDispatched:'+JSON.stringify(action));}
 const search=(await s.adsRead('after-search',{mode:'search_structure'})).value.result;
 const popup=(await s.adsRead('after-popup',{mode:'popup'})).value.result;
 const filter=(await s.adsRead('after-filter',{mode:'filter_state'})).value.result;
 const result={action,dates:d,search:search.data,popup:popup.data,filter:filter.data,paid_write:false};await s.store('filter-evidence',result);return result;
});const file=path.resolve('outputs/ads-monitoring/2026-10-19/recovery-1832/reads',id+'.json');await fs.writeFile(file,JSON.stringify(out,null,2),{flag:'wx'});console.log(JSON.stringify({file,status:out.status,result:out.result}));
