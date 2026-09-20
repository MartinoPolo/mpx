import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function recoverFinalLinks(root, apply = false, previewAfterFiles = false) {
const record=JSON.parse(await readFile(path.join(root,'cutover-record.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stat=async p=>lstat(p).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
for(const entry of [...record.links].reverse()){
 if(entry.state==='prepared')continue;
 if(!['applied','applying'].includes(entry.state))throw new Error('Incomplete link transaction requires manual inspection');
 const retained=await stat(entry.retained),current=await stat(entry.target);
 if(!retained && current?.isSymbolicLink() && await readlink(entry.target)===entry.previousTarget){console.log('already restored',entry.target);continue;}
 if(!retained?.isSymbolicLink()||await readlink(entry.retained)!==entry.previousTarget)throw new Error(`Retained link drift: ${entry.target}`);
 if(!current){
  console.log(apply?'restore':'preview restore',entry.target);
  if(apply)await rename(entry.retained,entry.target);
  continue;
 }
 if(entry.replacement){if(!current?.isSymbolicLink()||await readlink(entry.target)!==entry.replacement)throw new Error(`Replacement link drift: ${entry.target}`);}
 else if(entry.materializedHash){
  if(!apply&&previewAfterFiles){console.log('preview link restore after materialized file rollback',entry.target);continue;}
  if(!current?.isFile()||current.isSymbolicLink()||hash(await readFile(entry.target))!==entry.materializedHash)throw new Error(`Materialized settings drift: ${entry.target}`);
 }
 else if(current)throw new Error(`New resource preserved: ${entry.target}`);
 console.log(apply?'restore':'preview restore',entry.target);
 if(apply){if(current)await unlink(entry.target);await rename(entry.retained,entry.target);}
}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await recoverFinalLinks(path.dirname(fileURLToPath(import.meta.url)),process.argv.includes('--apply'),process.argv.includes('--preview-after-files'));
}
