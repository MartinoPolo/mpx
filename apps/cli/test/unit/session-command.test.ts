import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeSessionApplicationService,
  createNodeSessionLegacyImport,
  type NodeSessionApplicationDependencies,
} from '@mpx/application/node';
import { SessionError, SessionService, SessionStore, type SessionRecordV1 } from '@mpx/sessions';
import { executeSessionCommand } from '../../src/session-command.js';

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
async function fixture(overrides: Partial<Omit<NodeSessionApplicationDependencies, 'store'>> = {}) {
  const store = new SessionStore(await mkdtemp(path.join(tmpdir(), 'mpx-cli-session-')));
  await new SessionService(store).save(record('session-one'));
  const resolveIdentity = async () => identity;
  const application = createNodeSessionApplicationService({
    store,
    resolveIdentity,
    legacyImport: createNodeSessionLegacyImport({ store, resolveIdentity }),
    ...overrides,
  });
  return { store, application };
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
    const inspect = vi.fn(async () => ({ status: 'absent' as const }));
    const context = await fixture({ processInspector: { inspect } });
    const activePiRecord: SessionRecordV1 = {
      ...record('pi-active'),
      runtimeQualifiedId: 'pi:active',
      runtime: 'pi',
      nativeSessionRef: { kind: 'root-relative-file', value: 'sessions/active.jsonl' },
      liveness: 'active',
      process: { pid: 42, startFingerprint: 'start' },
    };
    await new SessionService(context.store).save(activePiRecord);
    await executeSessionCommand({ action: 'reconcile', args: [], options: new Map() }, context);
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

  it('rejects malformed legacy mapping syntax after reconcile admission', async () => {
    const prepared = {} as never;
    const prepareReconcile = vi.fn(async () => prepared);
    const reconcile = vi.fn();

    await expect(
      executeSessionCommand(
        {
          action: 'reconcile',
          args: [],
          options: new Map<string, string | string[]>([
            ['import-legacy', ['legacy.json']],
            ['map-account', ['missing-target=']],
          ]),
        },
        { application: { prepareReconcile, reconcile } as never },
      ),
    ).rejects.toMatchObject({
      code: 'SESSION_USAGE_ERROR',
      message: '--map-account requires SOURCE=TARGET',
    });
    expect(prepareReconcile).toHaveBeenCalledWith({ captureScheduled: false });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('validates Pi root mapping syntax before requiring an account mapping', async () => {
    const prepareReconcile = vi.fn(async () => ({}) as never);
    const reconcile = vi.fn();

    await expect(
      executeSessionCommand(
        {
          action: 'reconcile',
          args: [],
          options: new Map<string, string | string[]>([
            ['import-legacy', ['legacy.json']],
            ['map-pi-root', ['missing-root=']],
          ]),
        },
        { application: { prepareReconcile, reconcile } as never },
      ),
    ).rejects.toMatchObject({
      code: 'SESSION_USAGE_ERROR',
      message: '--map-pi-root requires SOURCE=TARGET',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('requires an explicit account mapping before reconciliation', async () => {
    const prepareReconcile = vi.fn(async () => ({}) as never);
    const reconcile = vi.fn();

    await expect(
      executeSessionCommand(
        {
          action: 'reconcile',
          args: [],
          options: new Map<string, string | string[]>([['import-legacy', ['legacy.json']]]),
        },
        { application: { prepareReconcile, reconcile } as never },
      ),
    ).rejects.toMatchObject({
      code: 'SESSION_USAGE_ERROR',
      message: 'legacy import requires explicit --map-account mappings',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reports an unbound parent before invalid branch options', async () => {
    await expect(
      executeSessionCommand(
        {
          action: 'branch',
          args: ['session-one'],
          options: new Map([['workspace', 'invalid']]),
        },
        await fixture({ branchService: { plan: vi.fn(), apply: vi.fn() } as never }),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_BRANCH_LAUNCH_UNBOUND' });
  });

  it.each([
    ['workspace', 'invalid', '--workspace must be default, isolated, or shared'],
    ['intent', 'invalid', '--intent must be read or modify'],
  ])('rejects invalid branch --%s after preparing the parent', async (name, value, message) => {
    const prepareBranch = vi.fn(async () => ({}) as never);

    await expect(
      executeSessionCommand(
        { action: 'branch', args: ['session-one'], options: new Map([[name, value]]) },
        { application: { prepareBranch } as never },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_USAGE_ERROR', message });
    expect(prepareBranch).toHaveBeenCalledWith('session-one');
  });

  it('forwards parsed branch arguments and the prepared token to the application', async () => {
    const prepared = {} as never;
    const prepareBranch = vi.fn(async () => prepared);
    const branch = vi.fn(async () => ({ kind: 'branch-result' }));
    const result = await executeSessionCommand(
      {
        action: 'branch',
        args: ['session-one'],
        options: new Map<string, string | boolean>([
          ['workspace', 'shared'],
          ['intent', 'read'],
          ['branch', 'feature/child'],
          ['terminal-tab', true],
          ['terminal-title', 'Child'],
          ['acknowledge-shared-risk', true],
          ['confirm-plan', 'confirmation'],
          ['dry-run', true],
        ]),
      },
      {
        application: { prepareBranch, branch } as never,
        terminalExecutable: 'C:/terminal.exe',
      },
    );

    expect(prepareBranch).toHaveBeenCalledWith('session-one');
    expect(branch).toHaveBeenCalledWith(prepared, {
      workspace: 'shared',
      intent: 'read',
      branch: 'feature/child',
      terminal: { executable: 'C:/terminal.exe', title: 'Child' },
      acknowledgeSharedRisk: true,
      confirmation: 'confirmation',
      dryRun: true,
    });
    expect(result).toEqual({ data: { kind: 'branch-result' }, warnings: [] });
  });

  it('delegates scheduled capture admission to the application service', async () => {
    const prepared = {} as never;
    const prepareReconcile = vi.fn(async () => prepared);
    const reconcile = vi.fn(async () => ({ data: 'reconciled', warnings: [] }));

    await executeSessionCommand(
      { action: 'reconcile', args: [], options: new Map([['capture', 'scheduled']]) },
      { application: { prepareReconcile, reconcile } as never },
    );

    expect(prepareReconcile).toHaveBeenCalledWith({ captureScheduled: true });
    expect(reconcile).toHaveBeenCalledWith(prepared, {});
  });

  it('admits scheduled capture before parsing legacy mappings', async () => {
    const failure = new SessionError(
      'SESSION_SCHEDULED_CAPTURE_AUTHORITY_UNAVAILABLE',
      'Installed scheduled capture has no valid immutable runner authority.',
    );
    const prepareReconcile = vi.fn(async () => {
      throw failure;
    });
    const reconcile = vi.fn();

    await expect(
      executeSessionCommand(
        {
          action: 'reconcile',
          args: [],
          options: new Map<string, string | string[]>([
            ['capture', 'scheduled'],
            ['import-legacy', ['legacy.json']],
            ['map-account', ['missing-target=']],
          ]),
        },
        { application: { prepareReconcile, reconcile } as never },
      ),
    ).rejects.toBe(failure);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('forwards parsed resume arguments and returns application data', async () => {
    const resume = vi.fn(async () => ({ kind: 'resume-result' }));

    await expect(
      executeSessionCommand(
        {
          action: 'resume',
          args: ['session-one'],
          options: new Map<string, string | boolean>([
            ['confirm-plan', 'confirmation'],
            ['dry-run', true],
          ]),
        },
        { application: { resume } as never },
      ),
    ).resolves.toEqual({ data: { kind: 'resume-result' }, warnings: [] });
    expect(resume).toHaveBeenCalledWith({
      id: 'session-one',
      confirmation: 'confirmation',
      dryRun: true,
    });
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
