import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  loadAgentExtensionResources,
  resolveSessionPersistencePolicy,
} from '../../../subagents/agent-runner.js';

test('forces noExtensions before discovery for default-true untrusted project config', async () => {
  const projectDiscoveryOverride = vi.fn((extensions) => extensions);
  const loader = vi.fn(async (policy) => policy);

  const policy = await loadAgentExtensionResources(
    'project',
    undefined,
    false,
    projectDiscoveryOverride,
    () => false,
    loader,
  );

  assert.deepEqual(policy, {
    noExtensions: true,
    additionalExtensionPaths: undefined,
    extensionsOverride: undefined,
  });
  assert.deepEqual(loader.mock.calls, [[policy]]);
  assert.equal(projectDiscoveryOverride.mock.calls.length, 0);
});

test('strips untrusted project extension paths and overrides', async () => {
  const override = vi.fn((extensions) => extensions);
  const loader = vi.fn(async (policy) => policy);

  const policy = await loadAgentExtensionResources(
    'project',
    ['/project/.pi/extensions/untrusted.ts'],
    false,
    override,
    () => false,
    loader,
  );

  assert.equal(policy.noExtensions, true);
  assert.equal(policy.additionalExtensionPaths, undefined);
  assert.equal(policy.extensionsOverride, undefined);
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
