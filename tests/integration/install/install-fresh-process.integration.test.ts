import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('reports an uninstalled machine from mpx install verify in each fresh process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-install-fresh-'));
  const entry = fileURLToPath(new URL('../../../apps/cli/dist/main.js', import.meta.url));
  const env = {
    ...process.env,
    MPX_APPS: path.join(root, 'apps'),
    APPDATA: path.join(root, 'roaming'),
    LOCALAPPDATA: path.join(root, 'local'),
    USERPROFILE: path.join(root, 'user'),
  };
  for (let processIndex = 0; processIndex < 2; processIndex++) {
    const { stdout, stderr } = await execute(
      process.execPath,
      [entry, '--json', 'install', 'verify'],
      { env, windowsHide: true },
    );
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        kind: 'install-verification',
        healthy: false,
        issues: ['receipt-missing'],
      },
    });
  }
}, 30_000);

it('builds deterministic intent and prepare plans in fresh read-only processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-install-guided-'));
  const machine = path.join(root, 'machine'),
    configPath = path.join(machine, 'roaming', 'mpx', 'config.json'),
    requestPath = path.join(root, 'request.json'),
    intentPath = path.join(root, 'intent.json');
  const native = (name: string) => path.join(root, 'native', name);
  const config = {
    identities: {
      home: {
        domain: 'personal',
        runtimeRoots: { claude: native('claude-personal'), pi: native('pi-personal') },
        gitAuthorRoute: 'home-git',
        providerRoutes: { github: 'home-gh' },
        sshRoute: 'home-ssh',
      },
      office: {
        domain: 'work',
        runtimeRoots: { claude: native('claude-work'), pi: native('pi-work') },
        gitAuthorRoute: 'work-git',
        providerRoutes: { github: 'work-gh' },
        sshRoute: 'work-ssh',
      },
    },
    domains: { personal: ['${MPX_PROJECTS}'], work: ['${MPX_WORK}'] },
    contentScopes: {},
    modes: {},
    skillPolicies: {},
    presets: {},
    launchDefaults: { projects: {}, scopes: {} },
    networkPolicies: {},
    executors: { host: {} },
  };
  const configSource = `${JSON.stringify(config, null, 2)}\n`;
  await mkdir(native('pi-personal'), { recursive: true });
  await mkdir(native('pi-work'), { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, configSource);
  const files = [
    'content/instructions/COMPACT.md',
    'content/instructions/global/AGENTS.md',
    'content/skills/agent-create/SKILL.md',
    'content/skills/architecture-review/REFERENCE.md',
    'content/skills/architecture-review/SKILL.md',
    'content/skills/code-clean/SKILL.md',
    'content/skills/execute/CLOSE_OUT.md',
    'content/skills/execute/SKILL.md',
    'content/skills/execute/mocking.md',
    'content/skills/execute/tests.md',
    'content/skills/grill/SKILL.md',
    'content/skills/handoff/SKILL.md',
    'content/skills/review/SKILL.md',
    'content/skills/commit-push/SKILL.md',
    'content/skills/design-refine/SKILL.md',
    'content/skills/epic-review/SKILL.md',
  ].sort((left, right) => left.localeCompare(right));
  const claudeRoles = [
      'plugin',
      'hooks',
      'status',
      'settings',
      'canonical-content',
      'agents',
      'licenses',
    ],
    piRoles = ['profile', 'status', 'settings', 'canonical-content', 'agents', 'licenses'];
  const request = {
    schemaVersion: 1,
    kind: 'install-intent-request',
    userConfigPath: configPath,
    identities: { personal: 'home', work: 'office' },
    providers: { personal: 'github', work: 'github' },
    executables: {
      claude: { path: process.execPath, version: process.version },
      pi: { path: process.execPath, version: process.version },
    },
    projections: {
      claude: claudeRoles.map((role, index) => ({ path: files[index], role })),
      pi: piRoles.map((role, index) => ({ path: files[index + claudeRoles.length], role })),
    },
    external: { gitRemotes: [] },
  };
  await writeFile(requestPath, JSON.stringify(request));
  const entry = fileURLToPath(new URL('../../../apps/cli/dist/main.js', import.meta.url));
  const env = {
    ...process.env,
    MPX_APPS: path.join(machine, 'apps'),
    APPDATA: path.join(machine, 'roaming'),
    LOCALAPPDATA: path.join(machine, 'local'),
    MPX_PROJECTS: path.join(machine, 'projects'),
    MPX_WORK: path.join(machine, 'work'),
    MPX_CLONED: path.join(machine, 'cloned'),
    USERPROFILE: path.join(machine, 'user'),
  };
  const run = async (args: string[]) =>
    JSON.parse(
      (await execute(process.execPath, [entry, '--json', ...args], { env, windowsHide: true }))
        .stdout,
    ) as { ok: boolean; data: unknown };
  const first = await run(['install', 'intent', '--request', requestPath]),
    second = await run(['install', 'intent', '--request', requestPath]);
  expect(first).toEqual(second);
  expect(first.ok).toBe(true);
  await writeFile(intentPath, JSON.stringify(first.data));
  const planned = await run(['install', 'plan', '--intent', intentPath]),
    prepared = await run(['install', 'prepare', '--request', requestPath]);
  expect(planned).toEqual(prepared);
  expect(planned).toMatchObject({
    ok: true,
    data: { kind: 'install-plan', confirmationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  });
  expect(prepared).toMatchObject({
    ok: true,
    data: {
      kind: 'install-plan',
      confirmationDigest: (planned.data as { confirmationDigest: string }).confirmationDigest,
    },
  });
  expect(await readFile(configPath, 'utf8')).toBe(configSource);
  for (const name of ['apps', 'local', 'projects', 'work', 'cloned']) {
    expect(
      await readdir(path.join(machine, name)).catch((error) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(error),
      ),
    ).toEqual([]);
  }
}, 60_000);
