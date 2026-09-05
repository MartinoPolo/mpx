import { errorEnvelope } from '@mpx/core';
import { describe, expect, it } from 'vitest';
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
  type ProviderDescriptor,
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

  it('advertises only issue capabilities implemented by each trusted built-in', () => {
    expect(providerRegistry.get('github', 'issues').capabilities).not.toContain('issue.move');
    expect(providerRegistry.get('gitlab', 'issues').capabilities).not.toContain('issue.move');
    expect(providerRegistry.get('kanbanflow', 'issues').capabilities).toContain('issue.move');
    expect(providerRegistry.get('local', 'issues').capabilities).toEqual([
      ...ISSUE_CAPABILITIES,
      ...LOCAL_ISSUE_CAPABILITIES,
    ]);
  });
});

describe('registry validation', () => {
  const github = BUILTIN_PROVIDERS[0]!;
  it('rejects duplicate IDs', () => {
    expect(() => new ProviderRegistry([github, github])).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_DUPLICATE' }),
    );
  });
  it('rejects caller-supplied provider extensions', () => {
    const extension = {
      id: 'trusted-issues',
      roles: ['issues'],
      capabilities: ['issue.list'],
      backend: 'trusted-sdk',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    } as const;
    expect(() => new ProviderRegistry([...BUILTIN_PROVIDERS, extension])).toThrowError(
      expect.objectContaining({ code: 'UNTRUSTED_PROVIDER_INJECTION' }),
    );
  });

  it('rejects executable/backend injection', () => {
    expect(() => new ProviderRegistry([{ ...github, backend: 'filesystem' }])).toThrowError(
      expect.objectContaining({ code: 'UNTRUSTED_PROVIDER_INJECTION' }),
    );
  });
  it('rejects unknown capabilities and invalid role combinations', () => {
    const unknown = { ...github, capabilities: ['issue.delete'] } as unknown as ProviderDescriptor;
    expect(() => new ProviderRegistry([unknown])).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_UNKNOWN' }),
    );
    const mismatch = {
      ...github,
      roles: ['repository'],
      capabilities: ['issue.list'],
    } as ProviderDescriptor;
    expect(() => new ProviderRegistry([mismatch])).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_INVALID' }),
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
