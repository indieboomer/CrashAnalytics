import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { Store, hash } from '../core/store.ts';
import { config } from '../core/config.ts';
export const PARSER='ingest-1';
const aliases: Record<string,string[]> = {
  crashGuid:['crashguid'], machine:['machineid','machineidentifier','loginid'], application:['appname','application','gamename'], build:['appversion','build','buildversion'],
  time:['crashtime','timestamp','timeofcrash','date'], uptime:['secondsinces tart','secondssincestart','uptime','uptimeseconds'], error:['errormessage','exceptionmessage','error'],
  stack:['callstack','stack','portablecallstack','stackframes'], gpu:['miscprimarygpubrand','gpuname','gpu'], cpu:['misccpubrand','cpuname','cpu'], driver:['miscgpudriveruserversion','driver'], driverInternal:['miscgpudriverinternalversion','driverinternal'],
  os:['misc osversionmajor','os','osversion'], engine:['engineversion'], renderingApi:['rhiname','renderingapi'], ram:['memorytotalphysical','ram'],vram:['vram'], aftermath:['baftermathenabled','aftermathenabled'],dred:['bdredenabled','dredenabled'],graphicsSettings:['graphicssettings']
};
const clean=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
export function walk(value:any, locator='', depth=0, out:{path:string,key:string,value:any}[]=[]):typeof out {
  if(depth>64) throw new Error('Input nesting exceeds 64 levels');
  if(value && typeof value==='object') for(const [key,v] of Object.entries(value)) {const path=locator+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1');out.push({path,key,value:v});walk(v,path,depth+1,out);}
  return out;
}
export function parseXml(text:string):any {
  if(/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities and DTDs are prohibited');
  if(XMLValidator.validate(text)!==true) throw new Error('Malformed XML');
  // Ordered nodes preserve queue hierarchy, repeated labels, attributes and unknown statuses.
  const result=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,trimValues:false}).parse(text);walk(result);return result;
}
export function normalize(raw:any, artifact:string) {
  const all=walk(raw), fields:Record<string,any>={}, evidence:any[]=[];
  for(const [field,names] of Object.entries(aliases)) {
    const matches=all.filter(e=>names.map(clean).includes(clean(e.key)) && e.value!=='' && e.value!==null && e.value!==undefined);
    fields[field]=matches[0]?.value ?? null;
    for(const m of matches) evidence.push({id:'ev-'+hash(artifact+m.path+field).slice(0,24),artifact_hash:artifact,locator:m.path,parser:PARSER,field,value:m.value,status:matches.some(x=>JSON.stringify(x.value)!==JSON.stringify(m.value))?'conflict':'parsed'});
  }
  const trees=all.filter(x=>clean(x.key)==='gpubreadcrumbs');
  fields.breadcrumbs=trees.map(x=>x.value);
  for(const m of trees) evidence.push({id:'ev-'+hash(artifact+m.path).slice(0,24),artifact_hash:artifact,locator:m.path,parser:PARSER,field:'breadcrumbs',value:m.value,status:'parsed'});
  fields.uptimeOrigin=fields.uptime!==null?'engine-reported; no stopwatch alignment':null;fields.uptimeUnit=fields.uptime===null?null:all.some(x=>['secondssincestart','uptimeseconds'].includes(clean(x.key)))?'seconds':'unknown';
  if(fields.time){ const text=String(fields.time);fields.timeUtc=/Z$|[+-]\d\d:\d\d$/.test(text)&&Number.isFinite(Date.parse(text))?new Date(text).toISOString():null; }
  return {fields,evidence};
}
export function parseLog(text:string,artifact:string){
  const lines=text.split(/\r?\n/);if(lines.length>200000)throw new Error('Log line count limit');const raw:Record<string,string>={},locations:Record<string,string>={};
  const known=new Set(Object.values(aliases).flat().map(clean));
  for(let i=0;i<lines.length;i++){
    const match=lines[i].match(/(?:^|\s)([A-Za-z][A-Za-z0-9_. ]{0,80})\s*[:=]\s*(.+)$/);
    if(match&&known.has(clean(match[1]))){raw[match[1].trim()]=match[2].trim();locations[match[1].trim()]='lines:'+(i+1)+'-'+(i+1);}
    if(!raw.ErrorMessage&&/GPU Crash dump Triggered|DXGI_ERROR_DEVICE_(?:HUNG|REMOVED)|out of memory|Unhandled Exception:.*ACCESS_VIOLATION/i.test(lines[i])){raw.ErrorMessage=lines[i];locations.ErrorMessage='lines:'+(i+1)+'-'+(i+1);}
  }
  const frames=lines.map((line,i)=>({line,i})).filter(x=>/\[Callstack\]/i.test(x.line));if(frames.length){raw.Callstack=frames.map(x=>x.line.replace(/^.*?\[Callstack\]\s*/i,'')).join('\n');locations.Callstack='lines:'+(frames[0].i+1)+'-'+(frames.at(-1)!.i+1);}
  const parsed=normalize(raw,artifact);parsed.evidence=parsed.evidence.map(e=>({...e,parser:'log-1',locator:locations[e.locator.slice(1)]??e.locator}));return parsed;
}
export function ingestReport(store:Store,raw:any,database='import',id?:string, origin?:string) {
  if(!raw || typeof raw!=='object'||Array.isArray(raw)) throw new Error('Report must be an object');
  const bytes=Buffer.from(JSON.stringify(raw)), artifact=store.put(bytes), flat=walk(raw);
  const reportId=String(id ?? raw.id ?? raw.Id ?? raw.ID ?? raw.reportId ?? flat.find(x=>clean(x.key)==='crashguid')?.value ?? 'artifact-'+artifact);
  const db=String(raw.database ?? raw.databaseName ?? database); const key=db+':'+reportId;
  const {fields,evidence}=normalize(raw,artifact); const revision=hash(JSON.stringify({artifact,PARSER}));
  if(Array.isArray(fields.stack)) fields.stack=fields.stack.map((f:any)=>f.functionName??f.symbol??'').filter(Boolean).join('\n');
  const existing=store.db.prepare('SELECT v.raw_hash FROM reports r JOIN report_revisions v ON v.report_key=r.key AND v.hash=r.revision WHERE r.key=?').get(key) as any;
  store.transaction(()=>{
    store.db.prepare('INSERT OR IGNORE INTO report_revisions VALUES(?,?,?,?,?)').run(key,revision,artifact,JSON.stringify({fields,parser:PARSER,origin:origin??'import'}),new Date().toISOString());
    if(existing?.raw_hash!==artifact) store.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,updated=excluded.updated').run(key,db,reportId,revision,new Date().toISOString());
    for(const e of evidence) store.db.prepare('INSERT OR IGNORE INTO evidence_items VALUES(?,?,?,?,?,?,?,?)').run('ev-'+hash(key+e.id).slice(0,24),key,e.artifact_hash,e.locator,e.parser,e.field,JSON.stringify(e.value),e.status);
    store.associate(key,'raw-report-'+artifact+'.json',artifact);
  });
  for(const leaf of flat.filter(x=>typeof x.value==='string' && /^\s*(<\?xml|<FGenericCrashContext)/.test(x.value))) enrich(store,key,Buffer.from(leaf.value),'embedded'+leaf.path+'.xml');
  return key;
}
export function enrich(store:Store,key:string,bytes:Uint8Array,name:string) {
  const artifact=store.put(bytes); store.associate(key,name,artifact);
  if(!/\.xml$|\.runtime-xml$|\.log$|\.txt$/i.test(name)) return;
  const text=Buffer.from(bytes).toString('utf8');const isXml=/\.xml$|\.runtime-xml$/i.test(name);
  const {fields,evidence}=isXml?normalize(parseXml(text),artifact):parseLog(text,artifact);
  store.transaction(()=>{
    const report=store.reports().find(r=>r.key===key); if(!report) throw new Error('Unknown report association');
    for(const e of evidence) store.db.prepare('INSERT OR IGNORE INTO evidence_items VALUES(?,?,?,?,?,?,?,?)').run('ev-'+hash(key+e.id).slice(0,24),key,e.artifact_hash,e.locator,e.parser,e.field,JSON.stringify(e.value),e.status);
    const combined={...report.fields};for(const [field,value] of Object.entries(fields)) if(value!==null && (!Array.isArray(value)||value.length)) combined[field]=value;
    const previous=store.db.prepare('SELECT raw_hash FROM report_revisions WHERE report_key=? AND hash=?').get(key,report.revision) as any;
    const revision=hash(JSON.stringify({raw:previous.raw_hash,fields:combined,PARSER}));
    if(store.db.prepare('SELECT 1 FROM report_revisions WHERE report_key=? AND hash=?').get(key,revision)) return;
    // Keep all candidates in evidence; latest XML is a display view, never a reconciliation of conflicts.
    store.db.prepare('INSERT OR IGNORE INTO report_revisions VALUES(?,?,?,?,?)').run(key,revision,previous.raw_hash,JSON.stringify({fields:combined,parser:PARSER,origin:report.origin}),new Date().toISOString());
    store.db.prepare('UPDATE reports SET revision=? WHERE key=?').run(revision,key);
  });
}
export function safeArchive(bytes:Uint8Array) {
  let total=0,count=0;
  const files=unzipSync(bytes,{filter(entry){
    if(++count>10000) throw new Error('ZIP entry count limit');
    if(/(^\/|^[a-z]:|(^|\/)\.\.(\/|$)|\\|\x00)/i.test(entry.name)) throw new Error('Unsafe ZIP path');
    total+=entry.originalSize;
    if(entry.originalSize>config.maxFile || total>512*1024*1024 || entry.originalSize>Math.max(entry.size*200,1024*1024)) throw new Error('ZIP decompression limit');
    return !entry.name.endsWith('/');
  }});return files;
}
export function importPath(store:Store,path:string,database='import') {
  const files:{name:string,bytes:Buffer}[]=[];
  const visit=(p:string,prefix='',depth=0)=>{
    if(depth>32) throw new Error('Directory nesting limit'); const stat=lstatSync(p);if(stat.isSymbolicLink()) throw new Error('Symbolic links are not imported');
    if(stat.isDirectory()){for(const name of readdirSync(p)) visit(join(p,name),prefix+name+'/',depth+1);}
    else {if(stat.size>config.maxFile) throw new Error('File exceeds import limit');const bytes=readFileSync(p);if(extname(p).toLowerCase()==='.zip') for(const [name,b] of Object.entries(safeArchive(bytes)))files.push({name:prefix+name,bytes:Buffer.from(b)});else files.push({name:prefix||basename(p),bytes});}
  };visit(path);
  const keys=new Set<string>(),warnings:string[]=[]; const folders=new Map<string,string[]>();
  for(const file of files.filter(f=>/\.json\/?$/i.test(f.name))) {
    const original=store.put(file.bytes); const raw=JSON.parse(file.bytes.toString('utf8'));walk(raw);
    const rows=Array.isArray(raw)?raw:raw.rows??raw.reports??raw.crashes??[raw];if(!Array.isArray(rows)) throw new Error('Export rows must be an array');
    for(const row of rows) {const key=ingestReport(store,row,database,undefined,'import');keys.add(key);store.associate(key,'original-export-'+original+'.json',original); const folder=file.name.replace(/[^/]+\/?$/,'');folders.set(folder,[...(folders.get(folder)??[]),key]);}
  }
  for(const file of files.filter(f=>! /\.json\/?$/i.test(f.name))) {
    const folder=file.name.replace(/[^/]+\/?$/,'');let candidates=folders.get(folder)??[];
    const segment=file.name.split('/').filter(Boolean);
    const byId=store.reports().filter(r=>r.database_name===database&&segment.includes(r.report_id)).map(r=>r.key);
    if(byId.length) candidates=byId;
    if(/\.xml\/?$|\.runtime-xml\/?$/i.test(file.name)) {
      const xml=parseXml(file.bytes.toString('utf8')), guid=normalize(xml,hash(file.bytes)).fields.crashGuid;
      const byGuid=store.reports().filter(r=>guid&&r.fields.crashGuid===guid).map(r=>r.key);if(byGuid.length)candidates=byGuid;
      if(!candidates.length && guid) {const key=ingestReport(store,xml,database,String(guid));keys.add(key);candidates=[key];}
    }
    candidates=[...new Set(candidates)];
    if(candidates.length===1) enrich(store,candidates[0],file.bytes,file.name.replace(/\/$/,''));
    else {store.put(file.bytes);warnings.push('Unassociated or ambiguous attachment: '+file.name);}
  }
  return {reports:keys.size,keys:[...keys],warnings,synthetic:[...keys].some(k=>store.reports().find(r=>r.key===k)?.fields.application==='SyntheticDemo')};
}
