import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionApplicationService,
  type PreparedSessionBranch,
  type PreparedSessionReconcile,
  type SessionApplicationDependencies,
} from '@mpx/application';
import { createNodeSessionApplicationService } from '@mpx/application/node';
import {
  SessionService,
  SessionStore,
  planResume,
  verifyResumeConfirmation,
  type SessionRecordV1,
} from '@mpx/sessions';

const identity = { domain: 'personal', name: 'me' };

async function branchFixture() {
  const store = new SessionStore(await mkdtemp(path.join(tmpdir(), 'mpx-application-session-')));
  const now = new Date().toISOString();
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref: 'binding',
    identity,
    runtime: 'claude',
    recordedRootDigest: 'b'.repeat(64),
    accountBindingRef: null,
    createdAt: now,
    updatedAt: now,
  });
  const record: SessionRecordV1 = {
    schemaVersion: 1,
    recordId: 'parent',
    runtimeQualifiedId: 'claude:parent',
    runtime: 'claude',
    identity,
    nativeBindingRef: 'binding',
    nativeSessionRef: { kind: 'native-id', value: 'parent' },
    launch: {
      launchKey: 'launch',
      descriptorDigest: 'a'.repeat(64),
      mode: 'interactive',
      skillPolicy: 'standard',
      contentScope: 'repo',
      executor: { kind: 'host' },
      workspace: 'direct',
      networkPolicy: 'restricted',
      grants: [],
      artifactKey: 'artifact',
      manifestKey: 'manifest',
    },
    location: { cwd: 'C:/repo', project: null, repository: null, worktree: null },
    metadata: { title: null, model: null, effort: null },
    liveness: 'inactive',
    process: null,
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
    timestamps: { createdAt: now, updatedAt: now, lastActivityAt: null },
    lifecycle: { bindingId: null, sequence: 0, timestamp: null },
  };
  await new SessionService(store).save(record);
  return store;
}

function directApplication(
  store: SessionStore,
  dependencies: Partial<SessionApplicationDependencies> = {},
): SessionApplicationService {
  const sessions = new SessionService(store);
  return new SessionApplicationService({
    sessions,
    nativeBindings: store,
    consumePending: async () => {
      await store.listLifecycleBindingIds();
      return 0;
    },
    planResume: (record, resumeDependencies) => planResume(store, record, resumeDependencies),
    verifyResumeConfirmation,
    ...dependencies,
  });
}

describe('SessionApplicationService reconcile orchestration', () => {
  it('does not discover or reconcile when legacy validation fails', async () => {
    const store = await branchFixture();
    const scan = vi.fn();
    const discoveries = vi.fn(async () => [{ scanner: { runtime: 'claude', scan } } as never]);
    const sessions = new SessionService(store);
    const failure = new Error('invalid legacy mapping');
    const application = directApplication(store, {
      sessions,
      legacyImport: {
        plan: async () => {
          throw failure;
        },
        import: vi.fn(),
      },
      discoveries,
    });

    const prepared = await application.prepareReconcile();
    await expect(
      application.reconcile(prepared, {
        legacy: { sources: ['bad.json'], accountMappings: [], piRootMappings: [] },
      }),
    ).rejects.toBe(failure);
    expect(discoveries).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    await expect(sessions.show('parent')).resolves.toMatchObject({ liveness: 'inactive' });
  });

  it('accepts each prepared reconcile token exactly once and only from its service', async () => {
    const store = await branchFixture();
    const first = directApplication(store);
    const second = directApplication(store);
    const prepared = await first.prepareReconcile();

    await expect(first.reconcile({} as PreparedSessionReconcile, {})).rejects.toMatchObject({
      code: 'SESSION_RECONCILE_PREPARATION_INVALID',
    });
    await expect(second.reconcile(prepared, {})).rejects.toMatchObject({
      code: 'SESSION_RECONCILE_PREPARATION_INVALID',
    });
    await expect(first.reconcile(prepared, {})).resolves.toMatchObject({
      data: { kind: 'session-reconcile' },
    });
    await expect(first.reconcile(prepared, {})).rejects.toMatchObject({
      code: 'SESSION_RECONCILE_PREPARATION_INVALID',
    });
  });
});

describe('SessionApplicationService resurrection export', () => {
  it('consumes pending events and deterministically exports active and inactive eligible MPX records', async () => {
    const store = await branchFixture();
    const sessions = new SessionService(store);
    const parent = await sessions.show('parent');
    const launched = parent.launch!;
    await sessions.save({
      ...parent,
      recordId: 'z-active',
      runtimeQualifiedId: 'claude:z-active',
      liveness: 'active',
    });
    await sessions.save({
      ...parent,
      recordId: 'a-inactive',
      runtimeQualifiedId: 'claude:a-inactive',
    });
    await sessions.save({
      ...parent,
      recordId: 'native',
      runtimeQualifiedId: 'claude:native',
      launch: null,
    });
    await sessions.save({
      ...parent,
      recordId: 'completed',
      runtimeQualifiedId: 'claude:completed',
      workflow: { ...parent.workflow, status: 'completed', inbox: false },
    });
    await sessions.save({
      ...parent,
      recordId: 'abandoned',
      runtimeQualifiedId: 'claude:abandoned',
      workflow: { ...parent.workflow, status: 'abandoned', inbox: false },
    });
    const consumePending = vi.fn(async () => 1);
    const application = directApplication(store, { consumePending });

    const result = await application.resurrectionExport();

    expect(consumePending).toHaveBeenCalledOnce();
    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'session-resurrection-export',
      records: [
        expect.objectContaining({ id: 'a-inactive', liveness: 'inactive' }),
        expect.objectContaining({ id: 'parent', liveness: 'inactive' }),
        expect.objectContaining({ id: 'z-active', liveness: 'active' }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(launched.launchKey);
  });
});

describe('SessionApplicationService resume orchestration', () => {
  it('verifies, consumes, reloads, replans, confirms, and executes in order', async () => {
    const store = await branchFixture();
    const order: string[] = [];
    vi.spyOn(store, 'listLifecycleBindingIds').mockImplementation(async () => {
      order.push('consume');
      return [];
    });
    const application = directApplication(store, {
      resumeDependencies: async () => ({
        resolveConfiguredRoot: async () => {
          order.push('verify');
          return {
            root: 'C:/native',
            canonicalRootDigest: 'b'.repeat(64),
            identity,
            runtime: 'claude' as const,
          };
        },
        verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
      }),
      executeConfirmedResume: async () => {
        order.push('execute');
        return 'launched';
      },
    });
    const planned = (await application.resume({ id: 'parent' })) as {
      confirmationDigest: string;
    };
    order.length = 0;

    await expect(
      application.resume({ id: 'parent', confirmation: planned.confirmationDigest }),
    ).resolves.toEqual({ schemaVersion: 1, kind: 'session-resume', result: 'launched' });
    expect(order).toEqual(['verify', 'consume', 'verify', 'execute']);
  });

  it('approves a resurrection only with the final replanned digest', async () => {
    const store = await branchFixture();
    const initialPlan = { confirmationDigest: 'initial' } as never;
    const finalPlan = { confirmationDigest: 'final' } as never;
    const planResume = vi.fn().mockResolvedValueOnce(initialPlan).mockResolvedValueOnce(finalPlan);
    const order: string[] = [];
    const verifyResumeConfirmation = vi.fn(() => {
      order.push('verify');
    });
    const executeConfirmedResume = vi.fn(async (_plan, authority) => {
      order.push('execute');
      expect(authority).toEqual({ approveHost: true });
      return 'launched';
    });
    const application = directApplication(store, {
      planResume,
      verifyResumeConfirmation,
      resumeDependencies: async () => ({}) as never,
      executeConfirmedResume,
    });

    await expect(application.resume({ id: 'parent', approveResurrection: true })).resolves.toEqual({
      schemaVersion: 1,
      kind: 'session-resume',
      result: 'launched',
    });
    expect(verifyResumeConfirmation).toHaveBeenCalledWith(finalPlan, 'final');
    expect(executeConfirmedResume).toHaveBeenCalledWith(finalPlan, { approveHost: true });
    expect(order).toEqual(['verify', 'execute']);
  });

  it('fails closed before execution when final resurrection confirmation verification throws', async () => {
    const store = await branchFixture();
    const finalPlan = { confirmationDigest: 'final' } as never;
    const failure = new Error('confirmation rejected');
    const verifyResumeConfirmation = vi.fn(() => {
      throw failure;
    });
    const executeConfirmedResume = vi.fn(async () => 'launched');
    const application = directApplication(store, {
      planResume: vi.fn(async () => finalPlan),
      verifyResumeConfirmation,
      resumeDependencies: async () => ({}) as never,
      executeConfirmedResume,
    });

    await expect(application.resume({ id: 'parent', approveResurrection: true })).rejects.toBe(
      failure,
    );
    expect(verifyResumeConfirmation).toHaveBeenCalledWith(finalPlan, 'final');
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });

  it('consumes no lifecycle events when initial verification fails', async () => {
    const store = await branchFixture();
    const consumed = vi.spyOn(store, 'listLifecycleBindingIds');
    const failure = new Error('root replaced');
    const application = directApplication(store, {
      resumeDependencies: async () => ({
        resolveConfiguredRoot: async () => {
          throw failure;
        },
        verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
      }),
    });

    await expect(application.resume({ id: 'parent' })).rejects.toBe(failure);
    expect(consumed).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the recorded resume policy changes after planning', async () => {
    const store = await branchFixture();
    const sessions = new SessionService(store);
    const resumeDependencies = async () => ({
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: 'b'.repeat(64),
        identity,
        runtime: 'claude' as const,
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
    });
    const executeConfirmedResume = vi.fn(async () => ({}));
    const application = directApplication(store, {
      resumeDependencies,
      executeConfirmedResume,
    });
    const planned = (await application.resume({ id: 'parent' })) as {
      confirmationDigest: string;
    };
    const parent = await sessions.show('parent');
    await sessions.save({
      ...parent,
      launch: {
        ...parent.launch!,
        grants: [{ resource: 'repo', access: 'write' }] as const,
      },
    });

    await expect(
      application.resume({ id: 'parent', confirmation: planned.confirmationDigest }),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_CONFIRMATION_MISMATCH' });
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });
});

describe('SessionApplicationService branch preparation', () => {
  it('accepts only a token prepared by the same service', async () => {
    const store = await branchFixture();
    const plan = vi.fn(async () => ({ kind: 'session-branch-plan' }));
    const first = createNodeSessionApplicationService({
      store,
      branchService: { plan, apply: vi.fn() } as never,
    });
    const second = createNodeSessionApplicationService({
      store,
      branchService: { plan, apply: vi.fn() } as never,
    });
    const prepared = await first.prepareBranch('parent');

    await expect(first.branch({} as PreparedSessionBranch, {})).rejects.toMatchObject({
      code: 'SESSION_BRANCH_PREPARATION_INVALID',
    });
    await expect(second.branch(prepared, {})).rejects.toMatchObject({
      code: 'SESSION_BRANCH_PREPARATION_INVALID',
    });
    await expect(first.branch(prepared, {})).resolves.toEqual({ kind: 'session-branch-plan' });
    expect(plan).toHaveBeenCalledOnce();
  });

  it('constructs the branch service request from prepared application state', async () => {
    const store = await branchFixture();
    const planned = { kind: 'session-branch-plan' };
    const plan = vi.fn(async () => planned);
    const application = directApplication(store, {
      branchService: { plan, apply: vi.fn() } as never,
    });
    const prepared = await application.prepareBranch('parent');

    await expect(
      application.branch(prepared, {
        workspace: 'shared',
        intent: 'read',
        branch: 'feature/session-child',
        acknowledgeSharedRisk: true,
        terminal: { executable: 'C:/terminal.exe', title: 'Child session' },
      }),
    ).resolves.toBe(planned);
    expect(plan).toHaveBeenCalledWith({
      schemaVersion: 1,
      parent: {
        runtimeQualifiedId: 'claude:parent',
        nativeSessionRef: { kind: 'native-id', value: 'parent' },
      },
      child: {
        runtimeQualifiedId: expect.stringMatching(/^claude:pending-[a-f0-9]{24}$/u),
        runtime: 'claude',
      },
      launchIdentity: {
        identity,
        rootDigest: 'b'.repeat(64),
        nativeBindingRef: 'binding',
        mode: 'interactive',
        executor: 'host',
        skillPolicy: 'standard',
        contentScope: 'repo',
        workspace: 'direct',
        networkPolicy: 'restricted',
        grants: [],
        artifactKey: 'artifact',
        manifestKey: 'manifest',
        launchKey: 'launch',
        descriptorDigest: 'a'.repeat(64),
      },
      workspace: {
        selection: 'shared',
        intent: 'read',
        cwd: 'C:/repo',
        projectRef: null,
        repositoryRef: null,
        worktreeRef: null,
        branch: 'feature/session-child',
      },
      files: {
        sharing: 'shared',
        collisionDisclosure: ['concurrent changes share the current checkout'],
        duplicateWriterRiskAcknowledged: true,
      },
      terminal: {
        enabled: true,
        executable: 'C:/terminal.exe',
        title: 'Child session',
      },
    });
  });

  it('delegates a confirmed branch plan to apply', async () => {
    const store = await branchFixture();
    const planned = { kind: 'session-branch-plan', confirmationDigest: 'confirm' };
    const plan = vi.fn(async () => planned);
    const applied = {
      schemaVersion: 1,
      kind: 'session-branch-apply',
      writerLease: { owner: 'child', workspaceDigest: 'digest' },
    };
    const apply = vi.fn(async () => applied);
    const application = directApplication(store, {
      branchService: { plan, apply } as never,
    });
    const prepared = await application.prepareBranch('parent');

    await expect(application.branch(prepared, { confirmation: 'confirm' })).resolves.toEqual(
      applied,
    );
    expect(apply).toHaveBeenCalledWith(planned, 'confirm');
  });
});
