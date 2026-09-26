import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require=createRequire(import.meta.url);
const native7z=require('7zip-bin-full').path7z;
const here=path.dirname(fileURLToPath(import.meta.url));
const repoRoot=path.resolve(here,'../..');
const work=path.join(repoRoot,'.direct-7zip-work');
fs.rmSync(work,{recursive:true,force:true}); fs.mkdirSync(work,{recursive:true});
const input=path.join(work,'expected-concatenation.jsonl');
const member=path.basename(input);
const data=Buffer.allocUnsafe(4*1024*1024);
for(let o=0,n=0;o<data.length;n++){const d=createHash('sha256').update('direct-7zip-'+n).digest();d.copy(data,o,0,Math.min(d.length,data.length-o));o+=d.length;}
fs.writeFileSync(input,data);

const modulePath=path.join(here,'build/stream7z.mjs');
const createModule=(await import(pathToFileURL(modulePath).href)).default;
let inFd=fs.openSync(input,'r'), inPos=0, outFd=-1;
const direct=path.join(work,'direct.7z');
outFd=fs.openSync(direct,'w');
const mod=await createModule({
  stream7zRead(id,view){if(id!==1)return -1;const n=fs.readSync(inFd,view,0,view.length,inPos);inPos+=n;return n;},
  stream7zWriteAt(id,pos,view){if(id!==1||!Number.isSafeInteger(pos))return -1;return fs.writeSync(outFd,view,0,view.length,pos);},
  stream7zSetSize(id,size){if(id!==1||!Number.isSafeInteger(size))return -1;fs.ftruncateSync(outFd,size);return 0;}
});
const create=mod.cwrap('stream7z_create','number',['number','number','string','number']);
const lastError=mod.cwrap('stream7z_last_error','string',[]);
assert.equal(create(1,1,member,data.length),0,lastError());
fs.closeSync(inFd);fs.closeSync(outFd);

const reference=path.join(work,'reference.7z');
const runner=path.join(repoRoot,'prototype/libarchive-streaming/js7z-reference.cjs');
const child=childProcess.spawnSync(process.execPath,[runner,work,member,path.basename(reference)],{cwd:repoRoot,encoding:'utf8'});
assert.equal(child.status,0,child.stderr+'\n'+child.stdout);
const d=fs.readFileSync(direct), r=fs.readFileSync(reference);
let first=-1; for(let i=0;i<Math.min(d.length,r.length);i++){if(d[i]!==r[i]){first=i;break;}} if(first<0&&d.length!==r.length)first=Math.min(d.length,r.length);
const dh=createHash('sha256').update(d).digest('hex'), rh=createHash('sha256').update(r).digest('hex');
assert.equal(dh,rh,`direct 7-Zip API archive differs from JS7z at byte ${first}; sizes ${d.length}/${r.length}`);
for(const archive of [direct,reference]){
 const t=childProcess.spawnSync(native7z,['t','-bd','-bso0','-bse0',archive],{encoding:'utf8'});
 assert.equal(t.status,0,t.stderr+'\n'+t.stdout);
}
console.log(JSON.stringify({bytes:d.length,sha256:dh,firstDifference:first}));
