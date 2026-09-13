#!/usr/bin/env node
// One reviewed transfer only. Never overwrites a canonical destination or changes legacy sources.
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projects = process.env.MPX_PROJECTS;
if (!projects || !isAbsolute(projects)) throw new Error('An absolute MPX_PROJECTS is required.');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const destination = join(root, 'content', 'agents', 'explorer.md');
if (await realpath(join(root, 'content', 'agents')) !== join(root, 'content', 'agents')) throw new Error('Canonical agent directory must not be redirected.');
let source = await readFile(join(projects, 'mpx', 'content', 'agents', 'mpx-explorer.md'), 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error(`Reviewed source changed: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
replaceOnce('name: mpx-explorer\n', 'name: explorer\n');
replaceOnce("---\n\nLocate and report.", "metadata:\n  mpx:\n    schemaVersion: 1\n    modelClass: exploration\n    thinking: medium\n    capabilities: [read, search, shell]\n---\n\nLocate and report.");
replaceOnce('Cast wide first (`Glob`, then `Grep` on symbol and string patterns), then read only the excerpts', 'Cast wide first (native file-name search, then text search on symbol and string patterns), then read only the excerpts');
replaceOnce("env | grep '^MPX_' | sort", 'for name in MPX_PROJECTS MPX_WORK MPX_CLONED MPX_APPS MPX_ONEDRIVE MPX_AI_GENERATED MPX_OBSIDIAN_VAULT; do\n  printf \'%s=%s\\n\' "$name" "${!name}"\ndone');
await writeFile(destination, source, { flag: 'wx' });
console.log('Transferred explorer: native tool terminology, allowlisted machine roots, and canonical metadata only.');
