import fs from 'node:fs';
import {readJSON,fail,fileHash} from './common.mjs';
export const DEFAULT_AUTOMATION_FILE='C:/Users/Operator/.codex/automations/automation-5/automation.toml';
export function loadRuntimeConfig(file=new URL('../config.json',import.meta.url)){return readJSON(file);}
export function assertLegacyPublisherPaused(file=DEFAULT_AUTOMATION_FILE){
 let text;try{text=fs.readFileSync(file,'utf8');}catch{fail('legacy_publisher_status_unreadable',40,{file});}
 const matches=[...text.matchAll(/^status\s*=\s*"([A-Z_]+)"\s*(?:#.*)?$/gm)];
 const status=matches.length===1?matches[0][1]:'UNKNOWN';
 if(status!=='PAUSED')fail('legacy_publisher_not_paused',40,{file,status});
 return{file,status,sha256:fileHash(file)};
}
