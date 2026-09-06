import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { ExecutionError } from '@mpx/executors';
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

  it('routes production Pi Docker launch to the shared typed fail-closed boundary', async () => {
    executionSpy.mockClear();
    sbxAdapterFactory.mockReset();
    const verify = vi.fn(verifiedDocker.verify);
    sbxAdapterFactory.mockResolvedValue({ ...verifiedDocker, verify });
    executionSpy.mockRejectedValueOnce(
      new ExecutionError(
        'PI_DOCKER_UNAVAILABLE',
        'Pi Docker execution is unavailable pending whole-agent sandbox isolation.',
        { executor: 'docker', runtime: 'pi' },
      ),
    );
    const service = factory({
      context: {
        exactNativeRootVerifier: { verify: async () => undefined },
        piAuthVerifier: { verify: async () => undefined },
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

    const resolved = await resolvedLaunch(service);
    const error = await service.execute(resolved).catch((failure) => failure);
    expect(error).toMatchObject({
      name: 'ExecutionError',
      code: 'PI_DOCKER_UNAVAILABLE',
      details: { executor: 'docker', runtime: 'pi' },
    });
    expect(JSON.stringify(error)).not.toContain('private-account-reference');
    expect(executionSpy).toHaveBeenCalledOnce();
    expect(
      (executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput).context
        .launchExecutorAdapterSource,
    ).toBe('production-admission');
    expect(verify).toHaveBeenCalledOnce();
  });

  it('performs exact-root and Pi auth verification initially and before child execution', async () => {
    executionSpy.mockClear();
    const verifyRoot = vi.fn(async () => undefined);
    const verifyAuth = vi.fn(async () => undefined);
    const service = factory({
      context: {
        launchExecutorAdapters: [verifiedDocker],
        exactNativeRootVerifier: { verify: verifyRoot },
        piAuthVerifier: { verify: verifyAuth },
      },
    });

    await service.execute(await resolvedLaunch(service));
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(verifyRoot).toHaveBeenCalledOnce();
    expect(verifyAuth).toHaveBeenCalledOnce();
    await execution.beforeChildExecution!();
    expect(verifyRoot).toHaveBeenCalledTimes(2);
    expect(verifyAuth).toHaveBeenCalledTimes(2);
    expect(verifyRoot).toHaveBeenCalledWith('C:/native/work/pi');
  });

  it('creates a lifecycle bridge without account authority', async () => {
    executionSpy.mockClear();
    const sessions = vi.fn(() => ({}));
    const service = factory({ sessions, context: { launchExecutorAdapters: [verifiedDocker] } });
    await service.execute(await resolvedLaunch(service));
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(execution.context.launchLifecycleBridge).toBeDefined();
    expect(sessions).toHaveBeenCalledOnce();
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
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
