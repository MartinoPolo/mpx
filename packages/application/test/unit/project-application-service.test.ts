import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import { createProjectApplicationService } from '../../src/index.js';

const project: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'synthetic/project' },
  repository: { provider: 'generic', remote: 'origin' },
};
const user: UserConfig = {
  identities: {
    zed: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/c', pi: 'C:/p' },
      gitAuthorRoute: 'git-z',
      providerRoutes: { zeta: 'z', alpha: 'a' },
      mcpSharing: { allow: ['z', 'a'], shareNativeAuth: false },
    },
  },
  domains: { work: ['C:/work'] },
  contentScopes: { work: { roots: ['C:/work'], skillPacks: ['core'] } },
  modes: {},
  skillPolicies: {},
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: {},
  executors: { host: {} },
};
const found = { path: 'C:/repo/mpxconfig.json', root: 'C:/repo', config: project };

function setup(overrides: Record<string, unknown> = {}) {
  return createProjectApplicationService({
    access: async () => undefined,
    discoverProjectConfig: async () => found,
    loadUserConfig: async () => user,
    resolveConfig: async () => ({
      project,
      cwdClassification: { status: 'known', domain: 'work', root: 'C:/work' },
      contentScope: { name: 'work', root: 'C:/work', skillPacks: ['core'], skillExposure: {} },
      provenance: [],
    }),
    path: {
      join: (...parts: string[]) => parts.join('/'),
      basename: (value: string) => value.split('/').at(-1)!,
      isAbsolute: (value: string) => /^[A-Z]:\//u.test(value),
    },
    ...overrides,
  });
}

describe('ProjectApplicationService', () => {
  it('constructs a sorted public identity inventory without runtime roots or native auth', () => {
    expect(setup().configurationItem({ kind: 'identity', action: 'list', user })).toEqual({
      data: {
        schemaVersion: 1,
        kind: 'identity',
        items: [
          {
            name: 'zed',
            domain: 'work',
            gitAuthorRoute: 'git-z',
            providerRoutes: { alpha: 'a', zeta: 'z' },
            sshRoute: null,
            mcpSharing: { allow: ['a', 'z'], shareNativeAuth: false },
          },
        ],
      },
    });
  });

  it('requires an absolute user configuration root for launch-bound operations', async () => {
    await expect(
      setup().requiredUserConfig({ appdata: 'relative', environment: {} }),
    ).rejects.toMatchObject({ code: 'USER_CONFIG_REQUIRED' });
  });

  it('does not require user configuration for project-only config actions', async () => {
    await expect(setup().config({ cwd: 'C:/repo', action: 'show' })).resolves.toEqual({
      data: { path: found.path, config: project },
    });
    await expect(setup().config({ cwd: 'C:/repo', action: 'validate' })).resolves.toEqual({
      data: { valid: true, path: found.path },
    });
  });

  it('compensates a confirmed init when dependent publication fails', async () => {
    const confirmation = {
      plan: { schemaVersion: 1 as const, cwd: 'C:/new', actions: [] },
      manifestPath: 'C:/new/mpxconfig.json',
      created: true,
    };
    const rollback = vi.fn(async () => undefined);
    const service = setup({
      discoverProjectConfig: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(found),
      confirmInit: async () => confirmation,
      rollbackConfirmedInit: rollback,
      ensureProject: async () => {
        throw new MpxError({ code: 'PORT_FAILED', message: 'failed' });
      },
    });
    await expect(service.init({ cwd: 'C:/new', confirm: true })).rejects.toMatchObject({
      code: 'PORT_FAILED',
    });
    expect(rollback).toHaveBeenCalledWith(confirmation);
  });

  it('aggregates domain diagnostics in stable source order and derives failure status', async () => {
    const service = setup({
      configDoctor: () => [{ code: 'CFG', message: 'config', severity: 'warning', pointer: '/x' }],
      skillDoctor: () => [{ code: 'SKILL', message: 'skill', path: 'skill.md' }],
    });
    await expect(
      service.doctor({
        cwd: 'C:/repo',
        user,
        canonical: [],
        projectInventory: { skills: [], diagnostics: [] },
        additionalDiagnostics: [{ code: 'EXTRA', message: 'extra', severity: 'error' }],
      }),
    ).resolves.toEqual({
      data: {
        diagnostics: [
          { code: 'CFG', message: 'config', severity: 'warning', details: { pointer: '/x' } },
          { code: 'SKILL', message: 'skill', severity: 'error', details: { path: 'skill.md' } },
          { code: 'EXTRA', message: 'extra', severity: 'error' },
        ],
        cwdClassification: { status: 'known', domain: 'work', root: 'C:/work' },
        resolvedContentScope: 'work',
      },
      exitCode: 1,
    });
  });
});
