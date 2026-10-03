import { createHmac } from 'node:crypto';
import { Store, hash } from '../core/store.ts';
import { exposureMetrics } from './exposure.ts';
export const RULES='classification-1';
export function classify(fields:any) {
  const error=String(fields.error??'');
  const family=/out of memory|outofmemory|E_OUTOFMEMORY/i.test(error)?'out-of-memory':/GPU Crash|device (removed|hung|lost)|DXGI_ERROR_DEVICE/i.test(error)?'gpu-fault':/access violation|c0000005/i.test(error)?'cpu-access-violation':/hang|timeout/i.test(error)?'hang':error?'other':'unknown';
  const frames=String(fields.stack??'').split(/\r?\n/).map(x=>x.replace(/0x[0-9a-f]+/gi,'<address>').replace(/\+\s*\d+ bytes/g,'').trim()).filter(x=>x&&!/ReportGPUCrash|RaiseException|UnhandledException|AssertFailed|GPU Crash dump Triggered|kernel32|ntdll/i.test(x)).slice(0,5);
  const specific=fields.decodedSignature?String(fields.decodedSignature):frames.length?frames.join('|'):error.replace(/0x[0-9a-f]+/gi,'<address>').trim();
  return {family,signature:hash(RULES+'|'+family+'|'+specific).slice(0,16),specific:!!(fields.decodedSignature||frames.length),frames,stageTags:[...new Set(JSON.stringify(fields.breadcrumbs??[]).match(/VirtualShadow|VSM|Nanite|ClearBuffer|Movie|Video|Present/gi)??[])]};
}
export function summarize(store:Store,filter:Record<string,string>={}) {
  const reports=store.reports().filter(r=>Object.entries(filter).every(([k,v])=>!v||(k==='cluster'?classify(r.fields).signature===v:String(r.fields[k]??'').includes(v)))).map(r=>({...r,...classify(r.fields)}));
  const groups=new Map<string,any>();
  for(const r of reports){
    store.db.prepare('INSERT OR IGNORE INTO cluster_memberships VALUES(?,?,?,?,?)').run(r.key,r.revision,r.signature,RULES,new Date().toISOString());
    if(!groups.has(r.signature))groups.set(r.signature,{id:r.signature,family:r.family,specific:r.specific,reports:[],stageTags:r.stageTags});groups.get(r.signature).reports.push(r);
  }
  const distribution=(field:string,rs=reports)=>{const counts:Record<string,number>={};for(const r of rs){const v=String(r.fields[field]??'Unknown');counts[v]=(counts[v]??0)+1;}return counts;};
  const uptimes=reports.filter(r=>r.fields.uptimeUnit==='seconds' && r.fields.uptime!==null && Number.isFinite(Number(r.fields.uptime))).map(r=>Number(r.fields.uptime)).sort((a,b)=>a-b);
  const quantile=(q:number)=>uptimes.length?uptimes[Math.floor((uptimes.length-1)*q)]:null;
  const machineIds=new Set(reports.map(r=>r.fields.machine).filter(Boolean));
  const coverage:Record<string,any>={};for(const field of ['machine','build','gpu','driver','driverInternal','uptime','stack','breadcrumbs','timeUtc']) coverage[field]={known:reports.filter(r=>r.fields[field]!==null&&r.fields[field]!==undefined&&(!Array.isArray(r.fields[field])||r.fields[field].length)).length,total:reports.length};
  const withinMachine=[...machineIds].map(machine=>({machine: pseudonym(store,String(machine)),incidents:reports.filter(r=>r.fields.machine===machine).length,builds:distribution('build',reports.filter(r=>r.fields.machine===machine)),drivers:distribution('driver',reports.filter(r=>r.fields.machine===machine))}));
  return {rules:RULES,total:reports.length,syntheticReports:reports.filter(r=>r.origin==='synthetic'||r.fields.application==='SyntheticDemo').length,affectedMachineIds:machineIds.size,unknownMachineReports:reports.filter(r=>!r.fields.machine).length,coverage,distributions:{build:distribution('build'),gpu:distribution('gpu'),driver:distribution('driver'),driverInternal:distribution('driverInternal')},uptime:{unit:'seconds',origin:'engine-reported',count:uptimes.length,p25:quantile(.25),median:quantile(.5),p75:quantile(.75),p95:quantile(.95),histogram:[0,60,120,180,300,600].map((start,i,a)=>({start,end:a[i+1]??null,count:uptimes.filter(x=>x>=start&&(a[i+1]===undefined||x<a[i+1])).length}))},withinMachine,exposure:exposureMetrics(store),clusters:[...groups.values()].map(c=>({...c,count:c.reports.length,machines:new Set(c.reports.map((r:any)=>r.fields.machine).filter(Boolean)).size,caseIds:c.reports.map((r:any)=>r.key),reports:undefined})),caveats:['Distributions among reported failures only; no crash probability without compatible exposure denominators.','Reported machine IDs are proxies, not verified physical computers.','Within-machine comparisons are observational and confounded.','Crash-only uptime is not a survival estimate; median is not a peak.']};
}
export function pseudonym(store:Store,value:string){return 'machine-'+createHmac('sha256',store.key).update(value).digest('hex').slice(0,16);}
export function representative(reports:any[],limit=12){
  const chosen:any[]=[],seen=new Set<string>();
  for(const r of reports){const cohort=JSON.stringify([r.fields.machine,r.fields.build,r.fields.gpu,r.fields.driver,classify(r.fields).signature]);if(!seen.has(cohort)){chosen.push(r);seen.add(cohort);}if(chosen.length===limit)break;}
  for(const r of reports) if(chosen.length<limit&&!chosen.includes(r))chosen.push(r);
  return chosen;
}
