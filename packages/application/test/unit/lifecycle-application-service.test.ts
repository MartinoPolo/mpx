import type { ProjectConfig } from '@mpx/config';
import type { DevServiceSnapshot } from '@mpx/dev-services';
import type { StatusSnapshotV1 } from '@mpx/status';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  LifecycleApplicationService,
  type LifecycleDevResult,
} from '../../src/lifecycle-application-service.js';

const config: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'example' },
  repository: { provider: 'generic', remote: 'origin' },
  tooling: { packageManager: 'pnpm' },
  development: {
    services: {
      api: {
        scope: 'checkout',
        port: { mode: 'managed' },
        environmentVariable: 'API_URL',
        protocol: 'http',
        start: { type: 'package-script', script: 'dev' },
      },
    },
  },
};

const devSnapshot: DevServiceSnapshot = {
  id: 'api',
  state: 'ready',
  pid: 42,
  fingerprint: 'process-42',
  cwd: '/repo/wt',
  command: 'pnpm run dev',
  ports: [4310],
  readyPorts: [4310],
  run: 1,
  generation: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  readyAt: '2026-01-01T00:00:01.000Z',
  stoppedAt: null,
  exitedAt: null,
  updatedAt: '2026-01-01T00:00:01.000Z',
  exitCode: null,
  exitSignal: null,
  lastError: null,
};

const statusSnapshot: StatusSnapshotV1 = {
  schemaVersion: 1,
  project: { id: 'example', cwd: '/repo' },
  worktree: { id: null, path: null, role: null, branch: null },
  portResolution: 'valid',
  services: [],
  diagnostics: [],
};

const devService = {
  start: vi.fn(async () => devSnapshot),
  status: vi.fn(async () => devSnapshot),
  logs: vi.fn(async () => 'log output'),
  restart: vi.fn(async () => devSnapshot),
  stop: vi.fn(async () => devSnapshot),
};

describe('LifecycleApplicationService', () => {
  it('exposes concrete development and status result contracts', () => {
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      devService,
      status: { snapshot: async () => statusSnapshot },
    });
    expectTypeOf(
      service.dev({
        action: 'status',
        cwd: '/repo',
        projectRoot: '/repo',
        config,
        executor: 'host',
      }),
    ).toEqualTypeOf<Promise<LifecycleDevResult>>();
    expectTypeOf(
      service.currentStatus({ cwd: '/repo', projectRoot: '/repo', config }),
    ).toEqualTypeOf<Promise<StatusSnapshotV1>>();
  });

  it('resolves assigned ports and invokes a configured package development service', async () => {
    const start = vi.fn(async () => devSnapshot);
    const service = new LifecycleApplicationService({
      path: { resolve: (...parts) => parts.join('/') },
      devService: { ...devService, start },
      ports: { resolve: vi.fn(async () => ({ services: { api: 4310 } })) },
    });

    const result = await service.dev({
      action: 'start',
      id: 'api',
      cwd: '/repo/wt',
      projectRoot: '/repo/wt',
      config,
      executor: 'host',
    });

    expect(result).toEqual(devSnapshot);
    expect(start).toHaveBeenCalledExactlyOnceWith({
      id: 'api',
      executable: 'pnpm',
      args: ['run', 'dev'],
      cwd: '/repo/wt',
      ports: [4310],
      assignment: { worktreeRoot: '/repo/wt', ports: [4310] },
      executor: 'host',
      environment: { API_URL: 'http://localhost:4310' },
    });
  });

  it('discovers project integrity and translates ensure warnings at the application boundary', async () => {
    const ensure = vi.fn(async () => ({
      lease: { leaseId: 'lease', services: { api: 4310 } },
      warnings: [{ code: 'FIXED_SHARED_DUPLICATE', message: 'shared', port: 4310 }],
    }));
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      projects: {
        discover: vi.fn(async () => ({ root: '/repo', config })),
        userConfig: vi.fn(),
      },
      ports: { resolve: vi.fn(), ensure },
    });

    await expect(service.port('ensure', { cwd: '/repo/wt' })).resolves.toEqual({
      data: { leaseId: 'lease', services: { api: 4310 } },
      warnings: [
        {
          code: 'FIXED_SHARED_DUPLICATE',
          message: 'shared',
          severity: 'warning',
          details: { port: 4310 },
        },
      ],
    });
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo/wt',
      projectRoot: '/repo',
      config,
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('selects resolve without ensuring and returns the existing lease unchanged', async () => {
    const lease = { leaseId: 'lease', services: { api: 4310 }, ownerRoot: '/repo' };
    const ensure = vi.fn();
    const resolve = vi.fn(async () => lease);
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      projects: {
        discover: vi.fn(async () => ({ root: '/repo', config })),
        userConfig: vi.fn(),
      },
      ports: { resolve, ensure },
    });

    await expect(service.port('resolve', { cwd: '/repo/wt' })).resolves.toEqual({
      data: lease,
      warnings: [],
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('inspects ports without loading project or user configuration', async () => {
    const inspect = vi.fn(async () => [{ port: 4310, pid: 42 }]);
    const discover = vi.fn();
    const userConfig = vi.fn();
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      projects: { discover, userConfig },
      ports: { resolve: vi.fn(), inspect },
    });

    await expect(service.port('inspect', { cwd: '/irrelevant' })).resolves.toEqual({
      data: [{ port: 4310, pid: 42 }],
      warnings: [],
    });
    expect(discover).not.toHaveBeenCalled();
    expect(userConfig).not.toHaveBeenCalled();
  });

  it('reconciles the current checkout without loading configuration when rebuild is false', async () => {
    const reconcile = vi.fn(async () => ({ removed: ['old'], repaired: [], orphaned: [] }));
    const discover = vi.fn();
    const userConfig = vi.fn();
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      projects: { discover, userConfig },
      ports: { resolve: vi.fn(), reconcile },
    });

    await expect(service.port('reconcile', { cwd: '/repo/wt', rebuild: false })).resolves.toEqual({
      data: { removed: ['old'], repaired: [], orphaned: [] },
      warnings: [],
    });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith({ cwd: '/repo/wt' });
    expect(discover).not.toHaveBeenCalled();
    expect(userConfig).not.toHaveBeenCalled();
  });

  it('rebuilds from concurrently loaded, normalized, insertion-ordered unique roots', async () => {
    let resolveUserConfig!: (value: { domains: Record<string, readonly string[]> }) => void;
    const userConfigGate = new Promise<{ domains: Record<string, readonly string[]> }>(
      (resolve) => {
        resolveUserConfig = resolve;
      },
    );
    let resolveProject!: (value: { root: string; config: ProjectConfig }) => void;
    const projectGate = new Promise<{ root: string; config: ProjectConfig }>((resolve) => {
      resolveProject = resolve;
    });
    const userConfig = vi.fn(() => userConfigGate);
    const discover = vi.fn(() => projectGate);
    const rebuild = vi.fn(async (request: { roots: string[] }) => ({
      discovered: 2,
      rebuilt: 2,
      roots: request.roots.length,
    }));
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => `/normalized/${value.replace(/^\/+/, '')}` },
      projects: { discover, userConfig },
      ports: { resolve: vi.fn(), rebuild },
    });

    const result = service.port('reconcile', { cwd: '/repo/wt', rebuild: true });
    expect(userConfig).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledOnce();

    resolveProject({ root: '/repo', config });
    resolveUserConfig({ domains: { first: ['/repo', '/known'], second: ['/known'] } });

    await expect(result).resolves.toEqual({
      data: { discovered: 2, rebuilt: 2, roots: 2 },
      warnings: [],
    });
    expect(rebuild).toHaveBeenCalledExactlyOnceWith({
      roots: ['/normalized/repo', '/normalized/known'],
    });
  });

  it('constructs stable port release and sorted list results', async () => {
    const release = vi.fn(async () => undefined);
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      ports: {
        resolve: vi.fn(),
        release,
        list: vi.fn(async () => [{ leaseId: 'z' }, { leaseId: 'a' }]),
      },
    });
    await expect(service.releasePorts({ cwd: '/repo' })).resolves.toEqual({ released: true });
    await expect(service.listPorts()).resolves.toEqual([{ leaseId: 'a' }, { leaseId: 'z' }]);
  });

  it('constructs the port process termination result after awaiting the adapter', async () => {
    const kill = vi.fn(async () => undefined);
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      ports: { resolve: vi.fn(), kill },
    });
    await expect(service.killPortProcess(42)).resolves.toEqual({ killed: true, pid: 42 });
    expect(kill).toHaveBeenCalledWith(42);
  });

  it('delegates create requests through the action-specific worktree facade', async () => {
    const result = {
      schemaVersion: 1 as const,
      owner: 'mpx' as const,
      operation: 'create' as const,
      status: 'ready',
      repositoryId: 'example',
      worktreePath: '/repo/wt',
    };
    const create = vi.fn(async () => result);
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      worktrees: {
        create,
        remove: vi.fn(),
        list: vi.fn(),
        select: vi.fn(),
        status: vi.fn(),
        prepare: vi.fn(),
        cancel: vi.fn(),
        reconcile: vi.fn(),
      },
    });
    await expect(service.worktree('create', { cwd: '/repo', branch: 'feat/x' })).resolves.toEqual(
      result,
    );
    expect(create).toHaveBeenCalledWith({ cwd: '/repo', branch: 'feat/x' });
  });

  it('composes current status from project evidence and supports watch iteration', async () => {
    const snapshot = vi.fn(async () => statusSnapshot);
    const service = new LifecycleApplicationService({
      path: { resolve: (value) => value },
      ports: { resolve: vi.fn() },
      status: { snapshot },
    });
    const request = { cwd: '/repo', projectRoot: '/repo', config };
    await expect(service.currentStatus(request)).resolves.toEqual(statusSnapshot);
    const watched: StatusSnapshotV1[] = [];
    await service.watchStatus(request, {
      iterations: 2,
      intervalMs: 0,
      emit: (value) => {
        watched.push(value);
      },
    });
    expect(watched).toHaveLength(2);
  });
});
