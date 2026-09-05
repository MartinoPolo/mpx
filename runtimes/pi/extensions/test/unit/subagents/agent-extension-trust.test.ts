import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  loadAgentExtensionResources,
  resolveMemoryScopePolicy,
  resolveSessionPersistencePolicy,
} from '../../../subagents/agent-runner.js';

test('forces noExtensions before discovery for an untrusted built-in default-true config', async () => {
  const projectDiscoveryOverride = vi.fn((extensions) => extensions);
  const loader = vi.fn(async (policy) => policy);

  const policy = await loadAgentExtensionResources(
    undefined,
    false,
    projectDiscoveryOverride,
    false,
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

test('strips every untrusted agent extension path and override', async () => {
  const override = vi.fn((extensions) => extensions);
  const loader = vi.fn(async (policy) => policy);

  for (const source of ['default', 'global', 'project']) {
    const policy = await loadAgentExtensionResources(
      [`/${source}/extension.ts`],
      false,
      override,
      false,
      loader,
    );

    assert.equal(policy.noExtensions, true);
    assert.equal(policy.additionalExtensionPaths, undefined);
    assert.equal(policy.extensionsOverride, undefined);
  }
});

test('applies the untrusted memory scope policy matrix', () => {
  for (const scope of ['user', 'project', 'local'] as const) {
    assert.equal(resolveMemoryScopePolicy('project', false, scope), undefined);
  }

  for (const source of ['default', 'global', undefined] as const) {
    assert.equal(resolveMemoryScopePolicy(source, false, 'user'), 'user');
    assert.equal(resolveMemoryScopePolicy(source, false, 'project'), undefined);
    assert.equal(resolveMemoryScopePolicy(source, false, 'local'), undefined);
  }
});

test('preserves configured memory when the project is trusted', () => {
  for (const source of ['default', 'global', 'project', undefined] as const) {
    for (const scope of ['user', 'project', 'local'] as const) {
      assert.equal(resolveMemoryScopePolicy(source, true, scope), scope);
    }
  }
});

test('disables native persistence paths from untrusted project agents', () => {
  assert.deepEqual(resolveSessionPersistencePolicy('project', false, true, '.pi/sessions'), {
    persistSession: false,
    sessionDir: undefined,
  });
});

test('retains persistence for trusted projects and non-project agent sources', () => {
  assert.deepEqual(resolveSessionPersistencePolicy('project', true, true, '.pi/sessions'), {
    persistSession: true,
    sessionDir: '.pi/sessions',
  });
  for (const source of ['compiled', 'global'] as const) {
    assert.deepEqual(resolveSessionPersistencePolicy(source, false, true, '~/sessions'), {
      persistSession: true,
      sessionDir: '~/sessions',
    });
  }
});

test('treats compiled agent memory as environment-trusted rather than project-provided', () => {
  assert.equal(resolveMemoryScopePolicy('compiled', false, 'user'), 'user');
  assert.equal(resolveMemoryScopePolicy('compiled', false, 'project'), undefined);
  assert.equal(resolveMemoryScopePolicy('compiled', false, 'local'), undefined);
});

test('preserves extension loading when the project is trusted', async () => {
  const paths = ['/project/.pi/extensions/trusted.ts'];
  const override = vi.fn((extensions) => extensions);
  const reload = vi.fn(async (policy) => policy);

  const policy = await loadAgentExtensionResources(paths, false, override, true, reload);

  assert.equal(policy.noExtensions, false);
  assert.deepEqual(policy.additionalExtensionPaths, paths);
  assert.equal(policy.extensionsOverride, override);
});
