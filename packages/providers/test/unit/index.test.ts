import { errorEnvelope } from '@mpx/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUILTIN_PROVIDERS,
  CI_CAPABILITIES,
  capabilitiesForProviderRole,
  ISSUE_CAPABILITIES,
  LOCAL_ISSUE_CAPABILITIES,
  ProviderError,
  ProviderRegistry,
  REVIEW_CAPABILITIES,
  providerRegistry,
} from '../../src/index.js';

describe('provider contracts', () => {
  it('publishes the migration capability contract', () => {
    expect({
      issues: ISSUE_CAPABILITIES,
      review: REVIEW_CAPABILITIES,
      ci: CI_CAPABILITIES,
    }).toEqual({
      issues: [
        'issue.list',
        'issue.view',
        'issue.create',
        'issue.edit',
        'issue.comment',
        'issue.label',
        'issue.move',
        'issue.finish',
      ],
      review: [
        'review.view',
        'review.create',
        'review.update',
        'review.comment',
        'review.ready',
        'review.merge',
      ],
      ci: ['ci.status', 'ci.watch', 'ci.logs', 'ci.retry'],
    });
  });

  it('classifies provider capabilities through one provider-neutral role helper', () => {
    const capabilities = [
      'review.view',
      'issue.list',
      'ci.status',
      'issue.dependency.add',
    ] as const;
    expect(capabilitiesForProviderRole(capabilities, 'issues')).toEqual([
      'issue.list',
      'issue.dependency.add',
    ]);
    expect(capabilitiesForProviderRole(capabilities, 'repository')).toEqual([
      'review.view',
      'ci.status',
    ]);
  });

  it('lists built-ins deterministically and by role', () => {
    expect(providerRegistry.list().map(({ id }) => id)).toEqual([
      'generic',
      'gerrit',
      'github',
      'gitlab',
      'kanbanflow',
      'local',
      'none',
    ]);
    expect(providerRegistry.list('repository').map(({ id }) => id)).toEqual([
      'generic',
      'gerrit',
      'github',
      'gitlab',
    ]);
    expect(providerRegistry.list('issues').map(({ id }) => id)).toEqual([
      'github',
      'gitlab',
      'kanbanflow',
      'local',
      'none',
    ]);
  });

  it('returns immutable descriptors and strict schemas', () => {
    const github = providerRegistry.get('github', 'repository');
    expect(Object.isFrozen(github)).toBe(true);
    expect(Object.isFrozen(github.capabilities)).toBe(true);
    expect(providerRegistry.schema('none', 'issues')).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('advertises only capabilities implemented by each trusted built-in', () => {
    expect(providerRegistry.get('gerrit', 'repository').capabilities).toEqual([
      'review.view',
      'review.create',
      'review.update',
      'review.comment',
      'review.ready',
      'review.vote',
      'review.merge',
    ]);
    expect(providerRegistry.get('gerrit', 'repository').capabilities).not.toContain('ci.status');
    expect(providerRegistry.get('github', 'repository').capabilities).not.toContain('review.vote');
    expect(providerRegistry.get('gitlab', 'repository').capabilities).not.toContain('review.vote');
    expect(providerRegistry.get('github', 'issues').capabilities).not.toContain('issue.move');
    expect(providerRegistry.get('gitlab', 'issues').capabilities).not.toContain('issue.move');
    expect(providerRegistry.get('kanbanflow', 'issues').capabilities).toContain('issue.move');
    expect(providerRegistry.get('local', 'issues').capabilities).toEqual([
      ...ISSUE_CAPABILITIES.filter((capability) => capability !== 'issue.move'),
      ...LOCAL_ISSUE_CAPABILITIES,
    ]);
  });
});

describe('public provider composition', () => {
  it('exports only fixed service composition and no arbitrary adapter injection API', async () => {
    const providers = await import('../../src/index.js');

    expect(providers).toHaveProperty('createBuiltinProviderService', expect.any(Function));
    for (const name of [
      'ProviderService',
      'ProviderAdapterRegistry',
      'createBuiltinProviderAdapters',
      'createGerritAdapter',
    ]) {
      expect(providers).not.toHaveProperty(name);
    }
  });
});

describe('fixed registry', () => {
  it('ignores runtime descriptor arguments and always exposes canonical built-ins', () => {
    expectTypeOf<ConstructorParameters<typeof ProviderRegistry>>().toEqualTypeOf<[]>();
    const RuntimeRegistry = ProviderRegistry as unknown as new (
      ...arguments_: unknown[]
    ) => ProviderRegistry;
    const altered = { ...BUILTIN_PROVIDERS[0]!, backend: 'filesystem' };
    const registry = new RuntimeRegistry([altered], [{ ...altered, id: 'injected' }]);

    expect(registry.list()).toEqual(providerRegistry.list());
    expect(registry.get('github').backend).toBe('gh');
    expect(() => registry.get('injected')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_FOUND' }),
    );
  });

  it('fails capability checks structurally', () => {
    expect(() => providerRegistry.assertCapability('generic', 'ci.logs')).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_UNSUPPORTED',
        capability: 'ci.logs',
        retryable: false,
      }),
    );
    expect(() => providerRegistry.assertCapability('github', 'repo.delete')).toThrowError(
      ProviderError,
    );
    expect(() => providerRegistry.get('missing')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_FOUND' }),
    );
  });

  it('preserves provider capability errors in public envelopes', () => {
    let error: unknown;
    try {
      providerRegistry.assertCapability('generic', 'ci.logs');
    } catch (caught) {
      error = caught;
    }
    expect(errorEnvelope(error)).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', capability: 'ci.logs', retryable: false },
      warnings: [],
    });
  });
});
