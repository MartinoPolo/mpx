import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import type { ResumePlanV1 } from '@mpx/sessions';
import {
  SessionResumeLaunchApplicationService,
  type SessionResumeLaunchApplicationDependencies,
} from '../../src/index.js';

const digest = 'a'.repeat(64);
const cwd = process.cwd();
const user = {
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: '/roots/claude', pi: '/roots/pi' },
      gitAuthorRoute: 'work',
    },
  },
  domains: { work: [cwd] },
  contentScopes: { work: { roots: [cwd], skillPacks: ['core'] } },
  modes: { project: { resources: { 'selected-project': 'read-write' } } },
  skillPolicies: { clean: { skillExposure: { default: 'explicit-only' } } },
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: { host: {}, docker: {} },
} satisfies UserConfig;
const plan = {
  schemaVersion: 1,
  newLaunchRequired: true,
  previousLaunch: { launchKey: 'old', descriptorDigest: digest },
  recordId: 'r',
  runtimeQualifiedId: 'pi:r',
  runtime: 'pi',
  identity: { name: 'work', domain: 'work' },
  nativeBindingRef: 'binding',
  nativeSessionRef: { kind: 'pi-session-id', id: 'native' },
  cwd,
  projectId: 'sample/app',
  repositoryId: 'recorded/repository',
  launch: {
    launchKey: 'old',
    descriptorDigest: digest,
    mode: 'project',
    skillPolicy: 'clean',
    contentScope: 'work',
    executor: { kind: 'host' },
    workspace: 'direct',
    networkPolicy: 'implementation',
    grants: [],
    artifactKey: 'artifact',
    manifestKey: 'manifest',
  },
  confirmationDigest: digest,
} as unknown as ResumePlanV1;

function dependencies(events: string[] = []): SessionResumeLaunchApplicationDependencies {
  return {
    piPreflight: async () => {
      events.push('preflight');
      return {
        nativeBinding: { ref: 'binding' },
        reverify: async () => {
          events.push('reverify');
        },
      };
    },
    isAbsolutePath: () => true,
    discoverProjectConfig: async () => ({
      root: cwd,
      path: `${cwd}/mpxconfig.json`,
      config: {
        schemaVersion: 1,
        project: { id: 'sample/app' },
        repository: { provider: 'generic', remote: 'origin' },
      },
    }),
    canonicalRoot: async () => '/catalog',
    rebuildSkills: async () =>
      ({
        catalog: [],
        manifest: { manifestKey: 'manifest' },
        artifact: { reference: { artifactKey: 'artifact' } },
        skillArtifact: { artifactKey: 'skill-artifact' },
      }) as never,
    prepareExecutor: async () => ({
      evidence: { status: 'verified', verifier: 'test', evidenceDigest: digest },
      execute: async (input) => {
        events.push('executor');
        await input.beforeChildExecution?.();
        events.push('child');
        return { ok: true, descriptor: input.descriptor };
      },
    }),
    resolveDescriptor: async () =>
      ({
        runtime: 'pi',
        identity: { name: 'work', domain: 'work' },
        launchKey: 'new',
        mode: 'project',
        skillPolicy: 'clean',
        contentScope: { name: 'work' },
        executor: { name: 'host' },
        workspace: 'direct',
        networkPolicy: { name: 'implementation' },
        grants: [],
        policyInputs: { manifestKey: 'manifest' },
      }) as never,
    descriptorDigest: () => 'b'.repeat(64),
    requireExecutionRoots: async () => {
      events.push('roots');
      return { artifactsRoot: '/artifacts', stateRoot: '/state' };
    },
    readNativeBinding: async () => {
      events.push('binding');
      return { ref: 'binding' };
    },
  };
}

describe('SessionResumeLaunchApplicationService', () => {
  it('fails closed for explicit Docker without host fallback or downstream execution', async () => {
    const execution = vi.fn(async () => ({ ok: true }));
    const downstream = {
      piPreflight: vi.fn(dependencies().piPreflight),
      discoverProjectConfig: vi.fn(dependencies().discoverProjectConfig),
      canonicalRoot: vi.fn(dependencies().canonicalRoot),
      rebuildSkills: vi.fn(dependencies().rebuildSkills),
      prepareExecutor: vi.fn(async () => ({
        evidence: { status: 'verified' as const, verifier: 'test', evidenceDigest: digest },
        execute: execution,
      })),
      resolveDescriptor: vi.fn(dependencies().resolveDescriptor),
      requireExecutionRoots: vi.fn(dependencies().requireExecutionRoots),
      readNativeBinding: vi.fn(dependencies().readNativeBinding),
    };
    const service = new SessionResumeLaunchApplicationService({
      ...dependencies(),
      ...downstream,
    });
    const dockerPlan = {
      ...plan,
      launch: {
        ...plan.launch,
        executor: { kind: 'docker' as const },
        workspace: 'clone' as const,
      },
    };
    const error = await service.prepare(dockerPlan, user).catch((failure) => failure);
    expect(error).toBeInstanceOf(MpxError);
    expect(error).toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
      details: { hostFallback: false },
    });
    for (const port of Object.values(downstream)) {
      expect(port).not.toHaveBeenCalled();
    }
    expect(execution).not.toHaveBeenCalled();
  });

  it('preflights Pi before validation and delegates the second reverify to the child boundary', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const service = new SessionResumeLaunchApplicationService({
      ...deps,
      discoverProjectConfig: async (value) => {
        events.push('project');
        return deps.discoverProjectConfig(value);
      },
    });
    const token = await service.prepare(plan, user);
    await service.execute(token);
    expect(events.filter((event) => event === 'reverify')).toEqual(['reverify', 'reverify']);
    expect(events.indexOf('reverify')).toBeLessThan(events.indexOf('project'));
    expect(events.slice(-3)).toEqual(['executor', 'reverify', 'child']);
  });

  it('does not reverify when prepared execution fails before the child boundary', async () => {
    const events: string[] = [];
    const service = new SessionResumeLaunchApplicationService({
      ...dependencies(events),
      prepareExecutor: async () => ({
        evidence: { status: 'verified', verifier: 'test', evidenceDigest: digest },
        execute: async () => {
          events.push('executor-failed');
          throw new Error('failed before child');
        },
      }),
    });
    const token = await service.prepare(plan, user);
    await expect(service.execute(token)).rejects.toThrow('failed before child');
    expect(events.filter((event) => event === 'reverify')).toEqual(['reverify']);
  });

  it('makes the delegated child-boundary reverify authority one-shot', async () => {
    const events: string[] = [];
    const service = new SessionResumeLaunchApplicationService({
      ...dependencies(events),
      prepareExecutor: async () => ({
        evidence: { status: 'verified', verifier: 'test', evidenceDigest: digest },
        execute: async (input) => {
          await input.beforeChildExecution?.();
          await expect(input.beforeChildExecution?.()).rejects.toMatchObject({
            code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
          });
          return { ok: true };
        },
      }),
    });
    await service.execute(await service.prepare(plan, user));
    expect(events.filter((event) => event === 'reverify')).toEqual(['reverify', 'reverify']);
  });

  it('builds skill evidence with the recorded repository id', async () => {
    const rebuildSkills = vi.fn(dependencies().rebuildSkills);
    const service = new SessionResumeLaunchApplicationService({ ...dependencies(), rebuildSkills });
    await service.prepare(plan, user);
    expect(rebuildSkills).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalRoot: '/catalog', repositoryId: 'recorded/repository' }),
    );
  });

  it('rejects a stale policy axis before requiring roots, binding, or execution', async () => {
    const roots = vi.fn(async () => ({ artifactsRoot: '/artifacts', stateRoot: '/state' }));
    const service = new SessionResumeLaunchApplicationService({
      ...dependencies(),
      requireExecutionRoots: roots,
    });
    await expect(
      service.prepare({ ...plan, launch: { ...plan.launch, artifactKey: 'stale' } }, user),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_PLAN_STALE' });
    expect(roots).not.toHaveBeenCalled();
  });

  it('rejects forged, cross-service, and replayed tokens before process execution', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const deps = {
      ...dependencies(),
      prepareExecutor: async () => ({
        evidence: { status: 'verified' as const, verifier: 'test', evidenceDigest: digest },
        execute,
      }),
    };
    const first = new SessionResumeLaunchApplicationService(deps),
      second = new SessionResumeLaunchApplicationService(deps);
    await expect(first.execute(Object.freeze({}) as never)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    const token = await first.prepare(plan, user);
    await expect(second.execute(token)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    await first.execute(token);
    await expect(first.execute(token)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('passes the exact prepared execution facts and preserves resumeLaunch output', async () => {
    let executionInput: unknown;
    const service = new SessionResumeLaunchApplicationService({
      ...dependencies(),
      prepareExecutor: async () => ({
        evidence: { status: 'verified', verifier: 'test', evidenceDigest: digest },
        execute: async (input) => {
          executionInput = input;
          return { exitCode: 7 };
        },
      }),
    });
    const token = await service.prepare(plan, user);
    const result = await service.execute(token);
    expect(executionInput).toMatchObject({
      cwd,
      canonicalRoot: '/catalog',
      repositoryId: 'recorded/repository',
      nativeRuntimeRoot: '/roots/pi',
      roots: { artifactsRoot: '/artifacts', stateRoot: '/state' },
    });
    expect(result).toMatchObject({
      exitCode: 7,
      resumeLaunch: { previousLaunchKey: 'old', previousDescriptorDigest: digest },
    });
  });
});
