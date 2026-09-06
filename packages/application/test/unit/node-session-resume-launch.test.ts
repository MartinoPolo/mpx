import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import type { ResumePlanV1 } from '@mpx/sessions';

const mocks = vi.hoisted(() => ({
  executeBoundary: undefined as
    typeof import('../../src/node/launch-execution.js').executeResolvedNodeLaunch | undefined,
  execute: vi.fn(async (input: { beforeChildExecution?: () => Promise<void> }) => {
    await input.beforeChildExecution?.();
    return { exitCode: 0 };
  }),
  status: vi.fn(),
  resolveLaunch: vi.fn(
    async (input: {
      runtime: 'claude' | 'pi';
      executor: 'docker' | 'host';
      workspace: 'clone' | 'host-worktree' | 'direct';
    }) => ({
      runtime: input.runtime,
      identity: { name: 'work', domain: 'work' },
      launchKey: 'new',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: { name: 'work' },
      executor: { name: input.executor },
      workspace: input.workspace,
      networkPolicy: { name: 'implementation' },
      grants: [],
    }),
  ),
}));
vi.mock('../../src/node/launch-execution.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/node/launch-execution.js')>();
  mocks.executeBoundary = actual.executeResolvedNodeLaunch;
  return { ...actual, executeResolvedNodeLaunch: mocks.execute };
});
vi.mock('../../src/launch-skill-resolution.js', () => ({
  resolveLaunchSkills: vi.fn(async () => ({
    catalog: [],
    manifest: { manifestKey: 'manifest' },
    artifact: { reference: { artifactKey: 'artifact' } },
    skillArtifact: { artifactKey: 'skill-artifact' },
  })),
}));
vi.mock('@mpx/launch', async (original) => ({
  ...(await original()),
  resolveLaunch: mocks.resolveLaunch,
}));

import {
  createNodeSessionResumeLaunchApplicationService,
  executeNodeSessionResumeLaunch,
  type NodeSessionResumeLaunchInput,
} from '../../src/node/session-resume-launch.js';

const cwd = process.cwd();
const digest = 'a'.repeat(64);
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
function plan(runtime: 'claude' | 'pi' = 'claude'): ResumePlanV1 {
  return {
    schemaVersion: 1,
    newLaunchRequired: true,
    previousLaunch: { launchKey: 'old', descriptorDigest: digest },
    recordId: 'r',
    runtimeQualifiedId: `${runtime}:r`,
    runtime,
    identity: { name: 'work', domain: 'work' },
    nativeBindingRef: 'binding',
    nativeSessionRef: { kind: 'native-id', id: 'native' },
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
}
function input(
  overrides: Partial<NodeSessionResumeLaunchInput> = {},
): NodeSessionResumeLaunchInput {
  return {
    store: {
      readNativeBinding: vi.fn(async () => ({
        ref: 'binding',
        runtime: 'claude',
        identity: { name: 'work', domain: 'work' },
      })),
    } as never,
    environment: { APPDATA: '/appdata', LOCALAPPDATA: '/local' },
    context: {},
    catalogRoot: async () => '/catalog',
    status: () => ({
      snapshot: mocks.status.mockImplementation(
        async () =>
          ({
            schemaVersion: 1,
            project: { id: 'sample/app', cwd },
            worktree: { id: null, path: null, role: null, branch: null },
            portResolution: 'missing',
            services: [{ id: 'web', status: 'running', port: 4321 }],
            diagnostics: [],
          }) as never,
      ),
    }),
    executionRoots: async () => ({ artifactsRoot: '/artifacts', stateRoot: '/state' }),
    discoverProjectConfig: async () => ({
      root: cwd,
      path: `${cwd}/mpxconfig.json`,
      config: {
        schemaVersion: 1,
        project: { id: 'sample/app' },
        repository: { provider: 'generic', remote: 'origin' },
      },
    }),
    ...overrides,
  };
}

describe('Node session resume launch composition', () => {
  it('fails closed for explicit Docker without host fallback or downstream execution', async () => {
    const base = input();
    const read = vi.fn(base.store.readNativeBinding.bind(base.store));
    const discover = vi.fn(base.discoverProjectConfig!);
    const status = vi.fn(base.status);
    mocks.execute.mockClear();
    const service = createNodeSessionResumeLaunchApplicationService({
      ...base,
      environment: { APPDATA: '/appdata' },
      store: { readNativeBinding: read } as never,
      discoverProjectConfig: discover,
      status,
      context: {},
    });
    const hostPlan = plan();
    const dockerPlan = {
      ...hostPlan,
      launch: {
        ...hostPlan.launch,
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
    expect(read).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(['NATIVE_ROOT_INVALID', 'OAUTH_UNAVAILABLE'])(
    'fails closed on Pi native preflight %s before project discovery',
    async (sourceCode) => {
      const events: string[] = [];
      const base = input();
      const service = createNodeSessionResumeLaunchApplicationService({
        ...base,
        store: {
          readNativeBinding: async () => ({
            ref: 'binding',
            runtime: 'pi',
            identity: { name: 'work', domain: 'work' },
          }),
        } as never,
        context: {
          exactNativeRootVerifier: {
            verify: async () => {
              events.push('verify');
              throw Object.assign(new Error(sourceCode), { code: sourceCode });
            },
          } as never,
          piAuthVerifier: {
            verify: async () => {
              events.push('oauth');
            },
          },
        },
        discoverProjectConfig: async () => {
          events.push('project');
          return undefined;
        },
      });
      await expect(service.prepare(plan('pi'), user)).rejects.toMatchObject({
        code: 'SESSION_RESUME_NATIVE_PREFLIGHT_UNAVAILABLE',
      });
      expect(events).toEqual(['verify']);
    },
  );

  it('reverifies Pi once before discovery and once at the child boundary', async () => {
    const events: string[] = [];
    const base = input();
    mocks.execute.mockImplementationOnce(async (execution) => {
      events.push('execution');
      await execution.beforeChildExecution?.();
      events.push('child');
      return { exitCode: 0 };
    });
    await executeNodeSessionResumeLaunch(
      {
        ...base,
        store: {
          readNativeBinding: async () => ({
            ref: 'binding',
            runtime: 'pi',
            identity: { name: 'work', domain: 'work' },
          }),
        } as never,
        context: {
          exactNativeRootVerifier: {
            verify: async () => {
              events.push('verify');
              return {};
            },
          } as never,
          piAuthVerifier: {
            verify: async () => {
              events.push('oauth');
            },
          },
        },
        discoverProjectConfig: async (value) => {
          events.push('project');
          return base.discoverProjectConfig!(value);
        },
      },
      plan('pi'),
      user,
    );
    expect(events).toEqual(['verify', 'oauth', 'project', 'execution', 'verify', 'oauth', 'child']);
  });

  it('maps resurrection approval to host approval only at resume execution', async () => {
    mocks.execute.mockClear();
    const resumePlan = plan();

    await executeNodeSessionResumeLaunch(input(), resumePlan, user, { approveHost: true });

    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ approveHost: true }));
  });

  it('maps the exact host resume target into execution', async () => {
    mocks.execute.mockClear();
    const resumePlan = plan();
    await executeNodeSessionResumeLaunch(input(), resumePlan, user, {});
    const execution = mocks.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(execution).toEqual(
      expect.objectContaining({
        resume: {
          nativeBinding: await input().store.readNativeBinding('binding'),
          nativeSessionRef: resumePlan.nativeSessionRef,
        },
      }),
    );
    expect(execution).not.toHaveProperty('branch');
    expect(execution).toMatchObject({ artifactsRoot: '/artifacts', stateRoot: '/state' });
  });
});
