import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@mpx/config';
import { createStatusProvider } from '../../src/index.js';

const config: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'acme/web' },
  repository: { provider: 'generic', remote: 'origin' },
  development: {
    services: {
      web: {
        scope: 'checkout',
        protocol: 'https',
        port: { mode: 'managed', preferred: 4100 },
        start: { type: 'package-script', script: 'dev' },
      },
    },
  },
};

const lease = {
  schemaVersion: 1 as const,
  leaseId: 'lease-1',
  projectId: 'acme/web',
  worktreeId: 'wt-1',
  configHash: 'hash-1',
  services: { web: 4102 },
};
const record = {
  leaseId: 'lease-1',
  projectId: 'acme/web',
  repositoryId: 'repo-1',
  worktreeId: 'wt-1',
  worktreePath: 'C:/repo.worktrees/feature',
  role: 'linked' as const,
  branch: 'refs/heads/feature',
  slot: 1,
  configHash: 'hash-1',
  services: { web: 4102 },
  claims: [{ port: 4102, exclusive: true }],
  updatedAt: 1,
};

describe('status provider', () => {
  it('builds a JSON-safe valid snapshot by joining the resolved lease, registry record, config, and listeners', async () => {
    const provider = createStatusProvider({
      portService: {
        resolve: async () => lease,
        list: async () => [record],
        inspect: async () => [
          { port: 4102, pid: 77, projectPath: 'C:/repo.worktrees/feature/apps/web' },
        ],
      },
    });

    const snapshot = await provider.snapshot({
      cwd: 'C:/repo.worktrees/feature/src',
      config,
      configHash: 'hash-1',
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      project: { id: 'acme/web', cwd: 'C:/repo.worktrees/feature/src' },
      worktree: {
        id: 'wt-1',
        path: 'C:/repo.worktrees/feature',
        role: 'linked',
        branch: 'feature',
      },
      portResolution: 'valid',
      services: [
        {
          id: 'web',
          mode: 'managed',
          scope: 'checkout',
          protocol: 'https',
          port: 4102,
          listening: true,
          conflict: 'none',
          pid: 77,
        },
      ],
      diagnostics: [],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('classifies a listener with a project path outside the authoritative worktree as external', async () => {
    const snapshot = await createStatusProvider({
      portService: {
        resolve: async () => lease,
        list: async () => [record],
        inspect: async () => [
          { port: 4102, pid: 77, projectPath: 'C:/repo.worktrees/feature-evil' },
        ],
      },
    }).snapshot({ cwd: 'C:/repo.worktrees/feature', config, configHash: 'hash-1' });

    expect(snapshot.services[0]).toMatchObject({ listening: true, conflict: 'external', pid: 77 });
    expect(snapshot.diagnostics).toEqual([
      {
        code: 'PORT_EXTERNAL_CONFLICT',
        severity: 'warning',
        message: 'Port 4102 for service web is occupied by an external listener.',
        serviceId: 'web',
      },
    ]);
  });

  it('keeps a managed listener unknown when native inspection cannot prove its project path', async () => {
    const snapshot = await createStatusProvider({
      portService: {
        resolve: async () => lease,
        list: async () => [record],
        inspect: async () => [{ port: 4102, pid: 77 }],
      },
    }).snapshot({ cwd: 'C:/repo.worktrees/feature', config, configHash: 'hash-1' });

    expect(snapshot.services[0]).toMatchObject({ listening: true, conflict: 'unknown', pid: 77 });
    expect(snapshot.diagnostics).toEqual([
      {
        code: 'PORT_LISTENER_OWNER_UNKNOWN',
        severity: 'warning',
        message: 'Port 4102 for service web has a listener whose ownership cannot be verified.',
        serviceId: 'web',
      },
    ]);
  });

  it('keeps ownership-free listeners unknown without a PID and for fixed-shared services', async () => {
    const fixedConfig: ProjectConfig = {
      ...config,
      development: {
        services: {
          web: {
            ...config.development!.services.web!,
            port: { mode: 'fixed-shared', preferred: 4102 },
          },
        },
      },
    };
    const snapshotFor = (listener: { port: number; pid?: number }) =>
      createStatusProvider({
        portService: {
          resolve: async () => lease,
          list: async () => [record],
          inspect: async () => [listener],
        },
      });

    const withoutPid = await snapshotFor({ port: 4102 }).snapshot({
      cwd: 'C:/repo.worktrees/feature',
      config,
      configHash: 'hash-1',
    });
    const fixedShared = await snapshotFor({ port: 4102, pid: 77 }).snapshot({
      cwd: 'C:/repo.worktrees/feature',
      config: fixedConfig,
      configHash: 'hash-1',
    });
    expect(withoutPid.services[0]).toMatchObject({ conflict: 'unknown', pid: null });
    expect(fixedShared.services[0]).toMatchObject({
      mode: 'fixed-shared',
      conflict: 'unknown',
      pid: 77,
    });
  });

  it('produces the same snapshot when equivalent listener inspection results are shuffled', async () => {
    const internal = { port: 4102, pid: 77, projectPath: 'C:/repo.worktrees/feature/apps/web' };
    const external = { port: 4102, pid: 77, projectPath: 'C:/other/apps/web' };
    const snapshotFor = (listeners: (typeof internal)[]) =>
      createStatusProvider({
        portService: {
          resolve: async () => lease,
          list: async () => [record],
          inspect: async () => listeners,
        },
      }).snapshot({ cwd: 'C:/repo.worktrees/feature', config, configHash: 'hash-1' });

    expect(await snapshotFor([internal, external])).toEqual(
      await snapshotFor([external, internal]),
    );
  });

  it('reports a duplicate fixed-shared claim and sorts shuffled services deterministically', async () => {
    const shuffled: ProjectConfig = {
      ...config,
      development: {
        services: {
          zeta: {
            scope: 'project',
            port: { mode: 'fixed-shared', preferred: 9000 },
            start: { type: 'package-script', script: 'z' },
          },
          alpha: {
            scope: 'checkout',
            protocol: 'http',
            port: { mode: 'managed', preferred: 4100 },
            start: { type: 'package-script', script: 'a' },
          },
        },
      },
    };
    const current = {
      ...record,
      services: { zeta: 9000, alpha: 4102 },
      claims: [
        { port: 9000, exclusive: false },
        { port: 4102, exclusive: true },
      ],
    };
    const other = {
      ...record,
      leaseId: 'other',
      projectId: 'other/project',
      repositoryId: 'repo-2',
      worktreeId: 'other',
      worktreePath: 'C:/other',
      services: { db: 9000 },
      claims: [{ port: 9000, exclusive: false }],
    };
    const snapshot = await createStatusProvider({
      portService: {
        resolve: async () => ({ ...lease, services: { zeta: 9000, alpha: 4102 } }),
        list: async () => [other, current],
        inspect: async () => [],
      },
    }).snapshot({ cwd: 'C:/repo.worktrees/feature', config: shuffled, configHash: 'hash-1' });

    expect(snapshot.services.map(({ id }) => id)).toEqual(['alpha', 'zeta']);
    expect(snapshot.services[1]).toMatchObject({
      mode: 'fixed-shared',
      port: 9000,
      listening: false,
      conflict: 'none',
    });
    expect(snapshot.diagnostics).toContainEqual({
      code: 'FIXED_SHARED_DUPLICATE',
      severity: 'warning',
      message: 'Fixed-shared port 9000 for service zeta has another registry claim.',
      serviceId: 'zeta',
    });
  });

  it.each([
    ['PORT_LEASE_INVALID', { cause: 'Error: ENOENT: no such file' }, 'missing'],
    ['PORT_LEASE_INVALID', { cause: 'unsafe symbolic link' }, 'invalid'],
    ['PORT_LEASE_MISMATCH', {}, 'stale'],
  ] as const)(
    'maps structured %s port errors to %s resolution',
    async (code, details, expected) => {
      const error = Object.assign(new Error(`resolution ${expected}`), { code, details });
      const snapshot = await createStatusProvider({
        portService: {
          resolve: async () => {
            throw error;
          },
          list: async () => [record],
          inspect: async () => {
            throw new Error('inspect must be skipped');
          },
        },
      }).snapshot({ cwd: 'C:/repo.worktrees/feature', config, configHash: 'hash-1' });

      expect(snapshot.portResolution).toBe(expected);
      expect(snapshot.services[0]).toMatchObject({
        port: null,
        listening: false,
        conflict: 'none',
        pid: null,
      });
    },
  );

  it('does not misclassify a malformed lease as missing when the resolver message mentions both', async () => {
    const error = Object.assign(
      new Error('The local port lease is missing, malformed, or unsafe.'),
      { code: 'PORT_LEASE_INVALID', details: { cause: 'SyntaxError: unexpected token' } },
    );
    const snapshot = await createStatusProvider({
      portService: {
        resolve: async () => {
          throw error;
        },
        list: async () => [record],
        inspect: async () => [],
      },
    }).snapshot({ cwd: 'C:/repo.worktrees/feature', config, configHash: 'hash-1' });
    expect(snapshot.portResolution).toBe('invalid');
  });

  it('never invokes an available allocating ensure dependency', async () => {
    const readOnlyWithTrap = {
      resolve: async () => lease,
      list: async () => [record],
      inspect: async () => [],
      ensure: async () => {
        throw new Error('status attempted allocation');
      },
    };
    const snapshot = await createStatusProvider({ portService: readOnlyWithTrap }).snapshot({
      cwd: 'C:/repo.worktrees/feature',
      config,
      configHash: 'hash-1',
    });
    expect(snapshot.portResolution).toBe('valid');
  });
});
