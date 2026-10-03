import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { Store,hash } from '../packages/core/store.ts';
import { ingestReport,enrich,importPath,parseXml,safeArchive } from '../packages/ingest/index.ts';
import { summarize,classify } from '../packages/analysis/index.ts';
import { packet,exportPacket,validateHypotheses,redact,analyze } from '../packages/ai/index.ts';
import { importExposure,exposureMetrics } from '../packages/analysis/exposure.ts';
import { createServer } from 'node:http';
import { sync,retry,HttpError,createVendor,type Vendor } from '../packages/bugsplat/index.ts';
import { boundedProcess } from '../packages/core/process.ts';
import { sourceSnippet,linkBuild } from '../packages/project/index.ts';
const temp=()=>mkdtempSync(join(tmpdir(),'crashlab-test-'));
const fixture=(fn:(store:Store,dir:string)=>any)=>async()=>{const dir=temp();const store=new Store(dir);try{await fn(store,dir);}finally{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\crashlab-test-')||resolve(dir).startsWith(resolve(tmpdir())+'/crashlab-test-'));rmSync(dir,{recursive:true,force:true});}};
const xml='<FGenericCrashContext><RuntimeProperties><CrashGUID>demo-guid</CrashGUID><SecondsSinceStart>159</SecondsSinceStart><Misc.GPUDriverUserVersion>demo-1</Misc.GPUDriverUserVersion></RuntimeProperties><GPUBreadcrumbs><Queue name="Graphics"><Node name="VSM" status="active"><Node name="ClearBuffer" status="unknown-new-status"/></Node></Queue><Queue name="Compute"><Node status="finished"/></Queue></GPUBreadcrumbs></FGenericCrashContext>';
test('immutable imports are idempotent, database-scoped, and retain separate repeated incidents',fixture((s)=>{
  const raw={id:1,machineId:'A',appVersion:'old',exceptionMessage:'GPU Crash dump Triggered'};
  ingestReport(s,raw,'one');ingestReport(s,raw,'one');ingestReport(s,raw,'two');ingestReport(s,{...raw,id:2},'one');
  assert.equal(s.reports().length,3);assert.equal(summarize(s).affectedMachineIds,1);assert.equal(summarize(s).total,3);
  const first=s.reports().find(r=>r.key==='one:1').revision;ingestReport(s,{...raw,appVersion:'new'},'one');assert.notEqual(s.reports().find(r=>r.key==='one:1').revision,first);
  assert.equal((s.db.prepare('SELECT count(*) n FROM report_revisions WHERE report_key=?').get('one:1') as any).n,2);
}));
test('nested XML preserves queues, statuses and conflicts despite empty standalone breadcrumbs',fixture(s=>{
  ingestReport(s,{id:1,driver:'conflicting-label',crashGuid:'demo-guid'},'test');enrich(s,'test:1',Buffer.from(xml),'context.xml');enrich(s,'test:1',Buffer.from('GPUBreadcrumbs header'),'breadcrumbs.txt');
  const r=s.reports()[0];assert.equal(r.fields.uptimeUnit,'seconds');assert.equal(r.fields.breadcrumbs[0].Queue.length,2);assert.equal(r.fields.breadcrumbs[0].Queue[0].Node.Node['@status'],'unknown-new-status');
  assert.ok(s.evidence(r.key).filter(e=>e.field==='driver').every(e=>e.status==='conflict'));const revision=r.revision;enrich(s,r.key,Buffer.from(xml),'context.xml');assert.equal(s.reports()[0].revision,revision);
}));
test('same filenames remain associated with distinct reports and identical bytes are stored once',fixture((s,dir)=>{
  const input=join(dir,'input');mkdirSync(input);for(const id of [1,2]){const folder=join(input,String(id));mkdirSync(folder);writeFileSync(join(folder,'report.json'),JSON.stringify({id}));writeFileSync(join(folder,'log.txt'),'same bytes');}
  const result=importPath(s,input,'test');assert.equal(result.reports,2);assert.equal(result.warnings.length,0);const attachments=s.db.prepare("SELECT * FROM report_artifacts WHERE name LIKE '%log.txt'").all() as any[];assert.equal(attachments.length,2);assert.equal(attachments[0].hash,attachments[1].hash);importPath(s,input,'test');assert.equal(s.reports().length,2);
}));
test('XML DTD, excessive nesting, ZIP traversal and decompression bombs are rejected',()=>{
  assert.throws(()=>parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x>&e;</x>'));
  assert.throws(()=>parseXml('<x>'.repeat(70)+'</x>'.repeat(70)));
  assert.throws(()=>safeArchive(zipSync({'../secret':strToU8('bad')})));
  assert.throws(()=>safeArchive(zipSync({'huge.txt':new Uint8Array(2*1024*1024)})));
});
test('unknowns remain unknown and no crash probability or causal breadcrumb clustering is inferred',fixture(s=>{
  ingestReport(s,{id:1,exceptionMessage:'GPU Crash dump Triggered',callstack:'ReportGPUCrash\nFirstPath'},'t');ingestReport(s,{id:2,exceptionMessage:'GPU Crash dump Triggered',callstack:'ReportGPUCrash\nDifferentPath'},'t');
  const metrics=summarize(s);assert.equal(metrics.clusters.length,2);assert.equal(metrics.unknownMachineReports,2);assert.equal(metrics.uptime.median,null);assert.equal(s.reports()[0].fields.aftermath,null);assert.ok(metrics.caveats[0].includes('no crash probability'));assert.equal(classify({error:'Out of memory'}).family,'out-of-memory');
}));
test('packets pseudonymize machines, redact private strings and mechanically reject invalid citations',fixture(s=>{
  ingestReport(s,{id:1,machineId:'private-machine',email:'player@example.test',comments:'private player text',callstack:'C:\\Users\\Alice\\source.cpp',gpu:'Demo GPU',exceptionMessage:'GPU Crash dump Triggered'},'test');
  const p=packet(s),text=JSON.stringify(p);for(const secret of ['private-machine','player@example.test','private player text','Alice'])assert.ok(!text.includes(secret));
  assert.ok(text.includes('machine-'));assert.throws(()=>validateHypotheses([{status:'confirmed'}],p));
  const h={title:'Candidate',status:'hypothesis',confidence:'low',confidence_reason:'limited',mechanism:'Candidate mechanism',supporting_evidence_ids:['fake'],contradicting_evidence_ids:[],missing_evidence:[],alternative_explanations:[],next_test:{change:'one',target_cohort:'test',supporting_outcome:'present',refuting_outcome:'absent'}};
  assert.throws(()=>validateHypotheses([h],p),/Invalid evidence/);h.supporting_evidence_ids=[p.cases[0].evidence[0].id];assert.equal(validateHypotheses([h],p).length,1);
  const archive=unzipSync(exportPacket(s,p,'pl'));assert.ok(Buffer.from(archive['report.md']).toString().includes('Ustalono'));assert.ok(!Object.keys(archive).some(x=>x.includes('dump')));
}));
test('resumable overlapping synchronization deduplicates IDs and reconciles delayed attachments',fixture(async(s)=>{
  let available=false;const checkpoints:any[]=[];const bundle=Buffer.from(zipSync({'context.xml':strToU8(xml),'dump.nv-gpudmp':strToU8('synthetic invalid dump')}));
  const v:Vendor={async list(){return [{id:1}]},async details(){return {id:1,exceptionMessage:'GPU Crash dump Triggered',dumpfile:available?'https://test.s3.amazonaws.com/signed':null}},async download(){return bundle}};
  const options={database:'test',attachments:'all' as const};await sync(s,options,{},c=>checkpoints.push(c),new AbortController().signal,v);assert.equal(s.reports().length,1);assert.equal((s.db.prepare("SELECT state FROM report_artifacts WHERE name='vendor-bundle.zip'").get() as any).state,'pending');
  available=true;await sync(s,options,{page:1},c=>checkpoints.push(c),new AbortController().signal,v);assert.equal(s.reports().length,1);assert.ok(s.db.prepare("SELECT 1 FROM report_artifacts WHERE name='dump.nv-gpudmp' AND state='downloaded'").get());assert.ok(!s.bytes((s.db.prepare('SELECT raw_hash FROM report_revisions LIMIT 1').get() as any).raw_hash).toString().includes('https://'));
}));
test('failed page does not lose successful reports; resume retries failed work',fixture(async(s)=>{
  let failure=true;let checkpoint:any={};const v:Vendor={async list(){return [{id:1},{id:2}]},async details(_db,id){if(id===2&&failure)throw new Error('transient');return {id};},async download(){return Buffer.alloc(0)}};
  await assert.rejects(sync(s,{database:'test',attachments:'metadata'},checkpoint,c=>checkpoint=c,new AbortController().signal,v));assert.equal(s.reports().length,1);failure=false;await sync(s,{database:'test',attachments:'metadata'},checkpoint,c=>checkpoint=c,new AbortController().signal,v);assert.equal(s.reports().length,2);
}));
test('transient network retries are bounded and use injected waits',async()=>{let attempts=0;const waits:number[]=[];const result=await retry(async()=>{if(++attempts<3)throw new Error('network');return 'ok';},undefined,async ms=>{waits.push(ms);});assert.equal(result,'ok');assert.equal(waits.length,2);});
test('decoder subprocess crashes and timeouts are isolated',async()=>{
  const crash=await boundedProcess(process.execPath,['-e','process.exit(2)'],5000);assert.equal(crash.code,2);
  const timeout=await boundedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],100);assert.equal(timeout.state,'timeout');
  const next=await boundedProcess(process.execPath,['-e','console.log("next dump")'],5000);assert.equal(next.code,0);assert.match(next.stdout,/next dump/);
});
test('unmapped historical builds fail rather than inspecting current HEAD',fixture(async(s)=>{await assert.rejects(sourceSnippet(s,'historical','source.cpp'),/No historical/);await assert.rejects(linkBuild(s,{build:'old',repository:'.',commit:'HEAD'}),/exact full commit/);}));
test('log evidence retains line ranges and does not erase nested XML breadcrumbs',fixture(s=>{
  ingestReport(s,{id:1},'test');enrich(s,'test:1',Buffer.from(xml),'context.xml');enrich(s,'test:1',Buffer.from('LogD3D12: Error: GPU Crash dump Triggered\nLogWindows: Error: [Callstack] RenderGraph::Execute\nLogWindows: Error: [Callstack] RenderThread::Run'),'game.log');
  assert.equal(s.reports()[0].fields.breadcrumbs.length,1);assert.ok(s.evidence('test:1').some(e=>e.parser==='log-1'&&e.locator==='lines:2-3'));assert.equal(classify(s.reports()[0].fields).family,'gpu-fault');
}));
test('exposure rates use compatible periods/cohorts and never count repeated incidents as computers',fixture((s,dir)=>{
  for(const id of [1,2])ingestReport(s,{id,appVersion:'build',gpu:'gpu',driver:'driver',machineId:'same-machine',crashTime:'2026-01-01T10:00:00Z'},'test');
  ingestReport(s,{id:3,appVersion:'other-build',gpu:'gpu',driver:'driver',crashTime:'2026-01-01T10:00:00Z'},'test');
  const path=join(dir,'exposure.csv');writeFileSync(path,'period_start,period_end,build,gpu,driver,sessions,distinct_machine_ids,gameplay_hours\n2026-01-01T00:00:00Z,2026-01-02T00:00:00Z,build,gpu,driver,100,10,50\n');importExposure(s,path);const metrics=exposureMetrics(s);assert.equal(metrics.coveredReports,2);assert.equal(metrics.uncoveredReports,1);assert.equal(metrics.cohorts[0].affectedReportedMachineIds,1);assert.equal(metrics.cohorts[0].reportedIncidentsPerSession,.02);assert.equal(metrics.cohorts[0].affectedIdShare,.1);assert.equal(importExposure(s,path).duplicate,true);
  writeFileSync(path,readFileSync(path,'utf8').replace(',100,',',200,'));assert.throws(()=>importExposure(s,path),/Overlapping/);
}));
test('keyset pages advance, overlap safely on resume and do not depend on offset positions',fixture(async(s)=>{
  const calls:number[]=[];let saved:any={};const v:Vendor={async list(o,page){assert.equal(page,0);calls.push(o.afterId??0);return Array.from({length:55},(_,i)=>({id:i+1})).filter(r=>r.id>(o.afterId??0)).slice(0,50);},async details(_db,id){return {id}},async download(){return Buffer.alloc(0);}};
  await sync(s,{database:'test',attachments:'metadata'},saved,c=>saved=c,new AbortController().signal,v);assert.deepEqual(calls,[0,50]);assert.equal(s.reports().length,55);await sync(s,{database:'test',attachments:'metadata'},saved,c=>saved=c,new AbortController().signal,v);assert.equal(calls.at(-1),50);assert.equal(s.reports().length,55);
}));
test('expired signed URL is refreshed without losing associated artifacts',fixture(async(s)=>{
  let details=0,downloads=0;const v:Vendor={async list(){return [{id:1}]},async details(){details++;return {id:1,dumpfile:details===1?'expired':'refreshed'};},async download(url){downloads++;if(url==='expired')throw new HttpError(403,null);return Buffer.from(zipSync({'context.xml':strToU8(xml)}));}};
  await sync(s,{database:'test',attachments:'all'},{},()=>{},new AbortController().signal,v);assert.equal(s.reports().length,1);assert.equal(details,2);assert.equal(downloads,2);
}));
test('HTTP 429 respects Retry-After and account auth errors do not retry',async()=>{
  let attempts=0;const waits:number[]=[];await retry(async()=>{if(++attempts===1)throw new HttpError(429,'2');return true;},undefined,async ms=>{waits.push(ms);});assert.deepEqual(waits,[2000]);let authCalls=0;await assert.rejects(retry(async()=>{authCalls++;throw new HttpError(401,null);},undefined,async()=>{}));assert.equal(authCalls,1);
});
test('official BugSplat client listing route is permitted while report mutations stay blocked',async()=>{
  const requests:{route:string,method:string}[]=[];
  const client={createFormData:()=>new FormData(),async fetch(route:string,init:any){requests.push({route,method:init.method});return new Response(JSON.stringify(route.startsWith('/api/crash/details')?{id:1,unknownField:'retained'}:{rows:[{id:'1',appName:'SyntheticDemo',appVersion:'demo'}],pageData:{}}),{status:200,headers:{'Content-Type':'application/json'}});}};
  const adapter=createVendor(client);
  const rows=await adapter.list({database:'synthetic',attachments:'metadata'},0);assert.equal(rows.length,1);assert.deepEqual(requests[0],{route:'/api/crashes.php',method:'POST'});
  const detail=await adapter.details('synthetic',1);assert.equal(detail.unknownField,'retained');
  await assert.rejects(client.fetch('/api/crashes.php',{method:'DELETE'}),/not allowlisted/);
  await assert.rejects(client.fetch('/api/crash/notes',{method:'POST'}),/not allowlisted/);
  await assert.rejects(client.fetch('/api/crashes.php/other',{method:'POST'}),/not allowlisted/);
});
test('OAuth scope denial is actionable without exposing unrelated vendor error fields',async()=>{
  const client={createFormData:()=>new FormData(),async fetch(){return new Response(JSON.stringify({message:'The access token does not have sufficient scope. Required: restricted',access_token:'must-not-leak'}),{status:403});}};
  const adapter=createVendor(client);await assert.rejects(adapter.list({database:'synthetic',attachments:'metadata'},0),(error:any)=>{assert.match(error.message,/Required scope: restricted/);assert.ok(!error.message.includes('must-not-leak'));return true;});
});
test('optional provider tools are scoped, logged, validated and cached using a synthetic local provider',fixture(async(s)=>{
  ingestReport(s,{id:1,gpu:'Synthetic GPU',exceptionMessage:'GPU Crash dump Triggered'},'synthetic');const p=packet(s);let requests=0;
  const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:requests===1?{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'get_evidence',arguments:JSON.stringify({id:p.cases[0].evidence[0].id})}}]}:{role:'assistant',content:JSON.stringify({hypotheses:[]})}}]}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address() as any;const saved={base:process.env.AI_BASE_URL,key:process.env.AI_API_KEY,model:process.env.AI_MODEL};process.env.AI_BASE_URL='http://127.0.0.1:'+addr.port+'/v1';process.env.AI_API_KEY='synthetic-not-a-real-key';process.env.AI_MODEL='synthetic-provider';
  try{const result=await analyze(s,p);assert.equal(result.hypotheses.length,0);assert.equal(requests,2);assert.equal((s.db.prepare('SELECT count(*) n FROM ai_tool_calls').get() as any).n,1);assert.equal((await analyze(s,p)).cached,true);assert.equal(requests,2);}finally{for(const [env,value] of [['AI_BASE_URL',saved.base],['AI_API_KEY',saved.key],['AI_MODEL',saved.model]]){if(value===undefined)delete process.env[env!];else process.env[env!]=value;}await new Promise<void>(r=>server.close(()=>r()));}
}));
