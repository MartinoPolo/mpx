import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  loadAgentExtensionResources,
  resolveSessionPersistencePolicy,
} from '../../../subagents/agent-runner.js';

test('forces noExtensions before discovery for default-true untrusted project config', async () => {
  const override = vi.fn((extensions) => extensions);
  const reload = vi.fn(async (policy) => policy);

  const policy = await loadAgentExtensionResources(
    'project',
    ['/project/.pi/extensions/untrusted.ts'],
    false,
    override,
    () => false,
    reload,
  );

  assert.deepEqual(policy, {
    noExtensions: true,
    additionalExtensionPaths: undefined,
    extensionsOverride: undefined,
  });
  assert.deepEqual(reload.mock.calls, [[policy]]);
  assert.equal(override.mock.calls.length, 0);
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

test('preserves trusted project and global extension loading', async () => {
  const paths = ['/project/.pi/extensions/trusted.ts'];
  const override = vi.fn((extensions) => extensions);
  const reload = vi.fn(async (policy) => policy);

  const trustedPolicy = await loadAgentExtensionResources(
    'project',
    paths,
    false,
    override,
    () => true,
    reload,
  );
  const globalPolicy = await loadAgentExtensionResources(
    'global',
    paths,
    false,
    override,
    () => false,
    reload,
  );

  for (const policy of [trustedPolicy, globalPolicy]) {
    assert.equal(policy.noExtensions, false);
    assert.deepEqual(policy.additionalExtensionPaths, paths);
    assert.equal(policy.extensionsOverride, override);
  }
});
