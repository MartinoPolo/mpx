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

  it('delegates verified port termination with a stable result', async () => {
    const { service, dependencies } = fixture();
    await expect(service.killPort({ schemaVersion: 1, pid: 42 })).resolves.toEqual({
      schemaVersion: 1,
      killed: true,
      pid: 42,
    });
    expect(dependencies.ports.kill).toHaveBeenCalledWith(42);
  });
});
