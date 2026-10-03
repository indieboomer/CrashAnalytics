import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.ts';
import { sync, vendor, HttpError, type SyncOptions } from '../bugsplat/index.ts';
import { decodePending } from '../decoder/index.ts';
import { importPath } from '../ingest/index.ts';
import { analyze, packet } from '../ai/index.ts';
import { importExposure } from '../analysis/exposure.ts';
export class Jobs {
  active=new Map<string,AbortController>(); running=false;
  constructor(public store:Store){
    const lock=join(store.root,'worker.lock');
    if(existsSync(lock)){
      const owner=Number(readFileSync(lock,'utf8'));let alive=false;try{process.kill(owner,0);alive=true;}catch{}
      if(alive)throw new Error('A worker is already running for this data directory. Use its UI or stop it before starting CLI jobs.');
      unlinkSync(lock);
    }
    writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
    process.once('exit',()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}catch{}});
    store.db.prepare("UPDATE jobs SET state='queued' WHERE state='running'").run();
  }
  list(){return this.store.db.prepare('SELECT * FROM jobs ORDER BY updated DESC').all().map((j:any)=>({...j,payload:JSON.parse(j.payload),checkpoint:JSON.parse(j.checkpoint)}));}
  create(kind:string,payload:any){if(!['sync','decode','import','ai','exposure'].includes(kind))throw new Error('Unknown job kind');
    if(kind==='sync'){
      if(payload.incremental&&!payload.from){const matches=this.store.reports().filter(r=>r.database_name===payload.database&&(!payload.application||r.fields.application===payload.application)&&(!payload.build||r.fields.build===payload.build)).map(r=>Date.parse(r.fields.timeUtc)).filter(Number.isFinite);if(matches.length)payload={...payload,from:new Date(Math.max(...matches)-48*3600*1000).toISOString()};}
      payload={...payload,to:payload.to||new Date().toISOString()};
    }
    const id=randomUUID();this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,kind,'queued',JSON.stringify(payload),'{}',null,new Date().toISOString());void this.pump();return {id};}
  cancel(id:string){this.active.get(id)?.abort();this.store.db.prepare("UPDATE jobs SET state='cancelled',updated=? WHERE id=?").run(new Date().toISOString(),id);}
  resume(id:string){if(this.active.has(id))throw new Error('Job still stopping');this.store.db.prepare("UPDATE jobs SET state='queued',error=NULL,updated=? WHERE id=? AND state IN ('failed','cancelled')").run(new Date().toISOString(),id);void this.pump();}
  async pump(){if(this.running)return;this.running=true;try{for(;;){const job=this.store.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY updated LIMIT 1").get() as any;if(!job)break;const controller=new AbortController();this.active.set(job.id,controller);this.store.db.prepare("UPDATE jobs SET state='running',updated=? WHERE id=?").run(new Date().toISOString(),job.id);
    const checkpoint=(c:any)=>this.store.db.prepare('UPDATE jobs SET checkpoint=?,updated=? WHERE id=?').run(JSON.stringify(c),new Date().toISOString(),job.id);
    try{const p=JSON.parse(job.payload);let result:any;
      if(job.kind==='sync'){result=await sync(this.store,p as SyncOptions,JSON.parse(job.checkpoint),checkpoint,controller.signal,await vendor());if(!result.complete)throw new Error('Page budget reached; resume required');}
      else if(job.kind==='decode')result=await decodePending(this.store,controller.signal);
      else if(job.kind==='ai'){const current=packet(this.store,p.cluster);if(p.packetId&&current.id!==p.packetId)throw new Error('Evidence changed since payload review');result=await analyze(this.store,current,controller.signal);}
      else if(job.kind==='exposure')result=importExposure(this.store,p.path);
      else result=importPath(this.store,p.path,p.database);
      controller.signal.throwIfAborted();checkpoint(result);this.store.db.prepare("UPDATE jobs SET state='complete',updated=? WHERE id=?").run(new Date().toISOString(),job.id);
    }catch(e){const message=job.kind==='sync'?(e instanceof HttpError?e.message:'Sync incomplete: check local credentials, permissions, network and attachment status; resume retries committed overlap.'):job.kind==='ai'?'AI request failed or output validation rejected.':String(e instanceof Error?e.message:e);this.store.db.prepare('UPDATE jobs SET state=?,error=?,updated=? WHERE id=?').run(controller.signal.aborted?'cancelled':'failed',message,new Date().toISOString(),job.id);}finally{this.active.delete(job.id);}
  }}finally{this.running=false;}}
}
