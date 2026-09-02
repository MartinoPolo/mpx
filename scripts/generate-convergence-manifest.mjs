import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptChangedSourceEntry,
  buildConvergenceManifest,
  compareConvergenceManifests,
  mergeReviewedDecisions,
  parseGenerateConvergenceArguments,
  validateConvergenceManifest,
} from './convergence-manifest.mjs';

const { check, sourceKey } = parseGenerateConvergenceArguments(process.argv.slice(2));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = process.env.MPX_PROJECTS;
if (!projects) {
  throw new Error('MPX_PROJECTS is required; source roots are never guessed');
}

const sources = [
  {
    id: 'claude',
    root: path.join(projects, 'mpx-claude-code'),
    symbolicRoot: '${MPX_PROJECTS}/mpx-claude-code',
  },
  { id: 'pi', root: path.join(projects, 'mpx-pi'), symbolicRoot: '${MPX_PROJECTS}/mpx-pi' },
];
const target = path.join(repositoryRoot, 'docs', 'history', 'CONVERGENCE_MANIFEST.json');

async function writeManifestAtomic(manifest) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

const generated = await buildConvergenceManifest({ sources });
const invalid = validateConvergenceManifest(generated, { gate: false });
if (invalid.length) {
  throw new Error(invalid.map((item) => `${item.code}: ${item.file}: ${item.message}`).join('\n'));
}

if (check) {
  let committed;
  try {
    committed = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    throw new Error(
      'Committed convergence manifest is missing or invalid; run pnpm convergence:generate',
    );
  }
  const diagnostics = [
    ...validateConvergenceManifest(committed, { gate: false }),
    ...compareConvergenceManifests(committed, generated),
  ];
  if (diagnostics.length) {
    for (const item of diagnostics) {
      console.error(`${item.code}: ${item.file}: ${item.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Verified ${generated.entries.length} convergence entries across ${generated.sources.length} sources.`,
    );
  }
} else {
  let committed;
  try {
    committed = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    committed = null;
  }
  if (sourceKey) {
    const accepted = acceptChangedSourceEntry(generated, committed, sourceKey);
    await writeManifestAtomic(accepted);
    console.log(
      `Accepted ${sourceKey} in ${path.relative(repositoryRoot, target)} while preserving every other reviewed entry.`,
    );
  } else {
    const reconciled = mergeReviewedDecisions(generated, committed);
    await writeManifestAtomic(reconciled);
    console.log(
      `Wrote ${reconciled.entries.length} convergence entries to ${path.relative(repositoryRoot, target)} while preserving unchanged reviewed decisions.`,
    );
  }
}
