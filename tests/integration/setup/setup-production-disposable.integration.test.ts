import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createNodeSetupApplicationService, NodeSetupRequestFactory } from '@mpx/application/node';
import {
  activateRelease,
  buildReleaseManifest,
  publishRelease,
  installerDigest,
  InstallIntentBuilder,
  InstallOrchestrator,
  NodeBinaryFileSystem,
  NodeCurrentReleaseBuilder,
  NodePiNativeSettingsPort,
  NodeTransactionStore,
  ProductionInstallerOperationAdapter,
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

async function createFixture(currentInstallation: boolean) {
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
      if (currentInstallation && destination === 'settings.json') {
        await writeFile(path.join(piRoot, destination), body);
      } else if (currentInstallation && destination === 'extensions') {
        await mkdir(path.join(piRoot, destination));
        await makeLink(linkTarget, path.join(piRoot, destination, 'mpx'), true);
        const worktreeTarget = path.join(projects, 'mpx.worktrees', 'deliberate-extension');
        await mkdir(worktreeTarget, { recursive: true });
        await writeFile(path.join(worktreeTarget, 'index.ts'), 'export const retained = true;\n');
        sourceSentinels.push(path.join(worktreeTarget, 'index.ts'));
        await makeLink(worktreeTarget, path.join(piRoot, destination, 'worktree'), true);
      } else {
        await makeLink(linkTarget, path.join(piRoot, destination), kind === 'tree');
      }
    }
  }

  const retainedLinks = new Map<string, string>();
  if (currentInstallation) {
    for (const piRoot of piRoots) {
      for (const destination of [
        ...legacyEntries
          .map(([, , destination]) => destination)
          .filter((destination) => destination !== 'settings.json' && destination !== 'extensions'),
        'extensions/mpx',
        'extensions/worktree',
      ]) {
        const link = path.join(piRoot, destination);
        retainedLinks.set(link, await readlink(link));
      }
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
    retainedLinks,
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

it.each([false, true])(
  'runs disposable production setup with current installation = %s',
  async (currentInstallation) => {
    const fixture = await createFixture(currentInstallation);
    const nodeReleases = new NodeCurrentReleaseBuilder({
      repositoryRoot: fixture.repositoryRoot,
      appsRoot: fixture.apps,
    });
    let upgradeSource: string | undefined;
    const releases = {
      appsRoot: fixture.apps,
      build: () => (upgradeSource ? buildReleaseManifest(upgradeSource) : nodeReleases.build()),
      publish: (releaseKey: string) =>
        upgradeSource
          ? publishRelease({ sourceDirectory: upgradeSource, appsRoot: fixture.apps })
          : nodeReleases.publish(releaseKey),
      verify: nodeReleases.verify.bind(nodeReleases),
    };
    const builder = new InstallIntentBuilder({
      releases,
      environment: fixture.environment,
    });
    let built: InstallIntentBuildResultV1 | undefined;
    const realBuild = builder.build.bind(builder);
    vi.spyOn(builder, 'build').mockImplementation(async (request) => {
      for (const piRoot of fixture.piRoots) {
        expect((await lstat(path.join(piRoot, 'settings.json'))).isSymbolicLink()).toBe(
          !currentInstallation && built === undefined,
        );
      }
      built = await realBuild(request);
      return built;
    });
    const runtimeRegistrations = {
      inspect: async (intent: InstallIntentBuildResultV1['intent']) => {
        for (const piRoot of fixture.piRoots) {
          for (const [, , destination] of legacyEntries) {
            expect((await lstat(path.join(piRoot, destination))).isSymbolicLink()).toBe(
              currentInstallation &&
                destination !== 'settings.json' &&
                destination !== 'extensions',
            );
          }
        }
        const registrations = intent.runtimeRegistrations!.registrations;
        return {
          observations: registrations.map(({ identity, executable, projection }) => ({
            identity,
            executable,
            projection,
          })),
          nativeRootProbes: registrations.map((registration) => ({
            identity: registration.identity,
            runtime: registration.runtime,
            domain: registration.domain,
            nativeRootDigest: registration.nativeRootDigest,
            status: 'available' as const,
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
    const adapter = new ProductionInstallerOperationAdapter(
      fixture.environment,
      'DISPOSABLE\\user',
      {
        files: new NodeBinaryFileSystem(),
        resources: fixture.resources,
        piNativeSettings: new NodePiNativeSettingsPort(),
        runtimeRegistrations,
      },
    );
    const store = new NodeTransactionStore(path.join(fixture.localAppData, 'mpx', 'installer'));
    const orchestrator = new InstallOrchestrator({
      adapter,
      store,
      releases,
      activate: (releaseKey, prior) => activateRelease(fixture.localAppData, prior, releaseKey),
    });
    const setup = createNodeSetupApplicationService({
      environment: fixture.environment,
      builder,
      orchestrator,
    });

    let priorPackageSource: string | undefined;
    const retainedProjectionTargets: string[] = [];
    const retainedProjectionBytes = new Map<string, Buffer>();
    const priorProjectionSources = new Map<string, Buffer>();
    const restore = vi.spyOn(adapter, 'restore');
    if (currentInstallation) {
      const canonicalManifest = await nodeReleases.build();
      await nodeReleases.publish(canonicalManifest.releaseKey);
      upgradeSource = path.join(fixture.root, 'prior-source');
      await cp(
        path.join(fixture.apps, 'mpx', 'releases', canonicalManifest.releaseKey),
        upgradeSource,
        { recursive: true },
      );
      await rm(path.join(upgradeSource, 'release-manifest.json'));
      const request = await new NodeSetupRequestFactory(fixture.environment).create();
      const oldClaudeInstruction = 'content/instructions/runtime/claude/CLAUDE.md';
      const oldPiProfile = 'content/runtime-profiles.json';
      const oldLicense = 'runtimes/pi/extensions/dist/package/subagents/LICENSE';
      const retiredPaths = [oldClaudeInstruction, oldPiProfile, oldLicense];
      await mkdir(path.dirname(path.join(upgradeSource, oldLicense)), { recursive: true });
      await cp(
        path.join(upgradeSource, 'runtimes/pi/extensions/subagents/LICENSE'),
        path.join(upgradeSource, oldLicense),
      );
      const priorBuilt = await builder.build({
        ...request,
        projections: {
          claude: [
            ...request.projections.claude.map((projection) => ({
              ...projection,
              path: projection.role === 'licenses' ? oldLicense : projection.path,
            })),
            { path: oldClaudeInstruction, role: 'canonical-content' as const },
          ].sort((left, right) => left.path.localeCompare(right.path)),
          pi: request.projections.pi
            .map((projection) => ({
              ...projection,
              path:
                projection.role === 'licenses'
                  ? oldLicense
                  : projection.role === 'profile'
                    ? oldPiProfile
                    : projection.path,
            }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        },
      });
      const priorPlan = await orchestrator.plan(priorBuilt.intent);
      const installed = await orchestrator.apply(priorPlan, priorPlan.confirmationDigest);
      const operations = installed.operations
        .map((operation) => {
          if (!operation.id.startsWith('61-projection-')) {
            return operation;
          }
          const registration = priorBuilt.intent.runtimeRegistrations!.registrations.find(
            (candidate) => operation.id.startsWith(`61-projection-${candidate.identity}-`),
          )!;
          const ordinal = registration.projection.files.findIndex((file) =>
            operation.target.endsWith(file.path.replaceAll('/', '\\')),
          );
          expect(ordinal).toBeGreaterThanOrEqual(0);
          if (
            retiredPaths.some((relative) =>
              operation.target.endsWith(relative.replaceAll('/', '\\')),
            )
          ) {
            retainedProjectionTargets.push(operation.target);
          }
          return {
            ...operation,
            id: `61-projection-${registration.identity}-${String(ordinal).padStart(4, '0')}`,
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const target of retainedProjectionTargets) {
        retainedProjectionBytes.set(target, await readFile(target));
      }
      await store.writeReceipt({
        ...installed,
        operations,
        operationLocators: operations.map((operation) => {
          const original = installed.operations.find(
            (candidate) => candidate.target === operation.target,
          )!;
          const spec = operation.id.startsWith('61-projection-')
            ? { kind: 'file' }
            : installed.operationLocators.find((locator) => locator.operationId === original.id)!
                .spec;
          return {
            operationId: operation.id,
            adapter: operation.adapter,
            spec,
            bindingDigest: installerDigest({ operation, spec }),
          };
        }),
      });
      const priorReleaseRoot = path.join(
        fixture.apps,
        'mpx',
        'releases',
        priorBuilt.intent.releaseKey,
      );
      priorPackageSource = resolvePiNativePackageSource(
        priorReleaseRoot,
        'runtimes/pi/extensions/dist/package',
      );
      for (const relative of retiredPaths) {
        const source = path.join(priorReleaseRoot, relative);
        priorProjectionSources.set(source, await readFile(source));
      }
      const obsoleteRegistry = path.join(
        fixture.localAppData,
        'mpx',
        'accounts',
        'v1',
        'registry.json',
      );
      await mkdir(path.dirname(obsoleteRegistry), { recursive: true });
      await writeFile(obsoleteRegistry, '{"schemaVersion":1,"records":[]}\n');
      fixture.before.set(obsoleteRegistry, await readFile(obsoleteRegistry));
      const installedFiles = [
        path.join(fixture.localAppData, 'mpx', 'installer', 'receipt.json'),
        path.join(fixture.localAppData, 'mpx', 'active-release'),
        path.join(fixture.piRoots[0]!, 'settings.json'),
        path.join(priorReleaseRoot, 'runtimes/pi/runtime-pi/src/profile.ts'),
      ];
      const installedBefore = new Map(
        await Promise.all(
          installedFiles.map(async (file) => [file, await readFile(file)] as const),
        ),
      );
      const apply = vi.spyOn(adapter, 'apply');
      for (const corrupted of installedFiles) {
        await writeFile(
          corrupted,
          corrupted.endsWith('settings.json') ? '{"packages":[]}' : 'corrupt',
        );
        try {
          await expect(setup.execute()).rejects.toBeDefined();
          expect(apply).not.toHaveBeenCalled();
          for (const [file, bytes] of [...fixture.before, ...installedBefore]) {
            if (file !== corrupted) {
              expect(await readFile(file), file).toEqual(bytes);
            }
          }
          for (const [link, target] of fixture.retainedLinks) {
            expect(await readlink(link)).toBe(target);
          }
        } finally {
          await writeFile(corrupted, installedBefore.get(corrupted)!);
        }
      }
      apply.mockRestore();
      upgradeSource = path.join(fixture.root, 'upgrade-source');
      await cp(priorReleaseRoot, upgradeSource, { recursive: true });
      await rm(path.join(upgradeSource, 'release-manifest.json'));
      await rm(path.join(upgradeSource, oldLicense));
      const profile = path.join(upgradeSource, 'runtimes/pi/runtime-pi/src/profile.ts');
      await writeFile(profile, `${await readFile(profile, 'utf8')}\n`);
      for (const piRoot of fixture.piRoots) {
        const settingsPath = path.join(piRoot, 'settings.json');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        await writeFile(
          settingsPath,
          JSON.stringify({
            ...settings,
            unrelatedField: 'changed-after-install',
            deliberate: { preserve: true },
          }),
        );
      }
      const pendingBuilt = await builder.build(
        await new NodeSetupRequestFactory(fixture.environment).create(),
      );
      const pendingManifest = await releases.publish(pendingBuilt.intent.releaseKey);
      const priorReceipt = required(await store.readReceipt(), 'prior ownership receipt');
      const pendingOperations = await adapter.operations(
        pendingBuilt.intent,
        pendingManifest,
        false,
        priorReceipt,
      );
      expect(
        priorReceipt.operations.filter((operation) => operation.id.startsWith('61-projection-')),
      ).toHaveLength(24);
      expect(
        pendingOperations.automatic.filter((operation) =>
          retainedProjectionTargets.includes(operation.target),
        ),
      ).toHaveLength(8);
      const shiftedClaudeSurvivors = pendingOperations.automatic.filter((operation) => {
        if (
          !operation.id.startsWith('61-projection-claude-') ||
          !operation.target.includes(pendingBuilt.intent.releaseKey)
        ) {
          return false;
        }
        const registration = pendingBuilt.intent.runtimeRegistrations!.registrations.find(
          (candidate) => operation.id.startsWith(`61-projection-${candidate.identity}-`),
        )!;
        const ordinal = registration.projection.files.findIndex((file) =>
          operation.target.endsWith(file.path.replaceAll('/', '\\')),
        );
        return (
          /-\d{4}$/u.test(operation.id) &&
          !operation.id.endsWith(`-${String(ordinal).padStart(4, '0')}`)
        );
      });
      expect(shiftedClaudeSurvivors).toHaveLength(10);
      const pendingOperation = required(
        pendingOperations.automatic.find((operation) => operation.id === '50-pi-settings-personal'),
        'pending Pi settings operation',
      );
      const snapshot = await adapter.capture(pendingOperation);
      const spec = await adapter.receiptLocator(pendingOperation);
      await adapter.apply(pendingOperation);
      const transactionId = 'disposable-interrupted-upgrade';
      await store.writeTransaction({
        journal: {
          schemaVersion: 1,
          kind: 'transaction-journal',
          transactionId,
          phase: 'applying',
          completedOperationIds: [pendingOperation.id],
          snapshot: {
            schemaVersion: 1,
            kind: 'machine-snapshot',
            transactionId,
            observations: [
              {
                id: pendingOperation.id,
                digest: required(
                  priorReceipt.operations.find((operation) => operation.id === pendingOperation.id),
                  'prior Pi settings operation',
                ).desiredDigest,
              },
            ],
            capturedAt: '2025-01-01T00:00:00.000Z',
          },
        },
        snapshots: { [pendingOperation.id]: snapshot },
        operations: [pendingOperation],
        operationLocators: [
          {
            operationId: pendingOperation.id,
            adapter: pendingOperation.adapter,
            spec,
            bindingDigest: installerDigest({ operation: pendingOperation, spec }),
          },
        ],
        priorReceipt,
      });
      const stateRoot = path.join(fixture.localAppData, 'mpx');
      const redirectedState = path.join(fixture.root, 'redirected-state');
      const pendingBefore = await store.readTransaction();
      expect(pendingBefore?.journal.phase).toBe('applying');
      const stateFiles = ['transaction.json', 'receipt.json'];
      const stateBefore = await Promise.all(
        stateFiles.map((file) => readFile(path.join(stateRoot, 'installer', file))),
      );
      const settingsBefore = await Promise.all(
        fixture.piRoots.map((root) => readFile(path.join(root, 'settings.json'))),
      );
      await rename(stateRoot, redirectedState);
      await makeLink(redirectedState, stateRoot, true);
      const createRequest = vi.spyOn(NodeSetupRequestFactory.prototype, 'create');
      const admit = vi.spyOn(orchestrator, 'admitCurrentInstallation');
      const exclusive = vi.spyOn(store, 'exclusive');
      const readTransaction = vi.spyOn(store, 'readTransaction');
      try {
        await expect(setup.execute()).rejects.toMatchObject({ code: 'SETUP_STATE_INVALID' });
        expect(createRequest).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
        expect(exclusive).not.toHaveBeenCalled();
        expect(readTransaction).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
        await expect(
          lstat(path.join(redirectedState, 'installer', 'transaction.lock')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        for (const [index, file] of stateFiles.entries()) {
          expect(await readFile(path.join(redirectedState, 'installer', file))).toEqual(
            stateBefore[index],
          );
        }
        for (const [index, root] of fixture.piRoots.entries()) {
          expect(await readFile(path.join(root, 'settings.json'))).toEqual(settingsBefore[index]);
        }
        for (const [file, bytes] of fixture.before) {
          expect(await readFile(file), file).toEqual(bytes);
        }
        for (const [link, target] of fixture.retainedLinks) {
          expect(await readlink(link)).toBe(target);
        }
      } finally {
        createRequest.mockRestore();
        admit.mockRestore();
        exclusive.mockRestore();
        readTransaction.mockRestore();
        await rm(stateRoot);
        await rename(redirectedState, stateRoot);
      }
    }
    const first = await setup.execute();
    expect(first.verification).toEqual({ healthy: true, issues: [] });
    expect(retainedProjectionTargets).toHaveLength(currentInstallation ? 8 : 0);
    for (const target of retainedProjectionTargets) {
      expect(await readFile(target)).toEqual(retainedProjectionBytes.get(target));
    }
    for (const [source, bytes] of priorProjectionSources) {
      expect(await readFile(source)).toEqual(bytes);
    }
    expect(
      (await store.readReceipt())!.operations.every((operation) => operation.action === 'ensure'),
    ).toBe(true);
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
    await expect(orchestrator.verify(true)).resolves.toMatchObject({
      healthy: true,
      issues: [],
    });
    for (const piRoot of fixture.piRoots) {
      expect(JSON.parse(await readFile(path.join(piRoot, 'settings.json'), 'utf8'))).toEqual({
        packages: ['unrelated-package', packageSource],
        unrelatedField: currentInstallation ? 'changed-after-install' : 'preserve-me',
        ...(currentInstallation ? { deliberate: { preserve: true } } : {}),
      });
      for (const [, , destination] of legacyEntries) {
        expect((await lstat(path.join(piRoot, destination))).isSymbolicLink()).toBe(
          currentInstallation && destination !== 'settings.json' && destination !== 'extensions',
        );
      }
      for (const skill of currentInstallation ? [] : ['mp-fallow-fix', 'mp-vocabulary']) {
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
      expect(settings).toEqual({
        packages: ['unrelated-package', packageSource],
        unrelatedField: currentInstallation ? 'changed-after-install' : 'preserve-me',
        ...(currentInstallation ? { deliberate: { preserve: true } } : {}),
      });
      expect(settings.packages.filter((entry) => entry === packageSource)).toHaveLength(1);
      if (priorPackageSource) {
        expect(packageSource).not.toBe(priorPackageSource);
        expect(settings.packages).not.toContain(priorPackageSource);
      }
    }
    for (const [link, target] of fixture.retainedLinks) {
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(target);
    }
    for (const [file, bytes] of fixture.before) {
      expect(await readFile(file), file).toEqual(bytes);
    }
    expect(restore).toHaveBeenCalledTimes(currentInstallation ? 1 : 0);
    expect(await store.readTransaction()).toBeUndefined();
    restore.mockRestore();
    if (currentInstallation) {
      await expect(
        readFile(path.join(fixture.localAppData, 'mpx', 'pi-legacy-detach.receipt.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
  300_000,
);
