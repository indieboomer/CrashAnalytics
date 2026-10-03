import { resolve, isAbsolute, relative } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { Store } from '../core/store.ts';
import { boundedProcess } from '../core/process.ts';
export async function linkBuild(store:Store,m:any){
  if(typeof m.build!=='string'||!m.build.trim()||typeof m.repository!=='string'||! /^[a-f0-9]{40,64}$/i.test(m.commit??''))throw new Error('Build, repository and exact full commit are required');
  const repository=realpathSync(m.repository);const probe=await boundedProcess('git',['-C',repository,'rev-parse','--verify',m.commit+'^{commit}']);if(probe.code!==0||probe.stdout.trim()!==m.commit)throw new Error('Historical commit is unavailable');
  const mapping={...m,repository,status:'source-commit-verified',symbolStatus:'unverified; executable/PDB and shader identities require matching build artifacts',verifiedAt:new Date().toISOString()};
  store.db.prepare('INSERT OR REPLACE INTO build_mappings VALUES(?,?)').run(m.build,JSON.stringify(mapping));return mapping;
}
export async function sourceSnippet(store:Store,build:string,file:string,start=1,end=100){
  const row=store.db.prepare('SELECT mapping FROM build_mappings WHERE build=?').get(build) as any;if(!row)throw new Error('No historical build mapping; current HEAD will not be used');const mapping=JSON.parse(row.mapping);
  if(!/^[a-zA-Z0-9_./ -]+$/.test(file)||file.split('/').includes('..')||isAbsolute(file)||! /\.(cpp|h|hpp|c|usf|ush|ini|uplugin|uproject|cs|cmake)$/i.test(file))throw new Error('Unsupported source path');
  const result=await boundedProcess('git',['-C',mapping.repository,'show',mapping.commit+':'+file]);if(result.code!==0)throw new Error('File not available at mapped commit');if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end-start>200)throw new Error('Invalid bounded line range');
  return {build,commit:mapping.commit,file,start,end,text:result.stdout.split(/\r?\n/).slice(start-1,end).join('\n'),sourceStatus:mapping.status,symbolStatus:mapping.symbolStatus};
}
export async function sourceDiff(store:Store,good:string,bad:string){
  const mappings=[good,bad].map(b=>{const r=store.db.prepare('SELECT mapping FROM build_mappings WHERE build=?').get(b) as any;if(!r)throw new Error('Both builds must be mapped');return JSON.parse(r.mapping);});if(mappings[0].repository!==mappings[1].repository)throw new Error('Build repositories differ');const result=await boundedProcess('git',['-C',mappings[0].repository,'diff','--no-ext-diff','--no-textconv',mappings[0].commit,mappings[1].commit,'--','*.cpp','*.h','*.hpp','*.usf','*.ush','*.ini','*.uplugin','*.cs']);if(result.code!==0||result.state!=='finished')throw new Error('Diff unavailable or exceeds output limit');return {good:mappings[0].commit,bad:mappings[1].commit,diff:result.stdout,caveat:'Last-known-good is user-supplied; changed code is a candidate, not causality.'};
}
