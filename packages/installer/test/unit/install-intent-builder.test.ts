import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  INSTALL_EXECUTABLE_MAX_BYTES,
  InstallIntentBuilder,
  installerDigest,
  parseInstallIntentRequestV1,
  type CurrentReleaseBuilder,
  type InstallIntentRequestV1,
  type ReleaseManifestV1,
} from '../../src/index.js';

const sha = (letter: string): string => letter.repeat(64);
const baseRequest = (): InstallIntentRequestV1 => ({
  schemaVersion: 1,
  kind: 'install-intent-request',
  userConfigPath: 'C:\\config\\config.json',
  identities: { personal: 'home', work: 'office' },
  providers: { personal: 'github', work: 'gitlab' },
  executables: {
    claude: { path: 'C:\\bin\\claude.exe', version: '1.0.0' },
    pi: { path: 'C:\\bin\\pi.exe', version: '2.0.0' },
  },
  projections: {
    claude: [{ path: 'content/claude', role: 'plugin' }],
    pi: [{ path: 'content/pi', role: 'profile' }],
  },
});

describe('InstallIntentRequestV1', () => {
  it('rejects unknown, duplicate, and unsorted request data', () => {
    const unknown = { ...baseRequest(), surprise: true };
    expect(() => parseInstallIntentRequestV1(unknown)).toThrowError(/unknown|missing/i);

    const duplicate = {
      ...baseRequest(),
      projections: {
        ...baseRequest().projections,
        claude: [
          { path: 'content/claude', role: 'plugin' },
          { path: 'content/claude', role: 'hooks' },
        ],
      },
    };
    expect(() => parseInstallIntentRequestV1(duplicate)).toThrowError(/unique|sorted/i);
  });
});

async function createBuildFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-intent-builder-'));
  const configPath = path.join(root, 'config.json');
  const claude = path.join(root, 'claude.exe'),
    pi = path.join(root, 'pi.exe');
  await Promise.all([writeFile(claude, 'claude'), writeFile(pi, 'pi')]);
  const roles = {
    claude: ['plugin', 'hooks', 'status', 'settings', 'canonical-content', 'agents', 'licenses'],
    pi: ['profile', 'canonical-content', 'agents', 'licenses'],
  } as const;
  const files = [
    ...roles.claude.map((role, index) => ({
      path: `claude/${index}`,
      bytes: 1,
      sha256: sha(String((index % 9) + 1)),
    })),
    ...roles.pi.map((role, index) => ({
      path: `pi/${index}`,
      bytes: 1,
      sha256: sha(String(((index + 2) % 9) + 1)),
    })),
    ...['build-metadata.json', 'index.mjs', 'package.json'].map((name, index) => ({
      path: `runtimes/pi/extensions/dist/package/${name}`,
      bytes: index + 1,
      sha256: sha(String(index + 1)),
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const releaseKey = installerDigest(files);
  const manifest: ReleaseManifestV1 = {
    schemaVersion: 1,
    kind: 'release-manifest',
    releaseKey,
    convergenceHash: releaseKey,
    files,
  };
  const releases: CurrentReleaseBuilder = {
    appsRoot: path.join(root, 'apps'),
    build: vi.fn(async () => manifest),
    publish: vi.fn(async () => {
      throw new Error('publish forbidden');
    }),
    verify: vi.fn(async () => []),
  };
  const config = {
    identities: {
      home: {
        domain: 'personal',
        runtimeRoots: {
          claude: path.join(root, 'native', 'cp'),
          pi: path.join(root, 'native', 'pp'),
        },
        gitAuthorRoute: 'git-home',
        providerRoutes: { github: 'gh-home' },
        sshRoute: 'ssh-home',
      },
      office: {
        domain: 'work',
        runtimeRoots: {
          claude: path.join(root, 'native', 'cw'),
          pi: path.join(root, 'native', 'pw'),
        },
        gitAuthorRoute: 'git-work',
        providerRoutes: { gitlab: 'gl-work' },
        sshRoute: 'ssh-work',
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
  await writeFile(configPath, configSource);
  const request: InstallIntentRequestV1 = {
    ...baseRequest(),
    userConfigPath: configPath,
    executables: { claude: { path: claude, version: '1.0.0' }, pi: { path: pi, version: '2.0.0' } },
    projections: {
      claude: roles.claude.map((role, index) => ({ path: `claude/${index}`, role })),
      pi: roles.pi.map((role, index) => ({ path: `pi/${index}`, role })),
    },
  };
  const builder = new InstallIntentBuilder({
    releases,
    environment: { MPX_PROJECTS: path.join(root, 'projects'), MPX_WORK: path.join(root, 'work') },
  });
  return { builder, configSource, releases, request };
}

it('builds a deterministic four-registration intent without publishing or external mutation', async () => {
  const { builder, configSource, releases, request } = await createBuildFixture();
  const first = await builder.build(request),
    second = await builder.build(request);
  expect(first).toEqual(second);
  expect(first.intent.runtimeRegistrations?.registrations.map((item) => item.identity)).toEqual([
    'claude-personal',
    'claude-work',
    'pi-personal',
    'pi-work',
  ]);
  const registrations = first.intent.runtimeRegistrations?.registrations ?? [];
  const piPackages = registrations
    .filter((item) => item.runtime === 'pi')
    .map((item) => item.nativePackage);
  expect(piPackages).toHaveLength(2);
  expect(piPackages[0]).toEqual(piPackages[1]);
  expect(
    registrations
      .filter((item) => item.runtime === 'claude')
      .every((item) => !('nativePackage' in item)),
  ).toBe(true);
  expect(first.intent.runtimeRegistrations?.registrations.map((item) => item.routes)).toEqual([
    {
      git: 'personal:git-home',
      provider: 'personal:gh-home',
      ssh: 'personal:ssh-home',
      mcpSharing: 'isolated',
    },
    {
      git: 'work:git-work',
      provider: 'work:gl-work',
      ssh: 'work:ssh-work',
      mcpSharing: 'isolated',
    },
    {
      git: 'personal:git-home',
      provider: 'personal:gh-home',
      ssh: 'personal:ssh-home',
      mcpSharing: 'isolated',
    },
    {
      git: 'work:git-work',
      provider: 'work:gl-work',
      ssh: 'work:ssh-work',
      mcpSharing: 'isolated',
    },
  ]);
  expect(first.intent.userConfigArtifact?.content).toBe(configSource);
  expect(releases.publish).not.toHaveBeenCalled();
});

it('accepts a regular non-symlink executable at the current Claude Code size', async () => {
  const { builder, request } = await createBuildFixture();
  await truncate(request.executables.claude.path, 315 * 1024 * 1024);

  const result = await builder.build(request);

  expect(result.intent.runtimeRegistrations?.registrations[0]?.executable.path).toBe(
    request.executables.claude.path,
  );
});

it('rejects an executable above the bounded security limit', async () => {
  const { builder, request } = await createBuildFixture();
  await truncate(request.executables.claude.path, INSTALL_EXECUTABLE_MAX_BYTES + 1);

  await expect(builder.build(request)).rejects.toMatchObject({
    code: 'INSTALL_EXECUTABLE_INVALID',
  });
});
