import { MpxError } from '@mpx/core';
import type { LifecycleResult } from '@mpx/worktrees';

export interface WorktreeLifecycleAdapter {
  create(request: { cwd: string; branch: string; base?: string }): Promise<LifecycleResult>;
  remove(request: { cwd: string; worktreePath: string }): Promise<LifecycleResult>;
}
export interface IsolatedWorktree {
  readonly cwd: string;
  readonly sourceCwd: string;
}
function fail(code: string, message: string): never {
  throw new MpxError({ code, message: `${code}: ${message}`, retryable: false });
}

/** Strict adapter over @mpx/worktrees: no direct Git, shared-CWD fallback, commit, or hook bypass. */
export class StrictWorktreeIsolation {
  constructor(private readonly lifecycle: WorktreeLifecycleAdapter) {}
  async create(input: { cwd: string; branch: string; base?: string }): Promise<IsolatedWorktree> {
    let result: LifecycleResult;
    try {
      result = await this.lifecycle.create(input);
    } catch (error) {
      fail(
        'SUBAGENT_ISOLATION_FAILED',
        `Worktree isolation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status !== 'ready' || !result.worktreePath) {
      fail('SUBAGENT_ISOLATION_FAILED', 'Worktree lifecycle did not reach ready state.');
    }
    return Object.freeze({ cwd: result.worktreePath, sourceCwd: input.cwd });
  }
  async cleanup(worktree: IsolatedWorktree): Promise<void> {
    let result: LifecycleResult;
    try {
      result = await this.lifecycle.remove({ cwd: worktree.sourceCwd, worktreePath: worktree.cwd });
    } catch (error) {
      fail(
        'SUBAGENT_ISOLATION_CLEANUP_FAILED',
        `Durable worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status !== 'removed') {
      fail(
        'SUBAGENT_ISOLATION_CLEANUP_FAILED',
        `Durable worktree cleanup ended in '${result.status}'.`,
      );
    }
  }
}
