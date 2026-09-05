import { lstat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { FakeBinaryFileSystem, FakeJsonResourceStore } from '@mpx/windows';
import {
  parseInstallIntentV1,
  installerDigest,
  type ReleaseManifestV1,
} from '../../src/immutable-core.js';
import {
  createRuntimeRegistrationMatrix,
  registerStaticMcp,
  type ProjectionFileV1,
} from '../../src/runtime-registration.js';
import { ProductionInstallerOperationAdapter } from '../../src/production-operation.js';
import { parsePiNativePackageRegistration } from '../../src/pi-native-package.js';

const sha = (value: string) => installerDigest(value);
function files(runtime: 'claude' | 'pi'): ProjectionFileV1[] {
  const roles =
    runtime === 'claude'
      ? ([
          'plugin',
          'hooks',
          'status',
          'settings',
          'canonical-content',
          'agents',
          'licenses',
        ] as const)
      : ([
          'extension',
          'profile',
          'keybindings',
          'themes',
          'status',
          'settings',
          'canonical-content',
          'agents',
          'licenses',
        ] as const);
  return roles.map((role, index) => ({
    path: `${runtime}/${index}-${role}.json`,
    sha256: sha(`${runtime}-${role}`),
    bytes: index + 1,
    role,
    owner: 'convergence',
  }));
}
const nativeInventory = [
  { path: 'build-metadata.json', sha256: sha('metadata'), bytes: 1 },
  { path: 'index.mjs', sha256: sha('index'), bytes: 1 },
  { path: 'package.json', sha256: sha('package'), bytes: 1 },
];
const nativePackage = parsePiNativePackageRegistration({
  name: '@mpx/pi-extensions',
  packageRoot: 'runtimes/pi/extensions/dist/package',
  artifactRootDigest: installerDigest(nativeInventory),
  files: nativeInventory,
});
function input(runtime: 'claude' | 'pi', domain: 'personal' | 'work', root: string) {
  const projectionFiles = files(runtime);
  const common = {
    domain,
    nativeRoot: root,
    executable: { path: `C:\\tools\\${runtime}.exe`, sha256: sha(`${runtime}-exe`), version: '1' },
    projection: {
      rootDigest: installerDigest(projectionFiles),
      files: projectionFiles,
      reader: 'canonical' as const,
      activation: 'argv-only' as const,
    },
    routes: {
      git: `${domain}:git`,
      provider: `${domain}:provider`,
      ssh: `${domain}:ssh`,
      mcpSharing: domain === 'personal' ? ('shared' as const) : ('isolated' as const),
    },
  };
  return runtime === 'pi'
    ? { ...common, runtime: 'pi' as const, nativePackage }
    : { ...common, runtime: 'claude' as const };
}

it('composes four runtime registrations and external references into automatic, confirmed, and manual installer state', async () => {
  const runtimeRegistrations = createRuntimeRegistrationMatrix([
    input('claude', 'personal', 'C:\\native\\claude-personal'),
    input('claude', 'work', 'C:\\native\\claude-work'),
    input('pi', 'personal', 'C:\\native\\pi-personal'),
    input('pi', 'work', 'C:\\native\\pi-work'),
  ]);
  const staticMcpRegistrations = [
    registerStaticMcp({
      label: 'personal:github',
      executable: { path: 'C:\\tools\\mcp.exe', sha256: sha('mcp'), version: '1' },
      argv: ['--stdio'],
    }),
  ];
  const files = new FakeBinaryFileSystem();
  const resources = new FakeJsonResourceStore();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
      MPX_NODE_EXECUTABLE: 'C:\\Node\\node.exe',
    },
    'me',
    {
      files,
      resources,
      runtimeRegistrations: {
        inspect: async () => ({
          observations: [],
          accountProbes: runtimeRegistrations.registrations.map((registration) => ({
            identity: registration.identity,
            runtime: registration.runtime,
            domain: registration.domain,
            nativeRootDigest: registration.nativeRootDigest,
            status: 'unavailable' as const,
            accountLabel: `${registration.domain}:account`,
          })),
          mcpSharing: Object.fromEntries(
            runtimeRegistrations.registrations.map((registration) => [
              registration.identity,
              registration.routes.mcpSharing,
            ]),
          ) as never,
        }),
      },
    },
  );
  const node = await lstat(process.execPath);
  expect(node.isFile()).toBe(true);
  // Production planning uses the configured immutable Node boundary, never a shell.
  (adapter as unknown as { environment: NodeJS.ProcessEnv }).environment.MPX_NODE_EXECUTABLE =
    process.execPath;
  const projectionEvidence = [
    ...new Map(
      runtimeRegistrations.registrations
        .flatMap((registration) => registration.projection.files)
        .map((file) => [file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256 }]),
    ).values(),
  ];
  const nativeEvidence = nativePackage.files.map((file) => ({
    ...file,
    path: `${nativePackage.packageRoot}/${file.path}`,
  }));
  const manifestFiles = [
    { path: 'bin/mpx.mjs', bytes: 3, sha256: sha('cli') },
    ...projectionEvidence,
    ...nativeEvidence,
  ].sort((a, b) => a.path.localeCompare(b.path));
  const releaseKey = installerDigest(manifestFiles);
  const manifest = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: manifestFiles,
  } as ReleaseManifestV1;
  const intent = parseInstallIntentV1({
    schemaVersion: 1,
    kind: 'install-intent',
    releaseKey,
    convergenceHash: releaseKey,
    components: ['cli', 'runtime-registration'],
    runtimeRegistrations,
    staticMcpRegistrations,
    externalIntegrations: [
      {
        id: 'git',
        adapter: 'git-remotes',
        classification: 'confirmation-required',
        planDigest: sha('git-plan'),
        verifierRef: 'git:repo',
      },
    ],
  });
  const changedManifest = (files: ReleaseManifestV1['files']): ReleaseManifestV1 => {
    const convergenceHash = installerDigest(files);
    return { ...manifest, releaseKey: convergenceHash, convergenceHash, files };
  };
  await expect(
    adapter.operations(
      intent,
      changedManifest(
        manifest.files.map((file) =>
          file.path.startsWith('claude/') || file.path.startsWith('pi/')
            ? { ...file, sha256: sha('mismatch') }
            : file,
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'INSTALL_PROJECTION_MISMATCH' });
  await expect(
    adapter.operations(
      intent,
      changedManifest(
        manifest.files.map((file) =>
          file.path.endsWith('/index.mjs') ? { ...file, sha256: sha('alternate-native') } : file,
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'REGISTRATION_NATIVE_PACKAGE_RELEASE_MISMATCH' });
  const operations = await adapter.operations(intent, manifest);
  const environmentOperation = operations.automatic.find(
    (operation) => operation.id === '20-user-environment',
  );
  if (!environmentOperation) {
    throw new Error('Expected user environment operation');
  }
  await adapter.apply(environmentOperation);
  await expect(resources.read('HKCU\\Environment')).resolves.toMatchObject({
    MPX_CLAUDE_EXECUTABLE: 'C:\\tools\\claude.exe',
    MPX_PI_EXECUTABLE: 'C:\\tools\\pi.exe',
  });
  expect(
    operations.automatic
      .map((operation) => operation.id)
      .filter((id) => id.includes('registration')),
  ).toEqual([
    '70-registration-claude-personal',
    '71-registration-claude-work',
    '72-registration-pi-personal',
    '73-registration-pi-work',
    '74-registration-mcp-personal-github',
  ]);
  expect(operations.classifications).toEqual({
    automatic: operations.automatic.map((operation) => operation.id),
    confirmationRequired: [{ id: 'git', planDigest: sha('git-plan'), verifierRef: 'git:repo' }],
    manualOnly: [],
  });
  expect(operations.automatic.some((operation) => ['git'].includes(operation.id))).toBe(false);
});
