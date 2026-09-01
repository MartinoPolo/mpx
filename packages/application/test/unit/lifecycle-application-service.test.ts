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
    expect(start).toHaveBeenCalledOnce();
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
