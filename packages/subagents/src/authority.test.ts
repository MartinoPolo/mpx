import { describe, expect, it } from 'vitest';
import { createRuntimeCapabilityManifestV1 } from '@mpx/runtime-contracts';
import { bindChildLaunchAuthority } from './authority.js';

const sha = 'a'.repeat(64);
function parent() {
  return createRuntimeCapabilityManifestV1({
    runtime: 'pi',
    launchKey: sha,
    identity: { name: 'personal', domain: 'personal', nativeRuntimeRootDigest: sha },
    binding: { projectId: 'o/r', repositoryId: 'o/r', contentScope: 'personal' },
    executor: 'docker',
    tools: [],
    routes: ['route'],
    resources: ['repo'],
    mounts: ['repo'],
    destinations: [],
    skills: ['test'],
    models: ['model-a'],
    nesting: { depth: 0, maxDepth: 2 },
  });
}
function child(overrides = {}) {
  const p = parent();
  return {
    schemaVersion: 1 as const,
    parentManifestKey: p.manifestKey,
    parentLaunchKey: p.launchKey,
    runtime: p.runtime,
    identity: p.identity,
    binding: p.binding,
    executor: p.executor,
    tools: [],
    routes: [],
    resources: ['repo'],
    mounts: ['repo'],
    destinations: [],
    skills: ['test'],
    models: ['model-a'],
    nesting: { depth: 1, maxDepth: 2 },
    ...overrides,
  };
}

describe('child authority', () => {
  it('denies every child authority widening', () => {
    expect(() =>
      bindChildLaunchAuthority(parent(), child({ resources: ['repo', 'secret'] })),
    ).toThrow(/CHILD_AUTHORITY_WIDENING/);
  });
  it('rejects the opposite identity', () => {
    expect(() =>
      bindChildLaunchAuthority(
        parent(),
        child({ identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: sha } }),
      ),
    ).toThrow(/CHILD_BINDING_MISMATCH/);
  });
  it('enforces bounded nesting metadata', () => {
    expect(() =>
      bindChildLaunchAuthority(parent(), child({ nesting: { depth: 3, maxDepth: 3 } })),
    ).toThrow(/CHILD_AUTHORITY_WIDENING/);
  });
});
