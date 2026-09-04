import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import type { ResumePlanV1 } from '@mpx/sessions';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (input: { beforeChildExecution?: () => Promise<void> }) => {
    await input.beforeChildExecution?.();
    return { exitCode: 0 };
  }),
  setResumeAction: vi.fn(),
  workerClientAvailable: true,
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
vi.mock('../../src/node/launch-execution.js', () => ({
  executeResolvedNodeLaunch: mocks.execute,
}));
vi.mock('../../src/node/sbx-execution.js', () => ({
  createProductionSbxExecutionAdapter: vi.fn(async () => ({
    name: 'docker',
    verify: async () => ({
      status: 'verified',
      verifier: 'sbx-test',
      evidenceDigest: 'a'.repeat(64),
    }),
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
    ...(mocks.workerClientAvailable ? { remoteToolClient: {} } : {}),
    setResumeAction: mocks.setResumeAction,
  })),
}));
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
      executor: { kind: 'docker' },
      workspace: 'clone',
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
        accountBindingRef: null,
      })),
    } as never,
    environment: { APPDATA: '/appdata', LOCALAPPDATA: '/local' },
    context: {
      sessionDockerResumeAdmission: async () => ({
        admitted: true,
        action: 'attach',
        sandboxName: 'exact-sandbox',
      }),
    },
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
    stateRoot: () => '/state',
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
  it('short-circuits every Node resume port when Docker admission is denied without local state', async () => {
    const base = input();
    const read = vi.fn(base.store.readNativeBinding.bind(base.store));
    const discover = vi.fn(base.discoverProjectConfig!);
    const status = vi.fn(base.status);
    const stateRoot = vi.fn(base.stateRoot);
    const service = createNodeSessionResumeLaunchApplicationService({
      ...base,
      environment: { APPDATA: '/appdata' },
      store: { readNativeBinding: read } as never,
      discoverProjectConfig: discover,
      status,
      stateRoot,
      context: {
        sessionDockerResumeAdmission: async () => ({
          admitted: false,
          code: 'F2_ADMISSION_DENIED',
          hostFallback: false,
          recreate: { required: true, reasons: ['proof'] },
        }),
      },
    });
    await expect(service.prepare(plan(), user)).rejects.toMatchObject({
      code: 'SESSION_RESUME_F2_ADMISSION_DENIED',
    });
    expect(read).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(stateRoot).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it.each([
    ['ACCOUNT_ROOT_DUPLICATE', 'SESSION_RESUME_ACCOUNT_DUPLICATE'],
    ['ACCOUNT_ROOT_CHANGED', 'SESSION_RESUME_ACCOUNT_MISMATCH'],
    ['OAUTH_UNAVAILABLE', 'SESSION_RESUME_ACCOUNT_UNAVAILABLE'],
  ])('maps Pi verification %s before project discovery', async (sourceCode, expectedCode) => {
    const events: string[] = [];
    const base = input();
    const service = createNodeSessionResumeLaunchApplicationService({
      ...base,
      store: {
        readNativeBinding: async () => ({
          ref: 'binding',
          runtime: 'pi',
          identity: { name: 'work', domain: 'work' },
          accountBindingRef: 'account',
        }),
      } as never,
      context: {
        sessionDockerResumeAdmission: base.context.sessionDockerResumeAdmission!,
        rootAttestationService: {
          store: { list: async () => [] },
          verify: async () => {
            events.push('verify');
            throw Object.assign(new Error(sourceCode), { code: sourceCode });
          },
        } as never,
        accountAuthVerifier: {
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
    await expect(service.prepare(plan('pi'), user)).rejects.toMatchObject({ code: expectedCode });
    expect(events).toEqual(['verify']);
  });

  it('fails closed before Pi Docker resume when no sandbox worker client exists', async () => {
    const base = input();
    mocks.execute.mockClear();
    mocks.workerClientAvailable = false;
    try {
      await expect(
        executeNodeSessionResumeLaunch(
          {
            ...base,
            store: {
              readNativeBinding: async () => ({
                ref: 'binding',
                runtime: 'pi',
                identity: { name: 'work', domain: 'work' },
                accountBindingRef: 'account',
              }),
            } as never,
            context: {
              sessionDockerResumeAdmission: base.context.sessionDockerResumeAdmission!,
              rootAttestationService: {
                store: { list: async () => [] },
                verify: async () => ({}),
              } as never,
              accountAuthVerifier: { verify: async () => undefined },
            },
          },
          plan('pi'),
          user,
        ),
      ).rejects.toMatchObject({ code: 'PI_SANDBOX_WORKER_UNAVAILABLE' });
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      mocks.workerClientAvailable = true;
    }
  });

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
            accountBindingRef: 'account',
          }),
        } as never,
        context: {
          sessionDockerResumeAdmission: base.context.sessionDockerResumeAdmission!,
          rootAttestationService: {
            store: { list: async () => [] },
            verify: async () => {
              events.push('verify');
              return {};
            },
          } as never,
          accountAuthVerifier: {
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
    const hostPlan = {
      ...resumePlan,
      launch: {
        ...resumePlan.launch,
        executor: { kind: 'host' as const },
        workspace: 'direct' as const,
      },
    };

    await executeNodeSessionResumeLaunch(input(), hostPlan, user, { approveHost: true });

    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ approveHost: true }));
  });

  it.each([
    [undefined, 'resume'],
    [{ executable: 'pi', argv: ['--fork', 'native'] }, 'branch'],
  ] as const)('maps SBX status and %s execution input', async (branchInvocation, expected) => {
    mocks.execute.mockClear();
    mocks.setResumeAction.mockClear();
    mocks.status.mockClear();
    mocks.resolveLaunch.mockClear();
    const resumePlan = plan();
    await executeNodeSessionResumeLaunch(
      input(branchInvocation ? { branchInvocation } : {}),
      resumePlan,
      user,
      branchInvocation ? { approveHost: true } : {},
    );
    expect(mocks.status).toHaveBeenCalled();
    expect(mocks.setResumeAction).toHaveBeenCalledWith('attach');
    expect(mocks.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerAvailability: 'available',
        executorVerification: {
          status: 'verified',
          verifier: 'sbx-test',
          evidenceDigest: 'a'.repeat(64),
        },
      }),
    );
    const execution = mocks.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(execution).toEqual(
      expect.objectContaining(
        expected === 'branch'
          ? {
              branch: {
                nativeBinding: await input().store.readNativeBinding('binding'),
                invocation: branchInvocation,
              },
            }
          : {
              resume: {
                nativeBinding: await input().store.readNativeBinding('binding'),
                nativeSessionRef: resumePlan.nativeSessionRef,
              },
            },
      ),
    );
    expect(execution).not.toHaveProperty(expected === 'resume' ? 'branch' : 'resume');
    if (branchInvocation) {
      expect(execution).not.toHaveProperty('approveHost');
    }
    expect(execution).toMatchObject({ artifactsRoot: '/artifacts', stateRoot: '/state' });
  });
});
