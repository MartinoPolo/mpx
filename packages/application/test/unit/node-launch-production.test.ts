import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { MpxError } from '@mpx/core';
import type { NodeLaunchExecutionInput } from '../../src/node/launch-execution.js';

const executionSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ exitCode: 0 })));
vi.mock('../../src/node/launch-execution.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/node/launch-execution.js')>()),
  executeResolvedNodeLaunch: executionSpy,
}));

import { createNodeLaunchApplicationService } from '../../src/node/index.js';

const user: UserConfig = {
  schemaVersion: 2,
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/native/work/claude', pi: 'C:/native/work/pi' },
      gitAuthorRoute: 'git-work',
      allowedSkillPacks: ['development'],
    },
  },
  domains: { work: [process.cwd()] },
  locations: { work: { roots: [process.cwd()], skillPacks: ['development'] } },
  modes: {
    developer: { resources: { 'selected-project': 'read-write' } },
    project: { resources: { 'selected-project': 'read-write' } },
  },
  presets: {
    standard: {
      identity: 'work',
      mode: 'project',
      executor: 'host',
      workspace: 'direct',
      networkPolicy: 'implementation',
    },
  },
  launchDefaults: { projects: {}, locations: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: { host: {}, docker: {} },
};

const catalogRoot = path.resolve(import.meta.dirname, '../../../../content/skills');

const verifiedHost = {
  name: 'host' as const,
  assertReady: async () => undefined,
  execute: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
};

function factory(overrides: Record<string, unknown> = {}) {
  return createNodeLaunchApplicationService({
    cwd: process.cwd(),
    catalogRoot,
    userConfig: user,
    environment: { APPDATA: 'C:/appdata', LOCALAPPDATA: 'C:/local' },
    context: { launchExecutorAdapters: [verifiedHost] },
    interaction: { json: true, reason: 'production fixture', approveHost: true },
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
    executor: 'host',
    workspace: 'direct',
    ...overrides,
  });
  return service.resolve(prepared, {
    reason: typeof overrides.reason === 'string' ? overrides.reason : 'production fixture',
  });
}

describe('Node launch production factory', () => {
  it('fails closed for explicit Docker without host fallback or downstream execution', async () => {
    executionSpy.mockClear();
    const status = vi.fn(() => ({}) as never);
    const sessions = vi.fn(() => ({}) as never);
    const service = factory({ status, sessions });
    const error = await service
      .prepare({
        operation: 'launch',
        cwd: process.cwd(),
        catalogRoot,
        userConfig: user,
        runtime: 'pi',
        identity: 'work',
        executor: 'docker',
        workspace: 'clone',
      })
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(MpxError);
    expect(error).toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
      details: { executor: 'docker', hostFallback: false },
    });
    expect(status).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(executionSpy).not.toHaveBeenCalled();
  });

  it('uses explicit noninteractive host approval without consulting a TTY', async () => {
    executionSpy.mockClear();
    const confirm = vi.fn(async () => {
      throw new Error('TTY confirmation must not run');
    });
    const host = {
      name: 'host' as const,
      assertReady: async () => undefined,
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

  it('performs exact-root and Pi auth verification initially and before child execution', async () => {
    executionSpy.mockClear();
    const verifyRoot = vi.fn(async () => undefined);
    const verifyAuth = vi.fn(async () => undefined);
    const service = factory({
      context: {
        launchExecutorAdapters: [verifiedHost],
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
    const service = factory({ sessions, context: { launchExecutorAdapters: [verifiedHost] } });
    await service.execute(await resolvedLaunch(service));
    const execution = executionSpy.mock.calls[0]![0] as NodeLaunchExecutionInput;
    expect(execution.context.launchLifecycleBridge).toBeDefined();
    expect(sessions).toHaveBeenCalledOnce();
  });

  it('keeps candidate and no-runtime selection explanations free of mutable production services', async () => {
    const status = vi.fn(() => {
      throw new Error('status must remain lazy');
    });
    const sessions = vi.fn(() => {
      throw new Error('sessions must remain lazy');
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
  });
});
