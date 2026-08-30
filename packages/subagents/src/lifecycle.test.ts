import { describe, expect, it, vi } from 'vitest';
import type { ChildLaunchAuthorityV1 } from '@mpx/runtime-contracts';
import { SubagentLifecycle } from './lifecycle.js';
import type { AgentLaunchRequest, AgentRunner } from './contracts.js';
import type { StrictWorktreeIsolation } from './isolation.js';

const authority = {
  identity: { name: 'personal' },
  nesting: { depth: 1, maxDepth: 2 },
} as ChildLaunchAuthorityV1;
function request(id: string, extra: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest {
  return {
    id,
    type: 'reviewer',
    identity: 'personal',
    description: id,
    prompt: 'work',
    join: 'background',
    model: { provider: 'openai', model: 'gpt' },
    nesting: { depth: 1, maxDepth: 2, parentAgentId: null, rootAgentId: 'root' },
    authority,
    ...extra,
  };
}
function deferredRunner() {
  const gates = new Map<string, (value: string) => void>();
  const active: string[] = [];
  const runner: AgentRunner = {
    run: async (req) => {
      active.push(req.id);
      return new Promise((resolve) => gates.set(req.id, resolve));
    },
  };
  return { runner, gates, active };
}

describe('subagent lifecycle', () => {
  it('limits running agents and drains the queue', async () => {
    const d = deferredRunner();
    const life = new SubagentLifecycle({ concurrency: 1, runner: d.runner });
    await life.launch(request('a'));
    await life.launch(request('b'));
    expect(life.list().map((a) => a.status)).toEqual(['running', 'queued']);
    d.gates.get('a')!('A');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.active).toEqual(['a', 'b']);
    d.gates.get('b')!('B');
  });
  it('batches one notification after a group settles across completion races', async () => {
    const d = deferredRunner();
    const notify = vi.fn();
    const life = new SubagentLifecycle({ concurrency: 2, runner: d.runner, notify });
    await life.launch(request('a', { join: 'group', groupId: 'g' }));
    await life.launch(request('b', { join: 'group', groupId: 'g' }));
    d.gates.get('a')!('A');
    await new Promise((resolve) => setTimeout(resolve, 0));
    life.registerGroup('g', ['a', 'b']);
    d.gates.get('b')!('B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].agents).toHaveLength(2);
  });
  it('does not strand a group when a queued member is cancelled', async () => {
    const d = deferredRunner();
    const notify = vi.fn();
    const life = new SubagentLifecycle({ concurrency: 1, runner: d.runner, notify });
    await life.launch(request('a', { join: 'group', groupId: 'g' }));
    await life.launch(request('b', { join: 'group', groupId: 'g' }));
    life.registerGroup('g', ['a', 'b']);
    life.cancel('b');
    d.gates.get('a')!('A');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('suppresses notifications when result consumption starts before completion', async () => {
    const d = deferredRunner();
    const notify = vi.fn();
    const life = new SubagentLifecycle({ concurrency: 1, runner: d.runner, notify });
    await life.launch(request('a'));
    const result = life.get_subagent_result('a');
    d.gates.get('a')!('done');
    await expect(result).resolves.toBe('done');
    expect(notify).not.toHaveBeenCalled();
  });
  it('captures an immutable resolved-model snapshot', async () => {
    const model = { provider: 'openai', model: 'gpt' };
    const d = deferredRunner();
    const life = new SubagentLifecycle({ concurrency: 1, runner: d.runner });
    await life.launch(request('a', { model }));
    model.model = 'changed';
    expect(life.get('a').model.model).toBe('gpt');
    d.gates.get('a')!('done');
  });
  it('delivers queued steering to the running agent', async () => {
    let steered = '';
    const life = new SubagentLifecycle({
      concurrency: 1,
      runner: {
        run: async (_request, context) => {
          for await (const message of context.steer) {
            steered = message;
            break;
          }
          return 'done';
        },
      },
    });
    await life.launch(request('a'));
    life.steer_subagent('a', 'focus tests');
    await life.get_subagent_result('a');
    expect(steered).toBe('focus tests');
  });
  it('waits inline for foreground completion', async () => {
    const life = new SubagentLifecycle({ concurrency: 1, runner: { run: async () => 'inline' } });
    await expect(life.launch(request('a', { join: 'foreground' }))).resolves.toMatchObject({
      status: 'completed',
      result: 'inline',
      resultConsumed: true,
    });
  });
  it('gates schedule creation on an explicit user request', () => {
    const life = new SubagentLifecycle({ concurrency: 1, runner: { run: async () => 'done' } });
    expect(() =>
      life.schedule({
        id: 'daily',
        explicitUserRequest: false,
        launch: request('scheduled'),
        nextRunAt: 1,
      }),
    ).toThrow(/SUBAGENT_SCHEDULE_EXPLICIT_REQUIRED/);
  });
  it('restores schedules on resume and preserves them on shutdown', async () => {
    const life = new SubagentLifecycle({
      concurrency: 1,
      runner: { run: async () => 'done' },
      now: () => 10,
    });
    life.restoreSchedules([
      {
        id: 'daily',
        explicitUserRequest: true,
        launch: request('scheduled'),
        nextRunAt: 5,
        intervalMs: 10,
        enabled: true,
        runCount: 0,
      },
    ]);
    await life.processDue();
    const saved = await life.shutdown();
    expect(saved[0]).toMatchObject({ runCount: 1, nextRunAt: 20, enabled: true });
  });
  it('delivers an unread background completion notification', async () => {
    const notify = vi.fn();
    const life = new SubagentLifecycle({
      concurrency: 1,
      runner: { run: async () => 'done' },
      notify,
    });
    await life.launch(request('a'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledWith({
      agents: [expect.objectContaining({ id: 'a', status: 'completed' })],
      partial: false,
    });
  });
  it('contains and deterministically reports rejected notification callbacks without changing the lifecycle result', async () => {
    const report = vi.fn();
    const life = new SubagentLifecycle({
      concurrency: 1,
      runner: { run: async () => 'done' },
      notify: async () => {
        throw new Error('transport down');
      },
      onNotificationError: report,
    });
    await life.launch(request('a'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(life.get_subagent_result('a')).resolves.toBe('done');
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transport down' }),
      expect.objectContaining({ agents: [expect.objectContaining({ id: 'a' })] }),
      1,
    );
  });
  it('marks a group delivered only after a bounded notification retry succeeds', async () => {
    const d = deferredRunner(),
      report = vi.fn(),
      notify = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const life = new SubagentLifecycle({
      concurrency: 1,
      runner: d.runner,
      notify,
      onNotificationError: report,
      notificationRetries: 1,
    });
    await life.launch(request('a', { join: 'group', groupId: 'g' }));
    life.registerGroup('g', ['a']);
    d.gates.get('a')!('done');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    await expect(life.get_subagent_result('a')).resolves.toBe('done');
  });
  it('cleans up an isolated worktree when the runner fails', async () => {
    const cleanup = vi.fn(async () => {});
    const isolation = {
      create: vi.fn(async () => ({ cwd: 'C:/repo.wt/a', sourceCwd: 'C:/repo' })),
      cleanup,
    } as unknown as StrictWorktreeIsolation;
    const life = new SubagentLifecycle({
      concurrency: 1,
      isolation,
      runner: {
        run: async () => {
          throw new Error('runner failed');
        },
      },
    });
    await life.launch(request('a', { isolation: { cwd: 'C:/repo', branch: 'agent-a' } }));
    await expect(life.get_subagent_result('a')).rejects.toThrow('runner failed');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('preserves the runner failure and deterministically appends a cleanup failure', async () => {
    const isolation = {
      create: vi.fn(async () => ({ cwd: 'C:/repo.wt/a', sourceCwd: 'C:/repo' })),
      cleanup: vi.fn(async () => {
        throw new Error('retained changes');
      }),
    } as unknown as StrictWorktreeIsolation;
    const life = new SubagentLifecycle({
      concurrency: 1,
      isolation,
      runner: {
        run: async () => {
          throw new Error('runner failed');
        },
      },
    });
    await life.launch(request('a', { isolation: { cwd: 'C:/repo', branch: 'agent-a' } }));
    await expect(life.get_subagent_result('a')).rejects.toThrow(
      'runner failed (cleanup also failed: retained changes)',
    );
  });
  it('cleans up an isolated worktree after cancellation aborts the runner', async () => {
    const cleanup = vi.fn(async () => {});
    const isolation = {
      create: vi.fn(async () => ({ cwd: 'C:/repo.wt/a', sourceCwd: 'C:/repo' })),
      cleanup,
    } as unknown as StrictWorktreeIsolation;
    const life = new SubagentLifecycle({
      concurrency: 1,
      isolation,
      runner: {
        run: async (_request, context) =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            }),
          ),
      },
    });
    await life.launch(request('a', { isolation: { cwd: 'C:/repo', branch: 'agent-a' } }));
    life.cancel('a');
    await expect(life.get_subagent_result('a')).rejects.toThrow('Cancelled');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('reports retained changed-worktree cleanup without retrying removal', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error(
        "SUBAGENT_ISOLATION_CLEANUP_FAILED: Durable worktree cleanup ended in 'retained'.",
      );
    });
    const isolation = {
      create: vi.fn(async () => ({ cwd: 'C:/repo.wt/a', sourceCwd: 'C:/repo' })),
      cleanup,
    } as unknown as StrictWorktreeIsolation;
    const life = new SubagentLifecycle({
      concurrency: 1,
      isolation,
      runner: { run: async () => 'done' },
    });
    await life.launch(request('a', { isolation: { cwd: 'C:/repo', branch: 'agent-a' } }));
    await expect(life.get_subagent_result('a')).rejects.toThrow(
      'SUBAGENT_ISOLATION_CLEANUP_FAILED',
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
