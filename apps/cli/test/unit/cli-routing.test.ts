import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { deriveNativeBindingRef, SessionStore, type ResumePlanV1 } from '@mpx/sessions';
import { run } from '../../src/main.js';
import { captureIo } from '../../src/io.js';

const deletedRoutes = [
  ...['enroll', 're-enroll', 'list', 'status', 'verify'].map((action) => ['account', action]),
  ...['intent', 'prepare', 'plan', 'apply', 'verify', 'rollback', 'uninstall'].map((action) => [
    'install',
    action,
  ]),
  ...['show', 'resolve', 'explain', 'validate'].map((action) => ['config', action]),
  ...['list', 'explain', 'doctor'].map((action) => ['provider', action]),
  ...['list', 'search', 'show', 'explain', 'complete'].map((action) => ['skill', action]),
  ...['identity', 'mode', 'skill-policy', 'preset'].flatMap((group) => [
    [group, 'list'],
    [group, 'show'],
  ]),
  ['runtime', 'claude'],
  ['runtime', 'pi'],
  ['view', 'rebuild'],
  ['content', 'current'],
  ['content', 'list'],
  ['content', 'show'],
  ['launch', 'explain'],
  ['launch', 'current'],
  ['launch', 'sbx-plan-export'],
  ['issue', 'show'],
  ['issue', 'update'],
  ['issue', 'close'],
  ['session', 'show'],
  ['session', 'save'],
  ['session', 'branch'],
  ['session', 'mark'],
  ['session', 'handoff'],
  ['session', 'complete'],
  ['session', 'completion'],
  ['session', 'inbox'],
  ['session', 'reconcile'],
  ['cc'],
  ['ccw'],
  ['pi'],
  ['piw'],
] as const;

async function resumableCliFixture() {
  const localAppData = await mkdtemp(path.join(tmpdir(), 'mpx-cli-confirmation-'));
  const nativeRoot = path.join(localAppData, 'native');
  const store = new SessionStore(localAppData);
  const identity = { domain: 'personal', name: 'main' } as const;
  const digest = canonicalNativeRootDigest(nativeRoot);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref: 'binding',
    identity,
    runtime: 'claude',
    recordedRootDigest: digest,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  await store.put({
    schemaVersion: 1,
    recordId: 'record-confirm',
    runtimeQualifiedId: 'claude:confirm',
    runtime: 'claude',
    identity,
    nativeBindingRef: 'binding',
    nativeSessionRef: { kind: 'native-id', value: 'confirm' },
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
    location: { cwd: nativeRoot, project: null, repository: null, worktree: null },
    metadata: { title: null, model: null, effort: null },
    liveness: 'inactive',
    process: null,
    workflow: {
      status: 'paused',
      inbox: false,
      nextAction: null,
      priority: null,
      note: null,
      relatedIssue: null,
      relatedReview: null,
    },
    resume: { state: 'resumable', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
    timestamps: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      lastActivityAt: '2025-01-01T00:00:00.000Z',
    },
    lifecycle: { bindingId: null, sequence: 0, timestamp: null },
  });
  return {
    localAppData,
    store,
    dependencies: async () => ({
      resolveConfiguredRoot: async () => ({
        root: nativeRoot,
        canonicalRootDigest: digest,
        identity,
        runtime: 'claude' as const,
      }),
      verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' as const }),
    }),
  };
}

describe('canonical CLI dispatch', () => {
  it('returns an init dry-run envelope without publishing', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-cli-init-dry-'));
    const io = captureIo();
    const ensure = vi.fn();

    expect(
      await run(['init', '--dry-run', '--json', '--cwd', cwd], io, {
        env: {},
        portService: { ensure } as never,
      }),
    ).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: { plan: { schemaVersion: 1 }, suggestedManifest: { schemaVersion: 1 } },
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('admits confirmed init and publishes its exact discovered manifest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mpx-cli-init-confirm-'));
    const io = captureIo();
    const ensure = vi.fn(async () => ({ lease: { port: 4173 }, warnings: [] }));

    expect(
      await run(['init', '--confirm', '--json', '--cwd', cwd], io, {
        env: {},
        portService: { ensure } as never,
      }),
    ).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: { confirmed: true, lease: { port: 4173 } },
    });
    await expect(access(path.join(cwd, 'mpxconfig.json'))).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalledOnce();
  });

  it.each(deletedRoutes.map((route) => [route]))('rejects deleted route %s', async (route) => {
    const io = captureIo();

    expect(await run([...route], io, { env: {} })).toBe(2);
    expect(io.err.join('')).toContain('USAGE_ERROR');
  });

  it('uses production Pi discovery to normalize stale durable liveness without touching host roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-cli-production-list-'));
    const appData = path.join(root, 'roaming');
    const localAppData = path.join(root, 'local');
    const stateRoot = path.join(localAppData, 'mpx');
    const piRoot = path.join(root, 'native-pi');
    const claudeRoot = path.join(root, 'native-claude');
    const registry = path.join(piRoot, 'agent-resurrect', 'active-sessions');
    await Promise.all([
      mkdir(path.join(appData, 'mpx'), { recursive: true }),
      mkdir(localAppData, { recursive: true }),
      mkdir(registry, { recursive: true }),
      mkdir(claudeRoot, { recursive: true }),
    ]);
    await writeFile(
      path.join(appData, 'mpx', 'config.json'),
      JSON.stringify({
        identities: {
          main: {
            domain: 'personal',
            runtimeRoots: { claude: claudeRoot, pi: piRoot },
            gitAuthorRoute: 'git-main',
          },
        },
        domains: { personal: [root] },
        contentScopes: { personal: { roots: [root], skillPacks: [] } },
        modes: {},
        skillPolicies: {},
        presets: {},
        launchDefaults: { projects: {}, scopes: {} },
        networkPolicies: {},
        executors: { host: {} },
      }),
    );
    const identity = { domain: 'personal', name: 'main' } as const;
    const store = new SessionStore(stateRoot);
    const recordedRootDigest = canonicalNativeRootDigest(piRoot);
    const nativeBindingRef = deriveNativeBindingRef(identity, 'pi', recordedRootDigest);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: nativeBindingRef,
      identity,
      runtime: 'pi',
      recordedRootDigest,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    const sessionFile = path.join(piRoot, 'native-session.jsonl');
    await writeFile(sessionFile, '{}\n');
    await writeFile(
      path.join(registry, 'native.json'),
      JSON.stringify({
        version: 2,
        agent: 'pi',
        sessionId: 'native',
        sessionFile,
        cwd: root,
        name: 'Native session',
        pid: 424242,
        processStartedAt: '2025-01-01T00:00:00.000Z',
        registeredAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    await store.put({
      schemaVersion: 1,
      recordId: 'durable-pi',
      runtimeQualifiedId: 'pi:native',
      runtime: 'pi',
      identity,
      nativeBindingRef,
      nativeSessionRef: { kind: 'root-relative-file', value: 'native-session.jsonl' },
      launch: null,
      location: { cwd: root, project: null, repository: null, worktree: null },
      metadata: { title: 'Native session', model: null, effort: null },
      liveness: 'active',
      process: { pid: 424242, startFingerprint: '2025-01-01T00:00:00.000Z' },
      workflow: {
        status: 'unfinished',
        inbox: true,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'resumable', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: {
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        lastActivityAt: '2025-01-01T00:00:00.000Z',
      },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
    const io = captureIo();

    expect(
      await run(['session', 'list', '--runtime', 'pi', '--json'], io, {
        env: { APPDATA: appData, LOCALAPPDATA: localAppData },
        sessionProcessInspector: { inspect: async () => ({ status: 'absent' }) },
        exactNativeRootVerifier: { verify: async () => undefined },
        piAuthVerifier: { verify: async () => undefined },
      }),
    ).toBe(0);
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: {
        kind: 'session-list',
        records: [
          {
            recordId: 'durable-pi',
            runtimeQualifiedId: 'pi:native',
            identity,
            nativeBindingRef,
            liveness: 'inactive',
            process: null,
          },
        ],
      },
    });
    expect(await store.readNativeBinding(nativeBindingRef)).not.toHaveProperty('accountBindingRef');
  });

  it('fails closed on a wrong plan confirmation and executes only the exact freshly planned digest', async () => {
    const fixture = await resumableCliFixture();
    const executor = vi.fn(
      async (_plan: ResumePlanV1, _authority: { readonly approveHost?: boolean }) => ({
        resumed: true,
      }),
    );
    const dryRunIo = captureIo();
    expect(
      await run(['session', 'resume', 'record-confirm', '--dry-run', '--json'], dryRunIo, {
        env: { LOCALAPPDATA: fixture.localAppData },
        sessionStore: fixture.store,
        sessionResumeDependencies: fixture.dependencies,
        sessionResumeExecutor: executor,
      }),
    ).toBe(0);
    const confirmation = JSON.parse(dryRunIo.out.join('')).data.confirmationDigest as string;

    const wrongIo = captureIo();
    expect(
      await run(
        ['session', 'resume', 'record-confirm', '--confirm-plan', 'wrong-digest', '--json'],
        wrongIo,
        {
          env: { LOCALAPPDATA: fixture.localAppData },
          sessionStore: fixture.store,
          sessionResumeDependencies: fixture.dependencies,
          sessionResumeExecutor: executor,
        },
      ),
    ).toBe(1);
    expect(JSON.parse(wrongIo.out.join(''))).toMatchObject({
      ok: false,
      error: { code: 'SESSION_RESUME_CONFIRMATION_MISMATCH' },
    });
    expect(executor).not.toHaveBeenCalled();

    const confirmedIo = captureIo();
    expect(
      await run(
        ['session', 'resume', 'record-confirm', '--confirm-plan', confirmation, '--json'],
        confirmedIo,
        {
          env: { LOCALAPPDATA: fixture.localAppData },
          sessionStore: fixture.store,
          sessionResumeDependencies: fixture.dependencies,
          sessionResumeExecutor: executor,
        },
      ),
    ).toBe(0);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].confirmationDigest).toBe(confirmation);
  });

  it.each([0, 7])(
    'returns completed resume child exit code %s without changing the envelope',
    async (exitCode) => {
      const fixture = await resumableCliFixture();
      const childResult = { exitCode, stdout: '', stderr: '', truncated: false };
      const executor = vi.fn(async () => childResult);
      const context = {
        env: { LOCALAPPDATA: fixture.localAppData },
        sessionStore: fixture.store,
        sessionResumeDependencies: fixture.dependencies,
        sessionResumeExecutor: executor,
      };
      const dryRunIo = captureIo();

      expect(
        await run(
          ['session', 'resume', 'record-confirm', '--dry-run', '--json'],
          dryRunIo,
          context,
        ),
      ).toBe(0);
      expect(executor).not.toHaveBeenCalled();
      const planned = JSON.parse(dryRunIo.out.join(''));
      expect(planned.ok).toBe(true);
      const confirmedIo = captureIo();

      expect(
        await run(
          [
            'session',
            'resume',
            'record-confirm',
            '--confirm-plan',
            planned.data.confirmationDigest,
            '--json',
          ],
          confirmedIo,
          context,
        ),
      ).toBe(exitCode);
      expect(executor).toHaveBeenCalledOnce();
      expect(JSON.parse(confirmedIo.out.join(''))).toMatchObject({
        ok: true,
        data: { kind: 'session-resume', result: childResult },
      });
    },
  );

  it('passes the exact prepared resume plan and resurrection authority to the injected executor', async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), 'mpx-cli-resume-'));
    const nativeRoot = path.join(localAppData, 'native');
    const store = new SessionStore(localAppData);
    const identity = { domain: 'personal', name: 'main' };
    const digest = canonicalNativeRootDigest(nativeRoot);
    await store.saveNativeBinding({
      schemaVersion: 1,
      ref: 'binding',
      identity,
      runtime: 'claude',
      recordedRootDigest: digest,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    await store.put({
      schemaVersion: 1,
      recordId: 'record-abc',
      runtimeQualifiedId: 'claude:abc',
      runtime: 'claude',
      identity,
      nativeBindingRef: 'binding',
      nativeSessionRef: { kind: 'native-id', value: 'abc' },
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
      location: { cwd: nativeRoot, project: null, repository: null, worktree: null },
      metadata: { title: null, model: null, effort: null },
      liveness: 'inactive',
      process: null,
      workflow: {
        status: 'paused',
        inbox: false,
        nextAction: null,
        priority: null,
        note: null,
        relatedIssue: null,
        relatedReview: null,
      },
      resume: { state: 'resumable', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
      timestamps: {
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        lastActivityAt: '2025-01-01T00:00:00.000Z',
      },
      lifecycle: { bindingId: null, sequence: 0, timestamp: null },
    });
    const executor = vi.fn(
      async (plan: ResumePlanV1, _authority: { readonly approveHost?: boolean }) => ({
        digest: plan.confirmationDigest,
      }),
    );
    const io = captureIo();

    expect(
      await run(['session', 'resume', 'record-abc', '--approve-resurrection', '--json'], io, {
        env: { LOCALAPPDATA: localAppData },
        sessionStore: store,
        sessionResumeDependencies: async () => ({
          resolveConfiguredRoot: async () => ({
            root: nativeRoot,
            canonicalRootDigest: digest,
            identity,
            runtime: 'claude',
          }),
          verifyNativeTarget: async () => ({ valid: true, activity: 'inactive' }),
        }),
        sessionResumeExecutor: executor,
      }),
    ).toBe(0);
    expect(executor).toHaveBeenCalledOnce();
    const [prepared, authority] = executor.mock.calls[0]!;
    expect(prepared).toMatchObject({
      schemaVersion: 1,
      recordId: 'record-abc',
      nativeSessionRef: { kind: 'native-id', value: 'abc' },
    });
    expect(authority).toEqual({ approveHost: true });
    expect(JSON.parse(io.out.join(''))).toMatchObject({
      ok: true,
      data: { kind: 'session-resume', result: { digest: prepared.confirmationDigest } },
    });
  });

  it('executes internal resurrection without revealing it in direct help', async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), 'mpx-cli-routing-'));
    const executeIo = captureIo();

    expect(
      await run(['session', 'resurrect-export', '--json'], executeIo, {
        env: { LOCALAPPDATA: localAppData },
      }),
    ).toBe(0);
    expect(JSON.parse(executeIo.out.join(''))).toMatchObject({
      ok: true,
      data: { schemaVersion: 1, records: [] },
    });

    const helpIo = captureIo();
    expect(await run(['session', 'resurrect-export', '--help'], helpIo, { env: {} })).toBe(0);
    expect(helpIo.out.join('')).not.toContain('resurrect-export');
  });
});
