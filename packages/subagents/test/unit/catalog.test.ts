import { describe, expect, it, vi } from 'vitest';
import { AgentCatalogError, parseAgentCatalog, resolveAgentCatalog } from '../../src/index.js';

const agent = {
  modelClass: 'standard',
  thinking: 'medium',
  capabilities: ['read', 'search'],
  nesting: [],
  outputSchema: 'text',
};
const catalog = (agents: Record<string, unknown> = { 'mpx-alpha': agent }) =>
  JSON.stringify({ schemaVersion: 1, agents });

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected catalog error');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentCatalogError);
    expect((error as AgentCatalogError).code).toBe(code);
  }
}

describe('agent catalog V1', () => {
  it('accepts exactly the semantic model classes and rejects legacy classes', () => {
    for (const modelClass of ['mechanical', 'exploration', 'standard', 'advanced', 'frontier']) {
      expect(parseAgentCatalog(catalog({ 'mpx-alpha': { ...agent, modelClass } }))).toMatchObject({
        agents: { 'mpx-alpha': { modelClass } },
      });
    }
    for (const modelClass of ['luna', 'terra', 'sol']) {
      expectCode(
        () => parseAgentCatalog(catalog({ 'mpx-alpha': { ...agent, modelClass } })),
        'AGENT_CATALOG_SCHEMA_INVALID',
      );
    }
  });

  it('retains the native SyntaxError cause for malformed JSON', () => {
    try {
      parseAgentCatalog('{');
      throw new Error('expected catalog error');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCatalogError);
      expect(error).toMatchObject({
        name: 'AgentCatalogError',
        code: 'AGENT_CATALOG_JSON_INVALID',
        message: 'agent catalog must be valid JSON',
        cause: expect.any(SyntaxError),
      });
      expect((error as AgentCatalogError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it.each([
    ['version', { schemaVersion: 2, agents: {} }],
    ['agents', { schemaVersion: 1, agents: [] }],
    ['identity', { schemaVersion: 1, agents: { Alpha: agent } }],
    ['model class', { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, modelClass: 'x' } } }],
    ['thinking', { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, thinking: 'max' } } }],
    [
      'capability collection',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, capabilities: 'read' } } },
    ],
    [
      'empty capabilities',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, capabilities: [] } } },
    ],
    [
      'capability value',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, capabilities: ['unknown'] } } },
    ],
    [
      'nesting collection',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, nesting: 'mpx-beta' } } },
    ],
    ['nesting value', { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, nesting: [1] } } }],
    [
      'output schema type',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, outputSchema: 1 } } },
    ],
    [
      'empty output schema',
      { schemaVersion: 1, agents: { 'mpx-alpha': { ...agent, outputSchema: '' } } },
    ],
  ])('rejects malformed %s fields with the stable schema code', (_name, value) => {
    expectCode(() => parseAgentCatalog(JSON.stringify(value)), 'AGENT_CATALOG_SCHEMA_INVALID');
  });

  it('reports immutable missing and unexpected identities for coverage failures', () => {
    const parsed = parseAgentCatalog(catalog({ 'mpx-alpha': agent, 'mpx-extra': agent }));
    try {
      resolveAgentCatalog(parsed, ['mpx-alpha', 'mpx-missing']);
      throw new Error('expected catalog error');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'AGENT_CATALOG_COVERAGE_INVALID',
        message: 'agent catalog must exactly cover canonical agents',
        missingIdentities: ['mpx-missing'],
        unexpectedIdentities: ['mpx-extra'],
      });
      const coverage = error as AgentCatalogError;
      expect(Object.isFrozen(coverage.missingIdentities)).toBe(true);
      expect(Object.isFrozen(coverage.unexpectedIdentities)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(coverage, 'missingIdentities')?.writable).toBe(false);
      expect(Object.getOwnPropertyDescriptor(coverage, 'unexpectedIdentities')?.writable).toBe(
        false,
      );
    }
  });

  it.each([
    ['identity length', `mpx-${'m'.repeat(124)}`, []],
    ['selector length', 'mpx-parent', ['x'.repeat(256)]],
    ['wildcard count', 'mpx-parent', [`mpx-${'*'.repeat(16)}`]],
  ])('accepts catalogs at the exact maximum %s', (_label, identity, nesting) => {
    expect(parseAgentCatalog(catalog({ [identity]: { ...agent, nesting } }))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it.each([
    ['identity length', `mpx-${'m'.repeat(125)}`, []],
    ['selector length', 'mpx-parent', ['x'.repeat(257)]],
    ['wildcard count', 'mpx-parent', [`mpx-${'*'.repeat(17)}`]],
  ])('rejects catalogs over the fixed %s safety limit', (_label, identity, nesting) => {
    expectCode(
      () => parseAgentCatalog(catalog({ [identity]: { ...agent, nesting } })),
      'AGENT_CATALOG_SCHEMA_INVALID',
    );
  });

  it('treats regex punctuation literally', () => {
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: ['mpx-reviewer.+*'] },
        'mpx-reviewer-a': agent,
      }),
    );
    expectCode(
      () => resolveAgentCatalog(parsed, ['mpx-parent', 'mpx-reviewer-a']),
      'AGENT_CATALOG_SELECTOR_UNRESOLVED',
    );
  });

  it('anchors wildcard selectors to the complete identity', () => {
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: ['reviewer-*'] },
        'mpx-reviewer-a': agent,
      }),
    );
    expectCode(
      () => resolveAgentCatalog(parsed, ['mpx-parent', 'mpx-reviewer-a']),
      'AGENT_CATALOG_SELECTOR_UNRESOLVED',
    );
  });

  it('matches repeated wildcards observably', () => {
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: ['mpx-**reviewer***-a'] },
        'mpx-reviewer-a': agent,
      }),
    );

    expect(
      resolveAgentCatalog(parsed, ['mpx-parent', 'mpx-reviewer-a']).agents['mpx-parent'],
    ).toMatchObject({ nesting: ['mpx-reviewer-a'] });
  });

  it('bounds adversarial wildcard nonmatches', () => {
    const selector = `${'*a'.repeat(16)}b`;
    const candidate = `mpx-${'a'.repeat(124)}`;
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: [selector] },
        [candidate]: agent,
      }),
    );
    expectCode(
      () => resolveAgentCatalog(parsed, ['mpx-parent', candidate]),
      'AGENT_CATALOG_SELECTOR_UNRESOLVED',
    );
  });

  it.each(['mpx-missing', 'mpx-missing*'])(
    'fails an unresolved literal or wildcard selector',
    (selector) => {
      const parsed = parseAgentCatalog(catalog({ 'mpx-alpha': { ...agent, nesting: [selector] } }));
      expectCode(
        () => resolveAgentCatalog(parsed, ['mpx-alpha']),
        'AGENT_CATALOG_SELECTOR_UNRESOLVED',
      );
    },
  );

  it('uses bytewise default sort without locale comparison', () => {
    const identities = ['mpx-zed', 'mpx-reviewer-b', 'mpx-parent', 'mpx-reviewer-a'];
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: ['mpx-reviewer-*'] },
        'mpx-reviewer-b': agent,
        'mpx-reviewer-a': agent,
        'mpx-zed': agent,
      }),
    );
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare is forbidden');
    });
    try {
      const resolved = resolveAgentCatalog(parsed, identities);
      expect(resolved.identities).toEqual([...identities].sort());
      expect(resolved.agents['mpx-parent']?.nesting).toEqual(['mpx-reviewer-a', 'mpx-reviewer-b']);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('uses selector order, sorted wildcard matches, and first-occurrence dedupe', () => {
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': {
          ...agent,
          nesting: ['mpx-zed', 'mpx-reviewer-*', 'mpx-reviewer-b'],
        },
        'mpx-reviewer-b': agent,
        'mpx-reviewer-a': agent,
        'mpx-zed': agent,
      }),
    );
    const resolved = resolveAgentCatalog(parsed, [
      'mpx-zed',
      'mpx-reviewer-b',
      'mpx-parent',
      'mpx-reviewer-a',
    ]);
    expect(resolved.identities).toEqual([
      'mpx-parent',
      'mpx-reviewer-a',
      'mpx-reviewer-b',
      'mpx-zed',
    ]);
    expect(resolved.agents['mpx-parent']?.nesting).toEqual([
      'mpx-zed',
      'mpx-reviewer-a',
      'mpx-reviewer-b',
    ]);
  });

  it('does not mutate parsed catalogs or caller identity arrays', () => {
    const parsed = parseAgentCatalog(
      catalog({
        'mpx-parent': { ...agent, nesting: ['mpx-child*'] },
        'mpx-child': agent,
      }),
    );
    const before = JSON.stringify(parsed);
    const identities = ['mpx-parent', 'mpx-child'];
    resolveAgentCatalog(parsed, identities);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(identities).toEqual(['mpx-parent', 'mpx-child']);
  });
});
