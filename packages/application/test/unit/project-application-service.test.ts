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

  it('reports both failures when init publication and rollback reject with domain errors', async () => {
    const confirmation = {
      plan: { schemaVersion: 1 as const, cwd: 'C:/new', actions: [] },
      manifestPath: 'C:/new/mpxconfig.json',
      created: true,
    };
    const service = setup({
      discoverProjectConfig: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(found),
      confirmInit: async () => confirmation,
      rollbackConfirmedInit: async () => {
        throw new MpxError({ code: 'ROLLBACK_DENIED', message: 'rollback failed' });
      },
      ensureProject: async () => {
        throw new MpxError({ code: 'PORT_FAILED', message: 'publication failed' });
      },
    });

    await expect(service.init({ cwd: 'C:/new', confirm: true })).rejects.toMatchObject({
      code: 'INIT_ROLLBACK_FAILED',
      details: { originalCode: 'PORT_FAILED', rollbackCode: 'ROLLBACK_DENIED' },
    });
  });

  it('resolves a selected local store and view before invoking the structural rebuilder', async () => {
    const rebuild = vi.fn(async () => ({ rebuilt: 3 }));
    const localProject: ProjectConfig = {
      ...project,
      issues: { provider: 'local', store: 'work-items', view: 'vault' },
    };
    const localUser = {
      ...user,
      localIssueStores: { 'work-items': { root: 'C:/issues' } },
      localViews: {
        vault: {
          vaultRoot: 'C:/vault',
          outputRoot: 'Projects',
          vaultSubtree: 'MPX/Issues',
          resumeBaseUrl: 'mpx://resume',
        },
      },
    } satisfies UserConfig;
    const service = setup({
      discoverProjectConfig: async () => ({ ...found, config: localProject }),
      loadUserConfig: async () => localUser,
      localIssueViewRebuilder: { rebuild },
    });

    await expect(
      service.rebuildLocalIssueView({
        cwd: 'C:/repo',
        appdata: 'C:/Users/test/AppData',
        environment: {},
      }),
    ).resolves.toEqual({ data: { rebuilt: 3 } });
    expect(rebuild).toHaveBeenCalledWith({
      storeRoot: 'C:/issues',
      projectId: 'synthetic/project',
      view: {
        vaultRoot: 'C:/vault',
        outputRoot: 'Projects',
        resumeBaseUrl: 'mpx://resume',
      },
    });
  });

  it('rejects an unselected local view before loading required user configuration', async () => {
    const load = vi.fn(async () => user);
    await expect(
      setup({
        loadUserConfig: load,
        localIssueViewRebuilder: { rebuild: vi.fn() },
      }).rebuildLocalIssueView({
        cwd: 'C:/repo',
        appdata: 'C:/Users/test/AppData',
        environment: {},
      }),
    ).rejects.toMatchObject({
      code: 'LOCAL_VIEW_UNAVAILABLE',
      message: 'The project must select logical local store and view registrations.',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('owns doctor diagnostic sequencing and only snapshots managed services', async () => {
    const order: string[] = [];
    const managedProject: ProjectConfig = {
      ...project,
      development: {
        services: {
          zed: {
            scope: 'checkout',
            port: { mode: 'fixed-shared', preferred: 4200 },
            start: { type: 'package-script', script: 'zed' },
          },
          app: {
            scope: 'checkout',
            port: { mode: 'managed', preferred: 4173 },
            start: { type: 'package-script', script: 'dev' },
          },
        },
      },
    };
    const service = setup({
      discoverProjectConfig: async () => {
        order.push('discover');
        return { ...found, config: managedProject };
      },
      loadUserConfig: async () => {
        order.push('config');
        return user;
      },
      inventoryCanonical: async () => {
        order.push('canonical');
        return [];
      },
      inventoryProjectSkills: async () => {
        order.push('project');
        return { skills: [], diagnostics: [] };
      },
      sbxDiagnostics: async () => {
        order.push('sbx');
        return { available: false, failureCodes: ['Z_CODE', 'A_CODE', 'A_CODE'], readOnly: true };
      },
      sbxProofDiagnostics: async () => {
        order.push('proof');
        return ['PROOF'];
      },
      branchDiagnostics: async () => {
        order.push('branch');
        return {
          runtime: { available: true },
          terminal: { available: false, code: 'WINDOWS_TERMINAL_UNAVAILABLE' },
          terminalConfigured: true,
        };
      },
      statusSnapshot: async (request: { configHash: string }) => {
        order.push('status');
        expect(request.configHash).toBeTruthy();
        return { diagnostics: [{ code: 'PORT', message: 'missing', severity: 'error' }] };
      },
      resolveConfig: async () => {
        order.push('resolve');
        return {
          project: managedProject,
          cwdClassification: { status: 'known', domain: 'work', root: 'C:/work' },
          contentScope: { name: 'work', root: 'C:/work', skillPacks: [], skillExposure: {} },
          provenance: [],
        };
      },
      configDoctor: () => [{ code: 'CFG', message: 'config', severity: 'warning', pointer: '/x' }],
      skillDoctor: () => [{ code: 'SKILL', message: 'skill', path: 'skill.md' }],
    });
    const result = await service.doctor({
      cwd: 'C:/repo',
      appdata: 'C:/Users/test/AppData',
      environment: {},
      catalogRoot: 'C:/catalog',
    });
    expect(order).toEqual([
      'discover',
      'config',
      'canonical',
      'project',
      'sbx',
      'proof',
      'branch',
      'status',
      'resolve',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.data.diagnostics.map(({ code }) => code)).toEqual([
      'CFG',
      'SKILL',
      'A_CODE',
      'Z_CODE',
      'PROOF',
      'WINDOWS_TERMINAL_UNAVAILABLE',
      'FIXED_SHARED_LIMITATION',
      'PORT',
    ]);
  });

  it('rejects mutable sandbox diagnostics before later diagnostic side effects', async () => {
    const branchDiagnostics = vi.fn();
    await expect(
      setup({
        inventoryCanonical: async () => [],
        inventoryProjectSkills: async () => ({ skills: [], diagnostics: [] }),
        sbxDiagnostics: async () => ({ available: true, failureCodes: [], readOnly: false }),
        branchDiagnostics,
      }).doctor({ cwd: 'C:/repo', environment: {}, catalogRoot: 'C:/catalog' }),
    ).rejects.toMatchObject({ code: 'SBX_DIAGNOSTICS_UNSAFE' });
    expect(branchDiagnostics).not.toHaveBeenCalled();
  });
});
