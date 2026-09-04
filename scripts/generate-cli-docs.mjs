import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps/cli/src/command-metadata.ts');
const outputRoot = path.join(root, 'content/instructions/shared');

async function loadRenderers() {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function generateCliDocs({ check = false } = {}) {
  const { renderBasicReference, renderCompleteReference } = await loadRenderers();
  const files = new Map([
    ['MPX_CLI_BASIC.md', renderBasicReference()],
    ['MPX_CLI_REFERENCE.md', renderCompleteReference()],
  ]);
  const drift = [];
  for (const [name, expected] of files) {
    const destination = path.join(outputRoot, name);
    if (check) {
      const actual = await readFile(destination, 'utf8').catch(() => undefined);
      if (actual !== expected) {
        drift.push(name);
      }
    } else {
      await writeFile(destination, expected, 'utf8');
    }
  }
  if (drift.length) {
    throw new Error(`Generated CLI documentation is stale: ${drift.join(', ')}`);
  }
  return [...files.keys()].map((name) => pathToFileURL(path.join(outputRoot, name)).pathname);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = await generateCliDocs({ check: process.argv.includes('--check') });
    console.log(
      `${process.argv.includes('--check') ? 'Checked' : 'Generated'} ${files.length} CLI references.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
