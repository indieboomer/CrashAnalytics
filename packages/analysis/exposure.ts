import { readFileSync,statSync } from 'node:fs';
import { Store,hash } from '../core/store.ts';
export function csvRows(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
  if(quoted)throw new Error('Unclosed CSV quote');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
export function importExposure(store:Store,path:string){
  if(statSync(path).size>10*1024*1024)throw new Error('Exposure CSV exceeds 10 MiB');const bytes=readFileSync(path),rows=csvRows(bytes.toString('utf8').replace(/^\uFEFF/,'')),headers=rows.shift()?.map(x=>x.trim());if(!headers)throw new Error('CSV header required');
  for(const k of ['period_start','period_end','build','gpu','driver'])if(!headers.includes(k))throw new Error('Missing exposure column '+k);
  const entries=rows.map(row=>{if(row.length!==headers.length)throw new Error('CSV column mismatch');const e:any=Object.fromEntries(headers.map((k,i)=>[k,row[i].trim()]));
    for(const k of ['period_start','period_end'])if(!/Z$|[+-]\d\d:\d\d$/.test(e[k])||!Number.isFinite(Date.parse(e[k])))throw new Error('Exposure periods require UTC offset');
    if(Date.parse(e.period_end)<=Date.parse(e.period_start))throw new Error('Exposure period must be positive');
    for(const k of ['sessions','distinct_machine_ids','gameplay_hours']){e[k]=e[k]?Number(e[k]):null;if(e[k]!==null&&(!Number.isFinite(e[k])||e[k]<=0))throw new Error('Exposure denominators must be positive');}
    if(!e.sessions&&!e.distinct_machine_ids)throw new Error('Sessions or distinct_machine_ids required');return e;
  });
  // Overlap would silently count successful exposure twice. Keep separate immutable imports, reject overlapping cohorts.
  const prior=store.db.prepare('SELECT data FROM exposure_imports').all().flatMap((x:any)=>JSON.parse(x.data));
  const id=hash(bytes);if(store.db.prepare('SELECT 1 FROM exposure_imports WHERE hash=?').get(id))return {rows:entries.length,id,duplicate:true};
  const combined=[...prior,...entries];for(let i=0;i<combined.length;i++)for(let j=i+1;j<combined.length;j++){const a=combined[i],b=combined[j];if(a.build===b.build&&a.gpu===b.gpu&&a.driver===b.driver&&Date.parse(a.period_start)<Date.parse(b.period_end)&&Date.parse(b.period_start)<Date.parse(a.period_end))throw new Error('Overlapping exposure cohorts require reconciliation before import');}
  store.put(bytes);store.db.prepare('INSERT INTO exposure_imports VALUES(?,?,?)').run(id,JSON.stringify(entries),new Date().toISOString());return {id,rows:entries.length,duplicate:false};
}
export function exposureMetrics(store:Store){
  const reports=store.reports(),entries=store.db.prepare('SELECT data FROM exposure_imports').all().flatMap((x:any)=>JSON.parse(x.data)),covered=new Set<string>();
  const cohorts=entries.map((e:any)=>{const incidents=reports.filter(r=>r.fields.build===e.build&&r.fields.gpu===e.gpu&&r.fields.driver===e.driver&&r.fields.timeUtc&&Date.parse(r.fields.timeUtc)>=Date.parse(e.period_start)&&Date.parse(r.fields.timeUtc)<Date.parse(e.period_end));for(const r of incidents)covered.add(r.key);const machines=new Set(incidents.map(r=>r.fields.machine).filter(Boolean));return {...e,reports:incidents.length,affectedReportedMachineIds:machines.size,unknownMachineReports:incidents.filter(r=>!r.fields.machine).length,reportedIncidentsPerSession:e.sessions?incidents.length/e.sessions:null,affectedIdShare:e.distinct_machine_ids?machines.size/e.distinct_machine_ids:null,reportedIncidentsPerGameplayHour:e.gameplay_hours?incidents.length/e.gameplay_hours:null};});
  return {cohorts,coveredReports:covered.size,uncoveredReports:reports.length-covered.size,caveat:'Rates describe reported incidents per compatible exposure, not individual crash probability. Machine-ID shares require matching identifier definitions; missing IDs and underreporting remain gaps.'};
}
