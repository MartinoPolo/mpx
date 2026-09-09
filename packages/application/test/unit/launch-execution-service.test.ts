import { describe, expect, it, vi } from 'vitest';
import { createSkillArtifactReference, sha256Canonical, type JsonValue } from '@mpx/core';
import { ExecutionError, type ExecutorAdapter, type RuntimeAdapter } from '@mpx/executors';
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
const selection = {
  location: { name: 'personal', canonicalRoot: 'C:/project' },
  packs: ['development'] as const,
  source: 'project' as const,
};

function fixture(executor: 'docker' | 'host' = 'docker') {
  const manifest = resolveManifest([], {
    repositoryId: 'sample/repo',
    projectId: 'sample/app',
    identity: 'personal',
    selection,
  });
  const artifact = createRuntimeSkillArtifact(manifest, [], { runtime: 'pi' });
  const skillArtifact = createSkillArtifactReference({
    runtime: 'pi',
    identity: 'personal',
    projectId: 'sample/app',
    repositoryId: 'sample/repo',
    catalogHash: hash('1'),
    selection,
  });
  const tuple = {
    schemaVersion: 3 as const,
    nativeRuntimeRootDigest: canonicalNativeRootDigest('C:/native/pi'),
    runtime: 'pi' as const,
    binding: { projectId: 'sample/app', repositoryId: 'sample/repo' },
    identity: { name: 'personal', domain: 'personal' },
    mode: 'project',
    selection,
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
              limitation:
                'Mounted content, host services, and direct extra mounts remain confidentiality limitations.' as const,
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
    workspace: 'direct' as const,
    networkPolicy: { name: 'minimal', declaration: { preset: 'deny-all' as const } },
    preset: null,
    provenance: {
      runtime: 'explicit' as const,
      identity: 'explicit' as const,
      mode: 'explicit' as const,
      executor: 'explicit' as const,
      workspace: 'explicit' as const,
      networkPolicy: 'explicit' as const,
    },
    diagnostics: [],
    cwdClassification: { domain: 'personal', location: 'personal' },
    routes: {
      gitAuthor: 'git-personal',
      providers: {},
      ssh: null,
      mcp: { allow: [], shareNativeAuth: false as const },
    },
    intendedPolicy: {
      mode: 'project',
      resources: { 'selected-project': 'read-write' as const },
      inputsDigest: sha256Canonical({
        schemaVersion: 1,
        manifestKey: manifest.manifestKey,
        skillArtifactKey: skillArtifact.artifactKey,
      }),
    },
    skillArtifact,
    elevationAudit: {
      elevated: executor === 'host',
      reason: executor === 'host' ? 'fixture' : null,
      approvalsDigest: sha256Canonical({
        unrestricted: null,
        host: executor === 'host' ? { reason: 'fixture', approvalKey: hash('d') } : null,
      }),
      banner:
        executor === 'host'
          ? {
              code: 'ELEVATED_LAUNCH' as const,
              persistent: true as const,
              message: 'ELEVATED LAUNCH — host-compatibility — fixture',
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
    assertReady: async () => {
      effects.push('ready');
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
    expect(requests).toEqual({
      api: {
        id: 'api',
        executable: 'pnpm',
        args: ['run', 'dev:api'],
        cwd: 'C:/worktree',
        ports: [4310],
        assignment: { worktreeRoot: 'C:/worktree', ports: [4310] },
        executor: 'docker',
        environment: { API_URL: 'http://localhost:4310' },
      },
    });
    const assertDeeplyFrozen = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(assertDeeplyFrozen);
      }
    };
    assertDeeplyFrozen(requests);
  });

  it('fails closed when the immutable current launch tuple is absent', () => {
    expect(() => currentLaunchTuple({})).toThrowError(
      expect.objectContaining({ code: 'LAUNCH_CONTEXT_REQUIRED' }),
    );
  });

  it('accepts only the exact context/projection tuple and sanitizes every invalid binding', () => {
    const context = {
      schemaVersion: 2,
      launchKey: hash('a'),
      launchDescriptor: { reference: 'launch.json', digest: hash('b') },
      manifestKey: hash('c'),
      runtimeArtifact: {
        schemaVersion: 5,
        runtime: 'pi',
        manifestKey: hash('c'),
        artifactKey: hash('d'),
        fileMapHash: hash('e'),
      },
      binding: {
        projectId: 'sample/app',
        repositoryId: 'sample/repo',
        identity: 'personal',
        selection,
      },
    };
    const projection = {
      projectionKey: hash('f'),
      fileMapHash: hash('9'),
      launchBinding: {
        launchKey: hash('a'),
        descriptorDigest: hash('b'),
        runtimeArtifactKey: hash('d'),
        runtime: 'pi',
        manifestKey: hash('c'),
      },
    };
    const environment = (contextValue: unknown, projectionValue: unknown) => ({
      MPX_RUNTIME_CONTEXT: JSON.stringify(contextValue),
      MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projectionValue),
    });
    expect(currentLaunchTuple(environment(context, projection))).toMatchObject({
      launchKey: hash('a'),
      projectionKey: hash('f'),
    });
    const secret = 'RAW-PRIVATE-CONTEXT';
    const invalid = [
      { context: { ...context, schemaVersion: 1 }, projection },
      { context: secret, projection },
      { context, projection: { ...projection, extra: true } },
      {
        context,
        projection: {
          ...projection,
          launchBinding: { ...projection.launchBinding, descriptorDigest: hash('0') },
        },
      },
      {
        context,
        projection: {
          ...projection,
          launchBinding: { ...projection.launchBinding, runtime: 'claude' },
        },
      },
      {
        context: { ...context, binding: { ...context.binding, selection: 42 } },
        projection,
      },
    ];
    for (const candidate of invalid) {
      try {
        currentLaunchTuple(environment(candidate.context, candidate.projection));
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'LAUNCH_CONTEXT_INVALID',
          remediation: 'Relaunch and restart the runtime process.',
        });
        expect(String((error as Error).message)).not.toContain(secret);
      }
    }
  });

  it('passes a frozen empty route map without materializing routes in production mode', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    const materialize = vi.fn(deps.routes!.materialize);
    let composedRoutes: Readonly<Record<string, string>> | undefined;

    await executeResolvedLaunch(request, {
      ...deps,
      runtimeAdapterMode: 'production',
      routes: { materialize },
      composer: async (composition) => {
        composedRoutes = composition.materializedRoutes;
        return deps.composer(composition);
      },
    });

    expect(materialize).not.toHaveBeenCalled();
    expect(composedRoutes).toEqual({});
    expect(Object.isFrozen(composedRoutes)).toBe(true);
  });

  it('fails closed without a route materializer when runtime adapter mode is omitted', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const { routes: _routes, ...deps } = dependencies(effects);

    await expect(executeResolvedLaunch(request, deps)).rejects.toMatchObject({
      code: 'PRIVATE_ROUTE_MATERIALIZER_REQUIRED',
    });
  });

  it('fails closed without a route materializer in injected runtime adapter mode', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const { routes: _routes, ...deps } = dependencies(effects);

    await expect(
      executeResolvedLaunch(request, { ...deps, runtimeAdapterMode: 'injected' }),
    ).rejects.toMatchObject({ code: 'PRIVATE_ROUTE_MATERIALIZER_REQUIRED' });
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
    const gated = {
      ...deps,
      executorAdapters: [
        {
          ...deps.executorAdapters[0]!,
          assertReady: async () => {
            effects.push('ready');
            throw new ExecutionError('EXECUTOR_UNAVAILABLE', 'fixture unavailable');
          },
        },
      ],
      lifecycle: { prepare, consume: vi.fn() },
    };
    await expect(
      executeResolvedLaunch({ ...request, statusSnapshot }, gated),
    ).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
    });
    expect(effects).toEqual(['ready']);
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
    expect(effects).toEqual(['ready']);
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
      'ready',
      'preflight',
      'resume',
      'lifecycle',
      'routes',
      'composer',
      'ready',
      'runtime',
      'ready',
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
    expect(effects).toEqual(['ready', 'resume']);
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
            assertReady: async () => undefined,
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

  it('uses an explicit noninteractive host approval at the execution boundary without a TTY', async () => {
    const effects: string[] = [];
    const { request } = fixture('host');
    const deps = dependencies(effects);
    const host: ExecutorAdapter = {
      name: 'host',
      assertReady: async () => undefined,
      execute: async () => {
        effects.push('execute');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    };

    await expect(
      executeResolvedLaunch(request, {
        ...deps,
        executorAdapters: [host],
        approveHost: true,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(effects).toContain('execute');
  });

  it('obtains host approval before runtime execution', async () => {
    const effects: string[] = [];
    const { request } = fixture('host');
    const deps = dependencies(effects);
    const host: ExecutorAdapter = {
      name: 'host',
      assertReady: async () => undefined,
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

  it('never substitutes the host executor for a selected Docker executor', async () => {
    const effects: string[] = [];
    const { request } = fixture();
    const deps = dependencies(effects);
    const docker = {
      ...deps.executorAdapters[0]!,
      execute: vi.fn(async () => {
        effects.push('selected-docker');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      }),
    };
    const host: ExecutorAdapter = {
      name: 'host',
      assertReady: async () => undefined,
      execute: vi.fn(async () => {
        effects.push('host-process');
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      }),
    };

    await executeResolvedLaunch(request, {
      ...deps,
      executorAdapters: [docker, host],
      runtimeAdapterMode: 'production',
    });

    expect(docker.execute).toHaveBeenCalledOnce();
    expect(host.execute).not.toHaveBeenCalled();
    expect(effects).toContain('selected-docker');
    expect(effects).not.toContain('host-process');
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
});

function lifecycleBinding(descriptor: LaunchDescriptor) {
  return {
    binding: { schemaVersion: 1, bindingId: 'binding-1', launchKey: descriptor.launchKey } as never,
    eventDirectory: 'C:/events',
  };
}
