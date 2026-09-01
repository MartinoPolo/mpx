import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { LaunchApplicationService } from '../../src/index.js';

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
  launchDefaults: { projects: { 'sample/app': { work: 'standard' } }, scopes: {} },
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
    dockerAdmission: async () => {
      events.push('admission');
    },
    executorEvidence: async () => {
      events.push('evidence');
      return { status: 'verified' as const, verifier: 'synthetic', evidenceDigest: 'a'.repeat(64) };
    },
    accountPreflight: async () => {
      events.push('account');
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
    const dockerDiagnostics = vi.fn(async () => undefined);
    const executorEvidence = vi.fn(dependencies().executorEvidence);
    const accountPreflight = vi.fn(async () => undefined);
    const launchExecution = vi.fn(dependencies().launchExecution);
    const service = new LaunchApplicationService({
      ...dependencies(),
      inventoryCanonical,
      inventoryProjectSkills,
      statusSnapshot,
      dockerDiagnostics,
      executorEvidence,
      accountPreflight,
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
          skillPolicy: { name: 'clean' },
          contentScope: { name: 'work' },
          executor: 'docker',
          workspace: 'clone',
          networkPolicy: { name: 'implementation' },
          preset: 'standard',
          provenance: {
            runtime: 'explicit',
            identity: 'explicit',
            mode: 'user-project',
            skillPolicy: 'user-project',
            contentScope: 'user-project',
            executor: 'user-project',
            workspace: 'user-project',
            networkPolicy: 'user-project',
          },
          cwdClassification: { domain: 'work', contentScope: 'work' },
        },
      },
      warnings: [],
    });
    expect(inventoryCanonical).not.toHaveBeenCalled();
    expect(inventoryProjectSkills).not.toHaveBeenCalled();
    expect(statusSnapshot).not.toHaveBeenCalled();
    expect(dockerDiagnostics).not.toHaveBeenCalled();
    expect(executorEvidence).not.toHaveBeenCalled();
    expect(accountPreflight).not.toHaveBeenCalled();
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
    ).rejects.toMatchObject({ code: 'IDENTITY_DOMAIN_MISMATCH' });
  });

  it('performs executable preconditions before child execution', async () => {
    const events: string[] = [];
    const service = new LaunchApplicationService(dependencies(events));
    const prepared = await service.prepare(request);
    const resolved = await service.resolve(prepared);
    await service.execute(resolved);
    expect(events).toEqual(['admission', 'evidence', 'account', 'execute']);
  });

  it('inseparably pairs prepared Docker evidence with its exact execution callback', async () => {
    const fallbackEvidence = vi.fn(dependencies().executorEvidence);
    const fallbackExecution = vi.fn(dependencies().launchExecution);
    const pairedExecution = vi.fn(async () => ({ exitCode: 9 }));
    const service = new LaunchApplicationService({
      ...dependencies(),
      executorEvidence: fallbackEvidence,
      launchExecution: fallbackExecution,
      prepareExecutor: async () => ({
        evidence: { status: 'verified', verifier: 'paired', evidenceDigest: 'b'.repeat(64) },
        execute: pairedExecution,
      }),
    });
    const prepared = await service.prepare(request);
    const resolved = await service.resolve(prepared);
    const result = await service.execute(resolved);
    expect(service.descriptor(resolved).executorVerification).toMatchObject({ verifier: 'paired' });
    expect(result.exitCode).toBe(9);
    expect(pairedExecution).toHaveBeenCalledTimes(1);
    expect(fallbackEvidence).not.toHaveBeenCalled();
    expect(fallbackExecution).not.toHaveBeenCalled();
  });

  it('keeps admission executors and account bindings private to interleaved resolved launches', async () => {
    let admitted = 0;
    let preflighted = 0;
    const executions: Array<{ verifier: string; accountBindingRef?: string }> = [];
    const service = new LaunchApplicationService({
      ...dependencies(),
      dockerAdmission: async () => {
        const launch = ++admitted;
        return {
          evidence: {
            status: 'verified' as const,
            verifier: `docker-${launch}`,
            evidenceDigest: String(launch).repeat(64),
          },
          execute: async (input) => {
            executions.push({
              verifier: input.descriptor.executorVerification.verifier,
              ...(input.accountBindingRef ? { accountBindingRef: input.accountBindingRef } : {}),
            });
            return { exitCode: launch };
          },
        };
      },
      accountPreflight: async () => {
        const launch = ++preflighted;
        return {
          accountBindingRef: `account-${launch}`,
          beforeChildExecution: async () => undefined,
        };
      },
    });
    const preparedA = await service.prepare(request);
    const preparedB = await service.prepare(request);
    const resolvedA = await service.resolve(preparedA);
    const resolvedB = await service.resolve(preparedB);

    expect((await service.execute(resolvedA)).exitCode).toBe(1);
    expect((await service.execute(resolvedB)).exitCode).toBe(2);
    expect(executions).toEqual([
      { verifier: 'docker-1', accountBindingRef: 'account-1' },
      { verifier: 'docker-2', accountBindingRef: 'account-2' },
    ]);
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
      schemaVersion: 2,
      runtime: 'pi',
      identity: { name: 'work' },
    });
    expect(events).toEqual([]);
  });

  it('surfaces project skill inventory diagnostics before admission', async () => {
    const admission = vi.fn();
    const service = new LaunchApplicationService({
      ...dependencies(),
      inventoryProjectSkills: async () => ({
        skills: [],
        diagnostics: [{ code: 'PROJECT_SKILL_INVALID', message: 'invalid synthetic skill' }],
      }),
      dockerAdmission: admission,
    });
    await expect(service.prepare(request)).rejects.toMatchObject({
      diagnostics: [{ code: 'PROJECT_SKILL_INVALID' }],
    });
    expect(admission).not.toHaveBeenCalled();
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
