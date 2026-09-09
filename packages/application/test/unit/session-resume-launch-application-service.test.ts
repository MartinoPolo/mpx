import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import {
  stableDigest,
  verifyResumeConfirmation,
  type NativeVerifiedResumeSeed,
} from '@mpx/sessions';
import {
  SessionResumeLaunchApplicationService,
  type SessionResumeLaunchApplicationDependencies,
} from '../../src/index.js';

const digest = 'a'.repeat(64);
const cwd = process.cwd();
const user = {
  schemaVersion: 2,
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: '/roots/claude', pi: '/roots/pi' },
      gitAuthorRoute: 'work',
      allowedSkillPacks: ['development'],
    },
  },
  domains: { work: [cwd] },
  locations: { work: { roots: [cwd], skillPacks: ['development'] } },
  modes: { project: { resources: { 'selected-project': 'read-write' } } },
  presets: {},
  launchDefaults: { projects: {}, locations: {} },
  networkPolicies: { implementation: { preset: 'balanced' } },
  executors: { host: {}, docker: {} },
} satisfies UserConfig;

const seed: NativeVerifiedResumeSeed = {
  schemaVersion: 1,
  newLaunchRequired: true,
  previousLaunch: { launchKey: 'old', descriptorDigest: digest },
  recordId: 'r',
  runtimeQualifiedId: 'pi:r',
  runtime: 'pi',
  identity: { name: 'work', domain: 'work' },
  nativeBindingRef: 'binding',
  nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/native.jsonl' },
  nativeVerificationDigest: digest,
  cwd,
  projectId: 'sample/app',
  repositoryId: 'recorded/repository',
  launch: {
    launchKey: 'old',
    descriptorDigest: digest,
    mode: 'project',
    selection: {
      location: { name: 'work', canonicalRoot: cwd },
      packs: ['development'],
      source: 'project',
    },
    executor: { kind: 'host' },
    workspace: 'direct',
    networkPolicy: 'implementation',
    artifactKey: 'old-release-artifact',
    manifestKey: 'manifest',
  },
};

function fixture() {
  const events: string[] = [];
  let recorded = structuredClone(seed);
  let configuration: UserConfig = structuredClone(user);
  let artifactKey = 'current-release-artifact';
  let manifestKey = 'manifest';
  const execute = vi.fn(
    async (
      input: Parameters<
        Awaited<
          ReturnType<SessionResumeLaunchApplicationDependencies['prepareExecutor']>
        >['execute']
      >[0],
    ) => {
      events.push('executor');
      await input.beforeChildExecution();
      events.push('child');
      return { exitCode: 7 };
    },
  );
  const roots = vi.fn(async () => ({ artifactsRoot: '/artifacts', stateRoot: '/state' }));
  const dependencies: SessionResumeLaunchApplicationDependencies = {
    confirmationDigest: stableDigest,
    verifySeed: vi.fn(async () => structuredClone(recorded)),
    readUserConfig: async () => configuration,
    piPreflight: async () => ({
      nativeBinding: { ref: 'binding' },
      reverify: async () => {
        events.push('reverify');
      },
    }),
    isAbsolutePath: () => true,
    discoverProjectConfig: async () => {
      events.push('project');
      return {
        root: cwd,
        path: `${cwd}/mpxconfig.json`,
        config: {
          schemaVersion: 1,
          project: { id: 'sample/app' },
          repository: { provider: 'generic', remote: 'origin' },
        },
      };
    },
    canonicalRoot: async () => '/catalog',
    rebuildSkills: vi.fn(
      async () =>
        ({
          catalog: [],
          manifest: { manifestKey, decisions: [] },
          artifact: { reference: { artifactKey } },
          skillArtifact: { artifactKey: 'capability-artifact' },
        }) as never,
    ),
    prepareExecutor: async () => ({ assertReady: async () => undefined, execute }),
    resolveDescriptor: async () =>
      ({
        runtime: recorded.runtime,
        identity: recorded.identity,
        launchKey: 'new',
        mode: 'project',
        selection: recorded.launch.selection,
        executor: { name: 'host', effectiveEnforcement: 'advisory', isolation: 'none' },
        intendedPolicy: { resources: configuration.modes.project!.resources },
        routes: {
          gitAuthor: 'work',
          providers: {},
          ssh: null,
          mcp: { allow: [], shareNativeAuth: false },
        },
        workspace: 'direct',
        networkPolicy: {
          name: 'implementation',
          declaration: configuration.networkPolicies.implementation,
        },
      }) as never,
    descriptorDigest: () => 'b'.repeat(64),
    requireExecutionRoots: roots,
    readNativeBinding: async () => ({ ref: 'binding' }),
  };
  const service = new SessionResumeLaunchApplicationService(dependencies);
  return {
    service,
    dependencies,
    events,
    execute,
    roots,
    setArtifact: (value: string) => {
      artifactKey = value;
    },
    setManifest: (value: string) => {
      manifestKey = value;
    },
    setRecord: (value: NativeVerifiedResumeSeed) => {
      recorded = value;
    },
    setConfig: (value: UserConfig) => {
      configuration = value;
    },
  };
}

describe('SessionResumeLaunchApplicationService', () => {
  it('plans a cross-release runtime artifact relocation and resumes the exact native file after explicit confirmation', async () => {
    const { service, execute, roots, dependencies } = fixture();
    const plan = await service.plan(seed, user);
    expect(roots).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      launch: { artifactKey: 'current-release-artifact', launchKey: 'new' },
      previousLaunch: seed.previousLaunch,
      nativeSessionRef: seed.nativeSessionRef,
      approval: { resurrection: 'confirmation-required' },
    });
    expect(plan.launch.artifactKey).not.toBe('capability-artifact');
    verifyResumeConfirmation(plan, plan.confirmationDigest);
    const result = await service.execute(await service.prepare(plan, user));
    expect(result).toMatchObject({
      exitCode: 7,
      resumeLaunch: { previousLaunchKey: 'old', newLaunchKey: 'new' },
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ plan, nativeRuntimeRoot: '/roots/pi' }),
    );
    expect(dependencies.rebuildSkills).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 'recorded/repository', canonicalRoot: '/catalog' }),
    );
  });

  it('binds the complete prospective plan, including provenance and approval, in the confirmation', async () => {
    const { service } = fixture();
    const plan = await service.plan(seed, user);
    for (const changed of [
      { ...plan, previousLaunch: { ...plan.previousLaunch, launchKey: 'forged' } },
      { ...plan, approval: { ...plan.approval, selectedConfigDigest: digest } },
      { ...plan, launch: { ...plan.launch, artifactKey: 'forged' } },
      { ...plan, effectiveAuthority: { ...plan.effectiveAuthority, resources: [] } },
    ]) {
      expect(() => verifyResumeConfirmation(changed, plan.confirmationDigest)).toThrow();
    }
    await expect(
      service.prepare({ ...seed, confirmationDigest: digest } as never, user),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_APPROVAL_UNAVAILABLE' });
  });

  it('rejects a substituted authority view even when its outer confirmation is recomputed', async () => {
    const f = fixture();
    const plan = await f.service.plan(seed, user);
    const { confirmationDigest: ignored, ...unsigned } = plan;
    void ignored;
    const forged = {
      ...unsigned,
      effectiveAuthority: { ...plan.effectiveAuthority, resources: [] },
    };
    await expect(
      f.service.prepare({ ...forged, confirmationDigest: stableDigest(forged) }, user),
    ).rejects.toMatchObject({
      code: 'SESSION_RESUME_PLAN_STALE',
      details: { axis: 'effectiveAuthority' },
    });
    expect(f.roots).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    'artifact',
    'manifest',
    'mode',
    'networkPolicy',
    'inheritedNetworkPolicy',
    'location',
    'route',
    'projectOverride',
  ] as const)(
    'rejects post-confirmation %s drift and accepts only the newly explicit plan',
    async (axis) => {
      const f = fixture();
      const approved = await f.service.plan(seed, user);
      const changed: UserConfig = structuredClone(user);
      if (axis === 'artifact') {
        f.setArtifact('changed-runtime-artifact');
      }
      if (axis === 'manifest') {
        f.setManifest('changed-manifest');
      }
      if (axis === 'mode') {
        changed.modes.project!.resources = {};
      }

      if (axis === 'networkPolicy') {
        changed.networkPolicies.implementation!.denyPrivateNetworks = true;
      }
      if (axis === 'inheritedNetworkPolicy') {
        changed.networkPolicies.base = { denyPrivateNetworks: true };
        changed.networkPolicies.implementation!.extends = 'base';
      }
      if (axis === 'location') {
        changed.identities.work!.allowedSkillPacks = ['development', 'personal'];
        changed.locations.work!.skillPacks = ['personal'];
      }
      if (axis === 'route') {
        changed.identities.work!.gitAuthorRoute = 'changed-route';
      }
      if (axis === 'projectOverride') {
        changed.identities.work!.allowedSkillPacks = ['development', 'personal'];
        changed.projects = { 'sample/app': { skillPacks: ['development', 'personal'] } };
      }
      f.setConfig(changed);
      const failure = await f.service.prepare(approved, changed).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'SESSION_RESUME_PLAN_STALE',
        details: {
          axis: expect.stringMatching(/^(launch|selectedConfig)$/u),
          approvedDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          currentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(Object.keys((failure as { details: object }).details).sort()).toEqual([
        'approvedDigest',
        'axis',
        'currentDigest',
      ]);
      expect(f.roots).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      const fresh = await f.service.plan(seed, changed);
      expect(() => verifyResumeConfirmation(fresh, approved.confirmationDigest)).toThrow();
      await expect(
        f.service.execute(await f.service.prepare(fresh, changed)),
      ).resolves.toMatchObject({ exitCode: 7 });
    },
  );

  it.each(['nativeBindingRef', 'nativeSessionRef', 'cwd', 'previousLaunch', 'launch'] as const)(
    'revalidates recorded %s independently instead of treating the prospective launch as history',
    async (axis) => {
      const f = fixture();
      const plan = await f.service.plan(seed, user);
      const changed = { ...seed };
      if (axis === 'nativeBindingRef') {
        changed.nativeBindingRef = 'changed';
      }
      if (axis === 'nativeSessionRef') {
        changed.nativeSessionRef = { kind: 'root-relative-file', value: 'sessions/other.jsonl' };
      }
      if (axis === 'cwd') {
        changed.cwd = '/other';
      }
      if (axis === 'previousLaunch') {
        changed.previousLaunch = { ...seed.previousLaunch, launchKey: 'changed' };
      }
      if (axis === 'launch') {
        changed.launch = { ...seed.launch, manifestKey: 'changed' };
      }
      f.setRecord(changed);
      await expect(f.service.prepare(plan, user)).rejects.toMatchObject({
        code: 'SESSION_RESUME_PLAN_STALE',
      });
      expect(f.roots).not.toHaveBeenCalled();
    },
  );

  it.each([
    'SESSION_RESUME_ACTIVE',
    'SESSION_RESUME_NATIVE_TARGET_INVALID',
    'SESSION_RESUME_ROOT_MISMATCH',
    'SESSION_RESUME_ACTIVITY_UNAVAILABLE',
  ])('retains the native guard %s at prepare and child boundaries', async (code) => {
    const f = fixture();
    const plan = await f.service.plan(seed, user);
    const token = await f.service.prepare(plan, user);
    f.dependencies.verifySeed = async () => {
      throw Object.assign(new Error('native guard'), { code });
    };
    await expect(f.service.prepare(plan, user)).rejects.toMatchObject({ code });
    await expect(f.service.execute(token)).rejects.toMatchObject({ code });
    expect(f.events).not.toContain('child');
  });

  it('rebuilds at the exact child boundary and catches configuration and artifact changes after prepare', async () => {
    for (const axis of ['config', 'artifact']) {
      const f = fixture();
      const plan = await f.service.plan(seed, user);
      const token = await f.service.prepare(plan, user);
      if (axis === 'artifact') {
        f.setArtifact('changed');
      } else {
        f.setConfig({ ...user, networkPolicies: { implementation: { preset: 'deny-all' } } });
      }
      await expect(f.service.execute(token)).rejects.toMatchObject({
        code: 'SESSION_RESUME_PLAN_STALE',
      });
      expect(f.events).not.toContain('child');
    }
  });

  it('rejects drift introduced during materialization at the exact child boundary', async () => {
    const f = fixture();
    const plan = await f.service.plan(seed, user);
    f.execute.mockImplementationOnce(async (input) => {
      f.setArtifact('changed-during-materialization');
      await input.beforeChildExecution();
      throw new Error('must not reach child');
    });
    await expect(f.service.execute(await f.service.prepare(plan, user))).rejects.toMatchObject({
      code: 'SESSION_RESUME_PLAN_STALE',
    });
  });

  it('preflights before discovery and makes child verification one-shot without checking after pre-child failure', async () => {
    const f = fixture();
    const plan = await f.service.plan(seed, user);
    f.events.length = 0;
    const token = await f.service.prepare(plan, user);
    f.execute.mockImplementationOnce(async (input) => {
      await input.beforeChildExecution();
      await expect(input.beforeChildExecution()).rejects.toMatchObject({
        code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
      });
      return { exitCode: 0 };
    });
    await f.service.execute(token);
    expect(f.events.filter((event) => event === 'reverify')).toHaveLength(3);
    expect(f.events.indexOf('reverify')).toBeLessThan(f.events.indexOf('project'));
    f.events.length = 0;
    const failed = await f.service.prepare(plan, user);
    f.execute.mockRejectedValueOnce(new Error('before child'));
    await expect(f.service.execute(failed)).rejects.toThrow('before child');
    expect(f.events.filter((event) => event === 'reverify')).toHaveLength(2);
  });

  it('rejects forged, cross-service, and replayed tokens', async () => {
    const f = fixture();
    const plan = await f.service.plan(seed, user);
    await expect(f.service.execute({} as never)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    const token = await f.service.prepare(plan, user);
    await expect(fixture().service.execute(token)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    await f.service.execute(token);
    await expect(f.service.execute(token)).rejects.toMatchObject({
      code: 'SESSION_RESUME_LAUNCH_STATE_INVALID',
    });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('fails closed on Docker and never manufactures unrestricted approvals', async () => {
    for (const launch of [
      { ...seed.launch, executor: { kind: 'docker' as const } },
      { ...seed.launch, mode: 'unrestricted' },
    ]) {
      const f = fixture();
      const changed = { ...seed, launch };
      f.setRecord(changed);
      await expect(f.service.plan(changed, user)).rejects.toMatchObject({
        code:
          launch.executor.kind === 'docker'
            ? 'EXECUTOR_UNAVAILABLE'
            : 'SESSION_RESUME_APPROVAL_UNAVAILABLE',
      });
      expect(f.roots).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it.each(['personal', 'work'])(
    'retains a provably identical %s launch without widening authority',
    async (domain) => {
      const f = fixture();
      const configured: UserConfig = {
        ...user,
        identities: { work: { ...user.identities.work, domain } },
        domains: { [domain]: [cwd] },
      };
      const previous = { ...seed, identity: { ...seed.identity, domain } };
      f.setRecord(previous);
      f.setConfig(configured);
      const proposed = await f.service.plan(previous, configured);
      const unchanged = {
        ...previous,
        launch: proposed.launch,
        previousLaunch: {
          launchKey: proposed.launch.launchKey,
          descriptorDigest: proposed.launch.descriptorDigest,
        },
      };
      f.setRecord(unchanged);
      const plan = await f.service.plan(unchanged, configured);
      expect(plan.approval.resurrection).toBe('unchanged');
      expect(plan.approval.recordedLaunchDigest).toBe(stableDigest(unchanged.launch));
      await expect(
        f.service.execute(await f.service.prepare(plan, configured)),
      ).resolves.toMatchObject({ exitCode: 7 });
    },
  );
});
