import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {writeJSON,readJSON,digest,safeID,fail} from './common.mjs';

export class State {
  constructor(dir,{readonly=false}={}) {
    this.dir=path.resolve(dir);this.readonly=readonly;
    const file=path.join(this.dir,'state.db');
    if(readonly&&!fs.existsSync(file)){this.db=null;return;}
    if(!readonly)fs.mkdirSync(this.dir,{recursive:true});
    this.db=new DatabaseSync(file,{readOnly:readonly});
    if(!readonly)this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS jobs(video_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(action_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, account TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages(job_id TEXT NOT NULL, stage TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,stage));
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, job_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(source TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_results(source TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }
  close(){this.db?.close();}
  query(sql,...args){return this.db?this.db.prepare(sql).all(...args):[];}
  jobs(){return this.query('SELECT data FROM jobs ORDER BY video_id').map(x=>JSON.parse(x.data));}
  job(id){return this.jobs().find(x=>x.video_id===id);}
  putJob(job){safeID(job.video_id);this.db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(video_id) DO UPDATE SET data=excluded.data').run(job.video_id,JSON.stringify(job));}
  attempts(){return this.query('SELECT data FROM attempts ORDER BY rowid').map(x=>JSON.parse(x.data));}
  beginAction(action){
    const item={...action,status:'unknown',result_unknown:true};
    const file=path.join(this.dir,'intents',digest(action.action_key)+'.json');
    // File first: a crash before the SQL insert still leaves a durable no-replay barrier.
    writeJSON(file,item,true);
    this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?)').run(action.action_key,action.job_id,action.account,action.stage,'unknown',JSON.stringify(item));
    return item;
  }
  action(key){return this.attempts().find(x=>x.action_key===key);}
  finishAction(key,result){const a=this.action(key);if(!a)fail('action_missing',40);const data={...a,...result};this.db.prepare('UPDATE attempts SET status=?,data=? WHERE action_key=?').run(data.status,JSON.stringify(data),key);}
  orphanIntents(){
    const dir=path.join(this.dir,'intents');if(!fs.existsSync(dir))return [];
    const keys=new Set(this.attempts().map(x=>x.action_key));
    return fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(x=>readJSON(path.join(dir,x))).filter(x=>!keys.has(x.action_key));
  }
  stages(id){return this.query('SELECT stage,data FROM stages WHERE job_id=?',id).map(x=>({stage:x.stage,...JSON.parse(x.data)}));}
  stage(id,name){return this.stages(id).find(x=>x.stage===name);}
  complete(id,name,data={}){this.db.prepare('INSERT INTO stages VALUES(?,?,?) ON CONFLICT(job_id,stage) DO UPDATE SET data=excluded.data').run(id,name,JSON.stringify({completed:true,...data}));}
  import(source,data){this.db.prepare('INSERT INTO imports VALUES(?,?) ON CONFLICT(source) DO UPDATE SET data=excluded.data').run(source,JSON.stringify(data));}
  imported(){return this.query('SELECT data FROM imports ORDER BY source').flatMap(x=>JSON.parse(x.data));}
  intakeResult(source,data){this.db.prepare('INSERT INTO intake_results VALUES(?,?) ON CONFLICT(source) DO UPDATE SET data=excluded.data').run(source,JSON.stringify(data));}
  intakeResults(){return this.query('SELECT data FROM intake_results ORDER BY source').map(x=>JSON.parse(x.data));}
  putCase(data){const id=data.id;writeJSON(path.join(this.dir,'cases',id+'.json'),data,true);this.db.prepare('INSERT INTO cases VALUES(?,?,?)').run(id,data.job_id??null,JSON.stringify(data));return path.join(this.dir,'cases',id+'.json');}
  cases(){return this.query('SELECT data FROM cases ORDER BY rowid').map(x=>JSON.parse(x.data));}
}
