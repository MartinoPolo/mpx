import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventoryProjectSkills } from '../../src/index.js';

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-project-support-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('ignores support-only directories while discovering managed and native skills', async () => {
  const root = await fixtureRoot();
  const skillsRoot = path.join(root, '.agents', 'skills');
  for (const name of ['shared', 'references', 'empty', 'commit', 'native']) {
    await mkdir(path.join(skillsRoot, name), { recursive: true });
  }
  await writeFile(path.join(skillsRoot, 'shared', 'GUIDE.md'), 'Shared instructions.');
  await writeFile(path.join(skillsRoot, 'references', 'README.md'), 'Reference material.');
  await writeFile(
    path.join(skillsRoot, 'commit', 'SKILL.md'),
    '---\nname: commit\ndescription: Project commit\nmetadata:\n  mpx:\n    projectExposure: full\n---\nProject body.\n',
  );
  await writeFile(
    path.join(skillsRoot, 'native', 'SKILL.md'),
    '---\nname: native\ndescription: Native skill\n---\nNative body.\n',
  );

  const inventory = await inventoryProjectSkills(root);
  expect(inventory.diagnostics).toEqual([]);
  expect(inventory.skills.map((skill) => skill.identity)).toEqual(['commit']);
  expect(inventory.nativeSkillDirectories.map((directory) => path.basename(directory))).toEqual([
    'native',
  ]);
});

it('does not hide malformed skills or non-file SKILL.md entries as support directories', async () => {
  const root = await fixtureRoot();
  const skillsRoot = path.join(root, '.agents', 'skills');
  await mkdir(path.join(skillsRoot, 'non-file', 'SKILL.md'), { recursive: true });
  await mkdir(path.join(skillsRoot, 'malformed'), { recursive: true });
  await writeFile(
    path.join(skillsRoot, 'malformed', 'SKILL.md'),
    '---\nname: malformed\ndescription: Invalid\nmetadata:\n  mpx:\n    projectExposure: invalid\n---\nBody.\n',
  );

  const inventory = await inventoryProjectSkills(root);
  expect(inventory.skills).toEqual([]);
  expect(inventory.nativeSkillDirectories).toEqual([]);
  expect(inventory.diagnostics.map((diagnostic) => diagnostic.path).sort()).toEqual([
    path.join(skillsRoot, 'malformed', 'SKILL.md'),
    path.join(skillsRoot, 'non-file', 'SKILL.md'),
  ]);
});
