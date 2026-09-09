import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { LaunchApplicationService } from '../../src/index.js';

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
  modes: { project: { resources: { 'selected-project': 'read-write' } } },
  presets: {
    standard: {
      identity: 'work',
      mode: 'project',
      executor: 'docker',
      workspace: 'clone',
      networkPolicy: 'implementation',
    },
  },
  launchDefaults: { projects: { 'sample/app': { work: 'standard' } }, locations: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: { host: {}, docker: {} },
};

function dependencies(events: string[] = []) {
  return {
    discoverProjectConfig: async () => ({
      root: process.cwd(),
      path: `${process.cwd()}/mpxconfig.json`,
      config: {
        schemaVersion: 1 as const,
        project: { id: 'sample/app' },
        repository: { provider: 'generic', remote: 'origin' },
      },
    }),
    inventoryCanonical: async () => [],
    inventoryProjectSkills: async () => ({ skills: [], diagnostics: [] }),
    statusSnapshot: async () => ({
      schemaVersion: 1 as const,
      project: { id: 'sample/app', cwd: process.cwd() },
      worktree: { id: null, path: null, role: null, branch: null },
      portResolution: 'missing' as const,
      services: [],
      diagnostics: [],
    }),
    prepareExecutor: async () => ({
      assertReady: async () => {
        events.push('ready');
      },
      execute: async () => ({ exitCode: 0 }),
    }),
    approveHost: async () => ({ reason: 'test', approvalKey: 'a'.repeat(64) }),
    piPreflight: async () => {
      events.push('native-root');
    },
    launchExecution: async () => {
      events.push('execute');
      return { exitCode: 0 };
    },
  };
}

const request = {
  operation: 'launch' as const,
  cwd: process.cwd(),
  catalogRoot: 'C:/catalog',
  userConfig: user,
  runtime: 'pi' as const,
  identity: 'work',
};

describe('LaunchApplicationService', () => {
  it('explains a no-runtime identity selection exactly without launch side effects', async () => {
    const inventoryCanonical = vi.fn(async () => []);
    const inventoryProjectSkills = vi.fn(async () => ({ skills: [], diagnostics: [] }));
    const statusSnapshot = vi.fn(dependencies().statusSnapshot);
    const prepareExecutor = vi.fn(dependencies().prepareExecutor);
    const piPreflight = vi.fn(async () => undefined);
    const launchExecution = vi.fn(dependencies().launchExecution);
    const service = new LaunchApplicationService({
      ...dependencies(),
      inventoryCanonical,
      inventoryProjectSkills,
      statusSnapshot,
      prepareExecutor,
      piPreflight,
      launchExecution,
    });

    const result = await service.explainSelection({
      cwd: process.cwd(),
      userConfig: user,
      identity: 'work',
    });

    expect(result).toEqual({
      data: {
        schemaVersion: 1,
        runtime: null,
        identity: { name: 'work', domain: 'work' },
        selection: {
          mode: { name: 'project' },
          selection: {
            location: { name: 'work', canonicalRoot: expect.any(String) },
            packs: ['development'],
            source: 'user-location',
          },
          executor: 'docker',
          workspace: 'clone',
          networkPolicy: { name: 'implementation' },
          preset: 'standard',
          provenance: {
            runtime: 'explicit',
            identity: 'explicit',
            mode: 'user-project',
            executor: 'user-project',
            workspace: 'user-project',
            networkPolicy: 'user-project',
          },
          cwdClassification: { domain: 'work', location: 'work' },
        },
      },
      warnings: [],
    });
    expect(inventoryCanonical).not.toHaveBeenCalled();
    expect(inventoryProjectSkills).not.toHaveBeenCalled();
    expect(statusSnapshot).not.toHaveBeenCalled();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(piPreflight).not.toHaveBeenCalled();
    expect(launchExecution).not.toHaveBeenCalled();
  });

  it('retains project identity-domain mismatch policy for no-runtime explanations', async () => {
    const service = new LaunchApplicationService({
      ...dependencies(),
      discoverProjectConfig: async () => ({
        root: process.cwd(),
        path: `${process.cwd()}/mpxconfig.json`,
        config: {
          schemaVersion: 1 as const,
          project: { id: 'sample/app' },
          repository: { provider: 'generic', remote: 'origin' },
        },
      }),
    });
    const mismatched = structuredClone(user);
    mismatched.identities.work!.domain = 'personal';

    await expect(
      service.explainSelection({ cwd: process.cwd(), userConfig: mismatched, identity: 'work' }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_DOMAIN_MISMATCH',
      message:
        "Identity 'work' cannot launch in domain 'work'. Select the owning identity or an explicit mode that admits the configured resource.",
    });
  });

  it('threads invocation-scoped runtime arguments through the descriptor into execution', async () => {
    const launchExecution = vi.fn(async () => ({ exitCode: 0 }));
    const service = new LaunchApplicationService({
      ...dependencies(),
      launchExecution,
      approveHost: async () => ({ reason: 'test', approvalKey: 'a'.repeat(64) }),
    });
    const runtimeArgs = ['--no-session', '--print', 'Reply with only: verified'];
    const prepared = await service.prepare({
      ...request,
      executor: 'host',
      workspace: 'direct',
      runtimeArgs,
    });
    const resolved = await service.resolve(prepared, { reason: 'test' });

    await service.execute(resolved);

    expect(service.descriptor(resolved).runtimeArgs).toEqual(runtimeArgs);
  });

  it('rejects runtime arguments for Docker execution', async () => {
    const service = new LaunchApplicationService(dependencies());
    await expect(service.prepare({ ...request, runtimeArgs: ['--print'] })).rejects.toMatchObject({
      code: 'RUNTIME_ARGS_EXECUTOR_UNAVAILABLE',
    });
  });

  it('rejects runtime arguments for the read-only explain operation', async () => {
    const service = new LaunchApplicationService(dependencies());
    await expect(
      service.prepare({ ...request, operation: 'explain', runtimeArgs: ['--print'] }),
    ).rejects.toMatchObject({ code: 'RUNTIME_ARGS_SCOPE_INVALID' });
  });

  it('fails Docker launch preparation before status, executor preparation, or process execution', async () => {
    const statusSnapshot = vi.fn(dependencies().statusSnapshot);
    const selectedProcess = vi.fn(async () => ({ exitCode: 0 }));
    const prepareExecutor = vi.fn(async () => ({
      assertReady: async () => undefined,
      execute: selectedProcess,
    }));
    const piPreflight = vi.fn(dependencies().piPreflight);
    const launchExecution = vi.fn(dependencies().launchExecution);
    const service = new LaunchApplicationService({
      ...dependencies(),
      statusSnapshot,
      prepareExecutor,
      piPreflight,
      launchExecution,
    });
    await expect(service.prepare(request)).rejects.toMatchObject({
      code: 'EXECUTOR_UNAVAILABLE',
      details: { executor: 'docker', hostFallback: false },
    });
    expect(statusSnapshot).not.toHaveBeenCalled();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(prepareExecutor).not.toHaveBeenCalled();
    expect(piPreflight).not.toHaveBeenCalled();
    expect(selectedProcess).not.toHaveBeenCalled();
    expect(launchExecution).not.toHaveBeenCalled();
  });

  it('performs executable preconditions before selecting process execution', async () => {
    const events: string[] = [];
    const service = new LaunchApplicationService(dependencies(events));
    const prepared = await service.prepare({ ...request, executor: 'host', workspace: 'direct' });
    const resolved = await service.resolve(prepared, { reason: 'test' });
    await service.execute(resolved);
    expect(events).toEqual(['ready', 'native-root']);
  });

  it('inseparably pairs a prepared executor binding with its exact execution callback', async () => {
    const fallbackExecution = vi.fn(dependencies().launchExecution);
    const pairedExecution = vi.fn(async () => ({ exitCode: 9 }));
    const service = new LaunchApplicationService({
      ...dependencies(),
      launchExecution: fallbackExecution,
      prepareExecutor: async () => ({
        assertReady: async () => undefined,
        execute: pairedExecution,
      }),
    });
    const prepared = await service.prepare({ ...request, executor: 'host', workspace: 'direct' });
    const resolved = await service.resolve(prepared, { reason: 'test' });
    const result = await service.execute(resolved);
    expect(result.exitCode).toBe(9);
    expect(pairedExecution).toHaveBeenCalledTimes(1);
    expect(fallbackExecution).not.toHaveBeenCalled();
  });

  it('keeps admission executors and Pi preflight callbacks private to interleaved launches', async () => {
    let admitted = 0;
    let preflighted = 0;
    const executions: Array<{ verifier: string }> = [];
    const service = new LaunchApplicationService({
      ...dependencies(),
      prepareExecutor: async () => {
        const launch = ++admitted;
        return {
          assertReady: async () => undefined,
          execute: async () => {
            executions.push({ verifier: `executor-${launch}` });
            return { exitCode: launch };
          },
        };
      },
      piPreflight: async () => {
        ++preflighted;
        return { beforeChildExecution: async () => undefined };
      },
    });
    const preparedA = await service.prepare({ ...request, executor: 'host', workspace: 'direct' });
    const preparedB = await service.prepare({ ...request, executor: 'host', workspace: 'direct' });
    const resolvedA = await service.resolve(preparedA, { reason: 'test' });
    const resolvedB = await service.resolve(preparedB, { reason: 'test' });

    expect((await service.execute(resolvedA)).exitCode).toBe(1);
    expect((await service.execute(resolvedB)).exitCode).toBe(2);
    expect(executions).toEqual([{ verifier: 'executor-1' }, { verifier: 'executor-2' }]);
    expect(preflighted).toBe(2);
    await expect(service.execute(Object.freeze({}) as never)).rejects.toMatchObject({
      code: 'LAUNCH_STATE_INVALID',
    });
  });

  it('keeps explain read-only while returning exact public launch serialization', async () => {
    const events: string[] = [];
    const service = new LaunchApplicationService(dependencies(events));
    const prepared = await service.prepare({ ...request, operation: 'explain' });
    const resolved = await service.resolve(prepared);
    const result = await service.execute(resolved);
    expect(service.descriptor(resolved)).toEqual(result.data);
    expect(result.data).toMatchObject({
      schemaVersion: 3,
      runtime: 'pi',
      identity: { name: 'work' },
    });
    expect(events).toEqual([]);
  });

  it('surfaces project skill inventory diagnostics before executor preparation', async () => {
    const prepareExecutor = vi.fn();
    const service = new LaunchApplicationService({
      ...dependencies(),
      inventoryProjectSkills: async () => ({
        skills: [],
        diagnostics: [{ code: 'PROJECT_SKILL_INVALID', message: 'invalid synthetic skill' }],
      }),
      prepareExecutor,
    });
    await expect(
      service.prepare({ ...request, executor: 'host', workspace: 'direct' }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVALID' }],
    });
    expect(prepareExecutor).not.toHaveBeenCalled();
  });

  it('propagates malformed project discovery and never treats it as missing', async () => {
    const malformed = new Error('malformed discovery');
    const service = new LaunchApplicationService({
      ...dependencies(),
      discoverProjectConfig: async () => {
        throw malformed;
      },
    });
    await expect(service.prepare(request)).rejects.toBe(malformed);
  });

  it('preserves missing work-project fallback provenance and warning through execution', async () => {
    const fallbackUser = structuredClone(user);
    fallbackUser.modes.developer = {
      resources: { 'identity-domain': 'read-write', 'cloned-repositories': 'read-only' },
    };
    const launchExecution = vi.fn(async () => ({ exitCode: 0 }));
    const service = new LaunchApplicationService({
      ...dependencies(),
      discoverProjectConfig: async () => undefined,
      launchExecution,
    });
    const prepared = await service.prepare({
      ...request,
      userConfig: fallbackUser,
      executor: 'host',
      workspace: 'direct',
    });
    const resolved = await service.resolve(prepared, { reason: 'test' });
    expect(service.descriptor(resolved)).toMatchObject({
      mode: 'developer',
      provenance: { mode: 'automatic-fallback' },
      diagnostics: [expect.objectContaining({ code: 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK' })],
    });
    await expect(service.execute(resolved)).resolves.toMatchObject({
      silent: true,
      warnings: [expect.objectContaining({ code: 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK' })],
    });
  });

  it('uses synthetic status for directory projects without invoking Git status discovery', async () => {
    const statusSnapshot = vi.fn(dependencies().statusSnapshot);
    const launchExecution = vi.fn(async (input) => {
      await expect(input.statusSnapshot()).resolves.toMatchObject({
        project: { id: 'sample/app' },
        worktree: { id: null, path: null },
      });
      return { exitCode: 0 };
    });
    const service = new LaunchApplicationService({
      ...dependencies(),
      discoverProjectConfig: async () => ({
        root: process.cwd(),
        path: `${process.cwd()}/mpxconfig.json`,
        config: {
          schemaVersion: 1 as const,
          project: { id: 'sample/app', kind: 'directory' as const },
        },
      }),
      statusSnapshot,
      launchExecution,
    });
    const prepared = await service.prepare({ ...request, executor: 'host', workspace: 'direct' });
    await service.execute(await service.resolve(prepared, { reason: 'test' }));
    expect(statusSnapshot).not.toHaveBeenCalled();
  });

  it('rejects forged immutable preparation state', async () => {
    const service = new LaunchApplicationService(dependencies());
    await expect(service.resolve(Object.freeze({}) as never)).rejects.toMatchObject({
      code: 'LAUNCH_STATE_INVALID',
    });
  });

  it('returns sorted identity candidates without inventory or executor side effects', async () => {
    const inventory = vi.fn(async () => []);
    const service = new LaunchApplicationService({
      ...dependencies(),
      inventoryCanonical: inventory,
    });
    const result = await service.prepareCandidates({
      operation: 'explain',
      cwd: process.cwd(),
      userConfig: user,
    });
    expect(result.data).toEqual({
      schemaVersion: 1,
      identity: null,
      runtime: null,
      candidates: [expect.objectContaining({ identity: 'work', identityDomainCompatible: true })],
    });
    expect(inventory).not.toHaveBeenCalled();
  });
});
