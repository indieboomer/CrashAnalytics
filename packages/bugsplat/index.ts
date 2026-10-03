import { createRequire } from 'node:module';
import { createWriteStream, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from '../core/store.ts';
import { config } from '../core/config.ts';
import { ingestReport, enrich, safeArchive } from '../ingest/index.ts';
// The official package's CJS entry supports Node; its ESM build has extensionless imports.
const sdk=createRequire(import.meta.url)('@bugsplat/js-api-client');
export interface SyncOptions {database:string;application?:string;build?:string;from?:string;to?:string;attachments:'metadata'|'xml-logs'|'representative'|'all';maxPages?:number;afterId?:number;incremental?:boolean;}
export interface Vendor {list(options:SyncOptions,page:number):Promise<any[]>;details(database:string,id:number):Promise<any>;download(url:string,signal?:AbortSignal):Promise<Buffer>;}
export class HttpError extends Error {constructor(public status:number,public retryAfter:string|null,requiredScope?:string){super(requiredScope?`BugSplat OAuth authenticated, but crash access was denied (HTTP ${status}). Required scope: ${requiredScope}. Update the integration's permissions, or use a supported account login.`:'BugSplat HTTP '+status);}}
export async function retry<T>(fn:()=>Promise<T>,signal?:AbortSignal,wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))):Promise<T>{
  for(let attempt=0;;attempt++){signal?.throwIfAborted();try{return await fn();}catch(e){if(attempt>=4 || (e instanceof HttpError && ![408,429,500,502,503,504].includes(e.status)))throw e;const ra=e instanceof HttpError?e.retryAfter:null;const delay=ra?(Number.isFinite(Number(ra))?Number(ra)*1000:Math.max(0,Date.parse(ra)-Date.now())):Math.min(30000,500*2**attempt)+Math.random()*250;await wait(Math.min(60000,Math.max(0,delay)));}}
}
export async function vendor():Promise<Vendor>{
  const env=process.env; let client:any;
  if(env.BUGSPLAT_CLIENT_ID && env.BUGSPLAT_CLIENT_SECRET) client=await sdk.OAuthClientCredentialsClient.createAuthenticatedClient(env.BUGSPLAT_CLIENT_ID,env.BUGSPLAT_CLIENT_SECRET);
  else if(env.BUGSPLAT_EMAIL&&env.BUGSPLAT_PASSWORD)client=await sdk.BugSplatApiClient.createAuthenticatedClientForNode(env.BUGSPLAT_EMAIL,env.BUGSPLAT_PASSWORD,'https://app.bugsplat.com');
  else throw new Error('BugSplat unavailable: configure OAuth client credentials or supported email/password locally; SSO password login is not assumed');
  return createVendor(client);
}
export function createVendor(client:any):Vendor {
  const original=client.fetch.bind(client);
  client.fetch=async(route:string,init:any)=>{
    // Only read endpoints are exposed through this adapter. SDK detail POST is a read operation.
    const path=route.split('?')[0],method=(init?.method??'GET').toUpperCase();
    if(!['/api/crashes','/api/crashes.php','/api/crash/details'].includes(path)||!['GET','POST'].includes(method))throw new Error('Vendor read request not allowlisted');
    const response=await original(route,{...init,signal:AbortSignal.timeout(30000)});
    if(response.status===401||response.status===403){
      let requiredScope:string|undefined;
      if(response.status===403){const errorBody=await response.json().catch(()=>({}));const message=String(errorBody?.message??errorBody?.error??'');if(/insufficient scope|sufficient scope/i.test(message))requiredScope=message.match(/Required:\s*([a-z][a-z0-9_.:-]{0,80})/i)?.[1];}
      // Never pass raw vendor error bodies, tokens or account details through to UI/logs.
      throw new HttpError(response.status,null,requiredScope);
    }
    if(response.status!==200)throw new HttpError(response.status,response.headers?.get?.('retry-after')??null);
    return response;
  };
  const crashes=new sdk.CrashesApiClient(client);
  return {
    async list(o,page){const groups:any[]=[];for(const [column,value] of [['appName',o.application],['appVersion',o.build]])if(value)groups.push(sdk.QueryFilterGroup.fromColumnValues([value],column));if(o.afterId)groups.push(sdk.QueryFilterGroup.fromApiTableFilter(new sdk.QueryFilter(o.afterId,'GREATER_THAN','id')));if(o.from||o.to)groups.push(sdk.QueryFilterGroup.fromTimeFrame('crashTime',o.from?new Date(o.from):undefined,o.to?new Date(o.to):undefined));const result=await retry(()=>crashes.getCrashes({database:o.database,page,pageSize:50,sortColumn:'id',sortOrder:'asc',filterGroups:groups}));return (result as any).rows;},
    async details(database,id){
      // GET preserves the entire JSON response rather than dropping unknown properties in createCrashDetails.
      const response=await retry(()=>client.fetch('/api/crash/details?'+new URLSearchParams({database,id:String(id)}),{method:'GET'}));return (response as any).json();
    },
    async download(url,signal){return retry(async()=>{
      const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!(u.hostname.endsWith('.amazonaws.com')||u.hostname.endsWith('.bugsplat.com')))throw new Error('Attachment host is not a verified BugSplat/S3 host');
      // Signed URLs authorize attachments. Never pass account Authorization/cookies.
      const response=await fetch(u,{redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(60000)])});
      if(!response.ok)throw new HttpError(response.status,response.headers.get('retry-after'));
      if(!response.body)throw new Error('Missing attachment body'); const expected=response.headers.get('content-length');if(expected&&Number(expected)>config.maxFile)throw new Error('Attachment size limit');
      const temp=join(config.data,randomUUID()+'.download.tmp');let size=0;
      try{await pipeline(Readable.fromWeb(response.body as any),new Transform({transform(chunk,encoding,callback){size+=chunk.length;callback(size>config.maxFile?new Error('Attachment size limit'):null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));if(expected&&Number(expected)!==size)throw new Error('Attachment length mismatch');return readFileSync(temp);}finally{try{unlinkSync(temp);}catch{}}
    },signal);}
  };
}
export async function sync(store:Store,o:SyncOptions,checkpoint:any,onCheckpoint:(c:any)=>void,signal:AbortSignal,v:Vendor){
  if(!o.database?.trim()||!['metadata','xml-logs','representative','all'].includes(o.attachments))throw new Error('Invalid sync database or attachment policy');
  for(const time of [o.from,o.to])if(time&&(!/Z$|[+-]\d\d:\d\d$/.test(time)||!Number.isFinite(Date.parse(time))))throw new Error('Sync dates must include a UTC offset');
  let page=Math.max(0,Number(checkpoint.page??0)-1), afterId=Number(checkpoint.previousLastId??0), downloaded=Number(checkpoint.downloaded??0); const failures:any[]=[];
  for(let sweep=0;sweep<(o.maxPages??20000);sweep++,page++){
    signal.throwIfAborted();const rows=await v.list({...o,afterId},0);if(!rows.length)return {page,downloaded,failures,complete:true};const previousLastId=afterId;
    for(const row of rows){signal.throwIfAborted();const id=Number(row.id);if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid vendor report ID');
      try{
        const detail=await v.details(o.database,id); const signed=detail.dumpfile; const persisted={...detail,dumpfile:signed?'[signed download URL omitted]':null};
        const key=ingestReport(store,persisted,o.database,String(id),'bugsplat');
        if(o.attachments==='metadata'){store.associate(key,'vendor-bundle.zip',null,signed?'pending':'unavailable','bugsplat');continue;}
        if(!signed){store.associate(key,'vendor-bundle.zip',null,'pending','bugsplat');continue;}
        let bytes:Buffer;try{bytes=await v.download(signed,signal);}catch(e){if(e instanceof HttpError&&[401,403].includes(e.status)){const refreshed=await v.details(o.database,id);bytes=await v.download(refreshed.dumpfile,signal);}else throw e;}
        const bundle=store.put(bytes),entries=safeArchive(bytes);store.associate(key,'vendor-bundle.zip',bundle,'downloaded','bugsplat');
        for(const [name,data] of Object.entries(entries)){
          const text=/\.xml$|\.runtime-xml$|\.log$|\.txt$/i.test(name), selected=o.attachments==='all'||text||(o.attachments==='representative'&&downloaded<12);
          if(selected)enrich(store,key,data,name);else store.associate(key,name,null,'pending','bugsplat');
        }downloaded++;
      }catch(e){signal.throwIfAborted();store.associate(o.database+':'+id,'vendor-bundle.zip',null,e instanceof HttpError&&e.status===403?'denied':'failed','bugsplat');failures.push({id,message:e instanceof HttpError?e.message:'Report ingestion/download failed'});}
    }
    const lastId=Math.max(...rows.map(r=>Number(r.id)));if(lastId<=afterId)throw new Error('Vendor pagination did not advance');afterId=lastId;
    onCheckpoint({page:page+1,previousLastId,lastId,downloaded,failures});if(failures.length)throw new Error('Partial sync: failed reports retained; resume retries overlapping page');
    if(rows.length<50)return {page:page+1,downloaded,failures,complete:true};
  }return {page,downloaded,failures,complete:false};
}
