import { describe, expect, it, vi } from 'vitest';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import type { ExecutorAdapter, RuntimeAdapter } from '@mpx/executors';
import { canonicalNativeRootDigest, type LaunchDescriptor } from '@mpx/launch';
import { createRuntimeSkillArtifact, resolveManifest } from '@mpx/skills';
import {
  currentLaunchTuple,
  executeResolvedLaunch,
  runtimeServiceRequests,
  type LaunchExecutionDependencies,
  type LaunchExecutionRequest,
} from '@mpx/application';

const hash = (value: string) => value.repeat(64);

function fixture(executor: 'docker' | 'host' = 'docker') {
  const manifest = resolveManifest([], {
    repositoryId: 'sample/repo',
    projectId: 'sample/app',
    contentScope: 'personal',
    identity: 'personal',
    skillPolicy: 'clean',
    skillPolicyConfig: { skillExposure: { default: 'off' } },
    enabledPacks: [],
  });
  const artifact = createRuntimeSkillArtifact(manifest, [], { runtime: 'pi' });
  const skillArtifact = {
    schemaVersion: 3 as const,
    runtime: 'pi' as const,
    identity: 'personal',
    skillPolicy: 'clean',
    contentScope: 'personal',
    projectId: 'sample/app',
    catalogHash: hash('1'),
    enabledPacks: [],
    skillPolicyConfigHash: hash('2'),
    contentScopeExposureHash: hash('3'),
    projectExposureHash: hash('4'),
    effectivePolicyHash: hash('5'),
    artifactKey: hash('6'),
  };
  const tuple = {
    schemaVersion: 2 as const,
    nativeRuntimeRootDigest: canonicalNativeRootDigest('C:/native/pi'),
    runtime: 'pi' as const,
    binding: { projectId: 'sample/app', repositoryId: 'sample/repo' },
    identity: { name: 'personal', domain: 'personal' },
    mode: 'project',
    skillPolicy: 'clean',
    executor:
      executor === 'docker'
        ? {
            name: 'docker' as const,
            effectiveEnforcement: 'mount-enforced' as const,
            isolation: 'container' as const,
            interception: {
              kind: 'container-boundary' as const,
              intercepted: ['container-filesystem', 'declared-mounts'] as const,
              knownBypasses: ['host-services', 'direct-extra-mounts'] as const,
            },
            mounts: { kind: 'explicit' as const, policyEnforced: true as const },
            confidentiality: {
              isolated: 'mount-dependent' as const,
              hostReadable: true as const,
              limitation: 'Mounted content remains host-readable.' as const,
            },
            availability: 'available' as const,
          }
        : {
            name: 'host' as const,
            effectiveEnforcement: 'advisory' as const,
            isolation: 'none' as const,
            interception: {
              kind: 'policy-hooks' as const,
              intercepted: ['mpx-mediated-operations'] as const,
              knownBypasses: ['raw-shell', 'direct-filesystem', 'unmanaged-children'] as const,
            },
            mounts: { kind: 'host-direct' as const, policyEnforced: false as const },
            confidentiality: {
              isolated: false as const,
              hostReadable: true as const,
              limitation: 'No filesystem or confidentiality isolation is enforced.' as const,
            },
          },
    executorVerification: {
      status: 'verified' as const,
      verifier: 'fixture',
      evidenceDigest: hash('b'),
    },
    workspace: 'direct' as const,
    networkPolicy: { name: 'minimal', declaration: { preset: 'deny-all' as const } },
    preset: null,
    provenance: {
      runtime: 'explicit' as const,
      identity: 'explicit' as const,
      mode: 'explicit' as const,
      skillPolicy: 'explicit' as const,
      contentScope: 'explicit' as const,
      executor: 'explicit' as const,
      workspace: 'explicit' as const,
      networkPolicy: 'explicit' as const,
    },
    diagnostics: [],
    contentScope: { name: 'personal' },
    grants: [],
    cwdClassification: { domain: 'personal', contentScope: 'personal' },
    routes: {
      gitAuthor: 'git-personal',
      providers: {},
      ssh: null,
      mcp: { allow: [], shareNativeAuth: false as const },
    },
    intendedPolicy: {
      mode: 'project',
      resources: { 'selected-project': 'read-write' as const },
      grants: [],
      inputsDigest: sha256Canonical({
        schemaVersion: 1,
        manifestKey: manifest.manifestKey,
        skillArtifactKey: skillArtifact.artifactKey,
      }),
      approvalsDigest: hash('d'),
    },
    skillArtifact,
    elevationAudit: {
      elevated: executor === 'host',
      reason: executor === 'host' ? 'fixture' : null,
      approvalsDigest: hash('d'),
      banner:
        executor === 'host'
          ? {
              code: 'ELEVATED_LAUNCH' as const,
              persistent: true as const,
              message: 'ELEVATED LAUNCH — fixture',
            }
          : null,
    },
  };
  const descriptor = {
    ...tuple,
    launchKey: sha256Canonical(tuple as unknown as JsonValue),
  } as unknown as LaunchDescriptor;
  const request: LaunchExecutionRequest = {
    descriptor,
    manifest,
    artifact,
    cwd: 'C:/project',
    environment: {},
    nativeRuntimeRoot: 'C:/native/pi',
    catalog: [],
    canonicalRoot: 'C:/skills',
    statusSnapshot: async () => ({
      schemaVersion: 1,
      project: { id: 'sample/app', cwd: 'C:/project' },
      worktree: { id: null, path: null, role: null, branch: null },
      portResolution: 'valid',
      services: [],
      diagnostics: [],
    }),
  };
  return { descriptor, request };
}

function dependencies(effects: string[] = []): LaunchExecutionDependencies {
  const executor: ExecutorAdapter = {
    name: 'docker',
    verify: async () => {
      effects.push('verify');
      return { status: 'verified', verifier: 'fixture', evidenceDigest: hash('b') };
    },
    execute: async () => {
      effects.push('execute');
      return { exitCode: 0, stdout: '', stderr: '', truncated: false };
    },
  };
  const runtime: RuntimeAdapter = {
    runtime: 'pi',
    prepare: async () => {
      effects.push('runtime');
      return { executable: 'C:/trusted/pi.exe', argv: [], environment: {} };
    },
  };
  return {
    composer: async () => {
      effects.push('composer');
      return { adapters: [runtime] };
    },
    executorAdapters: [executor],
    routes: {
      materialize: async () => {
        effects.push('routes');
        return { 'git:git-personal': 'C:/routes/git' };
      },
    },
  };
}

describe('launch execution application service', () => {
  it('constructs complete immutable development service requests', () => {
    const requests = runtimeServiceRequests(
      {
        schemaVersion: 1,
        project: { id: 'sample/app' },
        repository: { provider: 'generic', remote: 'origin' },
        tooling: { packageManager: 'pnpm' },
        development: {
          services: {
            api: {
              scope: 'checkout',
              port: { mode: 'managed' },
              protocol: 'http',
              environmentVariable: 'API_URL',
              start: { type: 'package-script', script: 'dev:api' },
            },
          },
        },
      },
      'C:/project',
      {
        schemaVersion: 1,
        project: { id: 'sample/app', cwd: 'C:/project' },
        worktree: { id: 'wt-1', path: 'C:/worktree', role: 'linked', branch: 'feature' },
        portResolution: 'valid',
        services: [
          {
            id: 'api',
            mode: 'managed',
            scope: 'checkout',
            protocol: 'http',
            port: 4310,
            listening: false,
            conflict: 'none',
            pid: null,
          },
        ],
        diagnostics: [],
      },
      'docker',
    );
    expect(requests.api).toMatchObject({ executable: 'pnpm', cwd: 'C:/worktree', ports: [4310] });
    expect(Object.isFrozen(requests.api)).toBe(true);
  });

  it('fails closed when the immutable current launch tuple is absent', () => {
    expect(() => currentLaunchTuple({})).toThrowError(
      expect.objectContaining({ code: 'LAUNCH_CONTEXT_REQUIRED' }),
    );
  });

  it('stops at an executor gate before composer, routes, status, or lifecycle effects', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    const statusSnapshot = vi.fn(request.statusSnapshot);
    const prepare = vi.fn(async () => {
      effects.push('lifecycle');
      return lifecycleBinding(request.descriptor);
    });
    const unavailableEvidence = {
      status: 'unavailable' as const,
      verifier: 'fixture',
      evidenceDigest: hash('b'),
    };
    const descriptor = withVerification(request.descriptor, unavailableEvidence);
    const gated = {
      ...deps,
      executorAdapters: [
        {
          ...deps.executorAdapters[0]!,
          verify: async () => {
            effects.push('verify');
            return unavailableEvidence;
          },
        },
      ],
      lifecycle: { prepare, consume: vi.fn() },
    };
    await expect(
      executeResolvedLaunch({ ...request, descriptor, statusSnapshot }, gated),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
    expect(effects).toEqual(['verify']);
    expect(statusSnapshot).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects incompatible runtime and lifecycle dependencies before every side effect', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    const lifecycle = {
      prepare: vi.fn(async () => {
        effects.push('lifecycle');
        return lifecycleBinding(request.descriptor);
      }),
      consume: vi.fn(async () => undefined),
    };
    await expect(
      executeResolvedLaunch(request, { ...deps, runtimeAdapterMode: 'injected', lifecycle }),
    ).rejects.toMatchObject({ code: 'RUNTIME_LIFECYCLE_CAPABILITY_REQUIRED' });
    expect(effects).toEqual(['verify']);
  });

  it('runs runtime preflight after immutable gates and before resume or launch side effects', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    const resumed = {
      ...request,
      resume: {
        nativeBinding: {} as never,
        nativeSessionRef: { kind: 'native-id' as const, value: 'session-1' },
      },
    };
    await executeResolvedLaunch(resumed, {
      ...deps,
      runtimePreflight: async () => {
        effects.push('preflight');
      },
      verifyResumeTarget: async () => {
        effects.push('resume');
        return { file: 'C:/sessions/session-1.jsonl' };
      },
      lifecycle: {
        prepare: async () => {
          effects.push('lifecycle');
          return lifecycleBinding(request.descriptor);
        },
        consume: async () => undefined,
      },
    });
    expect(effects).toEqual([
      'verify',
      'preflight',
      'resume',
      'lifecycle',
      'routes',
      'composer',
      'verify',
      'runtime',
      'verify',
      'execute',
    ]);
  });

  it('passes the validated native session reference unchanged when no resume verifier is injected', async () => {
    const { request } = fixture();
    const nativeSessionRef = { kind: 'native-id' as const, value: 'session-1' };
    const composer = vi.fn(dependencies().composer);
    await executeResolvedLaunch(
      {
        ...request,
        resume: { nativeBinding: {} as never, nativeSessionRef },
      },
      { ...dependencies(), composer },
    );
    expect(composer).toHaveBeenCalledWith(
      expect.objectContaining({ resumeTarget: nativeSessionRef }),
    );
    expect(composer.mock.calls[0]![0].resumeTarget).toBe(nativeSessionRef);
  });

  it('validates a resume target before lifecycle preparation and requires no cleanup on failure', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const prepare = vi.fn(async () => {
      effects.push('prepare');
      return lifecycleBinding(request.descriptor);
    });
    const consume = vi.fn();
    const verifyResumeTarget = vi.fn(async () => {
      effects.push('resume');
      throw new Error('stale resume');
    });
    const resumed = {
      ...request,
      resume: {
        nativeBinding: {} as never,
        nativeSessionRef: { kind: 'native-id' as const, value: 'session-1' },
      },
    };
    await expect(
      executeResolvedLaunch(resumed, {
        ...dependencies(effects),
        lifecycle: { prepare, consume },
        verifyResumeTarget,
      }),
    ).rejects.toThrow('stale resume');
    expect(effects).toEqual(['verify', 'resume']);
    expect(prepare).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('consumes lifecycle once when route materialization fails', async () => {
    const { request } = fixture();
    const primary = new Error('route failure');
    const consume = vi.fn(async () => undefined);
    await expect(
      executeResolvedLaunch(request, {
        ...dependencies(),
        routes: { materialize: async () => Promise.reject(primary) },
        lifecycle: { prepare: async () => lifecycleBinding(request.descriptor), consume },
      }),
    ).rejects.toBe(primary);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('consumes lifecycle once when runtime composition fails', async () => {
    const { request } = fixture();
    const primary = new Error('composer failure');
    const consume = vi.fn(async () => undefined);
    await expect(
      executeResolvedLaunch(request, {
        ...dependencies(),
        composer: async () => Promise.reject(primary),
        lifecycle: { prepare: async () => lifecycleBinding(request.descriptor), consume },
      }),
    ).rejects.toBe(primary);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('cleans the plan and lifecycle once when host approval fails', async () => {
    const { request } = fixture('host');
    const primary = new Error('approval failure');
    const cleanup = vi.fn(async () => undefined);
    const consume = vi.fn(async () => undefined);
    await expect(
      executeResolvedLaunch(request, {
        ...dependencies(),
        executorAdapters: [
          {
            name: 'host',
            verify: async () => request.descriptor.executorVerification,
            execute: vi.fn(),
          },
        ],
        composer: async (input) => ({
          adapters: (await dependencies().composer(input)).adapters,
          cleanup,
        }),
        lifecycle: { prepare: async () => lifecycleBinding(request.descriptor), consume },
        tty: { direct: true, confirm: async () => Promise.reject(primary) },
      }),
    ).rejects.toBe(primary);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('consumes lifecycle and plan cleanup exactly once after successful execution', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const cleanup = vi.fn(async () => {
      effects.push('plan-cleanup');
    });
    const consume = vi.fn(async () => {
      effects.push('lifecycle-cleanup');
    });
    const deps = dependencies(effects);
    const result = await executeResolvedLaunch(request, {
      ...deps,
      composer: async (input) => ({ adapters: (await deps.composer(input)).adapters, cleanup }),
      lifecycle: { prepare: async () => lifecycleBinding(request.descriptor), consume },
    });
    expect(result.exitCode).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('preserves the primary execution error while consuming lifecycle and plan cleanup once', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const cleanup = vi.fn(async () => undefined);
    const consume = vi.fn(async () => undefined);
    const deps = dependencies(effects);
    const primary = new Error('primary execution failure');
    const failingExecutor = {
      ...deps.executorAdapters[0]!,
      execute: async () => {
        throw primary;
      },
    };
    await expect(
      executeResolvedLaunch(request, {
        ...deps,
        executorAdapters: [failingExecutor],
        composer: async (input) => ({ adapters: (await deps.composer(input)).adapters, cleanup }),
        lifecycle: { prepare: async () => lifecycleBinding(request.descriptor), consume },
      }),
    ).rejects.toBe(primary);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('obtains host approval before runtime execution', async () => {
    const effects: string[] = [];
    const { request } = fixture('host');
    const deps = dependencies(effects);
    const host: ExecutorAdapter = {
      name: 'host',
      verify: async () => request.descriptor.executorVerification,
      execute: async () => {
        effects.push('execute');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    };
    await executeResolvedLaunch(request, {
      ...deps,
      executorAdapters: [host],
      tty: {
        direct: true,
        confirm: async () => {
          effects.push('approval');
          return true;
        },
      },
    });
    expect(effects).toContain('approval');
    expect(effects.indexOf('approval')).toBeLessThan(effects.indexOf('execute'));
  });

  it('contains an in-flight status refresh at shutdown', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    let scheduled: (() => Promise<void>) | undefined;
    let refreshWork: Promise<void> | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshSignal: AbortSignal | undefined;
    const readSnapshot = vi.fn();
    const waitForShutdown = vi.fn(async () => undefined);
    const executor: ExecutorAdapter = {
      ...deps.executorAdapters[0]!,
      execute: async () => {
        refreshWork = scheduled!();
        await vi.waitFor(() => expect(refreshSignal).toBeDefined());
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    };
    const runtime: RuntimeAdapter = {
      runtime: 'pi',
      prepare: async () => ({ executable: 'C:/trusted/pi.exe', argv: [], environment: {} }),
    };
    await executeResolvedLaunch(request, {
      ...deps,
      executorAdapters: [executor],
      composer: async () => ({
        adapters: [runtime],
        statusPaths: () => ({ snapshot: 'C:/status.json' }),
      }),
      liveStatus: {
        schedule: (callback) => {
          scheduled = callback;
          return () => undefined;
        },
        materializeSnapshot: async ({ signal }) => {
          refreshSignal = signal;
          await blocked;
          return 'C:/status.json';
        },
        readSnapshot,
        materializeRuntimeStatus: async () => 'C:/runtime.json',
        waitForShutdown,
      },
    });
    expect(waitForShutdown).toHaveBeenCalledTimes(1);
    expect(refreshSignal?.aborted).toBe(true);
    release();
    await refreshWork;
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('rejects changed immutable executor evidence before downstream effects', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    await expect(
      executeResolvedLaunch(request, {
        ...deps,
        executorAdapters: [
          {
            ...deps.executorAdapters[0]!,
            verify: async () => {
              effects.push('verify');
              return { status: 'verified', verifier: 'fixture', evidenceDigest: hash('f') };
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'LAUNCH_RESTART_REQUIRED' });
    expect(effects).toEqual(['verify']);
  });
});

function withVerification(
  descriptor: LaunchDescriptor,
  executorVerification: LaunchDescriptor['executorVerification'],
): LaunchDescriptor {
  const { launchKey: _launchKey, ...rest } = descriptor;
  const tuple = { ...rest, executorVerification };
  return {
    ...tuple,
    launchKey: sha256Canonical(tuple as unknown as JsonValue),
  } as LaunchDescriptor;
}

function lifecycleBinding(descriptor: LaunchDescriptor) {
  return {
    binding: { schemaVersion: 1, bindingId: 'binding-1', launchKey: descriptor.launchKey } as never,
    eventDirectory: 'C:/events',
  };
}
