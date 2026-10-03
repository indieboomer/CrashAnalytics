import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../packages/core/store.ts';
import { config } from '../../packages/core/config.ts';
import { Jobs } from '../../packages/core/jobs.ts';
import { summarize } from '../../packages/analysis/index.ts';
import { packet, exportPacket } from '../../packages/ai/index.ts';
import { doctor } from '../../packages/decoder/index.ts';
import { linkBuild, sourceSnippet, sourceDiff } from '../../packages/project/index.ts';
import { vendor } from '../../packages/bugsplat/index.ts';
const store=new Store(), jobs=new Jobs(store);const token=randomBytes(32).toString('hex');void jobs.pump();
async function body(req:IncomingMessage){let data='';for await(const chunk of req){data+=chunk;if(data.length>1024*1024)throw new Error('Request size limit');}return data?JSON.parse(data):{};}
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
    const origin='http://127.0.0.1:'+config.port;
    if(req.headers.host!== '127.0.0.1:'+config.port&&req.headers.host!=='localhost:'+config.port){res.writeHead(403);res.end('Invalid host');return;}
    if(req.headers.origin && ![origin,'http://localhost:'+config.port].includes(req.headers.origin)){res.writeHead(403);res.end('Invalid origin');return;}
    const url=new URL(req.url??'/',origin),path=url.pathname;const json=(data:any,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(path==='/api/session'&&req.method==='GET'){if(req.headers['sec-fetch-site']==='cross-site')throw new Error('Cross-site request');json({token});return;}
    if(path.startsWith('/api/')&&req.headers['x-crashlab-token']!==token){json({error:'Local session required'},403);return;}
    if(req.method==='GET'){
      if(path==='/api/doctor'){json(await doctor());return;}
      if(path==='/api/summary'){json(summarize(store,Object.fromEntries(url.searchParams)));return;}
      if(path==='/api/reports'){json(store.reports());return;}
      if(path==='/api/case'){const key=url.searchParams.get('id')??'';json({report:store.reports().find(r=>r.key===key),evidence:store.evidence(key),attachments:store.db.prepare('SELECT * FROM report_artifacts WHERE report_key=?').all(key)});return;}
      if(path==='/api/jobs'){json(jobs.list());return;}
      if(path==='/api/mappings'){json(store.db.prepare('SELECT * FROM build_mappings').all().map((m:any)=>JSON.parse(m.mapping)));return;}
      if(path==='/api/packet'){json(packet(store,url.searchParams.get('cluster')??undefined));return;}
      if(path==='/api/source'){json(await sourceSnippet(store,url.searchParams.get('build')??'',url.searchParams.get('file')??'',Number(url.searchParams.get('start')??1),Number(url.searchParams.get('end')??100)));return;}
      if(path==='/api/diff'){json(await sourceDiff(store,url.searchParams.get('good')??'',url.searchParams.get('bad')??''));return;}
      if(path==='/api/export'){const p=packet(store,url.searchParams.get('cluster')??undefined);const saved=store.db.prepare("SELECT hypotheses FROM investigation_runs WHERE json_extract(packet,'$.id')=? ORDER BY created DESC LIMIT 1").get(p.id) as any;res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="crashlab-investigation.zip"'});res.end(exportPacket(store,p,url.searchParams.get('language')??'en',saved?JSON.parse(saved.hypotheses):[]));return;}
    }else if(req.method==='POST'){
      const data=await body(req);
      if(path==='/api/jobs'){json(jobs.create(data.kind,data.payload??{}),202);return;}
      if(path==='/api/cancel'){jobs.cancel(data.id);json({ok:true});return;}
      if(path==='/api/resume'){jobs.resume(data.id);json({ok:true});return;}
      if(path==='/api/mappings'){json(await linkBuild(store,data));return;}
      if(path==='/api/preview-sync'){const v=await vendor(),rows=await v.list(data,0);json({pageCount:rows.length,totalCount:null,note:'Bounded first-page preview; full count unavailable until listing completes',attachmentPolicy:data.attachments});return;}
    }
    if(path.startsWith('/api/')){json({error:'Endpoint not found'},404);return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    const web=resolve('dist/web');const requested=resolve(web,'.'+path);if(!requested.startsWith(web+ '\\')&&!requested.startsWith(web+'/')&&requested!==web)throw new Error('Unsafe path');const file=existsSync(requested)&&extname(requested)?requested:resolve(web,'index.html');
    if(!existsSync(file)){res.writeHead(503,{'Content-Type':'text/plain'});res.end('Build the UI with npm run build first.');return;}
    res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'} as any)[extname(file)]??'application/octet-stream','Content-Security-Policy':"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(readFileSync(file));
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e instanceof Error?e.message:'Request failed'}));}
});
server.listen(config.port,'127.0.0.1',()=>console.log('Permafrost Crash Lab: http://127.0.0.1:'+config.port));
process.on('SIGINT',()=>{for(const c of jobs.active.values())c.abort();server.close(()=>{store.close();process.exit(0);});});
