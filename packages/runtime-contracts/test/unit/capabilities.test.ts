import { expect, it } from 'vitest';
import {
  createRuntimeCapabilityManifest,
  deriveChildAuthority,
  parseRuntimeCapabilityManifest,
  validateRuntimeCapabilityBinding,
} from '../../src/index.js';

const digest = (character: string): string => character.repeat(64);

function manifestInput() {
  return {
    runtime: 'pi' as const,
    launchKey: digest('a'),
    identity: {
      name: 'personal',
      domain: 'personal',
      nativeRuntimeRootDigest: digest('b'),
    },
    binding: {
      projectId: 'sample/app',
      repositoryId: 'sample/app',
      selection: {
        location: { name: 'coding', canonicalRoot: 'C:/projects' },
        packs: ['development'] as const,
        source: 'project' as const,
      },
    },
    executor: 'host' as const,
    tools: [],
    routes: [],
    resources: [],
    mounts: [],
    destinations: [],
    skills: ['execute'],
    models: ['default'],
    nesting: { depth: 0, maxDepth: 2 },
  };
}

it('rejects capability manifest schema 1 after the incompatible selection migration', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());

  expect(() => parseRuntimeCapabilityManifest({ ...manifest, schemaVersion: 1 })).toThrow(
    /UNKNOWN_SCHEMA_VERSION/u,
  );
});

it('creates and parses capability manifest schema 2 with its full resolved selection', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());

  expect(parseRuntimeCapabilityManifest(manifest)).toEqual(
    expect.objectContaining({ schemaVersion: 2, binding: manifestInput().binding }),
  );
});

function expectedBinding(manifest: ReturnType<typeof createRuntimeCapabilityManifest>) {
  return {
    manifestKey: manifest.manifestKey,
    launchKey: manifest.launchKey,
    runtime: manifest.runtime,
    identity: manifest.identity,
    binding: manifest.binding,
    executor: manifest.executor,
  };
}

it('rejects a capability binding for a changed selected location despite the same identity', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());
  const expected = expectedBinding(manifest);

  expect(() =>
    validateRuntimeCapabilityBinding(manifest, {
      ...expected,
      binding: {
        ...expected.binding,
        selection: {
          ...expected.binding.selection,
          location: { name: 'notes', canonicalRoot: 'C:/notes' },
        },
      },
    }),
  ).toThrow(/CAPABILITY_STALE/u);
});

it('rejects a capability binding for changed selected packs despite the same identity', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());
  const expected = expectedBinding(manifest);

  expect(() =>
    validateRuntimeCapabilityBinding(manifest, {
      ...expected,
      binding: {
        ...expected.binding,
        selection: { ...expected.binding.selection, packs: ['personal'] },
      },
    }),
  ).toThrow(/CAPABILITY_STALE/u);
});

it('rejects a capability binding for changed selection provenance despite the same identity', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());
  const expected = expectedBinding(manifest);

  expect(() =>
    validateRuntimeCapabilityBinding(manifest, {
      ...expected,
      binding: {
        ...expected.binding,
        selection: { ...expected.binding.selection, source: 'user-project' },
      },
    }),
  ).toThrow(/CAPABILITY_STALE/u);
});

it('rejects obsolete contentScope even when an otherwise valid selection is present', () => {
  const input = manifestInput();

  expect(() =>
    createRuntimeCapabilityManifest({
      ...input,
      binding: { ...input.binding, contentScope: 'legacy' } as never,
    }),
  ).toThrow(/unknown field 'contentScope'/u);
});

it('rejects foreign properties inside a resolved selection', () => {
  const input = manifestInput();

  expect(() =>
    createRuntimeCapabilityManifest({
      ...input,
      binding: {
        ...input.binding,
        selection: { ...input.binding.selection, policy: 'developer' },
      } as never,
    }),
  ).toThrow(/unknown field 'policy'/u);
});

it('rejects removed skill packs in a capability selection', () => {
  const input = manifestInput();

  expect(() =>
    createRuntimeCapabilityManifest({
      ...input,
      binding: {
        ...input.binding,
        selection: { ...input.binding.selection, packs: ['core'] },
      } as never,
    }),
  ).toThrow(/supported skill packs/u);
});

it('rejects a relative selected root before validating the capability key', () => {
  const manifest = createRuntimeCapabilityManifest(manifestInput());
  const { manifestKey: _manifestKey, ...tuple } = manifest;
  const malformed = {
    ...tuple,
    binding: {
      ...tuple.binding,
      selection: {
        ...tuple.binding.selection,
        location: { ...tuple.binding.selection.location, canonicalRoot: 'skills/canonical' },
      },
    },
  };

  expect(() =>
    parseRuntimeCapabilityManifest({ ...malformed, manifestKey: 'malformed-fixture-key' }),
  ).toThrow(/selection\.location\.canonicalRoot is invalid/u);
});

function authorizedManifest() {
  return createRuntimeCapabilityManifest({
    ...manifestInput(),
    tools: [
      {
        schemaVersion: 1,
        name: 'issues',
        executors: ['host'],
        routes: ['work'],
        network: { mode: 'allow-list', destinations: ['tracker'] },
        paidCredits: { allowed: true, maxCredits: 2 },
        input: { maxBytes: 128 },
        output: { maxBytes: 128 },
        timeout: { maxMs: 1_000 },
        cache: { mode: 'read-only', maxBytes: 128 },
      },
    ],
    routes: ['work'],
    resources: ['private-root'],
    mounts: ['workspace'],
    destinations: ['tracker'],
  });
}

function childRequest(manifest: ReturnType<typeof authorizedManifest>) {
  return {
    schemaVersion: 1 as const,
    parentManifestKey: manifest.manifestKey,
    parentLaunchKey: manifest.launchKey,
    runtime: manifest.runtime,
    identity: manifest.identity,
    binding: manifest.binding,
    executor: manifest.executor,
    tools: ['issues'],
    routes: ['work'],
    resources: ['private-root'],
    mounts: ['workspace'],
    destinations: ['tracker'],
    skills: ['execute'],
    models: ['default'],
    nesting: { depth: 1, maxDepth: 2 },
  };
}

it('rejects child authority when the selected packs differ from its parent', () => {
  const manifest = authorizedManifest();
  const request = childRequest(manifest);

  expect(() =>
    deriveChildAuthority(manifest, {
      ...request,
      binding: {
        ...request.binding,
        selection: { ...request.binding.selection, packs: ['personal'] },
      },
    }),
  ).toThrow(/CHILD_BINDING_MISMATCH/u);
});
