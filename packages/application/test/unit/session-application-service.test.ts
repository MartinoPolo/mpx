import { describe, expect, it, vi } from 'vitest';
import { SessionApplicationService, type SessionApplicationDependencies } from '@mpx/application';

const record = (overrides: Record<string, unknown> = {}) =>
  ({
    recordId: 'record',
    runtimeQualifiedId: 'claude:native',
    runtime: 'claude',
    identity: { domain: 'personal', name: 'main' },
    nativeBindingRef: 'binding',
    nativeSessionRef: { kind: 'native-id', value: 'native' },
    launch: { launchKey: 'launch' },
    workflow: { status: 'unfinished' },
    ...overrides,
  }) as never;

function service(overrides: Partial<SessionApplicationDependencies> = {}) {
  return new SessionApplicationService({
    sessions: {
      list: vi.fn(async () => []),
      show: vi.fn(async () => record()),
      reconcile: vi.fn(async () => []),
    },
    nativeBindings: { listLifecycleBindingIds: vi.fn(async () => []) },
    consumePending: vi.fn(async () => 0),
    projectResurrectionRecord: vi.fn((value) => ({ id: value.recordId }) as never),
    planResume: vi.fn(async () => ({ confirmationDigest: 'confirmed' }) as never),
    planCurrentResume: vi.fn(
      async (seed) =>
        ({
          ...seed,
          launch: { executor: { kind: 'host' } },
          approval: { resurrection: 'unchanged' },
        }) as never,
    ),
    verifyResumeConfirmation: vi.fn(),
    ...overrides,
  });
}

describe('SessionApplicationService retained operations', () => {
  it('exports eligible resurrection records without triggering discovery', async () => {
    const discoveries = vi.fn();
    const application = service({
      sessions: {
        list: vi.fn(async () => [
          record({ recordId: 'z' }),
          record({ recordId: 'a' }),
          record({ recordId: 'done', workflow: { status: 'completed' } }),
        ]),
        show: vi.fn(),
        reconcile: vi.fn(),
      },
      discoveries,
    });

    const result = await application.resurrectionExport();

    expect(result.records.map((item) => item.id)).toEqual(['a', 'z']);
    expect(discoveries).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation before invoking resume execution', async () => {
    const executeConfirmedResume = vi.fn(async () => 'must-not-execute');
    const application = service({
      resumeDependencies: vi.fn(async () => ({}) as never),
      planResume: vi.fn(async () => ({ confirmationDigest: 'fresh-confirmation' }) as never),
      verifyResumeConfirmation: vi.fn((_plan, confirmation) => {
        if (confirmation !== 'fresh-confirmation') {
          throw new Error('SESSION_RESUME_CONFIRMATION_MISMATCH');
        }
      }),
      executeConfirmedResume,
    });

    await expect(
      application.resume({ id: 'record', confirmation: 'wrong-confirmation' }),
    ).rejects.toThrow('SESSION_RESUME_CONFIRMATION_MISMATCH');
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });

  it('executes only the freshly replanned resume when its exact confirmation is supplied', async () => {
    const stale = { confirmationDigest: 'stale-confirmation' } as never;
    const fresh = { confirmationDigest: 'fresh-confirmation', exact: 'fresh-plan' } as never;
    const executeConfirmedResume = vi.fn(async () => 'executed');
    const application = service({
      resumeDependencies: vi.fn(async () => ({}) as never),
      planResume: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh),
      verifyResumeConfirmation: vi.fn((_plan, confirmation) => {
        if (confirmation !== 'fresh-confirmation') {
          throw new Error('SESSION_RESUME_CONFIRMATION_MISMATCH');
        }
      }),
      executeConfirmedResume,
    });

    await expect(
      application.resume({ id: 'record', confirmation: 'fresh-confirmation' }),
    ).resolves.toMatchObject({ kind: 'session-resume', result: 'executed' });
    expect(executeConfirmedResume).toHaveBeenCalledWith(expect.objectContaining(fresh), {
      approveHost: true,
    });
  });

  it.each([true, false])(
    'validates a supplied stale confirmation even when dryRun is %s',
    async (dryRun) => {
      const executeConfirmedResume = vi.fn();
      const application = service({
        resumeDependencies: vi.fn(async () => ({}) as never),
        executeConfirmedResume,
        verifyResumeConfirmation: () => {
          throw new Error('SESSION_RESUME_CONFIRMATION_MISMATCH');
        },
      });
      await expect(
        application.resume({ id: 'record', confirmation: 'stale', dryRun }),
      ).rejects.toThrow('SESSION_RESUME_CONFIRMATION_MISMATCH');
      expect(executeConfirmedResume).not.toHaveBeenCalled();
    },
  );

  it('requires explicit confirmation of changed evidence and never falls back to historical planning', async () => {
    const executeConfirmedResume = vi.fn();
    const application = service({
      resumeDependencies: vi.fn(async () => ({}) as never),
      planCurrentResume: vi.fn(
        async () => ({ approval: { resurrection: 'confirmation-required' } }) as never,
      ),
      executeConfirmedResume,
    });
    await expect(
      application.resume({ id: 'record', approveResurrection: true }),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_CONFIRMATION_REQUIRED' });
    await expect(
      service({ resumeDependencies: vi.fn(), planCurrentResume: undefined as never }).resume({
        id: 'record',
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_NOT_CONFIGURED' });
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });

  it('replans after lifecycle consumption and sends the exact confirmed plan and authority to execution', async () => {
    const first = record({ recordId: 'first' });
    const current = record({ recordId: 'current' });
    const show = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(current);
    const planned = { confirmationDigest: 'confirmed', exact: 'plan' } as never;
    const planResume = vi
      .fn()
      .mockResolvedValueOnce({ confirmationDigest: 'old' })
      .mockResolvedValueOnce(planned);
    const executeConfirmedResume = vi.fn(async () => 'executed');
    const application = service({
      sessions: { list: vi.fn(), show, reconcile: vi.fn() },
      resumeDependencies: vi.fn(async () => ({}) as never),
      planResume,
      executeConfirmedResume,
    });

    await expect(
      application.resume({ id: 'record', approveResurrection: true }),
    ).resolves.toMatchObject({ kind: 'session-resume', result: 'executed' });
    expect(executeConfirmedResume).toHaveBeenCalledWith(expect.objectContaining(planned), {
      approveHost: true,
    });
  });
});
