import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join,delimiter } from 'node:path';
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
// SDK DLLs remain outside the repository. Only the app/child process PATH changes.
const sdkPath=process.env.AFTERMATH_SDK_PATH;
if(process.platform==='win32'&&sdkPath){
  const runtime=[join(sdkPath,'lib','x64'),join(sdkPath,'lib')].find(p=>existsSync(join(p,'GFSDK_Aftermath_Lib.x64.dll')));
  if(runtime)process.env.PATH=runtime+delimiter+(process.env.PATH??'');
}
export const config = {
  data: resolve(process.env.CRASHLAB_DATA_DIR || '.local/data'),
  port: Number(process.env.CRASHLAB_PORT || 4317),
  quota: Number(process.env.CRASHLAB_QUOTA_MB || 10240) * 1024 * 1024,
  maxFile: 256 * 1024 * 1024,
  decoder: process.env.AFTERMATH_DECODER || '', shaders: process.env.AFTERMATH_SHADER_ARTIFACTS || '',
};
mkdirSync(config.data, { recursive: true });
