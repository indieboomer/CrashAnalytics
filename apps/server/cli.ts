import { writeFileSync } from 'node:fs';
import { Store } from '../../packages/core/store.ts';
import { importPath } from '../../packages/ingest/index.ts';
import { doctor, decodePending } from '../../packages/decoder/index.ts';
import { summarize } from '../../packages/analysis/index.ts';
import { packet, exportPacket, analyze } from '../../packages/ai/index.ts';
import { Jobs } from '../../packages/core/jobs.ts';
import { importExposure } from '../../packages/analysis/exposure.ts';
const args=process.argv.slice(2),command=args.shift();const option=(name:string,fallback?:string)=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:fallback;};const store=new Store();
try{let result:any;
  switch(command){
    case 'doctor':result=await doctor();break;
    case 'import':if(!args[0])throw new Error('Import path required');result=importPath(store,args[0],option('database','import'));break;
    case 'decode':result=await decodePending(store);break;
    case 'summary':result=summarize(store);break;
    case 'exposure':if(!args[0])throw new Error('Exposure CSV path required');result=importExposure(store,args[0]);break;
    case 'investigate':{const p=packet(store,option('cluster'));result=args.includes('--ai')?await analyze(store,p):p;break;}
    case 'export':{const investigation=option('investigation');const saved=investigation?store.db.prepare('SELECT * FROM investigation_runs WHERE id=?').get(investigation) as any:null;if(investigation&&!saved)throw new Error('Unknown investigation');const p=saved?JSON.parse(saved.packet):packet(store,option('cluster'));const output=option('output',store.root+'/investigation.zip')!;writeFileSync(output,exportPacket(store,p,option('language','en'),saved?JSON.parse(saved.hypotheses):[]));result={output};break;}
    case 'sync':{const database=option('database');if(!database)throw new Error('--database required');const jobs=new Jobs(store);const resumed=option('resume');if(resumed)jobs.resume(resumed);else jobs.create('sync',{database,application:option('application'),build:option('build'),from:option('from'),to:option('to'),incremental:args.includes('--incremental'),attachments:option('attachments','all'),maxPages:Number(option('max-pages','20000'))});while(jobs.running)await new Promise(r=>setTimeout(r,100));result=jobs.list();if(result.some((j:any)=>j.state==='failed'))process.exitCode=1;break;}
    case 'jobs':result=store.db.prepare('SELECT * FROM jobs ORDER BY updated DESC').all();break;
    default:result={usage:['npm run cli -- doctor','npm run cli -- import <json|zip|folder> --database <name>','npm run cli -- sync --database <name> --attachments metadata|xml-logs|representative|all --from <UTC> --to <UTC>','npm run cli -- sync --database <name> --resume <job-id>','npm run cli -- decode --pending','npm run cli -- summary','npm run cli -- investigate --cluster <id> [--ai]','npm run cli -- export [--cluster <id> | --investigation <id>] --language en|pl --output <zip>']};
  }console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e instanceof Error?e.message:'Command failed');process.exitCode=1;}finally{store.close();}
