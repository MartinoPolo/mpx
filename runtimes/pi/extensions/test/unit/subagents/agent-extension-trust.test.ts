import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  loadAgentExtensionResources,
  resolveSessionPersistencePolicy,
} from '../../../subagents/agent-runner.js';

test('rejects untrusted project extension paths before loader reload', async () => {
  const reload = vi.fn(async () => undefined);
  const activity = vi.fn();

  await assert.rejects(
    loadAgentExtensionResources(
      'project',
      ['/project/.pi/extensions/untrusted.ts'],
      'project-agent',
      () => false,
      activity,
      reload,
    ),
    /Blocked 1 custom extension path\(s\) from untrusted project agent "project-agent"/,
  );

  assert.equal(reload.mock.calls.length, 0);
  assert.equal(activity.mock.calls.length, 1);
  assert.match(activity.mock.calls[0]![0].toolName, /^extensions-error:Blocked/);
});

test('disables native persistence paths from untrusted project agents', () => {
  assert.deepEqual(resolveSessionPersistencePolicy('project', false, true, '.pi/sessions'), {
    persistSession: false,
    sessionDir: undefined,
  });
});

test('retains persistence for trusted projects and global agents', () => {
  assert.deepEqual(resolveSessionPersistencePolicy('project', true, true, '.pi/sessions'), {
    persistSession: true,
    sessionDir: '.pi/sessions',
  });
  assert.deepEqual(resolveSessionPersistencePolicy('global', false, true, '~/sessions'), {
    persistSession: true,
    sessionDir: '~/sessions',
  });
});

test('passes trusted project extension paths to loader reload', async () => {
  const paths = ['/project/.pi/extensions/trusted.ts'];
  const reload = vi.fn(async (additionalPaths: string[] | undefined) => additionalPaths);

  const loaded = await loadAgentExtensionResources(
    'project',
    paths,
    'project-agent',
    () => true,
    undefined,
    reload,
  );

  assert.deepEqual(loaded, paths);
  assert.deepEqual(reload.mock.calls, [[paths]]);
});
