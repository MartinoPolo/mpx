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
  schemaVersion: 2,
  identities: {
    zed: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/c', pi: 'C:/p' },
      gitAuthorRoute: 'git-z',
      providerRoutes: { zeta: 'z', alpha: 'a' },
      mcpSharing: { allow: ['z', 'a'], shareNativeAuth: false },
      allowedSkillPacks: ['development'],
    },
  },
  domains: { work: ['C:/work'] },
  locations: { work: { roots: ['C:/work'], skillPacks: ['development'] } },
  modes: {},
  presets: {},
  launchDefaults: { projects: {}, locations: {} },
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
      selection: {
        location: { name: 'work', canonicalRoot: 'C:/work' },
        packs: ['development'],
        source: 'user-location',
      },
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
  it('requires an absolute user configuration root for launch-bound operations', async () => {
    await expect(
      setup().requiredUserConfig({ appdata: 'relative', environment: {} }),
    ).rejects.toMatchObject({ code: 'USER_CONFIG_REQUIRED' });
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
          selection: {
            location: { name: 'work', canonicalRoot: 'C:/work' },
            packs: ['development'],
            source: 'project',
          },
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
      'status',
      'resolve',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.data.diagnostics.map(({ code }) => code)).toEqual([
      'CFG',
      'SKILL',
      'A_CODE',
      'Z_CODE',
      'FIXED_SHARED_LIMITATION',
      'PORT',
    ]);
  });

  it('rejects mutable sandbox diagnostics before later diagnostic side effects', async () => {
    await expect(
      setup({
        inventoryCanonical: async () => [],
        inventoryProjectSkills: async () => ({ skills: [], diagnostics: [] }),
        sbxDiagnostics: async () => ({ available: true, failureCodes: [], readOnly: false }),
      }).doctor({ cwd: 'C:/repo', environment: {}, catalogRoot: 'C:/catalog' }),
    ).rejects.toMatchObject({ code: 'SBX_DIAGNOSTICS_UNSAFE' });
  });
});
