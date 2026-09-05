import { sha256Canonical, type JsonValue } from '@mpx/core';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationService } from '../../src/workspace-application-service.js';

const config = {
  schemaVersion: 1 as const,
  project: { id: 'sample' },
  repository: { provider: 'generic', remote: 'origin' },
  tooling: { packageManager: 'pnpm' as const },
  development: {
    services: {
      web: {
        scope: 'checkout' as const,
        port: { mode: 'managed' as const, preferred: 3000 },
        environmentVariable: 'WEB_URL',
        protocol: 'http' as const,
        start: { type: 'package-script' as const, script: 'dev' },
      },
      database: {
        scope: 'project' as const,
        port: { mode: 'fixed-shared' as const, preferred: 5432 },
        start: { type: 'external' as const, kind: 'database' as const },
      },
    },
  },
};

function fixture(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const manager = {
    runtimeKind: 'host' as const,
    status: vi.fn(async () => []),
    start: vi.fn(async () => ({ id: 'web', state: 'starting', pid: 7 })),
    stop: vi.fn(async (id: string) => ({ id, state: 'stopped', pid: null })),
    restart: vi.fn(),
    logs: vi.fn(async () => 'hello'),
  };
  const dependencies = {
    path: {
      resolve: (...parts: string[]) => parts.at(-1)!,
      contains: (root: string, candidate: string) =>
        candidate === root || candidate.startsWith(`${root}/`),
    },
    worktrees: {
      reconcile: vi.fn(async () => {
        order.push('worktree-reconcile');
        return { status: 'ok' };
      }),
      list: vi.fn(async () => [
        {
          path: '/repo',
          branch: 'main',
          head: 'abc',
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/repo.worktrees/x',
          branch: 'feature/x',
          head: 'def',
          detached: false,
          locked: false,
          prunable: false,
        },
      ]),
      create: vi.fn(async () => ({
        schemaVersion: 1,
        owner: 'mpx',
        operation: 'create',
        status: 'ready',
        repositoryId: 'sample',
        worktreePath: '/repo.worktrees/x',
      })),
      remove: vi.fn(async () => {
        order.push('git-remove');
        return {
          schemaVersion: 1,
          owner: 'mpx',
          operation: 'remove',
          status: 'removed',
          repositoryId: 'sample',
        };
      }),
    },
    ports: {
      list: vi.fn(async () => [
        {
          leaseId: 'l',
          projectId: 'sample',
          worktreeId: 'w',
          worktreePath: '/repo.worktrees/x',
          role: 'linked' as const,
          services: { web: 3010 },
        },
      ]),
      resolve: vi.fn(async () => ({
        leaseId: 'l',
        services: { web: 3010, database: 5432 },
        ownerRoot: '/repo',
      })),
      kill: vi.fn(async () => undefined),
    },
    projects: { discover: vi.fn(async (cwd: string) => ({ root: cwd, config })) },
    status: {
      snapshot: vi.fn(async () => ({
        schemaVersion: 1,
        project: { id: 'sample', cwd: '/repo.worktrees/x' },
        worktree: { id: 'w', path: '/repo.worktrees/x', role: 'linked', branch: 'feature/x' },
        portResolution: 'valid',
        services: [
          {
            id: 'web',
            mode: 'managed',
            scope: 'checkout',
            protocol: 'http',
            port: 3010,
            listening: true,
            conflict: 'none',
            pid: 7,
          },
        ],
        diagnostics: [],
      })),
    },
    services: { forWorkspace: vi.fn(async () => manager) },
    executor: 'host' as const,
    ...overrides,
  };
  return {
    service: new WorkspaceApplicationService(dependencies as never),
    dependencies,
    manager,
    order,
  };
}

describe('WorkspaceApplicationService', () => {
  it('recovers once and joins worktree identity with leases', async () => {
    const { service, dependencies } = fixture();
    const result = await service.list({ schemaVersion: 1, cwd: '/repo' });
    expect(dependencies.worktrees.reconcile).toHaveBeenCalledTimes(1);
    expect(result.workspaces[1]).toMatchObject({
      path: '/repo.worktrees/x',
      branch: 'feature/x',
      head: 'def',
      role: 'linked',
      ports: { web: 3010 },
    });
  });

  it('performs one automatic orphan recovery using only the exact bounded approval', async () => {
    const orphaned = [{ leaseId: 'lease' }];
    const expectedApproval = `APPROVE WORKTREE ORPHAN RELEASE ${sha256Canonical(orphaned as JsonValue)}`;
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({ orphaned, expectedApproval })
      .mockResolvedValueOnce({ orphaned: [], status: 'resolved' });
    const { service } = fixture({
      worktrees: { ...fixture().dependencies.worktrees, reconcile },
    });
    await service.list({ schemaVersion: 1, cwd: '/repo' });
    expect(reconcile.mock.calls).toEqual([
      [{ cwd: '/repo' }],
      [{ cwd: '/repo', orphanApproval: expectedApproval }],
    ]);
  });

  it('reports malformed orphan recovery as a bounded degraded read without retrying', async () => {
    const reconcile = vi.fn(async () => ({
      orphaned: [{ leaseId: 'lease' }],
      expectedApproval: `UNTRUSTED C:\\private\\secret ${'x'.repeat(1000)}`,
    }));
    const { service } = fixture({
      worktrees: { ...fixture().dependencies.worktrees, reconcile },
    });
    const result = await service.list({ schemaVersion: 1, cwd: '/repo' });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'WORKSPACE_RECOVERY_INVALID' }),
    ]);
    expect(result.diagnostics[0]!.message).not.toContain('private');
  });

  it('blocks mutation before side effects for a structurally invalid orphan recovery result', async () => {
    const create = vi.fn();
    const reconcile = vi.fn(async () => ({
      orphaned: new Array(129).fill({ leaseId: 'lease' }),
      expectedApproval: `APPROVE WORKTREE ORPHAN RELEASE ${'a'.repeat(64)}`,
    }));
    const { service } = fixture({
      worktrees: { ...fixture().dependencies.worktrees, reconcile, create },
    });
    await expect(
      service.create({ schemaVersion: 1, cwd: '/repo', branch: 'feature/x' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_BLOCKED' });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns bounded redacted diagnostics for degraded reads', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('failed C:\\private\\secret TOKEN=value '.repeat(100));
    });
    const { service } = fixture({ worktrees: { ...fixture().dependencies.worktrees, reconcile } });
    const result = await service.show({ schemaVersion: 1, cwd: '/repo.worktrees/x' });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message.length).toBeLessThanOrEqual(256);
    expect(result.diagnostics[0]!.message).not.toMatch(/private|TOKEN|value/u);
  });

  it('blocks mutation before side effects when recovery fails', async () => {
    const remove = vi.fn();
    const { service } = fixture({
      worktrees: {
        ...fixture().dependencies.worktrees,
        reconcile: vi.fn(async () => {
          throw new Error('bad');
        }),
        remove,
      },
    });
    await expect(
      service.remove({ schemaVersion: 1, cwd: '/repo', path: '/repo.worktrees/x' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_BLOCKED' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops configured checkout services before durable Git removal', async () => {
    const { service, manager, order } = fixture();
    manager.status.mockImplementation(async () => [{ id: 'web', state: 'ready', pid: 7 } as never]);
    manager.stop.mockImplementation(async () => {
      order.push('service-stop');
      return { id: 'web', state: 'stopped', pid: null } as never;
    });
    await service.remove({ schemaVersion: 1, cwd: '/repo', path: '/repo.worktrees/x' });
    expect(order).toEqual(['worktree-reconcile', 'service-stop', 'git-remove']);
  });

  it('makes repeated start and stop convergent without accepting process input', async () => {
    const { service, manager } = fixture();
    (manager.status as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'web', state: 'ready', pid: 7 })
      .mockResolvedValueOnce(undefined);
    await service.start({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' });
    const repeated = await service.start({
      schemaVersion: 1,
      cwd: '/repo.worktrees/x',
      serviceId: 'web',
    });
    const stopped = await service.stop({
      schemaVersion: 1,
      cwd: '/repo.worktrees/x',
      serviceId: 'web',
    });
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(repeated.service.state).toBe('ready');
    expect(stopped.service.state).toBe('stopped');
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it('stops an active service once and makes a repeated stop convergent', async () => {
    const { service, manager } = fixture();
    manager.status
      .mockResolvedValueOnce({ id: 'web', state: 'ready', pid: 7 } as never)
      .mockResolvedValueOnce(undefined as never);
    const request = { schemaVersion: 1 as const, cwd: '/repo.worktrees/x', serviceId: 'web' };
    await service.stop(request);
    await service.stop(request);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('attempts tolerant recovery before stop without masking the stop operation', async () => {
    const failure = new Error('recovery failed');
    const { service, dependencies, manager } = fixture({
      worktrees: {
        ...fixture().dependencies.worktrees,
        reconcile: vi.fn(async () => {
          throw failure;
        }),
      },
    });
    manager.status.mockResolvedValue({ id: 'web', state: 'ready', pid: 7 } as never);
    await service.stop({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' });
    expect(dependencies.worktrees.reconcile).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('attempts tolerant recovery before logs and preserves the service log error', async () => {
    const logFailure = new Error('actual log failure');
    const { service, dependencies, manager } = fixture({
      worktrees: {
        ...fixture().dependencies.worktrees,
        reconcile: vi.fn(async () => {
          throw new Error('recovery failed');
        }),
      },
    });
    manager.status.mockResolvedValue({ id: 'web', state: 'ready', pid: 7 } as never);
    manager.logs.mockRejectedValue(logFailure);
    await expect(
      service.logs({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' }),
    ).rejects.toBe(logFailure);
    expect(dependencies.worktrees.reconcile).toHaveBeenCalledTimes(1);
  });

  it('delegates verified port termination with a stable result', async () => {
    const { service, dependencies } = fixture();
    await expect(service.killPort({ schemaVersion: 1, pid: 42 })).resolves.toEqual({
      schemaVersion: 1,
      kind: 'port-killed',
      killed: true,
      pid: 42,
    });
    expect(dependencies.ports.kill).toHaveBeenCalledWith(42);
  });

  it('rejects every unsupported schema before calling providers', async () => {
    const { service, dependencies } = fixture();
    const requests = [
      () => service.list({ schemaVersion: 2, cwd: '/repo' } as never),
      () => service.show({ schemaVersion: 2, cwd: '/repo' } as never),
      () => service.create({ schemaVersion: 2, cwd: '/repo', branch: 'x' } as never),
      () => service.remove({ schemaVersion: 2, cwd: '/repo', path: '/repo.worktrees/x' } as never),
      () => service.start({ schemaVersion: 2, cwd: '/repo', serviceId: 'web' } as never),
      () => service.stop({ schemaVersion: 2, cwd: '/repo', serviceId: 'web' } as never),
      () => service.logs({ schemaVersion: 2, cwd: '/repo', serviceId: 'web' } as never),
      () => service.killPort({ schemaVersion: 2, pid: 42 } as never),
    ];
    for (const invoke of requests) {
      await expect(invoke()).rejects.toMatchObject({ code: 'SCHEMA_VERSION_UNSUPPORTED' });
    }
    expect(dependencies.worktrees.reconcile).not.toHaveBeenCalled();
    expect(dependencies.projects.discover).not.toHaveBeenCalled();
    expect(dependencies.services.forWorkspace).not.toHaveBeenCalled();
    expect(dependencies.ports.kill).not.toHaveBeenCalled();
  });

  it('refuses a host manager when the runtime binding selects docker', async () => {
    const { service, manager } = fixture({ executor: 'docker' });
    await expect(
      service.start({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' }),
    ).rejects.toMatchObject({ code: 'DEV_EXECUTOR_BINDING_INVALID' });
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('requires an optional service path to exactly match repository inventory', async () => {
    const { service, dependencies, manager } = fixture();
    await expect(
      service.start({ schemaVersion: 1, cwd: '/repo', path: '/repo/evil', serviceId: 'web' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    expect(dependencies.projects.discover).toHaveBeenCalledWith('/repo');
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('refuses main, unknown, and subdirectory removal targets before stopping services', async () => {
    const { service, dependencies, manager } = fixture();
    for (const target of ['/repo', '/unknown', '/repo.worktrees/x/subdir']) {
      await expect(
        service.remove({ schemaVersion: 1, cwd: '/repo', path: target }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_REMOVE_TARGET_INVALID' });
    }
    expect(manager.stop).not.toHaveBeenCalled();
    expect(dependencies.worktrees.remove).not.toHaveBeenCalled();
  });

  it('keys project-scoped managers to the lease owner root', async () => {
    const projectConfig = structuredClone(config);
    (projectConfig.development.services.web as { scope: 'checkout' | 'project' }).scope = 'project';
    const { service, dependencies } = fixture({
      projects: { discover: vi.fn(async (cwd: string) => ({ root: cwd, config: projectConfig })) },
    });
    await service.start({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' });
    expect(dependencies.services.forWorkspace).toHaveBeenCalledWith('/repo');
  });

  it('does not grant absolute executable trust to an injected package resolver', async () => {
    const { service, manager } = fixture({
      resolvePackageInvocation: vi.fn(async () => ({
        executable: '/repo/malicious-pnpm',
        prefixArguments: [],
      })),
    });
    await service.start({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' });
    expect(manager.start).toHaveBeenCalledWith(
      expect.not.objectContaining({ trustedAbsoluteExecutable: true }),
    );
  });

  it('returns empty logs for a configured service that was never started', async () => {
    const { service, manager } = fixture();
    manager.status.mockResolvedValue(undefined as never);
    await expect(
      service.logs({ schemaVersion: 1, cwd: '/repo.worktrees/x', serviceId: 'web' }),
    ).resolves.toMatchObject({ kind: 'workspace-service-logs', text: '' });
    expect(manager.logs).not.toHaveBeenCalled();
  });
});
