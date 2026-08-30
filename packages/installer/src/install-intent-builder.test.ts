import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  INSTALL_EXECUTABLE_MAX_BYTES,
  InstallIntentBuilder,
  installerDigest,
  parseInstallIntentBuildResultV1,
  parseInstallIntentRequestV1,
  type CurrentReleaseBuilder,
  type InstallIntentBuildResultV1,
  type InstallIntentRequestV1,
  type ReleaseManifestV1,
} from './index.js';

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
    pi: [{ path: 'content/pi', role: 'extension' }],
  },
  external: { gitRemotes: [], obsidian: [], raycast: [] },
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

    const unsorted = {
      ...baseRequest(),
      external: {
        ...baseRequest().external,
        raycast: [
          { id: 'z', derivative: { encrypted: true as const, items: [] } },
          { id: 'a', derivative: { encrypted: true as const, items: [] } },
        ],
      },
    };
    expect(() => parseInstallIntentRequestV1(unsorted)).toThrowError(/unique|sorted/i);
  });
});

const completePlan = (
  adapter: 'git-remotes' | 'obsidian' | 'raycast',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (adapter === 'git-remotes') {
    const repository = path.resolve('fixture-repository'),
      commands: unknown[] = [],
      config = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    return {
      kind: 'git-remotes',
      classification: 'confirmation-required',
      repository,
      commands,
      preservedRemotes: [],
      expectedRemotes: [],
      confirmation: {
        required: true,
        scope: repository,
        digest: installerDigest({ repository, config, commands }),
      },
      rollback: {
        automatic: false,
        snapshot: {
          path: path.join(repository, '.git', 'config'),
          encoding: 'base64',
          bytes: '',
          sha256: config,
        },
        steps: ['restore'],
      },
      ...overrides,
    };
  }
  if (adapter === 'obsidian') {
    const subtree = path.resolve('fixture-vault', 'MPX'),
      snapshots: unknown[] = [],
      operations: unknown[] = [];
    return {
      kind: 'obsidian',
      classification: 'confirmation-required',
      subtree,
      reviewedFiles: [],
      expectedFiles: [],
      operations,
      confirmation: {
        required: true,
        scope: subtree,
        digest: installerDigest({ snapshots, operations }),
      },
      rollback: { automatic: false, snapshots, steps: ['restore'] },
      ...overrides,
    };
  }
  const items = (overrides.items ?? []) as unknown[];
  return {
    kind: 'raycast',
    classification: 'manual-only',
    automaticImport: false,
    encrypted: true,
    items,
    instructions: ['review'],
    confirmation: {
      required: true,
      scope: 'user-supplied-raycast-derivative',
      digest: installerDigest({ encrypted: true, items }),
    },
    rollback: { automatic: false, steps: ['restore'] },
    ...overrides,
  };
};

describe('InstallIntentBuildResultV1', () => {
  it('binds every strict external plan record to its intent entry', () => {
    const plan = completePlan('raycast');
    const planDigest = installerDigest(plan);
    const verifierRef = `raycast:settings:${planDigest}`;
    const intent = {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: sha('a'),
      convergenceHash: sha('a'),
      components: ['cli'],
      externalIntegrations: [
        {
          id: 'settings',
          adapter: 'raycast',
          classification: 'manual-only',
          planDigest,
          verifierRef,
        },
      ],
    } as const;
    const envelope = {
      schemaVersion: 1,
      kind: 'install-intent-build-result',
      intent,
      externalPlans: [
        {
          id: 'settings',
          adapter: 'raycast',
          classification: 'manual-only',
          planDigest,
          verifierRef,
          plan,
        },
      ],
    };
    expect(parseInstallIntentBuildResultV1(envelope)).toEqual(envelope);
    expect(() =>
      parseInstallIntentBuildResultV1({
        ...envelope,
        externalPlans: [{ ...envelope.externalPlans[0], id: 'other' }],
      }),
    ).toThrowError(/bound|match/i);
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
    pi: [
      'extension',
      'profile',
      'keybindings',
      'themes',
      'status',
      'settings',
      'canonical-content',
      'agents',
      'licenses',
    ],
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
  const never = { inspect: vi.fn(), plan: vi.fn() };
  const builder = new InstallIntentBuilder({
    releases,
    environment: { MPX_PROJECTS: path.join(root, 'projects'), MPX_WORK: path.join(root, 'work') },
    gitRemotes: never as never,
    obsidian: never as never,
    raycast: never as never,
  });
  return { builder, configSource, never, releases, request };
}

it('builds a deterministic four-registration intent without publishing or external mutation', async () => {
  const { builder, configSource, never, releases, request } = await createBuildFixture();
  const first = await builder.build(request),
    second = await builder.build(request);
  expect(first).toEqual(second);
  expect(first.intent.runtimeRegistrations?.registrations.map((item) => item.identity)).toEqual([
    'claude-personal',
    'claude-work',
    'pi-personal',
    'pi-work',
  ]);
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
  expect(never.inspect).not.toHaveBeenCalled();
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

function externalBuildResult(
  entries: readonly {
    id: string;
    adapter: 'git-remotes' | 'obsidian' | 'raycast';
    classification: 'confirmation-required' | 'manual-only';
    plan: Record<string, unknown>;
  }[],
): InstallIntentBuildResultV1 {
  const externalPlans = entries.map((entry) => {
    const plan = completePlan(entry.adapter, entry.plan),
      planDigest = installerDigest(plan);
    return {
      ...entry,
      plan,
      planDigest,
      verifierRef: `${entry.adapter}:${entry.id}:${planDigest}`,
    };
  });
  return parseInstallIntentBuildResultV1({
    schemaVersion: 1,
    kind: 'install-intent-build-result',
    intent: {
      schemaVersion: 1,
      kind: 'install-intent',
      releaseKey: sha('a'),
      convergenceHash: sha('a'),
      components: ['cli'],
      externalIntegrations: externalPlans.map(({ plan: _plan, ...entry }) => entry),
    },
    externalPlans,
  });
}

function verificationBuilder(adapters: {
  git?: ReturnType<typeof vi.fn>;
  obsidian?: ReturnType<typeof vi.fn>;
  raycast?: ReturnType<typeof vi.fn>;
}): InstallIntentBuilder {
  return new InstallIntentBuilder({
    releases: {} as CurrentReleaseBuilder,
    gitRemotes: { inspect: vi.fn(), plan: vi.fn(), verify: adapters.git ?? vi.fn() },
    obsidian: { inspect: vi.fn(), plan: vi.fn(), verify: adapters.obsidian ?? vi.fn() },
    raycast: { inspect: vi.fn(), plan: vi.fn(), verify: adapters.raycast ?? vi.fn() },
  });
}

it('verifies Git and Obsidian from the exact digest-bound plans', async () => {
  const git = vi.fn(async () => ({ healthy: true, issues: [] })),
    obsidian = vi.fn(async () => ({ healthy: true, issues: [] }));
  const built = externalBuildResult([
    {
      id: 'git',
      adapter: 'git-remotes',
      classification: 'confirmation-required',
      plan: { kind: 'git-remotes', classification: 'confirmation-required', expectedRemotes: [] },
    },
    {
      id: 'notes',
      adapter: 'obsidian',
      classification: 'confirmation-required',
      plan: { kind: 'obsidian', classification: 'confirmation-required', expectedFiles: [] },
    },
  ]);
  const result = await verificationBuilder({ git, obsidian }).verify(built);
  expect(git).toHaveBeenCalledExactlyOnceWith(built.externalPlans[0]!.plan);
  expect(obsidian).toHaveBeenCalledExactlyOnceWith(built.externalPlans[1]!.plan);
  expect(result.integrations.map((item) => item.healthy)).toEqual([true, true]);
});

it('records bounded unhealthy evidence for each verifier exception and continues verification', async () => {
  const git = vi.fn(async () => {
    throw Object.assign(new Error('secret timeout details'), { code: 'ETIMEDOUT' });
  });
  const obsidian = vi.fn(async () => {
    throw Object.assign(new Error('private path read failure'), { code: 'EACCES' });
  });
  const built = externalBuildResult([
    {
      id: 'git',
      adapter: 'git-remotes',
      classification: 'confirmation-required',
      plan: { kind: 'git-remotes', classification: 'confirmation-required' },
    },
    {
      id: 'notes',
      adapter: 'obsidian',
      classification: 'confirmation-required',
      plan: { kind: 'obsidian', classification: 'confirmation-required' },
    },
  ]);
  await expect(verificationBuilder({ git, obsidian }).verify(built)).resolves.toMatchObject({
    integrations: [
      { id: 'git', healthy: false, issues: ['external-verifier-failed'] },
      { id: 'notes', healthy: false, issues: ['external-verifier-failed'] },
    ],
  });
  expect(git).toHaveBeenCalledOnce();
  expect(obsidian).toHaveBeenCalledOnce();
});

it('rejects an incomplete forged plan before invoking a verifier', async () => {
  const git = vi.fn(),
    plan = { kind: 'git-remotes', classification: 'confirmation-required' },
    planDigest = installerDigest(plan),
    built = {
      schemaVersion: 1,
      kind: 'install-intent-build-result',
      intent: {
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey: sha('a'),
        convergenceHash: sha('a'),
        components: ['cli'],
        externalIntegrations: [
          {
            id: 'git',
            adapter: 'git-remotes',
            classification: 'confirmation-required',
            planDigest,
            verifierRef: `git-remotes:git:${planDigest}`,
          },
        ],
      },
      externalPlans: [
        {
          id: 'git',
          adapter: 'git-remotes',
          classification: 'confirmation-required',
          planDigest,
          verifierRef: `git-remotes:git:${planDigest}`,
          plan,
        },
      ],
    };
  await expect(verificationBuilder({ git }).verify(built)).rejects.toMatchObject({
    code: 'INSTALL_SCHEMA_INVALID',
  });
  expect(git).not.toHaveBeenCalled();
});

it('requires a strict Raycast post-export derivative', async () => {
  const raycast = vi.fn(),
    built = externalBuildResult([
      {
        id: 'ray',
        adapter: 'raycast',
        classification: 'manual-only',
        plan: { kind: 'raycast', classification: 'manual-only', items: [] },
      },
    ]);
  await expect(verificationBuilder({ raycast }).verify(built)).rejects.toMatchObject({
    code: 'RAYCAST_POST_EXPORT_REQUIRED',
  });
  expect(raycast).not.toHaveBeenCalled();
});

it('rejects Raycast evidence for unknown and non-Raycast integration IDs', async () => {
  const built = externalBuildResult([
    {
      id: 'git',
      adapter: 'git-remotes',
      classification: 'confirmation-required',
      plan: { kind: 'git-remotes', classification: 'confirmation-required' },
    },
  ]);
  const evidence = {
    schemaVersion: 1,
    kind: 'raycast-post-export-evidence',
    integrations: [{ id: 'git', derivative: { encrypted: true, items: [] } }],
  };
  await expect(verificationBuilder({}).verify(built, evidence)).rejects.toMatchObject({
    code: 'INSTALL_SCHEMA_INVALID',
  });
});

it('reports Raycast post-export drift through a bound verification result', async () => {
  const raycast = vi.fn(async () => ({ healthy: false, issues: ['raycast-id-category-drift'] }));
  const built = externalBuildResult([
    {
      id: 'ray',
      adapter: 'raycast',
      classification: 'manual-only',
      plan: {
        kind: 'raycast',
        classification: 'manual-only',
        items: [{ id: 'a', category: 'dev', command: 'x' }],
      },
    },
  ]);
  const evidence = {
    schemaVersion: 1,
    kind: 'raycast-post-export-evidence',
    integrations: [
      {
        id: 'ray',
        derivative: {
          encrypted: true,
          items: [{ id: 'a', category: 'changed', command: 'redacted' }],
        },
      },
    ],
  };
  await expect(verificationBuilder({ raycast }).verify(built, evidence)).resolves.toMatchObject({
    integrations: [
      { id: 'ray', adapter: 'raycast', healthy: false, issues: ['raycast-id-category-drift'] },
    ],
  });
});

it('accepts a healthy encrypted Raycast post-export derivative', async () => {
  const raycast = vi.fn(async () => ({ healthy: true, issues: [] }));
  const built = externalBuildResult([
    {
      id: 'ray',
      adapter: 'raycast',
      classification: 'manual-only',
      plan: { kind: 'raycast', classification: 'manual-only', items: [] },
    },
  ]);
  const derivative = { encrypted: true as const, items: [] };
  const result = await verificationBuilder({ raycast }).verify(built, {
    schemaVersion: 1,
    kind: 'raycast-post-export-evidence',
    integrations: [{ id: 'ray', derivative }],
  });
  expect(raycast).toHaveBeenCalledExactlyOnceWith(built.externalPlans[0]!.plan, derivative);
  expect(result.integrations[0]).toMatchObject({ healthy: true, issues: [] });
});

it('rejects malformed or unencrypted Raycast post-export evidence', async () => {
  const built = externalBuildResult([
    {
      id: 'ray',
      adapter: 'raycast',
      classification: 'manual-only',
      plan: { kind: 'raycast', classification: 'manual-only', items: [] },
    },
  ]);
  const evidence = {
    schemaVersion: 1,
    kind: 'raycast-post-export-evidence',
    integrations: [
      { id: 'ray', derivative: { encrypted: false, items: [], privateSettings: true } },
    ],
  };
  await expect(verificationBuilder({}).verify(built, evidence)).rejects.toMatchObject({
    code: 'INSTALL_SCHEMA_INVALID',
  });
});
