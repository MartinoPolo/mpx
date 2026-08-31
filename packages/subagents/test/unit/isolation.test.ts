import { describe, expect, it, vi } from 'vitest';
import { StrictWorktreeIsolation } from '../../src/isolation.js';

const result = (status: string, worktreePath?: string) => ({
  schemaVersion: 1 as const,
  owner: 'mpx' as const,
  operation: 'create' as const,
  status,
  repositoryId: 'o/r',
  ...(worktreePath ? { worktreePath } : {}),
});
describe('strict worktree isolation', () => {
  it('treats isolation failure as fatal without shared-CWD fallback', async () => {
    const isolation = new StrictWorktreeIsolation({
      create: async () => {
        throw new Error('git failed');
      },
      remove: async () => result('removed'),
    });
    await expect(isolation.create({ cwd: 'C:/repo', branch: 'agent/a' })).rejects.toThrow(
      /SUBAGENT_ISOLATION_FAILED/,
    );
  });
  it('preserves worktree paths containing spaces', async () => {
    const path = 'C:/MP Work/repo.worktrees/agent one';
    const isolation = new StrictWorktreeIsolation({
      create: async () => result('ready', path),
      remove: async () => result('removed'),
    });
    await expect(
      isolation.create({ cwd: 'C:/MP Work/repo', branch: 'agent/one' }),
    ).resolves.toEqual({ cwd: path, sourceCwd: 'C:/MP Work/repo' });
  });
  it('performs durable lifecycle cleanup', async () => {
    const remove = vi.fn(async () => result('removed'));
    const isolation = new StrictWorktreeIsolation({
      create: async () => result('ready', 'C:/tree'),
      remove,
    });
    const tree = await isolation.create({ cwd: 'C:/repo', branch: 'agent/a' });
    await isolation.cleanup(tree);
    expect(remove).toHaveBeenCalledWith({ cwd: 'C:/repo', worktreePath: 'C:/tree' });
  });
});
