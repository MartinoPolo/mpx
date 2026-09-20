import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverFinalLinks } from './final-links-recovery.mjs';

export async function recoverFinalCutover(root, apply = false) {
 const record=JSON.parse(await readFile(path.join(root,'cutover-record.json'),'utf8'));
 const args=apply?['--apply']:[];
 const seen=new Set();
 for(const entry of [...record.files].reverse()){
  const plan=JSON.parse(await readFile(entry.planPath,'utf8'));
  if(!apply&&seen.has(plan.target)){console.log('preview older layer after newest restore',plan.target);continue;}
  seen.add(plan.target);
  execFileSync(process.execPath,[path.join(path.dirname(entry.planPath),'protected-file-change-recovery.mjs'),entry.planPath,...args],{stdio:'inherit',windowsHide:true});
 }
 await recoverFinalLinks(root,apply,!apply);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await recoverFinalCutover(path.dirname(fileURLToPath(import.meta.url)),process.argv.includes('--apply'));
}
