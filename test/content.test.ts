import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkOutput } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('built projections match the retained canonical content slice', async () => {
  assert.deepEqual(await checkOutput(root), [], 'Run pnpm build after canonical content changes.');
});

test('explorer preserves bounded read-only search and limits root inspection to approved names', async () => {
  const source = await readFile(new URL('../content/agents/explorer.md', import.meta.url), 'utf8');
  for (const text of ['modelClass: exploration', 'thinking: xhigh', 'Do not review, audit, or propose changes.', 'relevant project and version or source', 'file_path:line_number', 'native file-name search']) assert.ok(source.replace(/\s+/g, ' ').includes(text), text);
  assert.match(source, /for name in MPX_PROJECTS MPX_WORK MPX_CLONED MPX_APPS MPX_ONEDRIVE MPX_AI_GENERATED MPX_OBSIDIAN_VAULT;/);
  assert.doesNotMatch(source, /env \| grep|Overrides the built-in/);
});

test('handoff preserves its complete continuity template and availability fallback', async () => {
  const source = await readFile(new URL('../content/skills/handoff/SKILL.md', import.meta.url), 'utf8');
  for (const section of ['Progress This Session', 'Key Decisions', 'Dead Ends & Mistakes', 'Bugs Found', 'Next Steps', 'Critical Files', 'Working Memory']) assert.ok(source.includes(`## ${section}`));
  assert.match(source, /20–200 lines/);
  assert.match(source, /preserve still-relevant items/);
  assert.match(source, /If a companion skill is not installed/);
});
