import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assignWorktreePorts, normalizeNativeWindowsPath, prepareWorktree } from '../scripts/prepare-worktree.mjs';

const script = fileURLToPath(new URL('../scripts/prepare-worktree.mjs', import.meta.url));
const portOptions = {
  file: '.env.development.local',
  ports: [
    { name: 'VITE_COMPONENTS_PORT', base: 8100 },
    { name: 'VITE_DOCS_PORT', base: 8101 },
  ],
  offset: 0,
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=mpx', '-c', 'user.email=mpx@example.invalid', ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

async function repositoryFixture(run: (base: string, root: string, addWorktree: (name: string) => string) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), 'mpx-worktree-ports-'));
  const root = path.join(base, 'root');
  await mkdir(root);
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const addWorktree = (name: string) => {
    const worktree = path.join(base, name);
    git(root, 'worktree', 'add', '-q', '-b', name, worktree);
    return worktree;
  };
  try {
    await run(base, root, addWorktree);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function fixture(run: (base: string, root: string, worktree: string) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), 'mpx-prepare-worktree-'));
  const root = path.join(base, 'root');
  const worktree = path.join(base, 'worktree');
  await mkdir(root);
  await mkdir(worktree);
  try {
    await run(base, root, worktree);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

void test('normalizes only POSIX-style drive paths on native Windows', () => {
  assert.equal(normalizeNativeWindowsPath('/c/projects/repo', 'win32'), 'c:/projects/repo');
  assert.equal(normalizeNativeWindowsPath('C:\\projects\\repo', 'win32'), 'C:\\projects\\repo');
  assert.equal(normalizeNativeWindowsPath('/c/projects/repo', 'linux'), '/c/projects/repo');
});

void test('copies missing files recursively from each optional directory', async () => {
  await fixture(async (_base, root, worktree) => {
    await mkdir(path.join(root, '.vscode', 'nested'), { recursive: true });
    await mkdir(path.join(root, '.cursor'), { recursive: true });
    await mkdir(path.join(root, '.local'), { recursive: true });
    await writeFile(path.join(root, '.vscode', 'settings.json'), 'settings');
    await writeFile(path.join(root, '.vscode', 'nested', 'file.txt'), 'nested');
    await writeFile(path.join(root, '.cursor', 'rules'), 'rules');
    await writeFile(path.join(root, '.local', 'config'), 'local');

    await prepareWorktree(root, worktree);

    assert.equal(await readFile(path.join(worktree, '.vscode', 'settings.json'), 'utf8'), 'settings');
    assert.equal(await readFile(path.join(worktree, '.vscode', 'nested', 'file.txt'), 'utf8'), 'nested');
    assert.equal(await readFile(path.join(worktree, '.cursor', 'rules'), 'utf8'), 'rules');
    assert.equal(await readFile(path.join(worktree, '.local', 'config'), 'utf8'), 'local');
  });
});

void test('allows missing optional directories and preserves destination files on retries', async () => {
  await fixture(async (_base, root, worktree) => {
    await mkdir(path.join(root, '.vscode'));
    await writeFile(path.join(root, '.vscode', 'settings.json'), 'source');
    await prepareWorktree(root, worktree);
    await writeFile(path.join(worktree, '.vscode', 'settings.json'), 'modified');
    await prepareWorktree(root, worktree);
    assert.equal(await readFile(path.join(worktree, '.vscode', 'settings.json'), 'utf8'), 'modified');
  });
});

void test('allows sibling directories whose names share a prefix', async () => {
  await fixture(async (base, root) => {
    const sibling = path.join(base, 'root-named');
    await mkdir(sibling);
    await mkdir(path.join(root, '.local'));
    await writeFile(path.join(root, '.local', 'config'), 'local');

    await prepareWorktree(root, sibling);

    assert.equal(await readFile(path.join(sibling, '.local', 'config'), 'utf8'), 'local');
  });
});

void test('rejects missing, non-directory, identical, and overlapping roots', async () => {
  await fixture(async (base, root, worktree) => {
    await assert.rejects(prepareWorktree(undefined, worktree), /ORCA_ROOT_PATH is required/);
    await assert.rejects(prepareWorktree(path.join(base, 'missing'), worktree), /existing directory/);
    const file = path.join(base, 'file');
    await writeFile(file, 'x');
    await assert.rejects(prepareWorktree(file, worktree), /real directory/);
    await assert.rejects(prepareWorktree(root, root), /non-overlapping/);
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    await assert.rejects(prepareWorktree(root, nested), /non-overlapping/);
    await assert.rejects(prepareWorktree(nested, root), /non-overlapping/);
    const dotDotNamed = path.join(root, '..named');
    await mkdir(dotDotNamed);
    await assert.rejects(prepareWorktree(root, dotDotNamed), /non-overlapping/);
  });
});

void test('does not follow source directory symbolic links when supported', async (t) => {
  await fixture(async (base, root, worktree) => {
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'outside');
    await mkdir(path.join(root, '.vscode'));
    try {
      await symlink(outside, path.join(root, '.vscode', 'linked'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symbolic links are not permitted on this Windows host');
        return;
      }
      throw error;
    }

    await prepareWorktree(root, worktree);
    await assert.rejects(readFile(path.join(worktree, '.vscode', 'linked', 'secret')), /ENOENT/);
  });
});

void test('does not write through destination directory or file symbolic links when supported', async (t) => {
  await fixture(async (base, root, worktree) => {
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'outside');
    await mkdir(path.join(root, '.vscode'));
    await writeFile(path.join(root, '.vscode', 'new-file'), 'source');
    try {
      await symlink(outside, path.join(worktree, '.vscode'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symbolic links are not permitted on this Windows host');
        return;
      }
      throw error;
    }

    await prepareWorktree(root, worktree);
    await assert.rejects(readFile(path.join(outside, 'new-file')), /ENOENT/);

    await rm(path.join(worktree, '.vscode'));
    await mkdir(path.join(worktree, '.vscode'));
    await writeFile(path.join(root, '.vscode', 'secret'), 'source');
    try {
      await symlink(path.join(outside, 'secret'), path.join(worktree, '.vscode', 'secret'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('file symbolic links are not permitted on this Windows host');
        return;
      }
      throw error;
    }
    await prepareWorktree(root, worktree);
    assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'outside');
  });
});

void test('direct CLI reads Orca environment and reports failures without dumping contents', async () => {
  await fixture(async (base, root, worktree) => {
    await mkdir(path.join(root, '.cursor'));
    await writeFile(path.join(root, '.cursor', 'token'), 'sensitive-value');
    const success = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_ROOT_PATH: root, ORCA_WORKTREE_PATH: worktree },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(await readFile(path.join(worktree, '.cursor', 'token'), 'utf8'), 'sensitive-value');

    if (process.platform === 'win32') {
      const asPosixDrivePath = (value: string) => `/${value[0]!.toLowerCase()}${value.slice(2).split(path.win32.sep).join('/')}`;
      const posixSuccess = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCA_ROOT_PATH: asPosixDrivePath(root),
          ORCA_WORKTREE_PATH: asPosixDrivePath(worktree),
        },
      });
      assert.equal(posixSuccess.status, 0, posixSuccess.stderr);
    }

    const failure = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_ROOT_PATH: path.join(base, 'missing'), ORCA_WORKTREE_PATH: worktree },
    });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /^prepare-worktree: ORCA_ROOT_PATH must be an existing directory/m);
    assert.doesNotMatch(failure.stderr, /sensitive-value/);
  });
});

void test('assigns the lowest free port slot and reuses a slot after its worktree is removed', async () => {
  await repositoryFixture(async (_base, root, addWorktree) => {
    const first = addWorktree('first');
    const second = addWorktree('second');

    assert.deepEqual(await assignWorktreePorts(first, portOptions), {
      slot: 1,
      values: [
        { name: 'VITE_COMPONENTS_PORT', value: 8110 },
        { name: 'VITE_DOCS_PORT', value: 8111 },
      ],
    });
    assert.equal((await assignWorktreePorts(second, portOptions))?.slot, 2);
    assert.equal(
      await readFile(path.join(second, '.env.development.local'), 'utf8'),
      'VITE_COMPONENTS_PORT=8120\nVITE_DOCS_PORT=8121\n',
    );

    git(root, 'worktree', 'remove', '--force', first);
    const third = addWorktree('third');
    assert.equal((await assignWorktreePorts(third, portOptions))?.slot, 1);
  });
});

void test('applies the machine offset, honors any checkout on the slot grid, and ignores off-grid ports', async () => {
  await repositoryFixture(async (_base, root, addWorktree) => {
    await writeFile(path.join(root, '.env.development.local'), 'VITE_COMPONENTS_PORT=9110\n');
    const manual = addWorktree('manual');
    await writeFile(path.join(manual, '.env.development.local'), 'VITE_COMPONENTS_PORT=3000\n');
    const worktree = addWorktree('worktree');

    const assignment = await assignWorktreePorts(worktree, { ...portOptions, offset: 1000 });

    assert.equal(assignment?.slot, 2);
    assert.deepEqual(assignment?.values.map(({ value }) => value), [9120, 9121]);
  });
});

void test('appends ports to an existing file and keeps a file that already sets a port', async () => {
  await repositoryFixture(async (_base, root, addWorktree) => {
    const appended = addWorktree('appended');
    await writeFile(path.join(appended, '.env.development.local'), 'PLAYWRIGHT_WORKERS=2');
    await assignWorktreePorts(appended, portOptions);
    assert.equal(
      await readFile(path.join(appended, '.env.development.local'), 'utf8'),
      'PLAYWRIGHT_WORKERS=2\nVITE_COMPONENTS_PORT=8110\nVITE_DOCS_PORT=8111\n',
    );

    const kept = addWorktree('kept');
    await writeFile(path.join(kept, '.env.development.local'), 'VITE_DOCS_PORT=8555\n');
    assert.equal(await assignWorktreePorts(kept, portOptions), undefined);
    assert.equal(await readFile(path.join(kept, '.env.development.local'), 'utf8'), 'VITE_DOCS_PORT=8555\n');
  });
});

void test('direct CLI assigns ports with the machine offset after preparing the worktree', async () => {
  await repositoryFixture(async (_base, root, addWorktree) => {
    const worktree = addWorktree('cli');
    const result = spawnSync(
      process.execPath,
      [script, '--port-file', '.env.development.local', '--port', 'VITE_COMPONENTS_PORT=8100', '--port', 'VITE_DOCS_PORT=8101'],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_ROOT_PATH: root, ORCA_WORKTREE_PATH: worktree, MPX_PORT_OFFSET: '1000' },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /port slot 1 in \.env\.development\.local: VITE_COMPONENTS_PORT=9110 VITE_DOCS_PORT=9111/);
  });
});
