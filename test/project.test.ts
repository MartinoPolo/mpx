import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupProject } from '../src/project.js';

test('project setup links only project-owned skills and preserves conflicts/configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-project-'));
  try {
    assert.equal((await setupProject(root)).status, 'missing-source');
    await mkdir(join(root, '.agents/skills'), { recursive: true });
    await writeFile(join(root, 'orca.yaml'), 'keep');
    assert.equal((await setupProject(root, true)).status, 'planned');
    assert.equal((await setupProject(root)).status, 'linked');
    assert.equal(resolve(await readlink(join(root, '.claude/skills'))), resolve(root, '.agents/skills'));
    assert.equal((await setupProject(root)).status, 'linked');
    await rm(join(root, '.claude/skills'));
    await mkdir(join(root, '.claude/skills'));
    assert.equal((await setupProject(root)).status, 'conflict');
    assert.equal(await readFile(join(root, 'orca.yaml'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});
