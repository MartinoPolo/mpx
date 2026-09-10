import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  createRuntimeCapabilityManifest,
  createRuntimeContext,
  type RuntimeBinding,
} from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  inventoryProjectSkills,
  resolveManifest,
} from '@mpx/skills';
import { composeRuntimeStatusEnvelope } from '@mpx/status';
import { createPiRuntimeProfile } from '@mpx/runtime-pi';
import {
  productionRuntimeAdapters,
  resolveClaudeCanonicalOutputStyle,
  type LaunchExecutionContext,
} from '../../src/node/index.js';

const selection = {
  location: { name: 'work', canonicalRoot: 'C:/work' },
  packs: ['development'] as const,
  source: 'project' as const,
};
const capabilityBinding = (binding: RuntimeBinding) => ({
  projectId: binding.projectId,
  repositoryId: binding.repositoryId,
  selection: binding.selection,
});

async function projectionContentFixture(
  root: string,
  runtime: 'claude' | 'pi',
  binding: RuntimeBinding,
  projectSkill = false,
) {
  const contentRoot = path.join(root, 'content');
  const canonicalRoot = path.join(contentRoot, 'skills');
  const agentsRoot = fileURLToPath(new URL('../../../../content/agents/', import.meta.url));
  const skillRoot = projectSkill
    ? path.join(root, '.agents', 'skills', 'sample')
    : path.join(canonicalRoot, 'sample');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    projectSkill
      ? '---\nname: sample\ndescription: Sample\nmetadata:\n  mpx:\n    projectExposure: full\n---\nSample body.\n'
      : '---\nname: sample\ndescription: Sample\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [development]\n    defaultExposure: full\n---\nSample body.\n',
  );
  const catalog = projectSkill
    ? (await inventoryProjectSkills(root)).skills
    : await inventoryCanonical(canonicalRoot);
  const manifest = resolveManifest(catalog, {
    repositoryId: binding.repositoryId,
    ...(binding.projectId ? { projectId: binding.projectId } : {}),
    identity: binding.identity,
    selection: binding.selection,
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

  it.each(['claude', 'pi'] as const)(
    'binds the %s invocation executor from the production descriptor',
    async (runtime) => {
      const stateRoot = await mkdtemp(path.join(tmpdir(), `mpx-${runtime}-executor-`));
      const launchKey = 'a'.repeat(64);
      const binding = {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        identity: 'work',
        selection,
      };
      const content = await projectionContentFixture(stateRoot, runtime, binding);
      const descriptor = {
        runtime,
        launchKey,
        identity: { name: 'work', domain: 'work' },
        mode: 'developer',
        executor: { name: 'docker' },
      } as unknown as LaunchDescriptor;
      const runtimeContext = createRuntimeContext({
        launchKey,
        launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
        manifestKey: content.artifact.reference.manifestKey,
        runtimeArtifact: content.artifact.reference,
        binding,
      });
      const capability = createRuntimeCapabilityManifest({
        runtime,
        launchKey,
        identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: 'f'.repeat(64) },
        binding: capabilityBinding(binding),
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
          cwd: stateRoot,
          environment: { MPX_RUNTIME_EXECUTOR: 'host' },
          nativeRuntimeRoot: `C:/native/${runtime}`,
          stateRoot,
          projectionInput: {
            descriptor,
            skillPlan: content.skillPlan,
            agentsRoot: content.agentsRoot,
            runtimeProfilesFile: content.runtimeProfilesFile,
            artifactsRoot: stateRoot,
            runtimeContext,
            runtimeStatusEnvelope: composeRuntimeStatusEnvelope({
              generatedAt: '2026-01-01T00:00:00.000Z',
              binding: { launchKey, runtimeId: runtime, repositoryId: binding.repositoryId },
              harness:
                runtime === 'pi'
                  ? { kind: 'pi', version: null, surface: 'footer' }
                  : { kind: 'claude', version: null, surface: 'statusline' },
              contributions: [],
            }),
            runtimeCapabilityManifest: capability,
            ...(runtime === 'pi'
              ? {
                  piRuntimeProfile: createPiRuntimeProfile(
                    {
                      schemaVersion: 1,
                      runtime: 'pi',
                      provider: 'openai-codex',
                      defaultModel: 'openai-codex/gpt-5.6-sol',
                      enabledModels: ['openai-codex/gpt-5.6-sol'],
                    },
                    [],
                  ),
                }
              : {}),
            runtimeLaunchBinding: {
              launchKey,
              runtime,
              identity: { name: 'work', domain: 'work' },
              worktreeRoot: stateRoot,
              executor: 'host',
              assignedPorts: [],
            },
          },
          launchBanner: 'launch',
          initialSnapshot: {
            schemaVersion: 1,
            project: { id: 'sample/app', cwd: stateRoot },
            worktree: { id: null, path: null, role: null, branch: null },
            portResolution: 'valid',
            services: [],
            diagnostics: [],
          },
          statusSnapshot: async () => ({}) as never,
          bindStatusPath: () => undefined,
          bindRuntimeStatusPath: () => undefined,
          statusMaterializer: { materialize: async () => undefined },
          runtimeStatusMaterializer: {
            materialize: async () => path.join(stateRoot, 'runtime.json'),
          },
          trustedExecutable: { executable: process.execPath, argvPrefix: [] },
        });

        const invocation = await adapter!.prepare({ routes: {} } as never);

        expect(invocation.environment.MPX_RUNTIME_EXECUTOR).toBe('docker');
      } finally {
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  );

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
      '---\nname: sample\ndescription: Sample skill\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [development]\n    defaultExposure: full\n---\n# Sample\n',
    );
    const catalog = await inventoryCanonical(canonicalRoot);
    const binding = {
      projectId: 'project',
      repositoryId: 'repository',
      identity: 'identity',
      selection,
    };
    const manifest = resolveManifest(catalog, {
      ...binding,
      identity: binding.identity,
      selection,
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
    const runtimeContext = createRuntimeContext({
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
    const runtimeStatusEnvelope = composeRuntimeStatusEnvelope({
      generatedAt: '2026-01-01T00:00:00.000Z',
      binding: { launchKey, runtimeId: 'pi', repositoryId: 'repository' },
      harness: { kind: 'pi', version: null, surface: 'footer' },
      contributions: [],
    });
    const runtimeCapabilityManifest = createRuntimeCapabilityManifest({
      runtime: 'pi',
      launchKey,
      identity: { name: 'identity', domain: 'personal', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding: capabilityBinding(binding),
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
        executor: { name: 'host' },
      } as LaunchDescriptor;
      await writeFile(
        path.join(canonicalRoot, 'mpxconfig.json'),
        JSON.stringify({
          schemaVersion: 1,
          project: { id: 'example/project' },
          repository: { provider: 'gitlab', remote: 'origin' },
          issues: {
            provider: 'kanbanflow',
            boardId: 'board',
            states: { todo: 'todo', wip: 'wip', review: 'review', done: 'done' },
          },
        }),
      );
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
          piRuntimeProfile: createPiRuntimeProfile(
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
        MPX_REPOSITORY_PROVIDER: 'gitlab',
        MPX_ISSUES_PROVIDER: 'kanbanflow',
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
    const projectCwd = path.join(stateRoot, 'project', 'nested');
    await mkdir(projectCwd, { recursive: true });
    const launchKey = 'a'.repeat(64);
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: verified'];
    const binding = {
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      identity: 'work',
      selection,
    };
    const content = await projectionContentFixture(stateRoot, 'pi', binding);
    const artifactReference = content.artifact.reference;
    const descriptor = {
      runtime: 'pi',
      launchKey,
      runtimeArgs,
      identity: { name: 'identity', domain: 'personal' },
      mode: 'developer',
      executor: { name: 'host' },
    } as unknown as LaunchDescriptor;
    const runtimeContext = createRuntimeContext({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: artifactReference.manifestKey,
      runtimeArtifact: artifactReference,
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        identity: 'work',
        selection,
      },
    });
    const capability = createRuntimeCapabilityManifest({
      runtime: 'pi',
      launchKey,
      identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        selection,
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
        cwd: projectCwd,
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
            worktreeRoot: projectCwd,
            executor: 'host',
            assignedPorts: [],
          },
        },
        launchBanner: 'launch',
        initialSnapshot: {
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: projectCwd },
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

  it('includes runtime and managed-project plugin directories through the application adapter', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-claude-project-plugin-'));
    const launchKey = 'a'.repeat(64);
    const binding = {
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      identity: 'work',
      selection,
    };
    const content = await projectionContentFixture(stateRoot, 'claude', binding, true);
    const descriptor = {
      runtime: 'claude',
      launchKey,
      identity: { name: 'work', domain: 'work' },
      executor: { name: 'host' },
    } as LaunchDescriptor;
    const runtimeContext = createRuntimeContext({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: content.artifact.reference.manifestKey,
      runtimeArtifact: content.artifact.reference,
      binding,
    });
    const capability = createRuntimeCapabilityManifest({
      runtime: 'claude',
      launchKey,
      identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding: capabilityBinding(binding),
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
        cwd: stateRoot,
        environment: {},
        nativeRuntimeRoot: 'C:/native/claude',
        stateRoot,
        projectionInput: {
          descriptor,
          skillPlan: content.skillPlan,
          agentsRoot: content.agentsRoot,
          runtimeProfilesFile: content.runtimeProfilesFile,
          artifactsRoot: stateRoot,
          runtimeContext,
          runtimeStatusEnvelope: composeRuntimeStatusEnvelope({
            generatedAt: '2026-01-01T00:00:00.000Z',
            binding: { launchKey, runtimeId: 'claude', repositoryId: binding.repositoryId },
            harness: { kind: 'claude', version: null, surface: 'statusline' },
            contributions: [],
          }),
          runtimeCapabilityManifest: capability,
          runtimeLaunchBinding: {
            launchKey,
            runtime: 'claude',
            identity: { name: 'work', domain: 'work' },
            worktreeRoot: stateRoot,
            executor: 'host',
            assignedPorts: [],
          },
        },
        launchBanner: 'launch',
        initialSnapshot: {
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: stateRoot },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'valid',
          services: [],
          diagnostics: [],
        },
        statusSnapshot: async () => ({}) as never,
        bindStatusPath: () => undefined,
        bindRuntimeStatusPath: () => undefined,
        statusMaterializer: { materialize: async () => undefined },
        runtimeStatusMaterializer: {
          materialize: async () => path.join(stateRoot, 'runtime.json'),
        },
        trustedExecutable: { executable: process.execPath, argvPrefix: [] },
      });

      const invocation = await adapter!.prepare({ routes: {} } as never);
      const pluginDirectories = invocation.argv.flatMap((value, index) =>
        value === '--plugin-dir' ? [invocation.argv[index + 1]] : [],
      );
      expect(pluginDirectories).toHaveLength(2);
      expect(pluginDirectories[1]).toBe(path.join(pluginDirectories[0]!, 'project-skills'));
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('rejects a Claude projection missing the managed-project plugin manifest', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mpx-claude-invalid-project-plugin-'));
    const launchKey = 'a'.repeat(64);
    const binding = {
      projectId: 'sample/app',
      repositoryId: 'sample/repo',
      identity: 'work',
      selection,
    };
    const content = await projectionContentFixture(stateRoot, 'claude', binding, true);
    const descriptor = {
      runtime: 'claude',
      launchKey,
      identity: { name: 'work', domain: 'work' },
      executor: { name: 'host' },
    } as LaunchDescriptor;
    const runtimeContext = createRuntimeContext({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: content.artifact.reference.manifestKey,
      runtimeArtifact: content.artifact.reference,
      binding,
    });
    const capability = createRuntimeCapabilityManifest({
      runtime: 'claude',
      launchKey,
      identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: 'f'.repeat(64) },
      binding: capabilityBinding(binding),
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
        cwd: stateRoot,
        environment: {},
        nativeRuntimeRoot: 'C:/native/claude',
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
          runtimeLaunchBinding: {
            launchKey,
            runtime: 'claude',
            identity: { name: 'work', domain: 'work' },
            worktreeRoot: stateRoot,
            executor: 'host',
            assignedPorts: [],
          },
        },
        launchBanner: 'launch',
        initialSnapshot: {
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: stateRoot },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'valid',
          services: [],
          diagnostics: [],
        },
        statusSnapshot: async () => ({}) as never,
        bindStatusPath: () => undefined,
        bindRuntimeStatusPath: () => undefined,
        statusMaterializer: { materialize: async () => undefined },
        runtimeStatusMaterializer: {
          materialize: async () => path.join(stateRoot, 'runtime.json'),
        },
        trustedExecutable: { executable: process.execPath, argvPrefix: [] },
        builder: async (input) => ({
          directory: stateRoot,
          pluginDirectory: stateRoot,
          artifactKey: 'd'.repeat(64),
          files: ['.claude-plugin/plugin.json'],
          reference: publishedReference(input),
        }),
        validator: async () => undefined,
      });

      await expect(adapter!.prepare({ routes: {} } as never)).rejects.toMatchObject({
        code: 'RUNTIME_PROJECTION_INVALID',
      });
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
      identity: 'work',
      selection,
    };
    const content = await projectionContentFixture(stateRoot, 'claude', binding);
    const artifactReference = content.artifact.reference;
    const runtimeContext = createRuntimeContext({
      launchKey,
      launchDescriptor: { reference: 'launch.json', digest: 'e'.repeat(64) },
      manifestKey: artifactReference.manifestKey,
      runtimeArtifact: artifactReference,
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        identity: 'work',
        selection,
      },
    });
    const capability = createRuntimeCapabilityManifest({
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
        selection,
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
    const descriptor = {
      runtime: 'claude',
      launchKey,
      executor: { name: 'host' },
    } as LaunchDescriptor;
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
        builder: async (input) => {
          expect(input).not.toHaveProperty('cwd');
          expect(input).not.toHaveProperty('globalInstructions');
          expect(input).not.toHaveProperty('claudeInstructions');
          expect(input).not.toHaveProperty('piAppendInstructions');
          return {
            directory: stateRoot,
            pluginDirectory: stateRoot,
            reference: publishedReference(input),
          };
        },
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
