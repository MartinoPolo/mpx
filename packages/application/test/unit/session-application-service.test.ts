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
    liveness: 'inactive',
    workflow: { status: 'unfinished' },
    lifecycle: { bindingId: 'lifecycle', sequence: 1, timestamp: null },
    ...overrides,
  }) as never;

function service(overrides: Partial<SessionApplicationDependencies> = {}) {
  return new SessionApplicationService({
    sessions: {
      list: vi.fn(async () => []),
      show: vi.fn(async () => record()),
      reconcile: vi.fn(async () => ({ records: [record()], diagnostics: [] })),
    },
    nativeBindings: { listLifecycleBindingIds: vi.fn(async () => []) },
    projectResurrectionRecord: vi.fn((value) => ({ id: value.recordId }) as never),
    planResume: vi.fn(async () => ({ native: 'fresh' }) as never),
    planCurrentResume: vi.fn(
      async () =>
        ({
          confirmationDigest: 'confirmed',
          launch: { executor: { kind: 'host' } },
          approval: { resurrection: 'unchanged' },
        }) as never,
    ),
    verifyResumeConfirmation: vi.fn(),
    ...overrides,
  });
}

describe('SessionApplicationService managed inventory', () => {
  it('exports one fresh inventory snapshot with v2 diagnostics and only managed unfinished records', async () => {
    const reconciled = vi.fn(async () => ({
      records: [
        record({ recordId: 'z' }),
        record({ recordId: 'a' }),
        record({ recordId: 'unbound', launch: null }),
        record({ recordId: 'done', workflow: { status: 'completed' } }),
      ],
      diagnostics: [
        {
          runtime: 'pi' as const,
          identity: null,
          status: 'unknown' as const,
          code: 'INSPECTOR_UNKNOWN',
        },
      ],
    }));
    const project = vi.fn((value) => ({ id: value.recordId }) as never);
    const application = service({
      sessions: { list: vi.fn(), show: vi.fn(), reconcile: reconciled },
      nativeBindings: { listLifecycleBindingIds: vi.fn(async () => ['binding']) },
      projectResurrectionRecord: project,
    });

    await expect(application.resurrectionExport()).resolves.toEqual({
      schemaVersion: 2,
      kind: 'session-resurrection-export',
      records: [{ id: 'a' }, { id: 'z' }],
      diagnostics: [
        { runtime: 'pi', identity: null, status: 'unknown', code: 'INSPECTOR_UNKNOWN' },
      ],
    });
    expect(reconciled).toHaveBeenCalledExactlyOnceWith(['binding']);
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('reconciles only the selected record and lifecycle binding before resume authorization', async () => {
    const selected = record();
    const reconcile = vi.fn(async () => ({ records: [selected], diagnostics: [] }));
    const application = service({
      sessions: { list: vi.fn(), show: vi.fn(async () => selected), reconcile },
      resumeDependencies: vi.fn(async () => ({}) as never),
    });

    await application.resume({ id: 'record', dryRun: true });

    expect(reconcile).toHaveBeenCalledExactlyOnceWith(['lifecycle'], {
      runtime: 'claude',
      identity: { domain: 'personal', name: 'main' },
      recordId: 'record',
      lifecycleBindingId: 'lifecycle',
    });
  });

  it('executes only the freshly authorized final plan when its exact confirmation is supplied', async () => {
    const staleRecord = record({ liveness: 'active' });
    const freshRecord = record({ liveness: 'inactive' });
    const planResume = vi.fn(async (value) => ({ native: value.liveness }) as never);
    const fresh = {
      confirmationDigest: 'fresh-confirmation',
      exact: 'fresh-plan',
      launch: { executor: { kind: 'host' } },
      approval: { resurrection: 'unchanged' },
    } as never;
    const executeConfirmedResume = vi.fn(async () => 'executed');
    const application = service({
      sessions: {
        list: vi.fn(),
        show: vi.fn(async () => staleRecord),
        reconcile: vi.fn(async () => ({ records: [freshRecord], diagnostics: [] })),
      },
      resumeDependencies: vi.fn(async () => ({}) as never),
      planResume,
      planCurrentResume: vi.fn(async () => fresh),
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
    expect(planResume).toHaveBeenCalledExactlyOnceWith(freshRecord, {});
    expect(executeConfirmedResume).toHaveBeenCalledExactlyOnceWith(fresh, { approveHost: true });
  });

  it('fails closed when selected inventory liveness is unknown', async () => {
    const executeConfirmedResume = vi.fn();
    const application = service({
      sessions: {
        list: vi.fn(),
        show: vi.fn(async () => record()),
        reconcile: vi.fn(async () => ({
          records: [record({ liveness: 'unknown' })],
          diagnostics: [],
        })),
      },
      resumeDependencies: vi.fn(async () => ({}) as never),
      executeConfirmedResume,
    });

    await expect(application.resume({ id: 'record', dryRun: true })).rejects.toMatchObject({
      code: 'SESSION_RESUME_LIVENESS_UNKNOWN',
    });
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });

  it('rejects a stale confirmation against the final plan before execution', async () => {
    const executeConfirmedResume = vi.fn();
    const application = service({
      resumeDependencies: vi.fn(async () => ({}) as never),
      verifyResumeConfirmation: vi.fn(() => {
        throw new Error('SESSION_RESUME_CONFIRMATION_MISMATCH');
      }),
      executeConfirmedResume,
    });

    await expect(application.resume({ id: 'record', confirmation: 'stale' })).rejects.toThrow(
      'SESSION_RESUME_CONFIRMATION_MISMATCH',
    );
    expect(executeConfirmedResume).not.toHaveBeenCalled();
  });
});
