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
function input(runtime: 'claude' | 'pi', domain: 'personal' | 'work', root: string) {
  const projectionFiles = files(runtime);
  return {
    runtime,
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
}

it('composes four runtime registrations and external references into automatic, confirmed, and manual installer state', async () => {
  const releaseKey = 'a'.repeat(64);
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
      {
        id: 'obsidian',
        adapter: 'obsidian',
        classification: 'confirmation-required',
        planDigest: sha('obsidian-plan'),
        verifierRef: 'obsidian:MPX',
      },
      {
        id: 'raycast',
        adapter: 'raycast',
        classification: 'manual-only',
        planDigest: sha('raycast-plan'),
        verifierRef: 'raycast:post-export',
      },
    ],
  });
  const files = new FakeBinaryFileSystem();
  const adapter = new ProductionInstallerOperationAdapter(
    {
      MPX_APPS: 'C:\\Apps',
      APPDATA: 'C:\\Roaming',
      LOCALAPPDATA: 'C:\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    'me',
    {
      files,
      resources: new FakeJsonResourceStore(),
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
  const manifest = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files: [{ path: 'bin/mpx.mjs', bytes: 3, sha256: sha('cli') }, ...projectionEvidence].sort(
      (a, b) => a.path.localeCompare(b.path),
    ),
  } as ReleaseManifestV1;
  await expect(
    adapter.operations(intent, {
      ...manifest,
      files: manifest.files.map((file, index) =>
        index === 0 ? file : { ...file, sha256: sha('mismatch') },
      ),
    }),
  ).rejects.toMatchObject({ code: 'INSTALL_PROJECTION_MISMATCH' });
  const operations = await adapter.operations(intent, manifest);
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
    confirmationRequired: [
      { id: 'git', planDigest: sha('git-plan'), verifierRef: 'git:repo' },
      { id: 'obsidian', planDigest: sha('obsidian-plan'), verifierRef: 'obsidian:MPX' },
    ],
    manualOnly: [
      { id: 'raycast', planDigest: sha('raycast-plan'), verifierRef: 'raycast:post-export' },
    ],
  });
  expect(
    operations.automatic.some((operation) => ['git', 'obsidian', 'raycast'].includes(operation.id)),
  ).toBe(false);
});
