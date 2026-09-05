import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createNodeSetupApplicationService } from '@mpx/application/node';
import {
  activateRelease,
  GitRemotePlanningAdapter,
  InstallIntentBuilder,
  InstallOrchestrator,
  NodeBinaryFileSystem,
  NodeCurrentReleaseBuilder,
  NodeGitCommandPort,
  NodePiNativeSettingsPort,
  NodeTransactionStore,
  ProductionInstallerOperationAdapter,
  removeActiveRelease,
  resolvePiNativePackageSource,
  type InstallIntentBuildResultV1,
} from '@mpx/installer';
import { FakeJsonResourceStore } from '@mpx/windows';
import { afterEach, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const disposableRoots: string[] = [];
const legacyEntries = [
  ['mpx-pi', 'agents', 'agents', 'tree'],
  ['mpx-pi', 'extensions', 'extensions', 'tree'],
  ['mpx-pi', 'prompts', 'prompts', 'tree'],
  ['mpx-pi', 'themes', 'themes', 'tree'],
  ['mpx-pi', 'APPEND_SYSTEM.md', 'APPEND_SYSTEM.md', 'file'],
  ['mpx-pi', 'keybindings.json', 'keybindings.json', 'file'],
  ['mpx-pi', 'settings.json', 'settings.json', 'file'],
  ['mpx-pi', 'subagents.json', 'subagents.json', 'file'],
  ['mpx-pi', 'skills/mp-symlink', 'skills/mp-symlink', 'tree'],
  ['mpx-pi', 'skills/mp-sync-base', 'skills/mp-sync-base', 'tree'],
  ['mpx-claude-code', 'instructions/AGENTS.md', 'AGENTS.md', 'file'],
  ['mpx-claude-code', 'skills/mp-fallow-fix', 'skills/mp-fallow-fix', 'tree'],
  ['mpx-claude-code', 'skills/mp-vocabulary', 'skills/mp-vocabulary', 'tree'],
] as const;

const materializationSource = (projects: string, repo: string, source: string): string =>
  path.join(
    projects,
    repo,
    repo === 'mpx-claude-code' && ['skills/mp-fallow-fix', 'skills/mp-vocabulary'].includes(source)
      ? `plugins/mp/${source}`
      : source,
  );

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

async function makeLink(target: string, destination: string, directory: boolean): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', 'mklink', ...(directory ? ['/D'] : []), destination, target],
      { windowsVerbatimArguments: true },
    );
  } else {
    const { symlink } = await import('node:fs/promises');
    await symlink(target, destination, directory ? 'dir' : 'file');
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-setup-production-'));
  disposableRoots.push(root);
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const home = path.join(root, 'home');
  const projects = path.join(root, 'projects');
  const workProjects = path.join(root, 'work-projects');
  const cloned = path.join(root, 'cloned');
  const apps = path.join(root, 'apps');
  const appData = path.join(root, 'appdata');
  const localAppData = path.join(root, 'localappdata');
  const piRoots = [path.join(home, '.pi', 'agent'), path.join(home, '.pi', 'agent-work')];
  const claudeRoots = [path.join(home, 'native-claude'), path.join(home, 'native-claude-work')];
  await Promise.all(
    [
      projects,
      workProjects,
      cloned,
      apps,
      path.join(appData, 'mpx'),
      localAppData,
      ...piRoots,
      ...claudeRoots,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );

  const unrelatedPiSettings = { packages: ['unrelated-package'], unrelatedField: 'preserve-me' };
  const sourceSentinels: string[] = [];
  for (const [repo, source, destination, kind] of legacyEntries) {
    const linkTarget = path.join(projects, repo, source);
    const sourcePath = materializationSource(projects, repo, source);
    const body =
      destination === 'settings.json'
        ? Buffer.from(`${JSON.stringify(unrelatedPiSettings, null, 2)}\r\n`)
        : Buffer.from(`legacy-source:${repo}:${source}\r\n`);
    if (kind === 'tree') {
      await mkdir(sourcePath, { recursive: true });
      const payload = path.join(sourcePath, 'source-sentinel.bin');
      await writeFile(payload, body);
      sourceSentinels.push(payload);
    } else {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, body);
      sourceSentinels.push(sourcePath);
    }
    for (const piRoot of piRoots) {
      await makeLink(linkTarget, path.join(piRoot, destination), kind === 'tree');
    }
  }

  const nativeSentinels: string[] = [];
  for (const nativeRoot of [...piRoots, ...claudeRoots]) {
    for (const [name, bytes] of [
      ['credentials.json', Buffer.from([0, 1, 2, 255, ...Buffer.from('credentials')])],
      ['sessions/session.bin', Buffer.from('session\r\nunchanged')],
      ['trust.json', Buffer.from('{"foreignTrust":true}\r\n')],
      ['cache/cache.bin', Buffer.from([255, 0, 127, 64])],
    ] as const) {
      const file = path.join(nativeRoot, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      nativeSentinels.push(file);
    }
  }

  const config = JSON.parse(
    await readFile(
      new URL('../../../packages/config/test/fixtures/user-launch-contracts.json', import.meta.url),
      'utf8',
    ),
  ) as { identities: Record<string, { runtimeRoots: { claude: string; pi: string } }> };
  config.identities.personal!.runtimeRoots = {
    claude: required(claudeRoots[0], 'personal Claude root'),
    pi: '~/.pi/agent',
  };
  config.identities.work!.runtimeRoots = {
    claude: required(claudeRoots[1], 'work Claude root'),
    pi: '~/.pi/agent-work',
  };
  const configFile = path.join(appData, 'mpx', 'config.json');
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\r\n`);
  await writeFile(configFile, configBytes);

  const bashProfile = path.join(home, '.bashrc');
  const powershellProfile = path.join(
    home,
    'Documents',
    'PowerShell',
    'Microsoft.PowerShell_profile.ps1',
  );
  const bashNative = Buffer.from('export FOREIGN_NATIVE=keep\r\n');
  const powershellNative = Buffer.from('$env:FOREIGN_NATIVE = "keep"\r\n');
  await mkdir(path.dirname(powershellProfile), { recursive: true });
  await writeFile(bashProfile, bashNative);
  await writeFile(powershellProfile, powershellNative);

  const environment = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
    MPX_PROJECTS: projects,
    MPX_WORK: workProjects,
    MPX_CLONED: cloned,
    MPX_APPS: apps,
    MPX_ONEDRIVE: path.join(root, 'onedrive'),
    MPX_AI_GENERATED: path.join(root, 'generated'),
    MPX_OBSIDIAN_VAULT: path.join(root, 'vault'),
    MPX_CLAUDE_EXECUTABLE: process.execPath,
    MPX_PI_EXECUTABLE: process.execPath,
    MPX_NODE_EXECUTABLE: process.execPath,
  };
  const terminalTarget = path.win32.join(
    localAppData,
    'Packages',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'LocalState',
    'settings.json',
  );
  const unrelatedShortcut = path.win32.join(home, 'Desktop', 'Foreign.lnk');
  const environmentTarget = 'HKCU\\Environment';
  const terminalValue = { profiles: [{ guid: 'foreign', name: 'Foreign' }], theme: 'keep' };
  const shortcutValue = { owner: 'foreign', targetPath: 'foreign.exe', note: 'keep' };
  const environmentValue = { FOREIGN_ENVIRONMENT: 'keep', OtherPathValue: 'unchanged' };
  const resources = new FakeJsonResourceStore({
    [terminalTarget]: terminalValue,
    [unrelatedShortcut]: shortcutValue,
    [environmentTarget]: environmentValue,
  });

  const before = new Map<string, Buffer>();
  for (const file of [...sourceSentinels, ...nativeSentinels, configFile]) {
    before.set(file, await readFile(file));
  }
  return {
    root,
    repositoryRoot,
    apps,
    localAppData,
    environment,
    piRoots,
    claudeRoots,
    configFile,
    bashProfile,
    powershellProfile,
    bashNative,
    powershellNative,
    sourceSentinels,
    nativeSentinels,
    before,
    unrelatedPiSettings,
    resources,
    resourceSentinels: [
      [terminalTarget, terminalValue],
      [unrelatedShortcut, shortcutValue],
      [environmentTarget, environmentValue],
    ] as const,
  };
}

afterEach(async () => {
  await Promise.all(
    disposableRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('runs setup twice and uninstalls only production-owned state in a fully disposable machine', async () => {
  const fixture = await createFixture();
  const releases = new NodeCurrentReleaseBuilder({
    repositoryRoot: fixture.repositoryRoot,
    appsRoot: fixture.apps,
  });
  const builder = new InstallIntentBuilder({
    releases,
    environment: fixture.environment,
    gitRemotes: new GitRemotePlanningAdapter({
      allowedRoots: [
        fixture.environment.MPX_PROJECTS,
        fixture.environment.MPX_WORK,
        fixture.environment.MPX_CLONED,
      ],
      git: new NodeGitCommandPort(fixture.environment),
    }),
  });
  let built: InstallIntentBuildResultV1 | undefined;
  const realBuild = builder.build.bind(builder);
  vi.spyOn(builder, 'build').mockImplementation(async (request) => {
    for (const piRoot of fixture.piRoots) {
      expect((await lstat(path.join(piRoot, 'settings.json'))).isSymbolicLink()).toBe(
        built === undefined,
      );
    }
    built = await realBuild(request);
    return built;
  });
  const runtimeRegistrations = {
    inspect: async (intent: InstallIntentBuildResultV1['intent']) => {
      for (const piRoot of fixture.piRoots) {
        for (const [, , destination] of legacyEntries) {
          expect((await lstat(path.join(piRoot, destination))).isSymbolicLink()).toBe(false);
        }
      }
      const registrations = intent.runtimeRegistrations!.registrations;
      return {
        observations: registrations.map(({ identity, executable, projection }) => ({
          identity,
          executable,
          projection,
        })),
        accountProbes: registrations.map((registration) => ({
          identity: registration.identity,
          runtime: registration.runtime,
          domain: registration.domain,
          nativeRootDigest: registration.nativeRootDigest,
          status: 'enrolled' as const,
          accountLabel: `${registration.domain}:disposable`,
        })),
        mcpSharing: Object.fromEntries(
          registrations.map((registration) => [
            registration.identity,
            registration.routes.mcpSharing,
          ]),
        ) as never,
      };
    },
  };
  const adapter = new ProductionInstallerOperationAdapter(fixture.environment, 'DISPOSABLE\\user', {
    files: new NodeBinaryFileSystem(),
    resources: fixture.resources,
    piNativeSettings: new NodePiNativeSettingsPort(),
    runtimeRegistrations,
  });
  const store = new NodeTransactionStore(path.join(fixture.localAppData, 'mpx', 'installer'));
  const orchestrator = new InstallOrchestrator({
    adapter,
    store,
    releases,
    activate: (releaseKey, prior) => activateRelease(fixture.localAppData, prior, releaseKey),
    deactivate: (releaseKey) => removeActiveRelease(fixture.localAppData, releaseKey),
  });
  const setup = createNodeSetupApplicationService({
    environment: fixture.environment,
    builder,
    orchestrator,
  });

  const first = await setup.execute();
  expect(first.verification).toEqual({ healthy: true, issues: [] });
  const intent = required(built, 'built setup intent').intent;
  const releaseRoot = path.join(fixture.apps, 'mpx', 'releases', intent.releaseKey);
  const packageSource = path.join(releaseRoot, 'runtimes', 'pi', 'extensions', 'dist', 'package');
  expect(
    intent
      .runtimeRegistrations!.registrations.filter((registration) => registration.runtime === 'pi')
      .map((registration) => ({
        name: registration.nativePackage.name,
        source: resolvePiNativePackageSource(releaseRoot, registration.nativePackage.packageRoot),
      })),
  ).toEqual([
    { name: '@mpx/pi-extensions', source: packageSource },
    { name: '@mpx/pi-extensions', source: packageSource },
  ]);
  for (const registration of intent.runtimeRegistrations!.registrations) {
    await expect(
      readFile(
        path.join(
          fixture.localAppData,
          'mpx',
          'installer',
          'registrations',
          `${registration.identity}.json`,
        ),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  }
  for (const file of ['build-metadata.json', 'index.mjs', 'package.json']) {
    await expect(readFile(path.join(packageSource, file))).resolves.toBeInstanceOf(Buffer);
  }
  await expect(
    orchestrator.verify(true, () => builder.verify(required(built, 'build result'))),
  ).resolves.toMatchObject({
    healthy: true,
    issues: [],
  });
  for (const piRoot of fixture.piRoots) {
    expect(JSON.parse(await readFile(path.join(piRoot, 'settings.json'), 'utf8'))).toEqual({
      packages: ['unrelated-package', packageSource],
      unrelatedField: 'preserve-me',
    });
    for (const [, , destination] of legacyEntries) {
      expect((await lstat(path.join(piRoot, destination))).isSymbolicLink()).toBe(false);
    }
    for (const skill of ['mp-fallow-fix', 'mp-vocabulary']) {
      expect(
        await readFile(path.join(piRoot, 'skills', skill, 'source-sentinel.bin'), 'utf8'),
      ).toBe(`legacy-source:mpx-claude-code:skills/${skill}\r\n`);
    }
  }
  expect(await readFile(fixture.bashProfile, 'utf8')).toContain(
    fixture.bashNative.toString('utf8'),
  );
  expect(await readFile(fixture.powershellProfile, 'utf8')).toContain(
    fixture.powershellNative.toString('utf8'),
  );
  for (const [target, original] of fixture.resourceSentinels) {
    if (target === 'HKCU\\Environment') {
      expect(await fixture.resources.read(target)).toMatchObject(original);
    } else {
      expect(await fixture.resources.read(target)).toEqual(original);
    }
  }
  for (const [file, bytes] of fixture.before) {
    expect(await readFile(file), file).toEqual(bytes);
  }

  await expect(setup.execute()).resolves.toMatchObject({ verification: { healthy: true } });
  for (const piRoot of fixture.piRoots) {
    const settings = JSON.parse(await readFile(path.join(piRoot, 'settings.json'), 'utf8')) as {
      packages: string[];
    };
    expect(settings.packages.filter((entry) => entry === packageSource)).toHaveLength(1);
  }

  const uninstallPlan = await orchestrator.planUninstall();
  await orchestrator.uninstall(uninstallPlan.confirmationDigest);
  for (const piRoot of fixture.piRoots) {
    expect(JSON.parse(await readFile(path.join(piRoot, 'settings.json'), 'utf8'))).toEqual(
      fixture.unrelatedPiSettings,
    );
    for (const [, , destination] of legacyEntries) {
      expect((await lstat(path.join(piRoot, destination))).isSymbolicLink()).toBe(false);
    }
  }
  await expect(readFile(path.join(fixture.apps, 'mpx', 'bin', 'mpx.cmd'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  for (const registration of intent.runtimeRegistrations!.registrations) {
    await expect(
      readFile(
        path.join(
          fixture.localAppData,
          'mpx',
          'installer',
          'registrations',
          `${registration.identity}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        path.join(
          fixture.localAppData,
          'mpx',
          'runtime-projections',
          intent.releaseKey,
          registration.identity,
          'projection.json',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await expect(readFile(path.join(releaseRoot, 'release-manifest.json'))).resolves.toBeInstanceOf(
    Buffer,
  );
  await expect(
    readFile(path.join(fixture.localAppData, 'mpx', 'pi-legacy-detach.receipt.json')),
  ).resolves.toBeInstanceOf(Buffer);
  expect(await readFile(fixture.bashProfile)).toEqual(fixture.bashNative);
  expect(await readFile(fixture.powershellProfile)).toEqual(fixture.powershellNative);
  for (const [target, original] of fixture.resourceSentinels) {
    expect(await fixture.resources.read(target)).toEqual(original);
  }
  for (const [file, bytes] of fixture.before) {
    expect(await readFile(file), file).toEqual(bytes);
  }
}, 300_000);
