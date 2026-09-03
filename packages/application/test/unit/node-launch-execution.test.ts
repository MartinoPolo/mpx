import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LaunchDescriptor } from '@mpx/launch';
import { createRuntimeCapabilityManifestV1, createRuntimeContextV1 } from '@mpx/runtime-contracts';
import {
  productionRuntimeAdapters,
  resolveClaudeCanonicalOutputStyle,
  type LaunchExecutionContext,
} from '../../src/node/index.js';

function publishedReference(
  input: Parameters<NonNullable<LaunchExecutionContext['launchProjectionBuilder']>>[0],
) {
  return {
    projectionKey: 'f'.repeat(64),
    fileMapHash: 'e'.repeat(64),
    launchBinding: {
      launchKey: input.runtimeContext.launchKey,
      descriptorDigest: input.runtimeContext.launchDescriptor.digest,
      runtimeArtifactKey: input.skillPlan.artifactReference.artifactKey,
      runtime: input.descriptor.runtime,
      manifestKey: input.skillPlan.manifestKey,
    },
  };
}

describe('Node launch execution runtime adapters', () => {
  it('derives the Claude canonical output style from the composed agents root', () => {
    expect(resolveClaudeCanonicalOutputStyle('C:/repo/content/agents')).toBe(
      path.join('C:/repo/content/agents', '..', 'output-styles', 'mpx-terse.md'),
    );
  });
  it('appends Pi runtime arguments as separate argv values after MPX-owned arguments', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-pi-runtime-args-'));
    const launchKey = 'a'.repeat(64);
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: verified'];
    const artifactReference = {
      schemaVersion: 4 as const,
      runtime: 'pi' as const,
      manifestKey: 'b'.repeat(64),
      artifactKey: 'c'.repeat(64),
      fileMapHash: 'd'.repeat(64),
    };
    const descriptor = { runtime: 'pi', launchKey, runtimeArgs } as unknown as LaunchDescriptor;
    const runtimeContext = createRuntimeContextV1({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: artifactReference.manifestKey,
      runtimeArtifact: artifactReference,
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        contentScope: 'work',
      },
    });
    const capability = createRuntimeCapabilityManifestV1({
      runtime: 'pi',
      launchKey,
      identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        contentScope: 'work',
      },
      executor: 'host',
      tools: [],
      routes: [],
      resources: [],
      mounts: [],
      destinations: [],
      skills: [],
      models: [],
      nesting: { depth: 0, maxDepth: 0 },
    });
    try {
      const [adapter] = productionRuntimeAdapters({
        descriptor,
        cwd: 'C:/project',
        environment: {},
        nativeRuntimeRoot: 'C:/native/pi',
        stateRoot,
        projectionInput: {
          descriptor,
          skillPlan: {
            runtime: 'pi',
            manifestKey: artifactReference.manifestKey,
            artifactReference,
            binding: {
              projectId: 'sample/app',
              repositoryId: 'sample/repo',
              contentScope: 'work',
            },
          } as never,
          agentsRoot: 'C:/agents',
          artifactsRoot: 'C:/artifacts',
          runtimeContext,
          runtimeStatusEnvelope: {} as never,
          runtimeCapabilityManifest: capability,
          runtimeLaunchBinding: {
            launchKey,
            runtime: 'pi',
            identity: { name: 'work', domain: 'work' },
            worktreeRoot: 'C:/project',
            executor: 'host',
            assignedPorts: [],
          },
        },
        launchBanner: 'launch',
        initialSnapshot: {
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: 'C:/project' },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'valid',
          services: [],
          diagnostics: [],
        },
        statusSnapshot: async () => ({}) as never,
        bindStatusPath: () => undefined,
        bindRuntimeStatusPath: () => undefined,
        statusMaterializer: { materialize: async () => undefined },
        runtimeStatusMaterializer: { materialize: async () => 'C:/state/runtime.json' },
        trustedExecutable: { executable: process.execPath, argvPrefix: ['wrapper-entry.js'] },
        builder: async (input) => ({
          directory: stateRoot,
          extension: path.join(stateRoot, 'extension.ts'),
          runtimeContextFile: path.join(stateRoot, 'runtime-context.json'),
          reference: publishedReference(input),
        }),
        validator: async () => undefined,
      });

      const invocation = await adapter!.prepare({ routes: {} } as never);

      expect(invocation.argv.slice(-runtimeArgs.length)).toEqual(runtimeArgs);
      expect(invocation.argv[0]).toBe('wrapper-entry.js');
      expect(invocation.argv.length).toBeGreaterThan(runtimeArgs.length + 1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('passes a Claude native resume target into the concrete invocation argv', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-claude-resume-'));
    const launchKey = 'a'.repeat(64);
    const artifactReference = {
      schemaVersion: 4 as const,
      runtime: 'claude' as const,
      manifestKey: 'b'.repeat(64),
      artifactKey: 'c'.repeat(64),
      fileMapHash: 'd'.repeat(64),
    };
    const runtimeContext = createRuntimeContextV1({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: artifactReference.manifestKey,
      runtimeArtifact: artifactReference,
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        contentScope: 'work',
      },
    });
    const capability = createRuntimeCapabilityManifestV1({
      runtime: 'claude',
      launchKey,
      identity: {
        name: 'work',
        domain: 'work',
        nativeRuntimeRootDigest: 'f'.repeat(64),
      },
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        contentScope: 'work',
      },
      executor: 'host',
      tools: [],
      routes: [],
      resources: [],
      mounts: [],
      destinations: [],
      skills: [],
      models: [],
      nesting: { depth: 0, maxDepth: 0 },
    });
    const descriptor = { runtime: 'claude', launchKey } as LaunchDescriptor;
    const launchBinding = {
      launchKey,
      runtime: 'claude' as const,
      identity: { name: 'work', domain: 'work' },
      worktreeRoot: 'C:/project',
      executor: 'host' as const,
      assignedPorts: [],
    };
    const resumeTarget = { kind: 'native-id' as const, value: 'session-1' };
    try {
      const [adapter] = productionRuntimeAdapters({
        descriptor,
        cwd: 'C:/project',
        environment: {},
        nativeRuntimeRoot: 'C:/native/claude',
        stateRoot,
        projectionInput: {
          descriptor,
          skillPlan: {
            runtime: 'claude',
            manifestKey: artifactReference.manifestKey,
            artifactReference,
            binding: {
              projectId: 'sample/app',
              repositoryId: 'sample/repo',
              contentScope: 'work',
            },
          } as never,
          agentsRoot: 'C:/agents',
          artifactsRoot: 'C:/artifacts',
          runtimeContext,
          runtimeStatusEnvelope: {} as never,
          runtimeCapabilityManifest: capability,
          runtimeLaunchBinding: launchBinding,
        },
        launchBanner: 'launch',
        initialSnapshot: {
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: 'C:/project' },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'valid',
          services: [],
          diagnostics: [],
        },
        statusSnapshot: async () => ({}) as never,
        bindStatusPath: () => undefined,
        bindRuntimeStatusPath: () => undefined,
        resumeTarget,
        statusMaterializer: { materialize: async () => undefined },
        runtimeStatusMaterializer: { materialize: async () => 'C:/state/runtime.json' },
        trustedExecutable: { executable: process.execPath, argvPrefix: [] },
        builder: async (input) => ({
          directory: stateRoot,
          pluginDirectory: stateRoot,
          reference: publishedReference(input),
        }),
        validator: async () => undefined,
      });
      const invocation = await adapter!.prepare({ routes: {} } as never);
      const resumeIndexes = invocation.argv.flatMap((value, index) =>
        value === '--resume' ? [index] : [],
      );
      expect(resumeIndexes).toEqual([expect.any(Number)]);
      expect(invocation.argv[resumeIndexes[0]! + 1]).toBe(resumeTarget.value);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
