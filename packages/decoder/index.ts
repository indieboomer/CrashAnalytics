import { existsSync, readFileSync, readdirSync, lstatSync, unlinkSync,statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Store, hash } from '../core/store.ts';
import { config } from '../core/config.ts';
import { boundedProcess } from '../core/process.ts';
import { walk } from '../ingest/index.ts';
export function shaderFingerprint(path=config.shaders):string {
  const entries:string[]=[];const visit=(p:string,depth=0)=>{if(depth>32)throw new Error('Shader tree nesting limit');const stat=lstatSync(p);if(stat.isSymbolicLink())throw new Error('Shader symlink prohibited');if(stat.isDirectory())for(const n of readdirSync(p).sort())visit(join(p,n),depth+1);else {if(stat.size>config.maxFile)throw new Error('Shader artifact too large');entries.push(hash(readFileSync(p)));}};if(path&&existsSync(path))visit(path);return hash(entries.join('|'));
}
export async function doctor(){
  const configured=!!config.decoder&&existsSync(config.decoder);const probe=configured?await boundedProcess(config.decoder,['--version'],10000):null;
  return {storage:{state:'available',path:config.data},bugsplat:{state:process.env.BUGSPLAT_CLIENT_ID&&process.env.BUGSPLAT_CLIENT_SECRET||process.env.BUGSPLAT_EMAIL&&process.env.BUGSPLAT_PASSWORD?'configured-live-gate-pending':'missing-credentials',liveGate:'pending: authenticate, bounded list, detail, XML/GPU bytes'},decoder:{state:!configured?'missing-sdk-or-wrapper':probe?.code===0?'runtime-available-real-dump-probe-pending':probe?.state==='timeout'?'timeout':'incompatible-runtime',version:probe?.stdout.trim()??null,realDecodeGate:'pending without a supplied real dump',shaderArtifacts:config.shaders&&existsSync(config.shaders)?'configured':'missing; GPU shader source coverage unknown'},ai:{state:process.env.AI_API_KEY&&process.env.AI_MODEL&&process.env.AI_BASE_URL?'configured':'export-only'},source:{state:'build mapping required'}};
}
export async function decodePending(store:Store,signal?:AbortSignal){
  const rows=store.db.prepare("SELECT DISTINCT hash FROM report_artifacts WHERE hash IS NOT NULL AND (lower(name) LIKE '%.nv-gpudmp' OR lower(name) LIKE '%.gpudmp')").all() as any[];
  const decoderHash=config.decoder&&existsSync(config.decoder)?hash(readFileSync(config.decoder)):'missing';const fingerprint=shaderFingerprint();const version=config.decoder?await boundedProcess(config.decoder,['--version'],10000):null;
  let count=0;for(const row of rows){signal?.throwIfAborted();const cache=hash(row.hash+decoderHash+fingerprint+'decode-1');if(store.db.prepare("SELECT 1 FROM decoder_runs WHERE cache_key=? AND state='success'").get(cache))continue;
    const output=join(store.root,cache+'.decoded.tmp');const start=Date.now();let state='missing-sdk',outputHash:string|null=null,diagnostics:any={};
    try{if(config.decoder&&existsSync(config.decoder)){
      const result=await boundedProcess(config.decoder,['--input',store.path(row.hash),'--output',output,...(config.shaders?['--shader-artifacts',resolve(config.shaders)]:[])],60000,signal);diagnostics={...result,decoderVersion:version?.stdout.trim()};state=result.state==='timeout'?'timeout':result.state==='cancelled'?'cancelled':result.state==='missing-runtime'?'incompatible-runtime':result.code===2?'corrupt-or-unsupported':result.code!==0?'decoder-failed':'success';
      if(state==='success'){if(statSync(output).size>config.maxFile)throw new Error('Decoded output limit');const raw=readFileSync(output);outputHash=store.put(raw);const parsed=JSON.parse(raw.toString().replace(/\0+$/,''));walk(parsed);
        const nodes=walk(parsed), fp=nodes.find(x=>x.key==='FingerprintWithDebugInfo')??nodes.find(x=>x.key==='Fingerprint');
        const observed=nodes.filter(x=>/^(DeviceInfo|DeviceStatus|PageFaultInfo|FaultInfo|Shaders|ActiveShaders|EventMarkers|Markers|Resources|ResourceInfo)$/i.test(x.key));
        const normalized={version:'decode-1',inputHash:row.hash,rawHash:outputHash,observed:observed.map(x=>({locator:x.path,value:x.value})),unresolvedLookups:Number(result.stderr.match(/unresolved_shader_lookups=(\d+)/)?.[1]??0)};
        diagnostics.normalizedHash=store.put(Buffer.from(JSON.stringify(normalized)));diagnostics.unresolvedShaderLookups=normalized.unresolvedLookups;
        for(const r of store.db.prepare('SELECT DISTINCT report_key FROM report_artifacts WHERE hash=?').all(row.hash) as any[]){const report=store.reports().find(x=>x.key===r.report_key);if(!report)continue;store.associate(report.key,'decoded-'+row.hash+'.json',outputHash);
          for(const item of observed)store.db.prepare('INSERT OR IGNORE INTO evidence_items VALUES(?,?,?,?,?,?,?,?)').run('ev-'+hash(report.key+outputHash+item.path).slice(0,24),report.key,outputHash,item.path,'decode-1','decodedObservation',JSON.stringify(item.value),'parsed');
          if(fp?.value?.Hash){const fields={...report.fields,decodedSignature:String(fp.value.Hash)};const rev=hash(report.revision+outputHash);const rawRev=store.db.prepare('SELECT raw_hash FROM report_revisions WHERE report_key=? AND hash=?').get(report.key,report.revision) as any;store.db.prepare('INSERT OR IGNORE INTO report_revisions VALUES(?,?,?,?,?)').run(report.key,rev,rawRev.raw_hash,JSON.stringify({fields,parser:'decode-1',origin:report.origin}),new Date().toISOString());store.db.prepare('UPDATE reports SET revision=? WHERE key=?').run(rev,report.key);store.db.prepare('INSERT OR IGNORE INTO evidence_items VALUES(?,?,?,?,?,?,?,?)').run('ev-'+hash(report.key+outputHash+fp.path).slice(0,24),report.key,outputHash,fp.path,'decode-1','decodedSignature',JSON.stringify(fp.value.Hash),'parsed');}
        }
      }
    }}catch{state=state==='success'?'partial-decode':state;diagnostics.error='Decode output unavailable or invalid';}finally{try{unlinkSync(output);}catch{}}
    const metadata=JSON.stringify({...diagnostics,elapsedMs:Date.now()-start,decoderHash,artifactIndex:fingerprint,shaderSourceCoverage:'unverified',normalizer:'decode-1',flags:'all'}),created=new Date().toISOString();
    store.db.prepare('INSERT OR REPLACE INTO decoder_runs VALUES(?,?,?,?,?,?)').run(cache,row.hash,outputHash,state,metadata,created);
    store.db.prepare('INSERT INTO decoder_attempts VALUES(?,?,?,?,?,?,?)').run(randomUUID(),cache,row.hash,outputHash,state,metadata,created);count++;
  }return {attempted:count,runs:store.db.prepare('SELECT * FROM decoder_runs').all()};
}
