import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';

function facade() {
  return {
    list: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-list',
      workspaces: [{ path: 'C:/repo', branch: 'main', head: 'abc', role: 'main', ports: {} }],
      diagnostics: [],
    })),
    show: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-show',
      path: 'C:/repo',
      branch: 'main',
      head: 'abc',
      role: 'main',
      ports: {},
      projectId: 'p',
      portResolution: 'valid',
      services: [],
      diagnostics: [],
    })),
    create: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-mutation',
      operation: 'create',
      status: 'ready',
      path: 'C:/repo.worktrees/x',
    })),
    remove: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-mutation',
      operation: 'remove',
      status: 'removed',
      path: 'C:/repo.worktrees/x',
    })),
    start: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-service',
      path: 'C:/repo',
      service: { id: 'web', managed: true, state: 'ready', pid: 7 },
    })),
    stop: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-service',
      path: 'C:/repo',
      service: { id: 'web', managed: true, state: 'stopped', pid: null },
    })),
    logs: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'workspace-service-logs',
      path: 'C:/repo',
      serviceId: 'web',
      text: 'ok',
    })),
    killPort: vi.fn(async ({ pid }: { pid: number }) => ({
      schemaVersion: 1,
      kind: 'port-killed',
      killed: true,
      pid,
    })),
  };
}

describe('workspace command', () => {
  it('parses every public route through one injected facade', async () => {
    const workspaceApplication = facade();
    for (const args of [
      ['workspace', 'list'],
      ['workspace', 'show', 'C:/repo.worktrees/x'],
      ['workspace', 'create', 'feature/x', '--base', 'main'],
      ['workspace', 'remove', 'C:/repo.worktrees/x'],
      ['workspace', 'start', 'web', 'C:/repo.worktrees/x'],
      ['workspace', 'stop', 'web', 'C:/repo.worktrees/x'],
      ['workspace', 'logs', 'web', 'C:/repo.worktrees/x', '--lines', '50'],
      ['port', 'kill', '42'],
    ]) {
      const io = captureIo();
      expect(await run(['--json', ...args], io, { env: {}, workspaceApplication } as never)).toBe(
        0,
      );
      expect(JSON.parse(io.out[0]!)).toMatchObject({ apiVersion: 1, ok: true });
    }
    const cwd = process.cwd();
    expect(workspaceApplication.list).toHaveBeenCalledWith({ schemaVersion: 1, cwd });
    expect(workspaceApplication.show).toHaveBeenCalledWith({
      schemaVersion: 1,
      cwd,
      path: 'C:/repo.worktrees/x',
    });
    expect(workspaceApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 1, cwd, branch: 'feature/x', base: 'main' }),
    );
    expect(workspaceApplication.remove).toHaveBeenCalledWith({
      schemaVersion: 1,
      cwd,
      path: 'C:/repo.worktrees/x',
    });
    for (const method of ['start', 'stop'] as const) {
      expect(workspaceApplication[method]).toHaveBeenCalledWith({
        schemaVersion: 1,
        cwd,
        serviceId: 'web',
        path: 'C:/repo.worktrees/x',
      });
    }
    expect(workspaceApplication.logs).toHaveBeenCalledWith({
      schemaVersion: 1,
      cwd,
      serviceId: 'web',
      path: 'C:/repo.worktrees/x',
      lines: 50,
    });
    expect(workspaceApplication.killPort).toHaveBeenCalledWith({ schemaVersion: 1, pid: 42 });
  });

  it('emits only the canonical path in machine mode', async () => {
    const io = captureIo();
    expect(
      await run(['workspace', 'show', '--machine'], io, {
        env: {},
        workspaceApplication: facade(),
      } as never),
    ).toBe(0);
    expect(io.out).toEqual(['C:/repo\n']);
  });

  it.each(['status', 'worktree', 'dev', 'ports'])(
    'rejects removed top-level %s routes',
    async (command) => {
      const io = captureIo();
      expect(
        await run(['--json', command], io, { env: {}, workspaceApplication: facade() } as never),
      ).toBe(2);
      expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: false, error: { code: 'USAGE_ERROR' } });
    },
  );
});
