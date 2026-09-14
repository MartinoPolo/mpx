// Disposable receiver overlay; external dependencies remain read-only and are integrity-checked by callers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadOrcaReceiverCandidate(orcaRoot, temporary) {
  const relative = 'src/shared/agent-hook-listener/providers/pi-family-events.ts';
  const source = path.join(orcaRoot, relative);
  const overlay = path.join(temporary, 'receiver');
  const candidate = path.join(overlay, relative);
  const patch = path.resolve(import.meta.dirname, '../patches/orca-pi-receiver-cancellation.patch');
  await mkdir(path.dirname(candidate), { recursive: true });
  await copyFile(source, candidate);
  await writeFile(path.join(overlay, 'package.json'), '{"type":"commonjs"}\n');
  const git = args => execFileSync('git', args, { cwd: overlay, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  git(['init', '--quiet']);
  git(['apply', '--check', patch]);
  git(['apply', patch]);
  const patched = await readFile(candidate, 'utf8');
  // Only the disposable overlay gets relocated imports. The distributable patch has no path rewrites.
  let imports = 0;
  const relocated = patched.replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, specifier) => {
    imports++;
    return `from ${JSON.stringify(path.resolve(path.dirname(source), `${specifier}.ts`).replaceAll('\\', '/'))}`;
  });
  if (imports !== 6) throw new Error('Unexpected receiver import closure; re-inspect before probing.');
  await writeFile(candidate, relocated);
  const originalModule = await import(pathToFileURL(source).href);
  const candidateModule = await import(pathToFileURL(candidate).href);
  return {
    original: originalModule.default ?? originalModule,
    candidate: candidateModule.default ?? candidateModule,
    sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    candidateSha256: createHash('sha256').update(patched).digest('hex'),
    executedSourceSha256: createHash('sha256').update(relocated).digest('hex'),
    patchSha256: createHash('sha256').update(await readFile(patch)).digest('hex'),
  };
}
