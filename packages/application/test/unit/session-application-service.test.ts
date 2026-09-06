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
    expect(executeConfirmedResume).toHaveBeenCalledWith(planned, { approveHost: true });
  });
});
