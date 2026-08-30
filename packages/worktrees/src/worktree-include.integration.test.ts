import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createNodeWorktreeIncludeDependencies } from './node-worktree-include-adapters.js';
import { executeWorktreeIncludePlan, planWorktreeIncludes } from './worktree-include.js';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))),
);

async function init(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFileAsync('git', ['init', root]);
}

it('rejects a Windows junction whose matched file resolves outside the source checkout', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'mpx include junction-'));
  temporary.push(sandbox);
  const main = path.join(sandbox, 'main');
  const source = path.join(sandbox, 'source');
  const destination = path.join(sandbox, 'destination');
  const outside = path.join(sandbox, 'outside');
  await Promise.all([init(main), init(source), init(destination), mkdir(outside)]);
  await writeFile(path.join(main, '.worktreeinclude'), 'linked/**\n');
  await writeFile(path.join(outside, 'secret.txt'), 'must not escape');
  const junction = path.join(source, 'linked');
  await execFileAsync('cmd', ['/c', 'mklink', '/J', junction, outside]);
  try {
    await expect(
      planWorktreeIncludes(
        {
          repositoryId: 'integration/repo',
          sourceRoot: source,
          mainRoot: main,
          destinationRoot: destination,
        },
        createNodeWorktreeIncludeDependencies(),
      ),
    ).rejects.toMatchObject({ code: 'WORKTREE_INCLUDE_SOURCE_ESCAPE' });
  } finally {
    await execFileAsync('cmd', ['/c', 'rmdir', junction]);
  }
});

it('does not execute a repository-local git.exe shim for include Git invocations', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'mpx include git shim '));
  temporary.push(sandbox);
  const repository = path.join(sandbox, 'repository with spaces');
  await init(repository);
  const shim = path.join(repository, 'git.exe');
  await writeFile(shim, 'not a trusted executable');

  const output = await createNodeWorktreeIncludeDependencies().git.run(
    ['rev-parse', '--show-toplevel'],
    repository,
  );

  expect(path.resolve(output.toString('utf8').trim())).toBe(path.resolve(repository));
});

it('uses inert editor and sequence-editor settings for include Git invocations', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'mpx include inert editors '));
  temporary.push(sandbox);
  const repository = path.join(sandbox, 'repository with spaces');
  await init(repository);
  const previousEditor = process.env.GIT_EDITOR;
  const previousSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
  process.env.GIT_EDITOR = path.join(sandbox, 'impossible editor');
  process.env.GIT_SEQUENCE_EDITOR = path.join(sandbox, 'impossible sequence editor');
  try {
    const dependencies = createNodeWorktreeIncludeDependencies();
    const editor = await dependencies.git.run(['var', 'GIT_EDITOR'], repository);
    const sequenceEditor = await dependencies.git.run(['var', 'GIT_SEQUENCE_EDITOR'], repository);
    expect(editor.toString('utf8').trim()).toBe('true');
    expect(sequenceEditor.toString('utf8').trim()).toBe('true');
  } finally {
    if (previousEditor === undefined) {
      delete process.env.GIT_EDITOR;
    } else {
      process.env.GIT_EDITOR = previousEditor;
    }
    if (previousSequenceEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    } else {
      process.env.GIT_SEQUENCE_EDITOR = previousSequenceEditor;
    }
  }
});

async function interruptedCopyFixture(label: string) {
  const sandbox = await mkdtemp(path.join(tmpdir(), `mpx include retry ${label} `));
  temporary.push(sandbox);
  const main = path.join(sandbox, 'main');
  const source = path.join(sandbox, 'source');
  const destination = path.join(sandbox, 'destination');
  await Promise.all([init(main), init(source), init(destination)]);
  await writeFile(path.join(main, '.worktreeinclude'), 'private/**\n');
  await mkdir(path.join(source, 'private'), { recursive: true });
  await writeFile(path.join(source, 'private', 'a.txt'), 'approved-a');
  await writeFile(path.join(source, 'private', 'b.txt'), 'approved-b');
  const dependencies = createNodeWorktreeIncludeDependencies();
  const plan = await planWorktreeIncludes(
    {
      repositoryId: `integration/${label}`,
      sourceRoot: source,
      mainRoot: main,
      destinationRoot: destination,
    },
    dependencies,
  );
  let writes = 0;
  const interrupted = {
    ...dependencies,
    fs: {
      ...dependencies.fs,
      writeFileExclusive: async (file: string, content: Buffer) => {
        writes += 1;
        if (writes === 2) {
          throw new Error('simulated disk failure');
        }
        await dependencies.fs.writeFileExclusive!(file, content);
      },
    },
  };
  await expect(executeWorktreeIncludePlan(plan, plan.approval, interrupted)).rejects.toThrow(
    'simulated disk failure',
  );
  return { destination, dependencies, plan };
}

it('resumes an approved interrupted real-filesystem copy only when the prior write is hash-identical', async () => {
  const value = await interruptedCopyFixture('resume');

  await expect(
    executeWorktreeIncludePlan(value.plan, value.plan.approval, value.dependencies, true),
  ).resolves.toMatchObject({ copiedCount: 2 });
  await expect(readFile(path.join(value.destination, 'private', 'a.txt'), 'utf8')).resolves.toBe(
    'approved-a',
  );
  await expect(readFile(path.join(value.destination, 'private', 'b.txt'), 'utf8')).resolves.toBe(
    'approved-b',
  );
});

it('fails closed when a prior destination from an interrupted approved copy was mutated', async () => {
  const value = await interruptedCopyFixture('mutated');
  await writeFile(path.join(value.destination, 'private', 'a.txt'), 'tampered!!');

  await expect(
    executeWorktreeIncludePlan(value.plan, value.plan.approval, value.dependencies, true),
  ).rejects.toMatchObject({ code: 'WORKTREE_INCLUDE_DESTINATION_MISMATCH' });
  await expect(readFile(path.join(value.destination, 'private', 'b.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('copies ignored/untracked paths with spaces and unicode through real Git argv and source-first fallback', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'mpx include integration-'));
  temporary.push(sandbox);
  const main = path.join(sandbox, 'main repo');
  const source = path.join(sandbox, 'source checkout');
  const destination = path.join(sandbox, 'destination checkout');
  await Promise.all([init(main), init(source), init(destination)]);
  await writeFile(path.join(main, '.worktreeinclude'), 'local data/**\n資料/**\n');
  await mkdir(path.join(main, 'local data'), { recursive: true });
  await mkdir(path.join(source, 'local data'), { recursive: true });
  await mkdir(path.join(source, '資料'), { recursive: true });
  await writeFile(path.join(main, 'local data', 'fallback.txt'), 'main fallback');
  await writeFile(path.join(main, 'local data', 'shared.txt'), 'old main');
  await writeFile(path.join(source, 'local data', 'shared.txt'), 'source wins');
  await writeFile(path.join(source, '資料', '空 白.txt'), 'unicode path');

  const dependencies = createNodeWorktreeIncludeDependencies();
  const plan = await planWorktreeIncludes(
    {
      repositoryId: 'integration/repo',
      sourceRoot: source,
      mainRoot: main,
      destinationRoot: destination,
    },
    dependencies,
  );
  const result = await executeWorktreeIncludePlan(plan, plan.approval, dependencies);

  expect(result).toMatchObject({ copiedCount: 3 });
  await expect(readFile(path.join(destination, 'local data', 'shared.txt'), 'utf8')).resolves.toBe(
    'source wins',
  );
  await expect(
    readFile(path.join(destination, 'local data', 'fallback.txt'), 'utf8'),
  ).resolves.toBe('main fallback');
  await expect(readFile(path.join(destination, '資料', '空 白.txt'), 'utf8')).resolves.toBe(
    'unicode path',
  );
});
