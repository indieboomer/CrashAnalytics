import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export class Store {
  db: DatabaseSync; key: Buffer;
  constructor(public root = config.data) {
    mkdirSync(join(root, 'objects'), {recursive:true});
    this.db = new DatabaseSync(join(root, 'crashlab.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS artifacts(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(key TEXT PRIMARY KEY,database_name TEXT NOT NULL,report_id TEXT NOT NULL,revision TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_revisions(report_key TEXT NOT NULL,hash TEXT NOT NULL,raw_hash TEXT NOT NULL,normalized TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(report_key,hash));
      CREATE TABLE IF NOT EXISTS report_artifacts(report_key TEXT NOT NULL,name TEXT NOT NULL,hash TEXT,state TEXT NOT NULL,source TEXT,updated TEXT NOT NULL,PRIMARY KEY(report_key,name));
      CREATE TABLE IF NOT EXISTS attachment_revisions(id TEXT PRIMARY KEY,report_key TEXT NOT NULL,name TEXT NOT NULL,hash TEXT,state TEXT NOT NULL,source TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_items(id TEXT PRIMARY KEY,report_key TEXT NOT NULL,artifact_hash TEXT NOT NULL,locator TEXT NOT NULL,parser TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decoder_runs(cache_key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,output_hash TEXT,state TEXT NOT NULL,metadata TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decoder_attempts(id TEXT PRIMARY KEY,cache_key TEXT NOT NULL,input_hash TEXT NOT NULL,output_hash TEXT,state TEXT NOT NULL,metadata TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_memberships(report_key TEXT NOT NULL,revision TEXT NOT NULL,signature TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(report_key,revision,rules,signature));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,checkpoint TEXT NOT NULL,error TEXT,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS build_mappings(build TEXT PRIMARY KEY,mapping TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS investigation_runs(id TEXT PRIMARY KEY,packet TEXT NOT NULL,hypotheses TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exposure_imports(hash TEXT PRIMARY KEY,data TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,packet_id TEXT NOT NULL,model TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_tool_calls(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,tool TEXT NOT NULL,arguments TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1);
      INSERT OR IGNORE INTO migrations VALUES(2);`);
    const keyPath = join(root, 'pseudonym.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), {mode:0o600,flag:'wx'});
    this.key = readFileSync(keyPath);
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try {const result=fn();this.db.exec('COMMIT');return result;} catch(e){this.db.exec('ROLLBACK');throw e;} }
  put(bytes: Uint8Array):string {
    if(bytes.length>config.maxFile) throw new Error('Artifact exceeds 256 MiB limit');
    const id=hash(bytes), path=this.path(id);
    if (!existsSync(path)) {
      const used = (this.db.prepare('SELECT coalesce(sum(size),0) n FROM artifacts').get() as any).n;
      if(used+bytes.length>config.quota) throw new Error('Local disk quota exceeded');
      const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp';
      writeFileSync(temp,bytes,{flag:'wx',mode:0o600}); renameSync(temp,path);
    }
    this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?)').run(id,bytes.length,new Date().toISOString());
    return id;
  }
  path(id:string) { if(!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact hash');return join(this.root,'objects',id); }
  bytes(id:string) { const data=readFileSync(this.path(id));if(hash(data)!==id) throw new Error('Artifact integrity failure');return data; }
  reports():any[] {return this.db.prepare('SELECT r.key,r.database_name,r.report_id,r.revision,v.normalized FROM reports r JOIN report_revisions v ON v.report_key=r.key AND v.hash=r.revision ORDER BY r.key').all().map((r:any)=>({...r,...JSON.parse(r.normalized)}));}
  evidence(key:string):any[] {
    const entries=this.db.prepare('SELECT * FROM evidence_items WHERE report_key=? ORDER BY id').all(key).map((e:any)=>({...e,value:JSON.parse(e.value)}));
    return entries.map(e=>({...e,status:entries.some(other=>other.field===e.field&&JSON.stringify(other.value)!==JSON.stringify(e.value))?'conflict':e.status}));
  }
  associate(key:string,name:string,id:string|null,state='downloaded',source='import') {
    this.db.prepare('INSERT INTO report_artifacts VALUES(?,?,?,?,?,?) ON CONFLICT(report_key,name) DO UPDATE SET hash=excluded.hash,state=excluded.state,source=excluded.source,updated=excluded.updated').run(key,name,id,state,source,new Date().toISOString());
    this.db.prepare('INSERT OR IGNORE INTO attachment_revisions VALUES(?,?,?,?,?,?,?)').run(hash(JSON.stringify([key,name,id,state,source])),key,name,id,state,source,new Date().toISOString());
  }
  close(){this.db.close();}
}
