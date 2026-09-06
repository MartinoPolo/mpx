import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { SessionStore, type ResumePlanV1 } from '@mpx/sessions';
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
      accountBindingRef: null,
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
