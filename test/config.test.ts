import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

test('parseRepositoryConfig accepts a projectId-only configuration', () => {
  assert.deepEqual(parseRepositoryConfig({ projectId: 'personal/orca' }), { projectId: 'personal/orca' });
});

test('parseRepositoryConfig retains explicit check commands and relative working directories', () => {
  const fast_checks = [{ command: 'pnpm exec prettier --write .  ', cwd: '.' }];
  const full_checks: never[] = [];
  assert.deepEqual(parseRepositoryConfig({ projectId: 'checks', fast_checks, full_checks }), {
    projectId: 'checks', fast_checks, full_checks,
  });
});

test('parseRepositoryConfig rejects malformed or escaping check commands', () => {
  for (const value of [
    { projectId: 'checks', fast_checks: {} },
    { projectId: 'checks', fast_checks: [{ command: '', cwd: '.' }] },
    { projectId: 'checks', full_checks: [{ command: 'pnpm test', cwd: '../other' }] },
    { projectId: 'checks', full_checks: [{ command: 'pnpm test', cwd: '/tmp' }] },
    { projectId: 'checks', full_checks: [{ command: 'pnpm test', cwd: 'D:checks' }] },
    { projectId: 'checks', full_checks: [{ command: 'pnpm test', cwd: '.', extra: true }] },
  ]) assert.throws(() => parseRepositoryConfig(value), /checks|command|cwd|unsupported/i);
});

test('parseRepositoryConfig accepts repository and issue roles independently', () => {
  assert.deepEqual(parseRepositoryConfig({
    projectId: 'repository-only', repository: repositoryConfig.repository,
  }), { projectId: 'repository-only', repository: repositoryConfig.repository });
  assert.deepEqual(parseRepositoryConfig({
    projectId: 'issues-only', issues: repositoryConfig.issues,
  }), { projectId: 'issues-only', issues: repositoryConfig.issues });
});

test('parseRepositoryConfig accepts independent supported providers and manager metadata', () => {
  assert.deepEqual(parseRepositoryConfig(repositoryConfig), repositoryConfig);
  for (const provider of ['github', 'gitlab', 'gerrit'] as const) {
    const parsed = parseRepositoryConfig({
      ...repositoryConfig,
      repository: { provider, remote: 'origin' },
      issues: { provider: 'kanbanflow', metadata: { boardId: 'board' } },
      packageManager: 'bun',
    });
    assert.deepEqual(parsed.repository, { provider, remote: 'origin' });
    assert.deepEqual(parsed.issues, { provider: 'kanbanflow', metadata: { boardId: 'board' } });
  }
});

test('parseRepositoryConfig strictly rejects malformed provided repository and issue roles', () => {
  for (const [value, message] of [
    [{ projectId: 'fixture', repository: null }, /repository must be an object/],
    [{ projectId: 'fixture', repository: { provider: 'github' } }, /repository remote/],
    [{ projectId: 'fixture', issues: [] }, /issues must be an object/],
    [{ projectId: 'fixture', issues: { provider: 'github', extra: true } }, /unsupported field extra/],
  ] as const) assert.throws(() => parseRepositoryConfig(value), message);
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
    domains: { personal: ['${MPX_PROJECTS}'], work: ['${MPX_WORK}', '${MPX_PROJECTS}/owned'], shared: ['${MPX_AI_DUMP}', '${MPX_TEMP}'] },
    defaultPacks: { personal: ['development', 'personal'], work: [] },
    executables: { pi: '${MPX_PI_EXECUTABLE}', claude: '${MPX_CLAUDE_EXECUTABLE}' },
  }));

  const config = await readUserConfig(file, {
    MPX_PROJECTS: projects,
    MPX_WORK: work,
    MPX_AI_DUMP: path.join(root, 'apps', '..', 'shared'),
    MPX_TEMP: path.join(root, 'scratch'),
    MPX_PI_EXECUTABLE: path.join(root, 'bin', '..', 'pi'),
    MPX_CLAUDE_EXECUTABLE: path.join(root, 'bin', 'claude'),
  });
  assert.equal(config.accounts.personal.pi, path.normalize(path.join(root, 'accounts', 'personal-pi')));
  assert.equal(config.domains.work[1], path.normalize(path.join(projects, 'owned')));
  assert.deepEqual(config.domains.shared, [path.join(root, 'shared'), path.join(root, 'scratch')]);
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

  await writeFile(file, JSON.stringify(base));
  assert.equal((await readUserConfig(file)).domains.shared, undefined);
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
  await writeFile(file, JSON.stringify({
    ...base,
    legacyPi: { accountRoot: path.join(root, 'legacy-account'), checkout: path.join(root, 'legacy-checkout') },
  }));
  await assert.rejects(readUserConfig(file), /unsupported field legacyPi/i);

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

  for (const [shared, message] of [
    [null, /domains\.shared must be an array/],
    ['not an array', /domains\.shared must be an array/],
    [[null], /domains\.shared\[0\].*non-empty string/],
    [['relative/shared'], /domains\.shared\[0\].*absolute path/],
    [['${HOME}/shared'], /domains\.shared\[0\].*unsupported environment variable/],
    [['${MPX_APPS}/shared'], /domains\.shared\[0\].*MPX_APPS.*not set/],
    [['${MPX_APPS/shared'], /domains\.shared\[0\].*malformed environment expansion/],
  ] as const) {
    await writeFile(file, JSON.stringify({ ...base, domains: { ...base.domains, shared } }));
    await assert.rejects(readUserConfig(file, {}), message);
  }

  await mkdir(path.join(root, 'personal'));
  const personalAlias = path.join(root, 'personal-alias');
  await symlink(path.join(root, 'personal'), personalAlias, 'junction');
  for (const owned of [path.join(root, 'personal', '.'), personalAlias, path.join(root, 'work', '..', 'work')]) {
    await writeFile(file, JSON.stringify({ ...base, domains: { ...base.domains, shared: [owned] } }));
    await assert.rejects(readUserConfig(file), /ambiguous.*shared.*domain/i);
  }
});

test('readUserConfig retains safely identifiable malformed project overrides as local diagnostics', async () => {
  const root = await temporaryDirectory('mpx-config-invalid-override-');
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({
    accounts: {
      personal: { pi: path.join(root, 'ppi'), claude: path.join(root, 'pcc') },
      work: { pi: path.join(root, 'wpi'), claude: path.join(root, 'wcc') },
    },
    domains: { personal: [], work: [] },
    projectOverrides: [{ path: path.join(root, 'project'), config: { projectId: '' } }],
  }));
  const config = await readUserConfig(file);
  assert.match(config.projectOverrideDiagnostics?.[0]?.message ?? '', /projectId/);
});

test('a non-Git folder accepts a direct minimal manifest without a missing-config warning', async () => {
  const root = await temporaryDirectory('mpx-config-minimal-folder-');
  await writeFile(path.join(root, 'mpxconfig.json'), JSON.stringify({ projectId: 'personal/orca' }));
  const selected = await resolveProject(root);
  assert.deepEqual(selected.config, { projectId: 'personal/orca' });
  assert.equal(selected.configSource, 'manifest');
  assert.deepEqual(selected.warnings, []);
});

test('project overrides provide absent configs, preserve manifests, and diagnose matching malformed overrides', async () => {
  const root = await temporaryDirectory('mpx-config-overrides-');
  const project = path.join(root, 'project');
  await mkdir(project);
  git(project, 'init');
  const overrideConfig = { projectId: 'override' };
  const fallback = userConfig({ projectOverrides: [{ path: project, config: overrideConfig }] });
  const selected = await resolveProject(project, fallback);
  assert.equal(selected.config?.projectId, 'override');
  assert.equal(selected.configSource, 'override');
  assert.equal(selected.configPath, await realpath(project));

  await writeFile(path.join(project, 'mpxconfig.json'), JSON.stringify(repositoryConfig));
  assert.equal((await resolveProject(project, fallback)).config?.projectId, 'example');

  await rm(path.join(project, 'mpxconfig.json'));
  const malformed = userConfig({ projectOverrideDiagnostics: [{ path: project, message: 'repository config projectId must be a non-empty string' }] });
  const invalid = await resolveProject(project, malformed);
  assert.equal(invalid.config, undefined);
  assert.equal(invalid.warnings[0]?.code, 'project-override-invalid');
  assert.equal(invalid.warnings[0]?.severity, 'orange');
});

test('Git discovery failures do not leak recursive ordinary-folder overrides or add missing-config warnings', async () => {
  const root = await temporaryDirectory('mpx-config-git-failure-');
  const parent = path.join(root, 'ordinary');
  const nested = path.join(parent, 'nested-repository');
  await mkdir(nested, { recursive: true });
  const shim = path.join(root, 'git-failure.mjs');
  await writeFile(shim, `process.stderr.write('fixture git unavailable'); process.exitCode = 2;`);
  const selected = await resolveProject(nested, userConfig({
    projectOverrides: [{ path: parent, config: { projectId: 'must-not-leak' } }],
  }), { gitExecutable: process.execPath, gitArguments: [shim] });
  assert.equal(selected.config, undefined);
  assert.deepEqual(selected.warnings.map(warning => warning.code), ['project-discovery-failed']);
  assert.equal(selected.warnings[0]?.severity, 'orange');
  assert.match(selected.warnings[0]?.message ?? '', new RegExp(nested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(selected.warnings[0]?.message ?? '', /fixture git unavailable/);
});

test('broken Git metadata is not treated as an ordinary folder', async () => {
  const root = await temporaryDirectory('mpx-config-broken-git-');
  const nested = path.join(root, 'repository');
  await mkdir(nested);
  const config = userConfig({
    projectOverrides: [{ path: root, config: { projectId: 'must-not-leak' } }],
  });
  await writeFile(path.join(nested, '.git'), 'gitdir: missing-metadata\n');
  const selected = await resolveProject(nested, config);
  assert.equal(selected.config, undefined);
  assert.deepEqual(selected.warnings.map(warning => warning.code), ['project-discovery-failed']);
  await rm(path.join(nested, '.git'));
  await mkdir(path.join(nested, '.git'));
  const child = path.join(nested, 'child');
  await mkdir(child);
  const corruptDirectory = await resolveProject(child, config);
  assert.equal(corruptDirectory.config, undefined);
  assert.deepEqual(corruptDirectory.warnings.map(warning => warning.code), ['project-discovery-failed']);
});

test('non-Git overrides recurse but never leak into a nested Git repository', async () => {
  const root = await temporaryDirectory('mpx-config-ordinary-');
  const parent = path.join(root, 'ordinary');
  const child = path.join(parent, 'child');
  const repository = path.join(parent, 'repository');
  await mkdir(child, { recursive: true });
  await mkdir(repository);
  git(repository, 'init');
  const config = userConfig({ projectOverrides: [{ path: parent, config: repositoryConfig }] });
  assert.equal((await resolveProject(child, config)).configSource, 'override');
  assert.equal((await resolveProject(repository, config)).config, undefined);
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

  await writeFile(path.join(main, 'mpxconfig.json'), '{broken');
  const malformedLinked = await resolveProject(linked);
  assert.match(malformedLinked.warnings[0]?.message ?? '', new RegExp(path.join(main, 'mpxconfig.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  const selection = await resolveProject(bare, userConfig({
    projectOverrides: [{ path: root, config: { projectId: 'must-not-recurse-into-bare' } }],
  }));
  assert.equal(selection.config, undefined);
  assert.equal(selection.warnings[0]?.code, 'project-config-missing');
});

test('resolveProject treats no Git, missing manifest, and malformed manifest as unregistered', async () => {
  const root = await temporaryDirectory('mpx-config-unregistered-');
  assert.equal((await resolveProject(root)).warnings[0]?.code, 'project-config-missing');

  git(root, 'init');
  const missing = await resolveProject(root);
  assert.equal(missing.config, undefined);
  assert.equal(missing.mainCheckout, await realpath(root));
  assert.equal(missing.warnings[0]?.code, 'project-config-missing');

  await writeFile(path.join(root, 'mpxconfig.json'), '{broken');
  const malformed = await resolveProject(root);
  assert.equal(malformed.config, undefined);
  assert.match(malformed.warnings.map(warning => warning.message).join('\n'), /mpxconfig\.json.*invalid/i);
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
    assert.match(result.warnings.map(warning => warning.message).join('\n'), /selection.*fallback/i);
  }

  const nativeOnlyRoot = await temporaryDirectory('mpx-config-native-only-');
  const result = await selectPacks(nativeOnlyRoot, 'pi', 'work', {
    config: { ...repositoryConfig, packs: ['missing'] }, warnings: [{ code: 'project-config-invalid', severity: 'orange', message: 'manifest warning' }],
  });
  assert.deepEqual(result.packs, []);
  assert.deepEqual(result.paths, []);
  assert.match(result.warnings.map(warning => warning.message).join('\n'), /manifest warning/);
  assert.match(result.warnings.map(warning => warning.message).join('\n'), /native skills only/i);
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
  assert.match(fileSelection.warnings.map(warning => warning.message).join('\n'), /selection.*fallback/i);
});
