import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import type { NodeLaunchExecutionInput } from '../../src/node/launch-execution.js';

const executionSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ exitCode: 0 })));
const sbxAdapterFactory = vi.hoisted(() => vi.fn());
vi.mock('../../src/node/launch-execution.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/node/launch-execution.js')>()),
  executeResolvedNodeLaunch: executionSpy,
}));
vi.mock('../../src/node/sbx-execution.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/node/sbx-execution.js')>()),
  createProductionSbxExecutionAdapter: sbxAdapterFactory,
}));

import { createNodeLaunchApplicationService } from '../../src/node/index.js';

const user: UserConfig = {
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/native/work/claude', pi: 'C:/native/work/pi' },
      gitAuthorRoute: 'git-work',
    },
  },
  domains: { work: [process.cwd()] },
  contentScopes: { work: { roots: [process.cwd()], skillPacks: ['core'] } },
  modes: { project: { resources: { 'selected-project': 'read-write' } } },
  skillPolicies: { clean: { skillExposure: { default: 'explicit-only' } } },
  presets: {
    standard: {
      identity: 'work',
      mode: 'project',
      skillPolicy: 'clean',
      contentScope: 'work',
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    },
  },
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: { host: {}, docker: {} },
};

const catalogRoot = path.resolve(import.meta.dirname, '../../../../content/skills');

const verifiedDocker = {
  name: 'docker' as const,
  verify: async () => ({
    status: 'verified' as const,
    verifier: 'test-docker',
    evidenceDigest: 'd'.repeat(64),
  }),
  execute: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
};

function factory(overrides: Record<string, unknown> = {}) {
  return createNodeLaunchApplicationService({
    cwd: process.cwd(),
    catalogRoot,
    userConfig: user,
    environment: { APPDATA: 'C:/appdata', LOCALAPPDATA: 'C:/local' },
    context: { launchExecutorAdapters: [verifiedDocker] },
    interaction: { json: true },
    discoverProjectConfig: async () => ({
      root: process.cwd(),
      path: path.join(process.cwd(), 'mpxconfig.json'),
      config: {
        schemaVersion: 1,
        project: { id: 'sample/app' },
        repository: { provider: 'generic', remote: 'origin' },
      },
    }),
    status: () => ({}) as never,
    sessions: () => ({}) as never,
    stateRoot: () => 'C:/state',
    ...overrides,
  });
}

async function resolvedLaunch(
  service: ReturnType<typeof factory>,
  overrides: Record<string, unknown> = {},
) {
  const prepared = await service.prepare({
    operation: 'launch',
    cwd: process.cwd(),
    catalogRoot,
    userConfig: user,
    runtime: 'pi',
    identity: 'work',
    ...overrides,
  });
  return service.resolve(
    prepared,
    typeof overrides.reason === 'string' ? { reason: overrides.reason } : {},
  );
}

describe('Node launch production factory', () => {
  it('uses explicit noninteractive host approval without consulting a TTY', async () => {
    executionSpy.mockClear();
    const confirm = vi.fn(async () => {
      throw new Error('TTY confirmation must not run');
    });
    const host = {
      name: 'host' as const,
      verify: async () => ({
        status: 'verified' as const,
        verifier: 'test-host',
        evidenceDigest: 'a'.repeat(64),
      }),
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
    };
    const service = factory({
      context: { launchExecutorAdapters: [host] },
      interaction: {
        json: true,
        reason: 'Suffixed Pi launcher approval',
        approveHost: true,
        tty: { direct: false, confirm },
      },
    });

    const resolved = await resolvedLaunch(service, {
      executor: 'host',
      workspace: 'direct',
      reason: 'Suffixed Pi launcher approval',
    });
    await service.execute(resolved);

    expect(confirm).not.toHaveBeenCalled();
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(execution.descriptor.elevationAudit).toMatchObject({
      elevated: true,
      reason: 'Suffixed Pi launcher approval',
    });
    expect(execution.descriptor.elevationAudit.approvalsDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(execution).toMatchObject({ approveHost: true });
  });

  it('marks Claude Docker adapters created by production admission with trusted provenance', async () => {
    executionSpy.mockClear();
    sbxAdapterFactory.mockReset();
    sbxAdapterFactory.mockResolvedValue(verifiedDocker);
    const service = factory({
      context: {},
      status: () => ({
        snapshot: async () => ({
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: process.cwd() },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'missing',
          services: [],
          diagnostics: [],
        }),
      }),
    });

    await service.execute(await resolvedLaunch(service, { runtime: 'claude' }));

    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(execution.context.launchExecutorAdapterSource).toBe('production-admission');
  });

  it('denies production Pi Docker admission when its sandbox adapter has no remote worker client', async () => {
    executionSpy.mockClear();
    sbxAdapterFactory.mockReset();
    const verify = vi.fn(verifiedDocker.verify);
    sbxAdapterFactory.mockResolvedValue({ ...verifiedDocker, verify });
    const service = factory({
      context: {},
      status: () => ({
        snapshot: async () => ({
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: process.cwd() },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'missing',
          services: [],
          diagnostics: [],
        }),
      }),
    });

    await expect(resolvedLaunch(service)).rejects.toMatchObject({
      code: 'PI_SANDBOX_WORKER_UNAVAILABLE',
      details: { executor: 'docker', runtime: 'pi' },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(executionSpy).not.toHaveBeenCalled();
  });

  it('performs initial Pi verification and binds exact pre-child reverification', async () => {
    executionSpy.mockClear();
    const verifyAttestation = vi.fn().mockResolvedValue({
      identity: { domain: 'work', name: 'work' },
      runtimeRoot: 'C:/native/work/pi',
      ref: 'pi-account-ref',
    });
    const verifyAuth = vi.fn(async () => undefined);
    const service = factory({
      context: {
        launchExecutorAdapters: [verifiedDocker],
        rootAttestationService: { verify: verifyAttestation },
        accountAuthVerifier: { verify: verifyAuth },
      },
    });

    await service.execute(await resolvedLaunch(service));
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(verifyAttestation).toHaveBeenNthCalledWith(
      1,
      { domain: 'work', name: 'work' },
      'C:/native/work/pi',
    );
    expect(verifyAuth).toHaveBeenCalledTimes(1);
    await execution.beforeChildExecution!();
    expect(verifyAttestation).toHaveBeenNthCalledWith(
      2,
      { domain: 'work', name: 'work' },
      'C:/native/work/pi',
      'pi-account-ref',
    );
    expect(verifyAuth).toHaveBeenCalledTimes(2);
  });

  it('keeps production Docker contexts and Pi account refs launch-local when resolution interleaves', async () => {
    executionSpy.mockClear();
    sbxAdapterFactory.mockReset();
    let adapterNumber = 0;
    sbxAdapterFactory.mockImplementation(async () => {
      const launch = ++adapterNumber;
      return {
        name: 'docker',
        remoteToolClient: {},
        verify: async () => ({
          status: 'verified',
          verifier: `adapter-${launch}`,
          evidenceDigest: String(launch).repeat(64),
        }),
      };
    });
    let attestationNumber = 0;
    const service = factory({
      context: {
        rootAttestationService: {
          verify: vi.fn(async () => {
            const launch = ++attestationNumber;
            return {
              identity: { domain: 'work', name: 'work' },
              runtimeRoot: 'C:/native/work/pi',
              ref: `account-${launch}`,
            };
          }),
        },
        accountAuthVerifier: { verify: vi.fn(async () => undefined) },
      },
      status: () => ({
        snapshot: async () => ({
          schemaVersion: 1,
          project: { id: 'sample/app', cwd: process.cwd() },
          worktree: { id: null, path: null, role: null, branch: null },
          portResolution: 'missing',
          services: [],
          diagnostics: [],
        }),
      }),
    });
    const resolvedA = await resolvedLaunch(service);
    const resolvedB = await resolvedLaunch(service);

    await service.execute(resolvedA);
    await service.execute(resolvedB);

    const launchA = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    const launchB = executionSpy.mock.calls[1]![0] as NodeLaunchExecutionInput;
    expect(launchA.descriptor.executorVerification.verifier).toBe('adapter-1');
    expect(launchB.descriptor.executorVerification.verifier).toBe('adapter-2');
    expect(launchA.context.launchExecutorAdapters?.[0]).not.toBe(
      launchB.context.launchExecutorAdapters?.[0],
    );
    expect(
      await (
        launchA.context.launchLifecycleBridge as never as {
          accountBindingRef(name: string, runtime: 'pi'): Promise<string | null>;
        }
      ).accountBindingRef('work', 'pi'),
    ).toBe('account-1');
    expect(
      await (
        launchB.context.launchLifecycleBridge as never as {
          accountBindingRef(name: string, runtime: 'pi'): Promise<string | null>;
        }
      ).accountBindingRef('work', 'pi'),
    ).toBe('account-2');
  });

  it('creates production lifecycle sessions with exact Pi binding and native fallback', async () => {
    executionSpy.mockClear();
    const sessions = vi.fn(() => ({}));
    const nativeResolve = vi.fn(async () => 'native-claude-ref');
    const service = factory({
      sessions,
      context: {
        launchExecutorAdapters: [verifiedDocker],
        rootAttestationService: {
          verify: vi.fn(async () => ({
            identity: { domain: 'work', name: 'work' },
            runtimeRoot: 'C:/native/work/pi',
            ref: 'exact-pi-ref',
          })),
        },
        accountAuthVerifier: { verify: vi.fn(async () => undefined) },
        nativeAccountBindingResolver: { resolve: nativeResolve },
      },
    });

    await service.execute(await resolvedLaunch(service));
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    const lifecycle = execution.context.launchLifecycleBridge as never as {
      accountBindingRef(name: string, runtime: 'claude' | 'pi'): Promise<string | null>;
    };
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(await lifecycle.accountBindingRef('work', 'pi')).toBe('exact-pi-ref');
    expect(await lifecycle.accountBindingRef('work', 'claude')).toBe('native-claude-ref');
    expect(nativeResolve).toHaveBeenCalledWith(
      { domain: 'work', name: 'work' },
      'claude',
      'C:/native/work/claude',
    );
  });

  it('rejects unsafe mutable diagnostics before adapter construction, evidence, or execution', async () => {
    executionSpy.mockClear();
    sbxAdapterFactory.mockReset();
    const adapterEvidence = vi.fn(verifiedDocker.verify);
    sbxAdapterFactory.mockResolvedValue({ ...verifiedDocker, verify: adapterEvidence });
    const diagnostics = vi.fn(async () => ({ available: true, failureCodes: [], readOnly: false }));
    const statusSnapshot = vi.fn(async () => ({
      schemaVersion: 1 as const,
      project: { id: 'sample/app', cwd: process.cwd() },
      worktree: { id: null, path: null, role: null, branch: null },
      portResolution: 'missing' as const,
      services: [],
      diagnostics: [],
    }));
    const service = factory({
      context: {},
      sbxDiagnostics: diagnostics,
      status: () => ({ snapshot: statusSnapshot }),
    });

    await expect(
      service.prepare({
        operation: 'launch',
        cwd: process.cwd(),
        catalogRoot,
        userConfig: user,
        runtime: 'pi',
        identity: 'work',
      }),
    ).rejects.toMatchObject({ code: 'SBX_DIAGNOSTICS_UNSAFE' });
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(statusSnapshot).not.toHaveBeenCalled();
    expect(sbxAdapterFactory).not.toHaveBeenCalled();
    expect(adapterEvidence).not.toHaveBeenCalled();
    expect(executionSpy).not.toHaveBeenCalled();
  });

  it('keeps candidate and no-runtime selection explanations free of mutable production services', async () => {
    const status = vi.fn(() => {
      throw new Error('status must remain lazy');
    });
    const sessions = vi.fn(() => {
      throw new Error('sessions must remain lazy');
    });
    const stateRoot = vi.fn(() => {
      throw new Error('state must remain lazy');
    });
    const diagnostics = vi.fn(async () => {
      throw new Error('diagnostics must remain lazy');
    });
    const service = createNodeLaunchApplicationService({
      cwd: process.cwd(),
      userConfig: user,
      environment: {},
      context: {},
      interaction: { json: true },
      discoverProjectConfig: async () => undefined,
      status,
      sessions,
      stateRoot,
      sbxDiagnostics: diagnostics,
    });

    const candidates = await service.prepareCandidates({
      operation: 'explain',
      cwd: process.cwd(),
      userConfig: user,
    });
    const selection = await service.explainSelection({
      cwd: process.cwd(),
      userConfig: user,
      identity: 'work',
    });

    expect(candidates.data).toMatchObject({ schemaVersion: 1, runtime: null });
    expect(selection.data).toMatchObject({ schemaVersion: 1, runtime: null });
    expect(status).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(stateRoot).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
