import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import {
  SessionStore,
  verifyNativeResumeSeed,
  type SessionRecordV1,
  type ResumeDependencies,
} from '@mpx/sessions';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (input: { beforeChildExecution?: () => Promise<void> }) => {
    await input.beforeChildExecution?.();
    return { exitCode: 0 };
  }),
  resolveLaunch: vi.fn<typeof import('@mpx/launch').resolveLaunch>(),
}));
vi.mock('../../src/node/launch-execution.js', () => ({ executeResolvedNodeLaunch: mocks.execute }));
vi.mock('@mpx/launch', async (original) => {
  const production = await original<typeof import('@mpx/launch')>();
  mocks.resolveLaunch.mockImplementation(production.resolveLaunch);
  return { ...production, resolveLaunch: mocks.resolveLaunch };
});

import {
  createNodeSessionResumeLaunchApplicationService,
  executeNodeSessionResumeLaunch,
  type NodeSessionResumeLaunchInput,
} from '../../src/node/session-resume-launch.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
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

async function fixture(runtime: 'claude' | 'pi' = 'claude') {
  mocks.execute.mockClear();
  mocks.resolveLaunch.mockClear();
  const directory = await mkdtemp(path.join(tmpdir(), 'mpx-resume-node-'));
  directories.push(directory);
  let catalogRoot = path.join(directory, 'catalog');
  const skillBody =
    '---\nname: review\ndescription: Review source safely\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: full\n---\nSECRET SKILL BODY\n';
  const writeCatalog = async (root: string) => {
    await mkdir(path.join(root, 'review'), { recursive: true });
    await writeFile(path.join(root, 'review', 'SKILL.md'), skillBody);
  };
  await writeCatalog(catalogRoot);
  let configuration: UserConfig = structuredClone(user);
  if (runtime === 'pi') {
    user.identities.work.runtimeRoots.pi = directory;
    configuration.identities.work!.runtimeRoots.pi = directory;
    await mkdir(path.join(directory, 'sessions'));
    await writeFile(
      path.join(directory, 'sessions', 'native.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'native', cwd })}\n`,
    );
  }
  const store = new SessionStore(directory);
  const timestamp = '2025-01-01T00:00:00.000Z';
  const identity = { domain: 'work', name: 'work' };
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref: 'binding',
    runtime,
    identity,
    recordedRootDigest: digest,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const record: SessionRecordV1 = {
    schemaVersion: 1,
    recordId: 'record-native',
    runtimeQualifiedId: `${runtime}:native`,
    runtime,
    identity,
    nativeBindingRef: 'binding',
    nativeSessionRef:
      runtime === 'pi'
        ? { kind: 'root-relative-file', value: 'sessions/native.jsonl' }
        : { kind: 'native-id', value: 'native' },
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
      artifactKey: 'old-artifact',
      manifestKey: 'manifest',
    },
    location: { cwd, project: 'sample/app', repository: 'recorded/repository', worktree: null },
    metadata: { title: null, model: null, effort: null },
    liveness: 'inactive',
    process: null,
    workflow: {
      status: 'paused',
      inbox: false,
      nextAction: null,
      note: null,
      relatedIssue: null,
      relatedReview: null,
      priority: null,
    },
    resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
    timestamps: { createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp },
    lifecycle: { bindingId: null, sequence: 0, timestamp: null },
  };
  await store.put(record);
  const dependencies: ResumeDependencies = {
    resolveConfiguredRoot: async () => ({
      root: user.identities.work.runtimeRoots[runtime],
      canonicalRootDigest: digest,
      identity,
      runtime,
    }),
    verifyNativeTarget: vi.fn(async () => ({ valid: true, activity: 'inactive' as const })),
  };
  const events: string[] = [];
  const input: NodeSessionResumeLaunchInput = {
    store,
    environment: {},
    readUserConfig: async () => configuration,
    resumeDependencies: async () => dependencies,
    context: {
      exactNativeRootVerifier: {
        verify: async () => {
          events.push('root');
        },
      },
      piAuthVerifier: {
        verify: async () => {
          events.push('oauth');
        },
      },
    },
    catalogRoot: async () => catalogRoot,
    status: vi.fn(),
    executionRoots: vi.fn(async () => ({ artifactsRoot: '/artifacts', stateRoot: '/state' })),
    discoverProjectConfig: async () => {
      events.push('project');
      return {
        root: directory,
        path: `${directory}/mpxconfig.json`,
        config: {
          schemaVersion: 1,
          project: { id: 'sample/app' },
          repository: { provider: 'generic', remote: 'origin' },
        },
      };
    },
  };
  const service = createNodeSessionResumeLaunchApplicationService(input);
  const seed = await verifyNativeResumeSeed(store, record, dependencies);
  return {
    input,
    service,
    seed,
    store,
    record,
    events,
    dependencies,
    setConfig: (value: UserConfig) => {
      configuration = value;
    },
    relocate: async () => {
      catalogRoot = path.join(directory, 'relocated-catalog');
      await writeCatalog(catalogRoot);
    },
  };
}

describe('Node session resume launch composition', () => {
  it('rebuilds the current proposal deterministically without materialization and without a confirmation cycle', async () => {
    const f = await fixture();
    const first = await f.service.plan(f.seed, user);
    const second = await f.service.plan(f.seed, user);
    expect(second).toEqual(first);
    expect(first.launch.artifactKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.launch.launchKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.previousLaunch.launchKey).toBe('old');
    expect(first.approval.resurrection).toBe('confirmation-required');
    const inputs = mocks.resolveLaunch.mock.calls.map(
      ([input]) => input as unknown as { hostApproval: { approvalKey: string } },
    );
    expect(inputs[0]!.hostApproval.approvalKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(inputs[0]!.hostApproval).toEqual(inputs[1]!.hostApproval);
    expect(f.input.executionRoots).not.toHaveBeenCalled();
    expect(f.input.status).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((await f.store.read(f.record.identity, f.record.runtime)).records).toEqual([f.record]);
    await executeNodeSessionResumeLaunch(f.input, first, user, { approveHost: true });
    expect(
      mocks.resolveLaunch.mock.calls.map(
        ([input]) => (input as unknown as { hostApproval: unknown }).hostApproval,
      ),
    ).toEqual(Array(5).fill(inputs[0]!.hostApproval));
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        approveHost: true,
        resume: {
          nativeBinding: await f.store.readNativeBinding('binding'),
          nativeSessionRef: f.seed.nativeSessionRef,
        },
      }),
    );
  });

  it('replays a completed production proposal with an exactly stable snapshot, while retaining fresh final provenance', async () => {
    const f = await fixture();
    const first = await f.service.plan(f.seed, user);
    await f.service.execute(await f.service.prepare(first, user));
    const completed: SessionRecordV1 = {
      ...f.record,
      launch: first.launch,
      process: { pid: 456, startFingerprint: 'completed-child' },
      workflow: { ...f.record.workflow, status: 'completed' },
      lifecycle: { bindingId: 'new-binding', sequence: 3, timestamp: '2025-01-02T00:00:00.000Z' },
    };
    await f.store.put(completed);
    const replayed = await verifyNativeResumeSeed(f.store, completed, f.dependencies);
    const next = await f.service.plan(replayed, user);
    expect(next.launch).toEqual(first.launch);
    expect(next.effectiveAuthority).toEqual(first.effectiveAuthority);
    expect(next.approval.resurrection).toBe('unchanged');
    expect(next.previousLaunch).toEqual({
      launchKey: first.launch.launchKey,
      descriptorDigest: first.launch.descriptorDigest,
    });
    expect(next.nativeVerificationDigest).not.toBe(first.nativeVerificationDigest);
    expect(next.confirmationDigest).not.toBe(first.confirmationDigest);
    expect(await f.service.plan(replayed, user)).toEqual(next);
    await f.service.execute(await f.service.prepare(next, user));

    await f.relocate();
    const relocated = await f.service.plan(replayed, user);
    expect(relocated.launch.manifestKey).toBe(next.launch.manifestKey);
    expect(relocated.launch.artifactKey).not.toBe(next.launch.artifactKey);
    expect(relocated.approval.resurrection).toBe('confirmation-required');
    await expect(f.service.prepare(next, user)).rejects.toMatchObject({
      code: 'SESSION_RESUME_PLAN_STALE',
    });
  });

  it('displays resolved authority rather than policy names or secret-bearing source objects', async () => {
    const f = await fixture();
    const configuration: UserConfig = structuredClone(user);
    configuration.networkPolicies = {
      base: { preset: 'deny-all', denyPrivateNetworks: true },
      implementation: { extends: 'base', requiredRuntimeEndpoints: true },
    };
    configuration.identities.work!.providerRoutes = { github: 'work-provider' };
    configuration.identities.work!.mcpSharing = { allow: ['work-search'], shareNativeAuth: false };
    Object.assign(configuration.networkPolicies.implementation!, {
      headers: { Authorization: 'SECRET AUTHORIZATION' },
      environment: { TOKEN: 'SECRET ENVIRONMENT' },
    });
    f.setConfig(configuration);
    const first = await f.service.plan(f.seed, configuration);
    expect(first.effectiveAuthority).toMatchObject({
      resources: expect.arrayContaining([
        { selector: 'selected-project', access: 'read-write' },
        { selector: 'identity-domain', access: 'none' },
      ]),
      network: {
        preset: 'deny-all',
        denyPrivateNetworks: true,
        requiredRuntimeEndpoints: true,
        approvedDeliveryAdditions: null,
      },
      routes: {
        gitAuthor: 'work',
        providers: [{ provider: 'github', route: 'work-provider' }],
        ssh: null,
        mcp: { allow: ['work-search'], shareNativeAuth: false },
      },
      executor: {
        kind: 'host',
        enforcement: 'advisory',
        isolation: 'none',
        verification: 'verified',
      },
      skills: {
        decisions: [
          {
            identity: 'review',
            included: true,
            exposure: 'explicit-only',
            humanInvocation: true,
            modelInvocation: false,
            metadataHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ],
      },
    });
    for (const forbidden of [
      'SECRET',
      'Authorization',
      'environment',
      'sourcePath',
      'realPath',
      'headers',
      'runtimeRoots',
    ]) {
      expect(JSON.stringify(first.effectiveAuthority)).not.toContain(forbidden);
    }
    const expanded = structuredClone(configuration);
    expanded.modes.project!.resources['identity-domain'] = 'read-write';
    expanded.skillPolicies.clean!.skillExposure.default = 'full';
    f.setConfig(expanded);
    const second = await f.service.plan(f.seed, expanded);
    expect(second.launch.mode).toBe(first.launch.mode);
    expect(second.launch.skillPolicy).toBe(first.launch.skillPolicy);
    expect(second.effectiveAuthority.resources).toContainEqual({
      selector: 'identity-domain',
      access: 'read-write',
    });
    expect(second.effectiveAuthority.skills.decisions[0]).toMatchObject({
      exposure: 'full',
      modelInvocation: true,
    });
    expect(second.launch.descriptorDigest).not.toBe(first.launch.descriptorDigest);
    expect(second.confirmationDigest).not.toBe(first.confirmationDigest);
    expect(second.approval.resurrection).toBe('confirmation-required');
    await expect(f.service.prepare(first, expanded)).rejects.toMatchObject({
      code: 'SESSION_RESUME_PLAN_STALE',
    });
  });

  it('binds selected declarations in the proposal audit key even when policy names are unchanged', async () => {
    const f = await fixture();
    const first = await f.service.plan(f.seed, user);
    const changed: UserConfig = {
      ...user,
      networkPolicies: { implementation: { preset: 'deny-all' } },
    };
    const second = await f.service.plan(f.seed, changed);
    const [left, right] = mocks.resolveLaunch.mock.calls.map(
      ([input]) =>
        (input as unknown as { hostApproval: { approvalKey: string } }).hostApproval.approvalKey,
    );
    expect(left).not.toBe(right);
    expect(first.approval.selectedConfigDigest).not.toBe(second.approval.selectedConfigDigest);
    expect(first.confirmationDigest).not.toBe(second.confirmationDigest);
  });

  it('checks Pi root and OAuth before discovery and at the exact child boundary', async () => {
    const f = await fixture('pi');
    const plan = await f.service.plan(f.seed, user);
    f.events.length = 0;
    await f.service.execute(await f.service.prepare(plan, user));
    expect(f.events).toEqual([
      'root',
      'oauth',
      'project',
      'root',
      'oauth',
      'project',
      'root',
      'oauth',
      'project',
    ]);
  });

  it('fails closed on Pi preflight failures without changing historical records', async () => {
    const f = await fixture('pi');
    const plan = await f.service.plan(f.seed, user);
    const service = createNodeSessionResumeLaunchApplicationService({
      ...f.input,
      context: {
        exactNativeRootVerifier: {
          verify: async () => {
            throw new Error('unavailable');
          },
        },
      },
    });
    await expect(service.prepare(plan, user)).rejects.toMatchObject({
      code: 'SESSION_RESUME_NATIVE_PREFLIGHT_UNAVAILABLE',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((await f.store.read(f.record.identity, f.record.runtime)).records).toEqual([f.record]);
  });

  it.each(['binding', 'root', 'header', 'pid'] as const)(
    'rechecks %s drift against native evidence immediately before execution',
    async (axis) => {
      const f = await fixture('pi');
      const plan = await f.service.plan(f.seed, user);
      const token = await f.service.prepare(plan, user);
      if (axis === 'binding') {
        await f.store.saveNativeBinding({
          ...(await f.store.readNativeBinding('binding')),
          identity: { domain: 'personal', name: 'work' },
        });
      }
      if (axis === 'root') {
        f.dependencies.resolveConfiguredRoot = async () => ({
          root: '/changed',
          canonicalRootDigest: 'b'.repeat(64),
          identity: f.record.identity,
          runtime: 'pi',
        });
      }
      if (axis === 'header') {
        f.dependencies.verifyNativeTarget = async () => ({ valid: false, activity: 'inactive' });
      }
      if (axis === 'pid') {
        f.dependencies.verifyNativeTarget = async () => ({ valid: true, activity: 'active' });
      }
      await expect(f.service.execute(token)).rejects.toMatchObject({
        code: {
          binding: 'SESSION_RESUME_BINDING_MISMATCH',
          root: 'SESSION_RESUME_ROOT_MISMATCH',
          header: 'SESSION_RESUME_NATIVE_TARGET_INVALID',
          pid: 'SESSION_RESUME_ACTIVE',
        }[axis],
      });
      expect((await f.store.read(f.record.identity, f.record.runtime)).records).toEqual([f.record]);
    },
  );

  it.each(['id', 'cwd', 'version', 'timestamp'] as const)(
    'rejects real Pi header %s drift without rewriting history',
    async (axis) => {
      const f = await fixture('pi');
      const plan = await f.service.plan(f.seed, user);
      const header = {
        type: 'session',
        version: 3,
        id: 'native',
        cwd,
        [axis]: axis === 'version' ? 4 : 'changed',
      };
      await writeFile(
        path.join(user.identities.work.runtimeRoots.pi, 'sessions', 'native.jsonl'),
        `${JSON.stringify(header)}\n`,
      );
      await expect(f.service.prepare(plan, user)).rejects.toMatchObject({
        code:
          axis === 'timestamp'
            ? 'SESSION_RESUME_PLAN_STALE'
            : 'SESSION_RESUME_NATIVE_TARGET_INVALID',
      });
      expect(mocks.execute).not.toHaveBeenCalled();
      expect((await f.store.read(f.record.identity, f.record.runtime)).records).toEqual([f.record]);
    },
  );

  it('rejects changed recorded PID provenance even when the new PID is also absent', async () => {
    const f = await fixture('pi');
    const plan = await f.service.plan(f.seed, user);
    await f.store.put({ ...f.record, process: { pid: 987, startFingerprint: 'different' } });
    await expect(f.service.prepare(plan, user)).rejects.toMatchObject({
      code: 'SESSION_RESUME_PLAN_STALE',
      details: { axis: 'native' },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('fails closed for Docker before roots, discovery, or execution', async () => {
    const f = await fixture();
    await expect(
      f.service.prepare(
        { ...f.seed, launch: { ...f.seed.launch, executor: { kind: 'docker' } } } as never,
        user,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE', details: { hostFallback: false } });
    expect(f.events).toEqual([]);
    expect(f.input.executionRoots).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
