import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
test('localhost workflow imports synthetic evidence, exposes honest capabilities and exports a packet',{timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'crashlab-http-'));const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
  const child=spawn(process.execPath,['--import','tsx','apps/server/main.ts'],{env:{...process.env,CRASHLAB_DATA_DIR:dir,CRASHLAB_PORT:String(port),AFTERMATH_DECODER:'',BUGSPLAT_CLIENT_ID:'',BUGSPLAT_CLIENT_SECRET:'',BUGSPLAT_EMAIL:'',BUGSPLAT_PASSWORD:'',AI_API_KEY:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const closed=new Promise<void>(r=>child.once('close',()=>r()));let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  try{
    const base='http://127.0.0.1:'+port;for(let i=0;i<100&&!logs.includes('Permafrost Crash Lab:');i++){if(child.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,100));}assert.ok(logs.includes('Permafrost Crash Lab:'),logs);
    const session:any=await fetch(base+'/api/session').then(r=>r.json());const headers={'X-Crashlab-Token':session.token,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/reports')).status,403);
    const invalidHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(base+'/api/session',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(invalidHost,403);
    assert.equal((await fetch(base+'/api/session',{headers:{Origin:'https://attacker.example'}})).status,403);
    const doctor:any=await fetch(base+'/api/doctor',{headers}).then(r=>r.json());assert.equal(doctor.bugsplat.state,'missing-credentials');assert.equal(doctor.decoder.state,'missing-sdk-or-wrapper');assert.equal(doctor.ai.state,'export-only');
    const created:any=await fetch(base+'/api/jobs',{method:'POST',headers,body:JSON.stringify({kind:'import',payload:{path:resolve('fixtures/synthetic/reports.json'),database:'synthetic'}})}).then(r=>r.json());let job:any;
    for(let i=0;i<100;i++){const list:any=await fetch(base+'/api/jobs',{headers}).then(r=>r.json());job=list.find((j:any)=>j.id===created.id);if(['complete','failed'].includes(job?.state))break;await new Promise(r=>setTimeout(r,50));}assert.equal(job.state,'complete',job.error);
    const summary:any=await fetch(base+'/api/summary',{headers}).then(r=>r.json());assert.equal(summary.total,3);assert.equal(summary.syntheticReports,3);
    const packet:any=await fetch(base+'/api/packet?cluster='+summary.clusters[0].id,{headers}).then(r=>r.json());assert.ok(packet.cases[0].evidence.length>0);
    const exported=await fetch(base+'/api/export?cluster='+summary.clusters[0].id+'&language=pl',{headers});assert.equal(exported.status,200);assert.equal(exported.headers.get('content-type'),'application/zip');assert.ok((await exported.arrayBuffer()).byteLength>1000);
    const home=await fetch(base);assert.equal(home.status,200);assert.match(await home.text(),/Permafrost Crash Lab/);
  }finally{child.kill();await closed;assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\crashlab-http-')||resolve(dir).startsWith(resolve(tmpdir())+'/crashlab-http-'));rmSync(dir,{recursive:true,force:true});}
});
