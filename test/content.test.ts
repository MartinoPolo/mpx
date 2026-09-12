import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkOutput } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('committed projections match the retained canonical content slice', async () => {
  assert.deepEqual(await checkOutput(root), [], 'Run pnpm build and commit projections with canonical changes.');
});

test('handoff preserves its complete continuity template and availability fallback', async () => {
  const source = await readFile(new URL('../content/skills/handoff/SKILL.md', import.meta.url), 'utf8');
  for (const section of ['Progress This Session', 'Key Decisions', 'Dead Ends & Mistakes', 'Bugs Found', 'Next Steps', 'Critical Files', 'Working Memory']) assert.ok(source.includes(`## ${section}`));
  assert.match(source, /20–200 lines/);
  assert.match(source, /preserve still-relevant items/);
  assert.match(source, /If a companion skill is not installed/);
});
