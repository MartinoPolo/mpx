import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { canonicalNativeRootDigest } from '@mpx/launch';
import {
  BranchLeaseStore,
  ConversationBranchService,
  SessionService,
  SessionStore,
  type BranchRequestV1,
  type SessionRecordV1,
} from '@mpx/sessions';
import {
  createNodeSessionBranchProduction,
  type NodeSessionBranchProductionInput,
} from '../../src/node/session-branch-production.js';

const digest = 'a'.repeat(64);
const user = {
  identities: {
    work: {
      domain: 'work',
      runtimeRoots: { claude: 'C:/roots/claude', pi: 'C:/roots/pi' },
      gitAuthorRoute: 'work',
    },
  },
  domains: { work: ['C:/repo'] },
  contentScopes: {},
  modes: {},
  skillPolicies: {},
  presets: {},
  launchDefaults: { projects: {}, scopes: {} },
  networkPolicies: {},
  executors: { host: {}, docker: {} },
} satisfies UserConfig;

function structural(overrides: Partial<NodeSessionBranchProductionInput> = {}) {
  return {
    enabled: true,
    cwd: 'C:/repo',
    user,
    store: {} as SessionStore,
    environment: {},
    stateRoot: () => {
      throw new Error('state root must stay lazy');
    },
    worktrees: () => {
      throw new Error('worktrees must stay lazy');
    },
    launchContext: {} as NodeSessionBranchProductionInput['launchContext'],
    catalogRoot: async () => 'C:/catalog',
    status: () => {
      throw new Error('status must stay lazy');
    },
    executionRoots: async () => ({ artifactsRoot: 'C:/artifacts', stateRoot: 'C:/state' }),
    ...overrides,
  } satisfies NodeSessionBranchProductionInput;
}

function sessionRecord(
  cwd: string,
  input: {
    runtimeQualifiedId?: string;
    liveness?: 'active' | 'inactive';
    process?: { pid: number; startFingerprint: string } | null;
  } = {},
): SessionRecordV1 {
  const runtimeQualifiedId = input.runtimeQualifiedId ?? 'claude:actual-child';
  return {
    schemaVersion: 1,
    recordId: runtimeQualifiedId.slice('claude:'.length),
    runtimeQualifiedId,
    runtime: 'claude',
    identity: request.launchIdentity.identity,
    nativeBindingRef: 'binding',
    nativeSessionRef: { kind: 'native-id', value: runtimeQualifiedId.slice('claude:'.length) },
    launch: null,
    location: { cwd, project: null, repository: null, worktree: null },
    metadata: { title: null, model: null, effort: null },
    liveness: input.liveness ?? 'active',
    process: input.process ?? null,
    workflow: {
      status: 'unfinished',
      inbox: true,
      nextAction: null,
      priority: null,
      note: null,
      relatedIssue: null,
      relatedReview: null,
    },
    resume: { state: 'unknown', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
    timestamps: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastActivityAt: null,
    },
    lifecycle: { bindingId: null, sequence: 0, timestamp: null },
  };
}

const request: BranchRequestV1 = {
  schemaVersion: 1,
  parent: {
    runtimeQualifiedId: 'claude:parent',
    nativeSessionRef: { kind: 'native-id', value: 'parent' },
  },
  child: { runtimeQualifiedId: 'claude:child', runtime: 'claude' },
  launchIdentity: {
    identity: { domain: 'work', name: 'work' },
    rootDigest: digest,
    nativeBindingRef: 'binding',
    mode: 'locked',
    executor: 'docker',
    skillPolicy: 'clean',
    contentScope: 'repo',
    workspace: 'direct',
    networkPolicy: 'restricted',
    grants: [{ resource: 'repo', access: 'write' }],
    artifactKey: 'artifact',
    manifestKey: 'manifest',
    launchKey: 'launch',
    descriptorDigest: digest,
  },
  workspace: {
    selection: 'shared',
    intent: 'read',
    cwd: 'C:/repo',
    projectRef: 'project',
    repositoryRef: 'repository',
    worktreeRef: null,
    branch: null,
  },
  files: {
    sharing: 'shared',
    collisionDisclosure: [],
    duplicateWriterRiskAcknowledged: false,
  },
  terminal: { enabled: false },
};

describe('Node session branch production', () => {
  it('short-circuits production state, worktree, and lease composition for an injected service', async () => {
    const injected = new ConversationBranchService({} as never);
    await expect(
      createNodeSessionBranchProduction(structural({ branchService: injected })),
    ).resolves.toEqual({ branchService: injected });
  });

  it('acquires worktrees before process inspection and state-root composition', async () => {
    const worktreeFailure = new Error('worktree factory failed');
    const inspect = vi.fn(async () => {
      throw new Error('process inspection must be later');
    });
    const stateRoot = vi.fn(() => {
      throw new Error('state root must be later');
    });

    await expect(
      createNodeSessionBranchProduction(
        structural({
          worktrees: () => {
            throw worktreeFailure;
          },
          processInspector: { inspect },
          stateRoot,
        }),
      ),
    ).rejects.toBe(worktreeFailure);
    expect(inspect).not.toHaveBeenCalled();
    expect(stateRoot).not.toHaveBeenCalled();
  });

  it('forwards the exact native branch invocation through normal runtime and lifecycle composition', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-branch-runtime-'));
    const store = new SessionStore(root);
    const rootDigest = canonicalNativeRootDigest(user.identities.work.runtimeRoots.claude);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity: request.launchIdentity.identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    let notifySessionsChanged!: () => Promise<void>;
    const executeResumeLaunch = vi.fn(async (input: { branchInvocation?: unknown }) => {
      await new SessionService(store).save(sessionRecord(root.replaceAll('\\', '/')));
      await notifySessionsChanged();
      return { exitCode: 0, input };
    });
    const production = await createNodeSessionBranchProduction(
      structural({
        store,
        stateRoot: () => root,
        worktrees: () => ({ create: vi.fn(), remove: vi.fn() }) as never,
        processInspector: { inspect: async () => ({ status: 'unknown' as const }) },
        environment: { MPX_CLAUDE_EXECUTABLE: 'C:/candidate/claude.exe' },
        launchExecutableResolver: async () => ({
          executable: 'C:/trusted/claude.exe',
          argvPrefix: [],
        }),
        lifecycleBridgeFactory: ({ onSessionsChanged }) => {
          notifySessionsChanged = onSessionsChanged;
          return {} as never;
        },
        executeResumeLaunch: executeResumeLaunch as never,
      }),
    );
    const hostRequest: BranchRequestV1 = {
      ...request,
      launchIdentity: { ...request.launchIdentity, executor: 'host', rootDigest },
      workspace: { ...request.workspace, cwd: root },
    };
    const plan = await production.branchService!.plan(hostRequest);
    const applied = await production.branchService!.apply(plan, plan.confirmationDigest);
    const invocation = {
      executable: 'C:/trusted/claude.exe',
      argv: ['--resume', 'parent', '--fork-session'],
      cwd: root.replaceAll('\\', '/'),
      nativeTarget: 'runtime-created',
    };
    expect(applied).toMatchObject({
      invocation,
      child: { runtimeQualifiedId: 'claude:actual-child' },
    });
    expect(executeResumeLaunch).toHaveBeenCalledTimes(1);
    expect(executeResumeLaunch.mock.calls[0]![0]).toMatchObject({
      branchInvocation: { executable: invocation.executable, argv: invocation.argv },
    });
  });

  it('maps isolated worktree create and compensation removal without reproducing worktree internals', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-branch-worktree-'));
    const isolated = path.join(root, 'isolated');
    const store = new SessionStore(root);
    const rootDigest = canonicalNativeRootDigest(user.identities.work.runtimeRoots.claude);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity: request.launchIdentity.identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const create = vi.fn(async () => ({ worktreePath: isolated }));
    const remove = vi.fn(async () => undefined);
    const production = await createNodeSessionBranchProduction(
      structural({
        store,
        stateRoot: () => root,
        worktrees: () => ({ create, remove }) as never,
        processInspector: { inspect: async () => ({ status: 'unknown' as const }) },
        environment: { MPX_CLAUDE_EXECUTABLE: 'C:/candidate/claude.exe' },
        launchExecutableResolver: async () => {
          throw new Error('native planning failed');
        },
      }),
    );
    const isolatedRequest: BranchRequestV1 = {
      ...request,
      launchIdentity: { ...request.launchIdentity, executor: 'host', rootDigest },
      workspace: {
        ...request.workspace,
        cwd: root,
        selection: 'isolated',
        intent: 'read',
        branch: 'feature/child',
      },
      files: { ...request.files, sharing: 'isolated' },
    };
    const plan = await production.branchService!.plan(isolatedRequest);
    await expect(production.branchService!.apply(plan, plan.confirmationDigest)).rejects.toThrow(
      'native planning failed',
    );
    expect(create).toHaveBeenCalledWith({ cwd: root, branch: 'feature/child', execution: 'none' });
    expect(remove).toHaveBeenCalledWith({ cwd: 'C:/repo', worktreePath: isolated });
  });

  it('maps inactive observed child liveness into stale writer-lease reclamation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-branch-lease-'));
    const store = new SessionStore(root);
    const leaseRoot = path.join(root, 'session-branch-leases');
    const seedInspector = {
      inspect: async (pid: number) => ({
        status: 'present' as const,
        pid,
        startFingerprint: 'old-controller',
      }),
    };
    const seeded = new BranchLeaseStore(leaseRoot, {
      processId: 777,
      controllerStartFingerprint: 'old-controller',
      processInspector: seedInspector,
      now: () => 0,
    });
    const lease = await seeded.acquire(root, 'claude:leased-child', {
      nativeBindingRef: 'binding',
    });
    await new SessionService(store).save(
      sessionRecord(root.replaceAll('\\', '/'), {
        runtimeQualifiedId: 'claude:leased-child',
        liveness: 'active',
        process: { pid: 42, startFingerprint: 'child-start' },
      }),
    );
    const inspect = vi.fn(async (pid: number) =>
      pid === process.pid
        ? { status: 'present' as const, pid, startFingerprint: 'current-controller' }
        : { status: 'absent' as const },
    );

    await createNodeSessionBranchProduction(
      structural({
        store,
        stateRoot: () => root,
        worktrees: () => ({ create: vi.fn(), remove: vi.fn() }) as never,
        processInspector: { inspect },
      }),
    );

    expect(inspect.mock.calls.map(([pid]) => pid)).toEqual([process.pid, 777, 42]);
    await expect(
      seeded.restore(lease.workspaceDigest, 'claude:leased-child'),
    ).rejects.toMatchObject({ code: 'SESSION_BRANCH_LEASE_NOT_FOUND' });
    await lease.release();
  });

  it('maps plan and apply to their complete synthetic Docker admission tuples', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-branch-production-'));
    const store = new SessionStore(root);
    const nativeRoot = user.identities.work.runtimeRoots.claude;
    const rootDigest = canonicalNativeRootDigest(nativeRoot);
    const dockerRequest: BranchRequestV1 = {
      ...request,
      launchIdentity: { ...request.launchIdentity, rootDigest },
      workspace: { ...request.workspace, cwd: root },
    };
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity: dockerRequest.launchIdentity.identity,
      runtime: 'claude',
      recordedRootDigest: rootDigest,
      accountBindingRef: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const admission = vi
      .fn()
      .mockResolvedValueOnce({
        admitted: true,
        hostFallback: false,
        recreate: { required: false, reasons: [] },
      })
      .mockResolvedValueOnce({
        admitted: false,
        code: 'F2_ADMISSION_DENIED',
        hostFallback: false,
        recreate: { required: true, reasons: ['test'] },
      });
    const production = await createNodeSessionBranchProduction(
      structural({
        store,
        stateRoot: () => root,
        worktrees: () => ({ create: vi.fn(), remove: vi.fn() }) as never,
        processInspector: { inspect: async () => ({ status: 'unknown' as const }) },
        dockerAdmission: admission,
      }),
    );
    const plan = await production.branchService!.plan(dockerRequest);
    await expect(
      production.branchService!.apply(plan, plan.confirmationDigest),
    ).rejects.toMatchObject({
      code: 'SESSION_BRANCH_EXECUTOR_NOT_ADMITTED',
    });
    const common = {
      schemaVersion: 1 as const,
      newLaunchRequired: true,
      previousLaunch: { launchKey: 'launch', descriptorDigest: digest },
      recordId: 'claude:child',
      runtimeQualifiedId: 'claude:child',
      runtime: 'claude' as const,
      identity: { domain: 'work', name: 'work' },
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id' as const, value: 'parent' },
      cwd: root,
      projectId: 'project',
      repositoryId: 'repository',
      launch: {
        launchKey: 'launch',
        descriptorDigest: digest,
        mode: 'locked',
        skillPolicy: 'clean',
        contentScope: 'repo',
        executor: { kind: 'docker' as const },
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [{ resource: 'repo', access: 'write' }],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
      },
    };
    expect(admission.mock.calls).toEqual([
      [{ ...common, confirmationDigest: sha256Canonical(dockerRequest as unknown as JsonValue) }],
      [{ ...common, confirmationDigest: plan.confirmationDigest }],
    ]);
  });
});
