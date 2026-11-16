import fs from'node:fs/promises';import path from'node:path';
import{EcoGateway}from'./ads-filter-gateway-legacy.mjs';
const[kind,sectionId,label]=process.argv.slice(2);if(!['inspect','open-operator','choose-contains','uncheck-label','check-excluded','apply-excluded'].includes(kind)||!/^[a-z0-9_-]{1,75}$/.test(sectionId??''))throw Error('FixedReportCommandRequired');
const out=await new EcoGateway({root:process.cwd(),allowReportUi:kind!=='inspect'}).section({module:'ads',sectionId,waitMs:20000},async s=>{
 const before=(await s.adsFilterInspect('read-current-filter')).value.result;if(!before?.identity||before.roots?.length!==1)throw Error('OneActualExistingExplorationPopupRequired');let action=null;
 if(kind!=='inspect'){action=(await s.adsFilterUi('fixed-report-'+kind,{kind,expected_operator:before.roots[0].operator.trim(),expected_states:before.roots[0].states,...(label?{label}:{})})).value.result;if(!action?.dispatched)throw Error('ExactFilterNotDispatched');}
 const after=(await s.adsFilterInspect('read-filter-after')).value.result;return{before,action,after,paid_write:false};
});const p=path.resolve('outputs/ads-monitoring/2026-10-19/recovery-1832/reads',sectionId+'.json');await fs.writeFile(p,JSON.stringify(out,null,2),{flag:'wx'});console.log(JSON.stringify({file:p,result:out.result}));
