import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  parseRepositoryConfig,
  readUserConfig,
  resolveProject,
  selectPacks,
} from '../src/config.js';
import type { ProjectSelection, RepositoryConfig, UserConfig } from '../src/contracts.js';

const repositoryConfig: RepositoryConfig = {
  projectId: 'example',
  repository: { provider: 'gitlab', remote: 'group/example' },
  issues: { provider: 'github', metadata: { repository: 'other/issues' } },
  packageManager: 'pnpm',
  packs: ['development'],
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function makePack(root: string, pack: string, harness: 'pi' | 'claude'): Promise<string> {
  const directory = harness === 'pi'
    ? path.join(root, 'dist', 'packs', pack, 'pi', 'skills')
    : path.join(root, 'dist', 'packs', pack, 'claude');
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

function userConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    accounts: {
      personal: { pi: '/accounts/personal/pi', claude: '/accounts/personal/claude' },
      work: { pi: '/accounts/work/pi', claude: '/accounts/work/claude' },
    },
    domains: { personal: ['/personal'], work: ['/work'] },
    ...overrides,
  };
}

test('parseRepositoryConfig accepts independent supported providers and manager metadata', () => {
  assert.deepEqual(parseRepositoryConfig(repositoryConfig), repositoryConfig);
  for (const provider of ['github', 'gitlab', 'gerrit'] as const) {
    const parsed = parseRepositoryConfig({
      ...repositoryConfig,
      repository: { provider, remote: 'origin' },
      issues: { provider: 'kanbanflow', metadata: { boardId: 'board' } },
      packageManager: 'bun',
    });
    assert.equal(parsed.repository.provider, provider);
    assert.equal(parsed.issues.provider, 'kanbanflow');
  }
});

test('parseRepositoryConfig rejects malformed configuration and local issues directly', () => {
  for (const [value, message] of [
    [{ ...repositoryConfig, projectId: '' }, /projectId/],
    [{ ...repositoryConfig, repository: { provider: 'bitbucket', remote: 'x' } }, /repository provider/],
    [{ ...repositoryConfig, issues: { provider: 'jira' } }, /issue provider/],
    [{ ...repositoryConfig, packageManager: 'volta' }, /packageManager/],
    [{ ...repositoryConfig, packs: ['../personal'] }, /safe lowercase/],
    [{ ...repositoryConfig, credentials: { token: 'not-owned' } }, /unsupported field credentials/],
  ] as const) {
    assert.throws(() => parseRepositoryConfig(value), message);
  }
  assert.throws(
    () => parseRepositoryConfig({ ...repositoryConfig, issues: { provider: 'local' } }),
    /local issues are unsupported/i,
  );
});

test('readUserConfig expands only approved variables and returns normalized paths', async () => {
  const root = await temporaryDirectory('mpx-config-user-');
  const projects = path.join(root, 'projects');
  const work = path.join(root, 'work');
  await Promise.all([
    mkdir(path.join(root, 'accounts', 'personal-pi'), { recursive: true }),
    mkdir(path.join(root, 'accounts', 'personal-claude'), { recursive: true }),
    mkdir(path.join(root, 'accounts', 'work-pi'), { recursive: true }),
    mkdir(path.join(root, 'accounts', 'work-claude'), { recursive: true }),
  ]);
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({
    accounts: {
      personal: {
        pi: '${MPX_PROJECTS}/../accounts/personal-pi',
        claude: '${MPX_PROJECTS}/../accounts/personal-claude',
      },
      work: {
        pi: '${MPX_WORK}/../accounts/work-pi',
        claude: '${MPX_WORK}/../accounts/work-claude',
      },
    },
    domains: { personal: ['${MPX_PROJECTS}'], work: ['${MPX_WORK}', '${MPX_PROJECTS}/shared'] },
    defaultPacks: { personal: ['development', 'personal'], work: [] },
    executables: { pi: '${MPX_PI_EXECUTABLE}', claude: '${MPX_CLAUDE_EXECUTABLE}' },
  }));

  const config = await readUserConfig(file, {
    MPX_PROJECTS: projects,
    MPX_WORK: work,
    MPX_PI_EXECUTABLE: path.join(root, 'bin', '..', 'pi'),
    MPX_CLAUDE_EXECUTABLE: path.join(root, 'bin', 'claude'),
  });
  assert.equal(config.accounts.personal.pi, path.normalize(path.join(root, 'accounts', 'personal-pi')));
  assert.equal(config.domains.work[1], path.normalize(path.join(projects, 'shared')));
  assert.equal(config.executables?.pi, path.normalize(path.join(root, 'pi')));
  assert.deepEqual(config.defaultPacks?.work, []);
});

test('readUserConfig rejects missing paths, unsupported expansion, aliases, and ambiguous domains', async () => {
  const root = await temporaryDirectory('mpx-config-invalid-user-');
  const file = path.join(root, 'config.json');
  const base = {
    accounts: {
      personal: { pi: path.join(root, 'ppi'), claude: path.join(root, 'pcc') },
      work: { pi: path.join(root, 'wpi'), claude: path.join(root, 'wcc') },
    },
    domains: { personal: [path.join(root, 'personal')], work: [path.join(root, 'work')] },
  };

  await writeFile(file, JSON.stringify({ ...base, accounts: { personal: base.accounts.personal } }));
  await assert.rejects(readUserConfig(file), /accounts\.work/);
  await writeFile(file, JSON.stringify({ ...base, domains: { ...base.domains, personal: ['${HOME}/guess'] } }));
  await assert.rejects(readUserConfig(file, { HOME: root }), /unsupported environment variable/i);
  await writeFile(file, JSON.stringify({ ...base, domains: { ...base.domains, personal: ['${MPX_PROJECTS}'] } }));
  await assert.rejects(readUserConfig(file, {}), /MPX_PROJECTS.*not set/i);

  await writeFile(file, JSON.stringify({
    ...base,
    accounts: { ...base.accounts, personal: { ...base.accounts.personal, pi: 'relative/account' } },
  }));
  await assert.rejects(readUserConfig(file), /accounts\.personal\.pi.*absolute path/i);
  await writeFile(file, JSON.stringify({
    ...base,
    domains: { ...base.domains, work: ['relative/domain'] },
  }));
  await assert.rejects(readUserConfig(file), /domains\.work\[0\].*absolute path/i);
  await writeFile(file, JSON.stringify({ ...base, executables: { pi: 'relative/pi' } }));
  await assert.rejects(readUserConfig(file), /executables\.pi.*absolute path/i);

  const shared = path.join(root, 'shared-account');
  await mkdir(shared);
  const alias = path.join(root, 'shared-account-alias');
  await symlink(shared, alias, 'junction');
  await writeFile(file, JSON.stringify({
    ...base,
    accounts: {
      personal: { ...base.accounts.personal, pi: shared },
      work: { ...base.accounts.work, pi: alias },
    },
  }));
  await assert.rejects(readUserConfig(file), /personal and work pi account roots.*same/i);

  await writeFile(file, JSON.stringify({
    ...base,
    domains: { personal: [path.join(root, 'same')], work: [path.join(root, 'same', '.')] },
  }));
  await assert.rejects(readUserConfig(file), /ambiguous.*domain/i);
});

test('resolveProject handles main checkout, subdirectories, and a fresh linked worktree', async () => {
  const root = await temporaryDirectory('mpx-config-git-');
  const main = path.join(root, 'main');
  await mkdir(main);
  git(main, 'init');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'config', 'user.name', 'Fixture');
  await writeFile(path.join(main, 'seed'), 'seed');
  await writeFile(path.join(main, 'mpxconfig.json'), JSON.stringify(repositoryConfig));
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'fixture');
  await mkdir(path.join(main, 'nested'));

  const mainSelection = await resolveProject(path.join(main, 'nested'));
  assert.equal(mainSelection.mainCheckout, await realpath(main));
  assert.equal(mainSelection.config?.projectId, 'example');
  assert.deepEqual(mainSelection.warnings, []);

  const linked = path.join(root, 'linked');
  git(main, 'worktree', 'add', linked, '-b', 'fixture-linked');
  await writeFile(path.join(main, 'mpxconfig.json'), JSON.stringify({ ...repositoryConfig, packs: [] }));
  const linkedSelection = await resolveProject(linked);
  assert.equal(linkedSelection.mainCheckout, await realpath(main));
  assert.deepEqual(linkedSelection.config?.packs, []);
});

test('resolveProject finds a separate-git-dir main checkout and its linked worktrees', async () => {
  const root = await temporaryDirectory('mpx-config-separate-git-');
  const main = path.join(root, 'main');
  const gitDirectory = path.join(root, 'metadata', 'repository.git');
  await mkdir(path.dirname(gitDirectory));
  git(root, 'init', '--separate-git-dir', gitDirectory, main);
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  git(main, 'config', 'user.name', 'Fixture');
  await writeFile(path.join(main, 'seed'), 'seed');
  await writeFile(path.join(main, 'mpxconfig.json'), JSON.stringify(repositoryConfig));
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'fixture');

  const fromMain = await resolveProject(main);
  assert.equal(fromMain.mainCheckout, await realpath(main));
  assert.equal(fromMain.config?.projectId, 'example');

  // Git does not retain a reverse path to an external worktree; make it explicit before linking.
  git(main, 'config', 'core.worktree', main);
  const linked = path.join(root, 'linked');
  git(main, 'worktree', 'add', linked, '-b', 'fixture-separate-linked');
  await writeFile(path.join(main, 'mpxconfig.json'), JSON.stringify({ ...repositoryConfig, packs: [] }));
  const fromLinked = await resolveProject(linked);
  assert.equal(fromLinked.mainCheckout, await realpath(main));
  assert.deepEqual(fromLinked.config?.packs, []);
});

test('resolveProject treats a bare repository as having no registered checkout', async () => {
  const root = await temporaryDirectory('mpx-config-bare-git-');
  const bare = path.join(root, 'bare.git');
  git(root, 'init', '--bare', bare);
  assert.deepEqual(await resolveProject(bare), { warnings: [] });
});

test('resolveProject treats no Git, missing manifest, and malformed manifest as unregistered', async () => {
  const root = await temporaryDirectory('mpx-config-unregistered-');
  assert.deepEqual(await resolveProject(root), { warnings: [] });

  git(root, 'init');
  const missing = await resolveProject(root);
  assert.equal(missing.config, undefined);
  assert.equal(missing.mainCheckout, await realpath(root));
  assert.deepEqual(missing.warnings, []);

  await writeFile(path.join(root, 'mpxconfig.json'), '{broken');
  const malformed = await resolveProject(root);
  assert.equal(malformed.config, undefined);
  assert.match(malformed.warnings.join('\n'), /mpxconfig\.json.*invalid/i);
});

test('selectPacks applies account defaults and configured defaults', async () => {
  const root = await temporaryDirectory('mpx-config-packs-');
  const development = await makePack(root, 'development', 'pi');
  const personal = await makePack(root, 'personal', 'pi');
  const review = await makePack(root, 'review', 'pi');
  const unregistered: ProjectSelection = { warnings: [] };

  assert.deepEqual(await selectPacks(root, 'pi', 'personal', unregistered), {
    packs: ['development', 'personal'], paths: [development, personal], warnings: [],
  });
  assert.deepEqual(await selectPacks(root, 'pi', 'work', unregistered, userConfig({
    defaultPacks: { work: ['review'] },
  })), { packs: ['review'], paths: [review], warnings: [] });
});

test('selectPacks preserves explicit empty and valid replacement selections', async () => {
  const root = await temporaryDirectory('mpx-config-explicit-packs-');
  const review = await makePack(root, 'review', 'claude');
  assert.deepEqual(await selectPacks(root, 'claude', 'personal', {
    config: { ...repositoryConfig, packs: [] }, warnings: [],
  }), { packs: [], paths: [], warnings: [] });
  assert.deepEqual(await selectPacks(root, 'claude', 'personal', {
    config: { ...repositoryConfig, packs: ['review'] }, warnings: [],
  }), { packs: ['review'], paths: [review], warnings: [] });
});

test('selectPacks falls back on unsafe, unknown, or unavailable explicit selections', async () => {
  const root = await temporaryDirectory('mpx-config-fallback-packs-');
  const development = await makePack(root, 'development', 'pi');
  const personal = await makePack(root, 'personal', 'pi');
  for (const packs of [['unknown'], ['../personal']] as string[][]) {
    const result = await selectPacks(root, 'pi', 'personal', {
      config: { ...repositoryConfig, packs }, warnings: [],
    });
    assert.deepEqual(result.packs, ['development', 'personal']);
    assert.deepEqual(result.paths, [development, personal]);
    assert.match(result.warnings.join('\n'), /selection.*fallback/i);
  }

  const nativeOnlyRoot = await temporaryDirectory('mpx-config-native-only-');
  const result = await selectPacks(nativeOnlyRoot, 'pi', 'work', {
    config: { ...repositoryConfig, packs: ['missing'] }, warnings: ['manifest warning'],
  });
  assert.deepEqual(result.packs, []);
  assert.deepEqual(result.paths, []);
  assert.match(result.warnings.join('\n'), /manifest warning/);
  assert.match(result.warnings.join('\n'), /native skills only/i);
});

test('selectPacks requires directories and keeps concurrent repository selections isolated', async () => {
  const root = await temporaryDirectory('mpx-config-concurrent-');
  const alpha = await makePack(root, 'alpha', 'pi');
  const beta = await makePack(root, 'beta', 'pi');
  await writeFile(path.join(root, 'dist', 'packs', 'not-a-directory'), 'file');
  const [first, second, fileSelection] = await Promise.all([
    selectPacks(root, 'pi', 'work', { config: { ...repositoryConfig, packs: ['alpha'] }, warnings: [] }),
    selectPacks(root, 'pi', 'work', { config: { ...repositoryConfig, packs: ['beta'] }, warnings: [] }),
    selectPacks(root, 'pi', 'work', { config: { ...repositoryConfig, packs: ['not-a-directory'] }, warnings: [] }, userConfig({ defaultPacks: { work: [] } })),
  ]);
  assert.deepEqual(first, { packs: ['alpha'], paths: [alpha], warnings: [] });
  assert.deepEqual(second, { packs: ['beta'], paths: [beta], warnings: [] });
  assert.deepEqual(fileSelection.packs, []);
  assert.deepEqual(fileSelection.paths, []);
  assert.match(fileSelection.warnings.join('\n'), /selection.*fallback/i);
});
