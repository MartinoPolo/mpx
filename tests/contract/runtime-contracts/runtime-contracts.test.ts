import { afterEach, describe, expect, it, vi } from 'vitest';

const fsCalls = vi.hoisted(() => ({ watchedRoot: '', sourceReads: 0, sourceListings: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: actual.readFile,
    open: async (file: any, ...args: any[]) => {
      if (fsCalls.watchedRoot && path.dirname(String(file)) === fsCalls.watchedRoot) {
        fsCalls.sourceReads += 1;
      }
      return (actual.open as any)(file, ...args);
    },
    opendir: async (directory: any, ...args: any[]) => {
      if (fsCalls.watchedRoot && String(directory) === fsCalls.watchedRoot) {
        fsCalls.sourceListings += 1;
      }
      return (actual.opendir as any)(directory, ...args);
    },
  };
});
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RuntimeContractError,
  createResolvedSkillManifest,
  parseResolvedSkillManifest,
  createRuntimeContext,
  createRuntimeSkillArtifactReference,
  parseRuntimeContext,
  publishRuntimeArtifact,
  revalidateRuntimeArtifact,
  validateRuntimeContext,
  createSessionLifecycleBinding,
  parseSessionLifecycleBinding,
  createSessionLifecycleEvent,
  parseSessionLifecycleEvent,
  createRuntimeSessionObservation,
  parseRuntimeSessionObservation,
  validateSessionLifecycleBinding,
} from '@mpx/runtime-contracts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

const decisions = [
  {
    identity: 'review',
    included: true,
    exclusionReasons: [],
    exposure: 'name-only' as const,
    permissions: { humanInvocation: true, modelInvocation: true },
    metadataHash: 'meta',
    sourceHash: 'source',
  },
];
const binding = {
  projectId: 'project-1',
  repositoryId: 'repo-1',
  identity: 'work',
  selection: {
    location: { name: 'work', canonicalRoot: 'C:/work' },
    packs: ['development'] as const,
    source: 'project' as const,
  },
};
const launchBinding = (launchKey = 'launch') => ({
  launchKey,
  descriptorDigest: 'descriptor',
  runtimeArtifactKey: 'skills',
  runtime: 'pi' as const,
  manifestKey: 'manifest',
});

describe('private lifecycle v1 contracts', () => {
  const lifecycleBinding = createSessionLifecycleBinding({
    bindingId: 'binding-1',
    bindingRef: 'binding-ref-1',
    runtime: 'pi',
    identityRef: 'identity-1',
    launchKey: 'launch',
    launchDescriptorDigest: 'digest',
    artifactKey: 'artifact',
    manifestKey: 'manifest',
    projectRef: 'project-1',
    repositoryRef: 'repository-1',
    worktreeRef: 'worktree-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    expiresAt: '2025-01-02T00:00:00.000Z',
  });

  it('strictly parses private lifecycle bindings and rejects unknown or malformed data', () => {
    expect(parseSessionLifecycleBinding(lifecycleBinding)).toEqual(lifecycleBinding);
    expect(() => parseSessionLifecycleBinding({ ...lifecycleBinding, extra: true })).toThrowError(
      /UNKNOWN_FIELD/u,
    );
    expect(() =>
      parseSessionLifecycleBinding({ ...lifecycleBinding, schemaVersion: 2 }),
    ).toThrowError(/UNKNOWN_SCHEMA_VERSION/u);
    expect(() =>
      createSessionLifecycleBinding({ ...lifecycleBinding, identityRef: 'bad\nidentity' }),
    ).toThrowError(/INVALID_CONTRACT/u);
  });

  it('keeps lifecycle events prompt-blind and validates safe native references', () => {
    const event = createSessionLifecycleEvent({
      eventId: 'event-1',
      bindingId: lifecycleBinding.bindingId,
      type: 'start',
      sequence: 1,
      timestamp: '2025-01-01T00:00:01.000Z',
      nativeSessionId: 'native-1',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/native-1.jsonl' },
      cwd: 'C:/repo',
      title: 'Safe title',
      model: 'model',
      effort: null,
      pid: 12,
      startFingerprint: 'pid-12-start',
    });
    expect(parseSessionLifecycleEvent(event)).toEqual(event);
    expect(JSON.stringify(event)).not.toMatch(/prompt|message|transcript/iu);
    expect(() => parseSessionLifecycleEvent({ ...event, prompt: 'secret' })).toThrowError(
      /UNKNOWN_FIELD/u,
    );
    expect(() =>
      createSessionLifecycleEvent({
        ...event,
        nativeSessionRef: { kind: 'root-relative-file', value: '../secret' },
      }),
    ).toThrowError(/INVALID_CONTRACT/u);
  });

  it('rejects expired or launch-mismatched lifecycle bindings', () => {
    const context = createRuntimeContext({
      launchKey: 'launch',
      launchDescriptor: { reference: 'launch.json', digest: 'digest' },
      manifestKey: 'manifest',
      runtimeArtifact: {
        schemaVersion: 5,
        runtime: 'pi',
        manifestKey: 'manifest',
        artifactKey: 'artifact',
        fileMapHash: 'map',
      },
      binding,
    });
    expect(
      validateSessionLifecycleBinding({
        binding: lifecycleBinding,
        context,
        runtime: 'pi',
        now: '2025-01-01T12:00:00.000Z',
      }),
    ).toEqual(lifecycleBinding);
    expect(() =>
      validateSessionLifecycleBinding({
        binding: lifecycleBinding,
        context,
        runtime: 'pi',
        now: '2025-01-02T00:00:00.000Z',
      }),
    ).toThrowError(/LIFECYCLE_BINDING_EXPIRED/u);
    expect(() =>
      validateSessionLifecycleBinding({
        binding: { ...lifecycleBinding, artifactKey: 'wrong' },
        context,
        runtime: 'pi',
        now: '2025-01-01T12:00:00.000Z',
      }),
    ).toThrowError(/BINDING_MISMATCH/u);
  });

  it('strictly parses bounded runtime observations without native content', () => {
    const observation = createRuntimeSessionObservation({
      runtime: 'claude',
      identityRef: 'identity-1',
      runtimeQualifiedId: 'claude:native-1',
      displayId: 'native-1',
      title: null,
      resumeState: 'resumable',
      lifecycleState: 'active',
      workflowStatus: 'unfinished',
      inbox: true,
      dispositionAt: null,
      capturedAt: '2025-01-01T00:00:02.000Z',
      freshUntil: '2025-01-01T00:01:02.000Z',
      source: 'lifecycle-event',
      diagnostic: null,
    });
    expect(parseRuntimeSessionObservation(observation)).toEqual(observation);
    expect(() =>
      parseRuntimeSessionObservation({ ...observation, title: 'x'.repeat(513) }),
    ).toThrowError(/INVALID_CONTRACT/u);
    expect(() => parseRuntimeSessionObservation({ ...observation, messages: [] })).toThrowError(
      /UNKNOWN_FIELD/u,
    );
  });
});

describe('runtime-neutral v5 contracts', () => {
  it('shares one body-free, path-free manifest key across runtime projections', () => {
    const manifest = createResolvedSkillManifest({ binding, decisions });
    const claude = createRuntimeSkillArtifactReference({
      runtime: 'claude',
      manifestKey: manifest.manifestKey,
      artifactKey: 'a',
      fileMapHash: 'f',
    });
    const pi = createRuntimeSkillArtifactReference({
      runtime: 'pi',
      manifestKey: manifest.manifestKey,
      artifactKey: 'b',
      fileMapHash: 'g',
    });
    expect(manifest.schemaVersion).toBe(5);
    expect(claude.schemaVersion).toBe(5);
    expect(pi.manifestKey).toBe(claude.manifestKey);
    expect(JSON.stringify(manifest)).not.toMatch(/body|[A-Z]:\\|realPath|absolutePath/u);
    expect(manifest.decisions[0]).toMatchObject({
      included: true,
      exclusionReasons: [],
      exposure: 'name-only',
      permissions: { humanInvocation: true, modelInvocation: true },
      metadataHash: 'meta',
      sourceHash: 'source',
    });
    expect(parseResolvedSkillManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() => parseResolvedSkillManifest({ ...manifest, schemaVersion: 3 })).toThrowError(
      /UNKNOWN_SCHEMA_VERSION/u,
    );
  });

  it('binds runtime context and fails closed on unknown versions and fields', () => {
    const manifest = createResolvedSkillManifest({ binding, decisions });
    const artifact = createRuntimeSkillArtifactReference({
      runtime: 'pi',
      manifestKey: manifest.manifestKey,
      artifactKey: 'artifact',
      fileMapHash: 'map',
    });
    const context = createRuntimeContext({
      launchKey: 'launch',
      launchDescriptor: { reference: 'launch.json', digest: 'digest' },
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact,
      binding,
    });
    expect(parseRuntimeContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
    expect(() => parseRuntimeContext({ ...context, schemaVersion: 1 })).toThrowError(
      RuntimeContractError,
    );
    expect(() => parseRuntimeContext({ ...context, schemaVersion: 3 })).toThrowError(
      RuntimeContractError,
    );
    expect(() => parseRuntimeContext({ ...context, surprise: true })).toThrowError(
      /UNKNOWN_FIELD/u,
    );
    expect(() => createRuntimeContext({ ...context, manifestKey: 'different' })).toThrowError(
      /BINDING_MISMATCH/u,
    );
  });
});

describe('immutable runtime artifact publication', () => {
  it('publishes a deterministic sorted file map atomically and exactly reuses it', async () => {
    const source = await root('mpx-publish-source-');
    const artifactsRoot = await root('mpx-publish-dest-');
    await mkdir(path.join(source, 'nested'));
    await writeFile(path.join(source, 'z.txt'), 'z');
    await writeFile(path.join(source, 'nested', 'a.txt'), 'a');
    const first = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    const second = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    expect(second).toEqual({ ...first, reused: true });
    expect(first.fileMap.map((entry) => entry.path)).toEqual(['nested/a.txt', 'z.txt']);
    expect(await readdirNames(artifactsRoot)).toEqual([first.reference.projectionKey]);
    await expect(
      revalidateRuntimeArtifact(first.directory, first.reference),
    ).resolves.toMatchObject({ valid: true });
  });

  it('rejects source symlinks and partial, symlinked, or mismatched destinations', async () => {
    const outside = await root('mpx-publish-outside-');
    await writeFile(path.join(outside, 'secret'), 'secret');
    const source = await root('mpx-publish-source-');
    const artifactsRoot = await root('mpx-publish-dest-');
    await symlink(path.join(outside, 'secret'), path.join(source, 'escape'), 'file');
    await expect(
      publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() }),
    ).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });

    await rm(path.join(source, 'escape'));
    await writeFile(path.join(source, 'ok'), 'ok');
    const published = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    await writeFile(path.join(published.directory, 'ok'), 'altered');
    await expect(
      publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_MISMATCH' });
    await expect(
      revalidateRuntimeArtifact(published.directory, published.reference),
    ).resolves.toMatchObject({ valid: false });
  });

  it('binds projection identity to the full launch while keeping paths private', async () => {
    const source = await root('mpx-launch-source-');
    const artifactsRoot = await root('mpx-launch-dest-');
    await writeFile(path.join(source, 'same'), 'bytes');
    const first = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding('launch-a'),
    });
    const second = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding('launch-b'),
    });
    expect(first.reference.launchBinding).toEqual(launchBinding('launch-a'));
    expect(first.reference.projectionKey).not.toBe(second.reference.projectionKey);
    expect(first.directory).not.toBe(second.directory);
    expect(JSON.stringify(first.reference)).not.toContain(source);
  });

  it('rejects reuse when stored launch metadata does not match', async () => {
    const source = await root('mpx-reuse-source-');
    const artifactsRoot = await root('mpx-reuse-dest-');
    await writeFile(path.join(source, 'file'), 'value');
    const published = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    const metadataPath = path.join(published.directory, '.mpx-runtime-artifact.json');
    const stored = JSON.parse(await readFile(metadataPath, 'utf8'));
    stored.reference.launchBinding.launchKey = 'wrong';
    await writeFile(metadataPath, JSON.stringify(stored));
    await expect(
      publishRuntimeArtifact({ sourceRoot: source, artifactsRoot, launchBinding: launchBinding() }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_MISMATCH' });
  });

  it.each([
    ['MAX_FILE_COUNT', { maxFileCount: 1, maxFileBytes: 10, maxAggregateBytes: 10 }],
    ['MAX_FILE_BYTES', { maxFileCount: 2, maxFileBytes: 0, maxAggregateBytes: 10 }],
    ['MAX_AGGREGATE_BYTES', { maxFileCount: 2, maxFileBytes: 10, maxAggregateBytes: 1 }],
  ])(
    'enforces %s from lstat inventory before reading file contents',
    async (code, inventoryLimits) => {
      const source = await root('mpx-limits-source-');
      const artifactsRoot = await root('mpx-limits-dest-');
      await writeFile(path.join(source, 'a'), 'a');
      await writeFile(path.join(source, 'b'), 'b');
      fsCalls.watchedRoot = source;
      fsCalls.sourceReads = 0;
      await expect(
        publishRuntimeArtifact({
          sourceRoot: source,
          artifactsRoot,
          launchBinding: launchBinding(),
          inventoryLimits,
        }),
      ).rejects.toMatchObject({ code });
      expect(fsCalls.sourceReads).toBe(0);
      fsCalls.watchedRoot = '';
    },
  );

  it('creates one source inventory and reuses its bytes for hashing and copying', async () => {
    const source = await root('mpx-inventory-source-');
    const artifactsRoot = await root('mpx-inventory-dest-');
    await writeFile(path.join(source, 'file'), 'value');
    fsCalls.watchedRoot = source;
    fsCalls.sourceReads = 0;
    fsCalls.sourceListings = 0;
    await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    expect({ reads: fsCalls.sourceReads, listings: fsCalls.sourceListings }).toEqual({
      reads: 1,
      listings: 1,
    });
    fsCalls.watchedRoot = '';
  });

  it.each([
    ['MAX_DIRECTORY_COUNT', { maxDirectoryCount: 1, maxDepth: 4 }, ['a', 'b']],
    ['MAX_DEPTH', { maxDirectoryCount: 4, maxDepth: 1 }, ['a', 'a/b']],
  ])(
    'enforces %s before descending through wide or deep trees',
    async (code, bounds, directories) => {
      const source = await root('mpx-tree-limits-source-');
      const artifactsRoot = await root('mpx-tree-limits-dest-');
      for (const directory of directories) {
        await mkdir(path.join(source, directory), { recursive: true });
      }
      await expect(
        publishRuntimeArtifact({
          sourceRoot: source,
          artifactsRoot,
          launchBinding: launchBinding(),
          inventoryLimits: { maxFileCount: 1, maxFileBytes: 1, maxAggregateBytes: 1, ...bounds },
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it('rejects oversized metadata before parsing or scanning artifact files', async () => {
    const source = await root('mpx-metadata-large-source-');
    const artifactsRoot = await root('mpx-metadata-large-dest-');
    await writeFile(path.join(source, 'file'), 'value');
    const published = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    await writeFile(
      path.join(published.directory, '.mpx-runtime-artifact.json'),
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
    );
    fsCalls.watchedRoot = published.directory;
    fsCalls.sourceListings = 0;
    await expect(
      revalidateRuntimeArtifact(published.directory, published.reference),
    ).resolves.toMatchObject({ valid: false });
    expect(fsCalls.sourceListings).toBe(0);
    fsCalls.watchedRoot = '';
  });

  it.each([
    (stored: any) => {
      stored.extra = true;
    },
    (stored: any) => {
      stored.reference.extra = true;
    },
    (stored: any) => {
      stored.fileMap[0].extra = true;
    },
    (stored: any) => {
      stored.fileMap.push({ ...stored.fileMap[0] });
    },
    (stored: any) => {
      stored.fileMap[0].path = '../escape';
    },
    (stored: any) => {
      stored.fileMap[0].sha256 = 'not-a-hash';
    },
    (stored: any) => {
      stored.fileMap[0].bytes = -1;
    },
  ])('strictly rejects malformed, duplicate, or unsafe metadata', async (mutate) => {
    const source = await root('mpx-metadata-invalid-source-');
    const artifactsRoot = await root('mpx-metadata-invalid-dest-');
    await writeFile(path.join(source, 'file'), 'value');
    const published = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    const metadataPath = path.join(published.directory, '.mpx-runtime-artifact.json');
    const stored = JSON.parse(await readFile(metadataPath, 'utf8'));
    mutate(stored);
    await writeFile(metadataPath, JSON.stringify(stored));
    fsCalls.watchedRoot = published.directory;
    fsCalls.sourceListings = 0;
    await expect(
      revalidateRuntimeArtifact(published.directory, published.reference),
    ).resolves.toMatchObject({ valid: false });
    expect(fsCalls.sourceListings).toBe(0);
    fsCalls.watchedRoot = '';
  });
});

describe('runtime context validation', () => {
  it('detects altered launch, artifact, and file-map bindings', async () => {
    const source = await root('mpx-validation-source-');
    const artifactsRoot = await root('mpx-validation-dest-');
    await writeFile(path.join(source, 'file'), 'value');
    const published = await publishRuntimeArtifact({
      sourceRoot: source,
      artifactsRoot,
      launchBinding: launchBinding(),
    });
    const runtimeArtifact = createRuntimeSkillArtifactReference({
      runtime: 'pi',
      manifestKey: 'manifest',
      artifactKey: 'skills',
      fileMapHash: 'skill-map',
    });
    const context = createRuntimeContext({
      launchKey: 'launch',
      launchDescriptor: { reference: 'launch.json', digest: 'expected' },
      manifestKey: 'manifest',
      runtimeArtifact,
      binding,
    });
    await writeFile(path.join(published.directory, 'file'), 'changed');
    const result = await validateRuntimeContext({
      context,
      expectedLaunch: { launchKey: 'other', descriptorDigest: 'changed' },
      expectedManifestKey: 'other-manifest',
      currentBinding: binding,
      artifactDirectory: published.directory,
      expectedPublishedArtifact: published.reference,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'LAUNCH_BINDING_CHANGED',
        'MANIFEST_BINDING_CHANGED',
        'ARTIFACT_FILE_MAP_CHANGED',
      ]),
    );
  });

  it('emits restart-required diagnostics when project or skill selection changes', async () => {
    const manifest = createResolvedSkillManifest({ binding, decisions });
    const artifact = createRuntimeSkillArtifactReference({
      runtime: 'claude',
      manifestKey: manifest.manifestKey,
      artifactKey: 'a',
      fileMapHash: 'f',
    });
    const context = createRuntimeContext({
      launchKey: 'launch',
      launchDescriptor: { reference: 'launch.json', digest: 'digest' },
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact,
      binding,
    });
    const result = await validateRuntimeContext({
      context,
      expectedLaunch: { launchKey: 'launch', descriptorDigest: 'digest' },
      expectedManifestKey: manifest.manifestKey,
      currentBinding: {
        ...binding,
        projectId: 'project-2',
        selection: {
          location: { name: 'personal', canonicalRoot: 'C:/personal' },
          packs: ['personal'],
          source: 'project',
        },
      },
    });
    expect(
      result.diagnostics.filter((item) => item.restartRequired).map((item) => item.code),
    ).toEqual(['PROJECT_CHANGED', 'SKILL_SELECTION_CHANGED']);
  });
});

async function readdirNames(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(directory)).sort();
}
