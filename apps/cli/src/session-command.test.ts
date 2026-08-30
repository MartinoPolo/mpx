import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionService, SessionStore, type SessionRecordV1 } from '@mpx/sessions';
import { executeSessionCommand } from './session-command.js';

const identity = { domain: 'personal', name: 'me' };
const record = (id: string): SessionRecordV1 => ({
  schemaVersion: 1,
  recordId: id,
  runtimeQualifiedId: `claude:${id}`,
  runtime: 'claude',
  identity,
  nativeBindingRef: 'binding',
  nativeSessionRef: { kind: 'native-id', value: id },
  launch: null,
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
  timestamps: {
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastActivityAt: null,
  },
  lifecycle: { bindingId: null, sequence: 0, timestamp: null },
});
async function fixture() {
  const store = new SessionStore(await mkdtemp(path.join(tmpdir(), 'mpx-cli-session-')));
  await new SessionService(store).save(record('session-one'));
  return { store, resolveIdentity: async () => identity };
}

describe('session command', () => {
  it('returns versioned filtered list data', async () => {
    const result = await executeSessionCommand(
      { action: 'list', args: [], options: new Map([['runtime', 'claude']]) },
      await fixture(),
    );
    expect(result.data).toMatchObject({
      schemaVersion: 1,
      kind: 'session-list',
      records: [{ recordId: 'session-one' }],
    });
  });

  it('passes an injected absent process inspector through reconcile', async () => {
    const context = await fixture();
    const activePiRecord: SessionRecordV1 = {
      ...record('pi-active'),
      runtimeQualifiedId: 'pi:active',
      runtime: 'pi',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/active.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    };
    await new SessionService(context.store).save(activePiRecord);
    const inspect = vi.fn(async () => ({ status: 'absent' as const }));
    await executeSessionCommand(
      { action: 'reconcile', args: [], options: new Map() },
      { ...context, processInspector: { inspect } },
    );
    expect(inspect).toHaveBeenCalledWith(42);
    expect(await new SessionService(context.store).show('pi:active')).toMatchObject({
      liveness: 'inactive',
      process: null,
    });
  });

  it('durably marks every workflow flag and applies inbox policy', async () => {
    const context = await fixture();
    await executeSessionCommand(
      {
        action: 'mark',
        args: ['session-one', 'needs-review'],
        options: new Map([
          ['priority', '3'],
          ['next-action', 'address feedback'],
          ['note', 'handoff'],
          ['related-issue', 'GH-12'],
          ['related-review', 'PR-7'],
        ]),
      },
      context,
    );
    expect((await new SessionService(context.store).show('session-one')).workflow).toEqual({
      status: 'needs-review',
      inbox: true,
      priority: 3,
      nextAction: 'address feedback',
      note: 'handoff',
      relatedIssue: 'GH-12',
      relatedReview: 'PR-7',
    });
  });

  it('maps --state between liveness and workflow without conflating inactive', async () => {
    const context = await fixture();
    expect(
      (
        await executeSessionCommand(
          { action: 'list', args: [], options: new Map([['state', 'unfinished']]) },
          context,
        )
      ).data,
    ).toMatchObject({ records: [{ recordId: 'session-one' }] });
    expect(
      (
        await executeSessionCommand(
          { action: 'list', args: [], options: new Map([['state', 'active']]) },
          context,
        )
      ).data,
    ).toMatchObject({ records: [] });
    expect(
      (
        await executeSessionCommand(
          { action: 'list', args: [], options: new Map([['state', 'unknown']]) },
          context,
        )
      ).data,
    ).toMatchObject({ records: [] });
  });

  it('orders inbox records by priority', async () => {
    const context = await fixture(),
      service = new SessionService(context.store);
    await service.save(record('session-two'));
    await service.mark('session-one', 'unfinished', { priority: 5 });
    await service.mark('session-two', 'unfinished', { priority: 1 });
    const result = (await executeSessionCommand(
      { action: 'inbox', args: [], options: new Map() },
      context,
    )) as { data: { records: SessionRecordV1[] } };
    expect(result.data.records.map((item) => item.recordId)).toEqual([
      'session-two',
      'session-one',
    ]);
  });

  it('plans a Claude-only legacy import with only an explicit account mapping', async () => {
    const context = await fixture(),
      source = path.join(context.store.stateRoot, 'claude-save.json');
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'claude-binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: 'a'.repeat(64),
      accountBindingRef: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 2,
        savedAt: '2025-01-01T00:00:00.000Z',
        sessions: [
          { agent: 'claude', sessionId: 'legacy-one', account: 'old-account', cwd: 'C:/repo' },
        ],
      }),
    );
    const result = (await executeSessionCommand(
      {
        action: 'reconcile',
        args: [],
        options: new Map<string, string | string[]>([
          ['import-legacy', [source]],
          ['map-account', ['old-account=me']],
        ]),
      },
      context,
    )) as { data: { legacy: { records: SessionRecordV1[]; quarantine: unknown[] } } };
    expect(result.data.legacy.records).toMatchObject([
      { runtimeQualifiedId: 'claude:legacy-one', identity },
    ]);
    expect(result.data.legacy.quarantine).toEqual([]);
  });

  it('propagates an explicit Pi directory mapping to each validated registry file', async () => {
    const context = await fixture(),
      sourceDirectory = path.join(context.store.stateRoot, 'pi-registry'),
      nativeRoot = path.join(context.store.stateRoot, 'pi-native');
    const sessionFile = path.join(nativeRoot, 'sessions', 'legacy-pi.jsonl'),
      registryFile = path.join(sourceDirectory, 'legacy-pi.json');
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await mkdir(sourceDirectory);
    await writeFile(sessionFile, '{}');
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 2,
        agent: 'pi',
        sessionId: 'legacy-pi',
        sessionFile,
        cwd: 'C:/repo',
        pid: 42,
        processStartedAt: '2025-01-01T00:00:00.000Z',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'pi-binding',
      identity,
      runtime: 'pi',
      recordedRootDigest: 'b'.repeat(64),
      accountBindingRef: 'account',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    const result = (await executeSessionCommand(
      {
        action: 'reconcile',
        args: [],
        options: new Map<string, string | string[]>([
          ['import-legacy', [sourceDirectory]],
          ['map-account', [`pi:${sourceDirectory}=me`]],
          ['map-pi-root', [`me=${nativeRoot}`]],
        ]),
      },
      context,
    )) as { data: { legacy: { records: SessionRecordV1[]; quarantine: unknown[] } } };
    expect(result.data.legacy.records).toMatchObject([
      {
        runtimeQualifiedId: 'pi:legacy-pi',
        identity,
        nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/legacy-pi.jsonl' },
      },
    ]);
    expect(result.data.legacy.quarantine).toEqual([]);
  });

  it('returns a branch plan without applying side effects before confirmation', async () => {
    const context = await fixture(),
      service = new SessionService(context.store),
      now = new Date().toISOString();
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: 'b'.repeat(64),
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await service.save({
      ...record('session-one'),
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
    });
    const plan = vi.fn(async (request: unknown) => ({
        schemaVersion: 1 as const,
        kind: 'session-branch-plan' as const,
        confirmationDigest: 'c'.repeat(64),
        request,
      })),
      apply = vi.fn();
    const result = await executeSessionCommand(
      { action: 'branch', args: ['session-one'], options: new Map([['workspace', 'isolated']]) },
      { ...context, branchService: { plan, apply } as never },
    );
    expect(result.data).toMatchObject({
      kind: 'session-branch-plan',
      confirmationDigest: 'c'.repeat(64),
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies only the digest-confirmed branch plan', async () => {
    const context = await fixture(),
      service = new SessionService(context.store),
      now = new Date().toISOString(),
      confirmationDigest = 'c'.repeat(64);
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: 'b'.repeat(64),
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await service.save({
      ...record('session-one'),
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
    });
    const planned = {
        schemaVersion: 1 as const,
        kind: 'session-branch-plan' as const,
        confirmationDigest,
      },
      plan = vi.fn(async () => planned),
      apply = vi.fn(async () => ({
        schemaVersion: 1,
        kind: 'session-branch-apply',
        writerLease: null,
      }));
    await executeSessionCommand(
      {
        action: 'branch',
        args: ['session-one'],
        options: new Map([['confirm-plan', confirmationDigest]]),
      },
      { ...context, branchService: { plan, apply } as never },
    );
    expect(apply).toHaveBeenCalledWith(planned, confirmationDigest);
  });

  it('admits scheduled capture only with Phase I immutable runner authority', async () => {
    const context = await fixture(),
      inspect = vi.fn(async () => ({ installed: true, authorityDigest: 'a'.repeat(64) })),
      discoveries = vi.fn(async () => []);
    await expect(
      executeSessionCommand(
        { action: 'reconcile', args: [], options: new Map([['capture', 'scheduled']]) },
        { ...context, discoveries, scheduledCaptureAuthority: { inspect } },
      ),
    ).resolves.toMatchObject({ data: { schemaVersion: 1, kind: 'session-reconcile' } });
    expect(inspect).toHaveBeenCalledOnce();
    expect(discoveries).toHaveBeenCalledOnce();
  });

  it('keeps scheduled capture fail-closed without immutable runner authority', async () => {
    const context = await fixture(),
      discoveries = vi.fn(async () => []);
    await expect(
      executeSessionCommand(
        { action: 'reconcile', args: [], options: new Map([['capture', 'scheduled']]) },
        { ...context, discoveries },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_SCHEDULED_CAPTURE_AUTHORITY_UNAVAILABLE' });
    expect(discoveries).not.toHaveBeenCalled();
  });

  it('verifies an existing resume target before consuming pending lifecycle events and then replans', async () => {
    const context = await fixture(),
      service = new SessionService(context.store),
      now = new Date().toISOString(),
      order: string[] = [];
    const launch = {
      launchKey: 'old-launch',
      descriptorDigest: 'a'.repeat(64),
      mode: 'interactive',
      skillPolicy: 'standard',
      contentScope: 'repo',
      executor: { kind: 'host' },
      workspace: 'direct',
      networkPolicy: 'restricted',
      grants: [{ resource: 'repo', access: 'read' }],
      artifactKey: 'artifact',
      manifestKey: 'manifest',
    } as const;
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: 'b'.repeat(64),
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await service.save({ ...record('session-one'), launch });
    vi.spyOn(context.store, 'listLifecycleBindingIds').mockImplementation(async () => {
      order.push('consume');
      return [];
    });
    const resumeDependencies = async () => ({
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
    });
    await executeSessionCommand(
      { action: 'resume', args: ['session-one'], options: new Map() },
      { ...context, resumeDependencies },
    );
    expect(order).toEqual(['verify', 'consume', 'verify']);
  });

  it('does not consume pending lifecycle events when resume verification fails', async () => {
    const context = await fixture(),
      consumed = vi.spyOn(context.store, 'listLifecycleBindingIds');
    const failure = new Error('root replaced');
    await expect(
      executeSessionCommand(
        { action: 'resume', args: ['session-one'], options: new Map() },
        {
          ...context,
          resumeDependencies: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(consumed).not.toHaveBeenCalled();
  });

  it('rejects command confirmation after the recorded resume policy changes', async () => {
    const context = await fixture(),
      service = new SessionService(context.store),
      now = new Date().toISOString();
    const launch = {
      launchKey: 'old-launch',
      descriptorDigest: 'a'.repeat(64),
      mode: 'interactive',
      skillPolicy: 'standard',
      contentScope: 'repo',
      executor: { kind: 'host' },
      workspace: 'direct',
      networkPolicy: 'restricted',
      grants: [{ resource: 'repo', access: 'read' }],
      artifactKey: 'artifact',
      manifestKey: 'manifest',
    } as const;
    await context.store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: 'b'.repeat(64),
      accountBindingRef: null,
      createdAt: now,
      updatedAt: now,
    });
    await service.save({ ...record('session-one'), launch });
    const resumeDependencies = async () => ({
      resolveConfiguredRoot: async () => ({
        root: 'C:/native',
        canonicalRootDigest: 'b'.repeat(64),
        identity,
        runtime: 'claude' as const,
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
    });
    const planned = (await executeSessionCommand(
      { action: 'resume', args: ['session-one'], options: new Map() },
      { ...context, resumeDependencies },
    )) as { data: { confirmationDigest: string } };
    await service.save({
      ...(await service.show('session-one')),
      launch: { ...launch, grants: [{ resource: 'repo', access: 'write' }] },
    });
    await expect(
      executeSessionCommand(
        {
          action: 'resume',
          args: ['session-one'],
          options: new Map([['confirm-plan', planned.data.confirmationDigest]]),
        },
        { ...context, resumeDependencies, executeResume: async () => ({}) },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_CONFIRMATION_MISMATCH' });
  });
});

it('emits structured no-model handoff and completion envelopes with bounded required user text', async () => {
  const context = await fixture();
  const handoff = await executeSessionCommand(
    {
      action: 'handoff',
      args: ['session-one'],
      options: new Map([
        ['identity', 'me'],
        ['summary', 'Implementation is ready'],
        ['next-action', 'Run acceptance'],
        ['disposition', 'paused'],
      ]),
    },
    context,
  );
  expect(handoff.data).toMatchObject({
    schemaVersion: 1,
    kind: 'session-disposition',
    operation: 'handoff',
    disposition: 'paused',
  });

  const completion = await executeSessionCommand(
    {
      action: 'complete',
      args: ['session-one'],
      options: new Map([
        ['identity', 'me'],
        ['summary', 'Acceptance passed'],
        ['next-action', 'Archive work'],
        ['disposition', 'completed'],
      ]),
    },
    context,
  );
  expect(completion.data).toMatchObject({
    schemaVersion: 1,
    kind: 'session-disposition',
    operation: 'completion',
    record: { workflow: { inbox: false } },
  });

  for (const [name, value] of [
    ['summary', ''],
    ['summary', 'x'.repeat(513)],
    ['next-action', 'bad\u0000text'],
  ] as const) {
    const options = new Map<string, string>([
      ['identity', 'me'],
      ['summary', 'ok'],
      ['next-action', 'continue'],
      ['disposition', 'unfinished'],
    ]);
    options.set(name, value);
    await expect(
      executeSessionCommand({ action: 'handoff', args: ['session-one'], options }, context),
    ).rejects.toMatchObject({ code: 'SESSION_USAGE_ERROR' });
  }
});
