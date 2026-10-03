import { spawn } from 'node:child_process';
export function boundedProcess(executable:string,args:string[],timeout=30000,signal?:AbortSignal):Promise<{code:number|null,stdout:string,stderr:string,elapsed:number,state:string}>{
  return new Promise(resolve=>{const start=Date.now();let stdout='',stderr='',state='finished',done=false;const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});const stop=(why:string)=>{state=why;child.kill();};const timer=setTimeout(()=>stop('timeout'),timeout);const cancel=()=>stop('cancelled');signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    const append=(which:'stdout'|'stderr',data:Buffer)=>{if(stdout.length+stderr.length+data.length>1024*1024){stop('output-limit');return;}if(which==='stdout')stdout+=data.toString();else stderr+=data.toString();};child.stdout.on('data',d=>append('stdout',d));child.stderr.on('data',d=>append('stderr',d));
    const finish=(code:number|null)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve({code,stdout,stderr,elapsed:Date.now()-start,state});};child.on('error',()=>{state='missing-runtime';finish(null);});child.on('close',finish);
  });
}
