import { describe, expect, it, vi } from 'vitest';
import { createNodeWorkspaceApplicationService } from '../../src/node/index.js';

describe('Node workspace composition', () => {
  it('uses target-scoped config, status, ports, and service adapters', async () => {
    const target = 'C:/repo.worktrees/x';
    const discover = vi.fn(async () => ({
      root: target,
      config: {
        schemaVersion: 1,
        project: { id: 'p' },
        repository: { provider: 'generic', remote: 'origin' },
      },
    }));
    const forWorkspace = vi.fn(async () => ({
      runtimeKind: 'host',
      status: async () => [],
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      logs: vi.fn(),
    }));
    const snapshot = vi.fn(async () => ({
      schemaVersion: 1,
      project: { id: 'p', cwd: target },
      worktree: { id: 'x', path: target, role: 'linked', branch: 'x' },
      portResolution: 'valid',
      services: [],
      diagnostics: [],
    }));
    const listPorts = vi.fn(async () => [{ worktreePath: target, role: 'linked', services: {} }]);
    const service = createNodeWorkspaceApplicationService({
      worktrees: {
        reconcile: async () => ({}),
        list: async () => [
          {
            path: target,
            branch: 'x',
            head: 'abc',
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
        create: vi.fn(),
        remove: vi.fn(),
      },
      ports: { list: listPorts, resolve: vi.fn(), kill: vi.fn() },
      projects: { discover },
      status: { snapshot },
      services: { forWorkspace },
    } as never);
    await service.show({ schemaVersion: 1, cwd: 'C:/repo', path: target });
    expect(discover).toHaveBeenCalledWith(target);
    expect(forWorkspace).toHaveBeenCalledWith(target);
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: target, projectRoot: target }),
    );
    expect(listPorts).toHaveBeenCalledOnce();
  });
});
