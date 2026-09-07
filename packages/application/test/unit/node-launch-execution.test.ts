import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchDescriptor } from '@mpx/launch';
import { createRuntimeCapabilityManifestV1, createRuntimeContextV1 } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  resolveManifest,
} from '@mpx/skills';
import { composeRuntimeStatusEnvelopeV1 } from '@mpx/status';
import { createPiRuntimeProfileV1 } from '@mpx/runtime-pi';
import {
  productionRuntimeAdapters,
  resolveClaudeCanonicalOutputStyle,
  type LaunchExecutionContext,
} from '../../src/node/index.js';

async function projectionContentFixture(
  root: string,
  runtime: 'claude' | 'pi',
  binding: { projectId: string; repositoryId: string; contentScope: string },
) {
  const contentRoot = path.join(root, 'content');
  const canonicalRoot = path.join(contentRoot, 'skills');
  const agentsRoot = fileURLToPath(new URL('../../../../content/agents/', import.meta.url));
  await mkdir(path.join(canonicalRoot, 'sample'), { recursive: true });
  await writeFile(
    path.join(canonicalRoot, 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Sample\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\nSample body.\n',
  );
  const catalog = await inventoryCanonical(canonicalRoot);
  const manifest = resolveManifest(catalog, {
    ...binding,
    enabledPacks: ['core'],
    identity: 'identity',
    skillPolicy: 'policy',
    skillPolicyConfig: { skillExposure: { default: 'full' } },
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime });
  const skillPlan = await createSkillProjectionPlan({ manifest, artifact, catalog, canonicalRoot });
  return {
    artifact,
    skillPlan,
    agentsRoot,
    runtimeProfilesFile: fileURLToPath(
      new URL('../../../../content/runtime-profiles.json', import.meta.url),
    ),
  };
}

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

  it('builds a production projection with the tracked Pi semantic model mapping', async () => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const canonicalRoot = await mkdtemp(path.join(tmpdir(), 'mpx-production-profile-skills-'));
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'mpx-production-profile-output-'));
    const skillDirectory = path.join(canonicalRoot, 'sample');
    await mkdir(skillDirectory);
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: sample\ndescription: Sample skill\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\n# Sample\n',
    );
    const catalog = await inventoryCanonical(canonicalRoot);
    const binding = { projectId: 'project', repositoryId: 'repository', contentScope: 'scope' };
    const manifest = resolveManifest(catalog, {
      ...binding,
      enabledPacks: ['core'],
      identity: 'identity',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillPacks: ['core'], skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const skillPlan = await createSkillProjectionPlan({
      manifest,
      artifact,
      catalog,
      canonicalRoot,
    });
    const launchKey = 'a'.repeat(64);
    const descriptorDigest = 'e'.repeat(64);
    const runtimeContext = createRuntimeContextV1({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: descriptorDigest },
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding,
    });
    const statusSnapshot = {
      schemaVersion: 1 as const,
      project: { id: 'project', cwd: canonicalRoot },
      worktree: { id: null, path: null, role: null, branch: null },
      portResolution: 'valid' as const,
      services: [],
      diagnostics: [],
    };
    const runtimeStatusEnvelope = composeRuntimeStatusEnvelopeV1({
      generatedAt: '2026-01-01T00:00:00.000Z',
      binding: { launchKey, runtimeId: 'pi', repositoryId: 'repository' },
      harness: { kind: 'pi', version: null, surface: 'footer' },
      contributions: [],
    });
    const runtimeCapabilityManifest = createRuntimeCapabilityManifestV1({
      runtime: 'pi',
      launchKey,
      identity: { name: 'identity', domain: 'personal', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding,
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
    const runtimeLaunchBinding = {
      launchKey,
      runtime: 'pi' as const,
      identity: { name: 'identity', domain: 'personal' },
      worktreeRoot: canonicalRoot,
      executor: 'host' as const,
      assignedPorts: [],
    };

    try {
      const descriptor = {
        runtime: 'pi',
        launchKey,
        identity: { name: 'identity', domain: 'personal' },
        mode: 'developer',
      } as LaunchDescriptor;
      const statusMaterialize = vi.fn(async () => undefined);
      const runtimeStatusMaterialize = vi.fn(async () => 'C:/state/runtime.json');
      const [adapter] = productionRuntimeAdapters({
        descriptor,
        cwd: canonicalRoot,
        environment: {},
        nativeRuntimeRoot: canonicalRoot,
        stateRoot: artifactsRoot,
        projectionInput: {
          descriptor,
          skillPlan,
          agentsRoot: path.join(repositoryRoot, 'content', 'agents'),
          runtimeProfilesFile: path.join(repositoryRoot, 'content', 'runtime-profiles.json'),
          artifactsRoot,
          runtimeContext,
          runtimeStatusEnvelope,
          runtimeCapabilityManifest,
          runtimeLaunchBinding,
          piRuntimeProfile: createPiRuntimeProfileV1(
            {
              schemaVersion: 1,
              runtime: 'pi',
              provider: 'openai-codex',
              defaultModel: 'openai-codex/gpt-5.6-sol',
              enabledModels: [
                'openai-codex/gpt-5.6-luna',
                'openai-codex/gpt-5.6-sol',
                'openai-codex/gpt-5.6-terra',
              ],
            },
            [],
          ),
        },
        launchBanner: 'launch',
        initialSnapshot: statusSnapshot,
        statusSnapshot: async () => statusSnapshot,
        bindStatusPath: () => undefined,
        bindRuntimeStatusPath: () => undefined,
        statusMaterializer: { materialize: statusMaterialize },
        runtimeStatusMaterializer: { materialize: runtimeStatusMaterialize },
        trustedExecutable: { executable: process.execPath, argvPrefix: [] },
      });
      const invocation = await adapter!.prepare({ routes: {} } as never);
      expect(statusMaterialize).not.toHaveBeenCalled();
      expect(runtimeStatusMaterialize).not.toHaveBeenCalled();
      expect(invocation.environment).not.toHaveProperty('MPX_PI_LAUNCH_PRIVATE_BRIDGE');
      expect(invocation.environment).not.toHaveProperty('MPX_STATUS_SNAPSHOT_FILE');
      expect(invocation.environment).not.toHaveProperty('MPX_RUNTIME_STATUS_ENVELOPE_FILE');
      expect(invocation.argv).not.toContain('--no-extensions');
      expect(invocation.argv).not.toContain('--extension');
      const projectionDirectory = invocation.environment.MPX_ACTIVE_CONTENT_ROOT!;
      expect(invocation.argv.filter((argument) => argument === '--no-skills')).toEqual([
        '--no-skills',
      ]);
      const skillIndexes = invocation.argv.flatMap((argument, index) =>
        argument === '--skill' ? [index] : [],
      );
      expect(skillIndexes.map((index) => invocation.argv[index + 1])).toEqual([]);
      expect(invocation.environment.MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY).toBeDefined();
      expect(invocation.environment).toMatchObject({
        MPX_IDENTITY: 'identity',
        MPX_MODE: 'developer',
      });
      await expect(
        readFile(path.join(projectionDirectory, 'skills', 'sample', 'SKILL.md'), 'utf8'),
      ).resolves.toBe("---\nname: sample\ndescription: 'Sample skill'\n---\n# Sample\n");
      await expect(
        readFile(path.join(projectionDirectory, 'agents', 'mpx-tdd-executor.md'), 'utf8'),
      ).resolves.toContain("model: 'openai-codex/gpt-5.6-sol'");
    } finally {
      await rm(canonicalRoot, { recursive: true, force: true });
      await rm(artifactsRoot, { recursive: true, force: true });
    }
  });
  it('appends Pi runtime arguments as separate argv values after MPX-owned arguments', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-pi-runtime-args-'));
    const launchKey = 'a'.repeat(64);
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: verified'];
    const binding = {
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      contentScope: 'work',
    };
    const content = await projectionContentFixture(stateRoot, 'pi', binding);
    const artifactReference = content.artifact.reference;
    const descriptor = {
      runtime: 'pi',
      launchKey,
      runtimeArgs,
      identity: { name: 'identity', domain: 'personal' },
      mode: 'developer',
    } as unknown as LaunchDescriptor;
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
          skillPlan: content.skillPlan,
          agentsRoot: content.agentsRoot,
          runtimeProfilesFile: content.runtimeProfilesFile,
          artifactsRoot: stateRoot,
          runtimeContext,
          runtimeStatusEnvelope: {} as never,
          runtimeCapabilityManifest: capability,
          piRuntimeProfile: {
            schemaVersion: 1,
            provider: 'openai-codex',
            model: 'gpt-5.6-sol',
            models: ['openai-codex/gpt-5.6-sol'],
            thinking: 'medium',
            theme: 'dark',
            tuiMode: 'fullscreen',
            terminalProgress: false,
            trust: 'ask',
            capabilityIds: [],
          },
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
    const binding = {
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      contentScope: 'work',
    };
    const content = await projectionContentFixture(stateRoot, 'claude', binding);
    const artifactReference = content.artifact.reference;
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
          skillPlan: content.skillPlan,
          agentsRoot: content.agentsRoot,
          runtimeProfilesFile: content.runtimeProfilesFile,
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
