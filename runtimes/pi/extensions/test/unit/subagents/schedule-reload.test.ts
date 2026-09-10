import assert from 'node:assert/strict';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { test, vi } from 'vitest';

import type { AgentManager } from '../../../subagents/agent-manager.js';
import { SubagentScheduler } from '../../../subagents/schedule.js';
import type { ScheduleStore } from '../../../subagents/schedule-store.js';
import type { ScheduledSubagent } from '../../../subagents/types.js';

test('a scheduled fire reloads the catalog and refuses to spawn when validation fails', async () => {
  const job: ScheduledSubagent = {
    id: 'scheduled-1',
    name: 'stale managed job',
    description: 'Must not run stale identity',
    schedule: '1h',
    scheduleType: 'interval',
    intervalMs: 3_600_000,
    subagent_type: 'ManagedSpecialist',
    prompt: 'Do managed work',
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
  const update = vi.fn();
  const store = {
    list: () => [],
    get: vi.fn(() => job),
    update,
  } as unknown as ScheduleStore;
  const spawn = vi.fn(() => 'agent-1');
  const manager = { spawn, getRecord: vi.fn() } as unknown as AgentManager;
  const emit = vi.fn();
  const reload = vi.fn(async () => {
    throw new Error('managed catalog changed');
  });
  const scheduler = new SubagentScheduler();
  scheduler.start(
    { events: { emit } } as unknown as ExtensionAPI,
    { modelRegistry: {} } as ExtensionContext,
    manager,
    store,
    reload,
  );

  await (scheduler as unknown as { executeJob(id: string): Promise<void> }).executeJob(job.id);

  assert.equal(reload.mock.calls.length, 1);
  assert.equal(spawn.mock.calls.length, 0);
  assert.equal(update.mock.calls.at(-1)?.[1]?.lastStatus, 'error');
  assert.match(String(emit.mock.calls.at(-1)?.[1]?.error), /managed catalog changed/);
  scheduler.stop();
});
