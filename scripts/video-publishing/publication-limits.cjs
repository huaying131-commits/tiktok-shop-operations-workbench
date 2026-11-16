const fs=require('fs'),path=require('path');
function resolvePublicationLimits(policy){const p=policy.publishing_target??{},dailyCap=p.natural_day_cap_per_account??3,minimumSeconds=p.minimum_real_success_interval_seconds??3600;if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>5||!Number.isInteger(minimumSeconds)||minimumSeconds<3600)throw Error('InvalidAuthorizedPublicationLimits');return{dailyCap,minimumIntervalMs:minimumSeconds*1000,dailyTargetPerAccount:p.daily_target_per_account??3,dailyTargetTotal:p.daily_total_target??15};}
function getPublicationLimits(){return resolvePublicationLimits(JSON.parse(fs.readFileSync(path.join(__dirname,'../../operations/module-execution-policy.json'),'utf8')));}
module.exports={resolvePublicationLimits,getPublicationLimits};
