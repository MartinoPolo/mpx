import { describe, expect, it, vi } from 'vitest';
import {
  SessionApplicationService,
  type SessionApplicationDependencies,
} from '../../src/session-application-service.js';

const record = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    recordId: id,
    runtime: 'pi',
    identity: { domain: 'personal', name: 'main' },
    liveness: 'active',
    workflow: { status: 'unfinished' },
    launch: { launchKey: 'managed' },
    ...overrides,
  }) as never;

function dependencies(
  inventory: Awaited<ReturnType<SessionApplicationDependencies['sessions']['reconcile']>> = {
    records: [record('durable')],
    diagnostics: [],
  },
) {
  return {
    sessions: {
      list: vi.fn(async () => {
        throw new Error('list must not perform a second inventory read');
      }),
      show: vi.fn(),
      reconcile: vi.fn(async () => inventory),
    },
    nativeBindings: { listLifecycleBindingIds: vi.fn(async () => ['z', 'a']) },
    projectResurrectionRecord: vi.fn(),
    planResume: vi.fn(),
    planCurrentResume: vi.fn(),
    verifyResumeConfirmation: vi.fn(),
  } satisfies SessionApplicationDependencies;
}

describe('SessionApplicationService managed inventory', () => {
  it('lists from one reconciled lifecycle-and-process snapshot and applies public filters once', async () => {
    const identity = { domain: 'personal', name: 'main' } as const;
    const input = dependencies({
      records: [
        record('z'),
        record('a'),
        record('inactive', { liveness: 'inactive' }),
        record('done', { workflow: { status: 'completed' } }),
      ],
      diagnostics: [],
    });

    const result = await new SessionApplicationService(input).list({
      filter: { runtime: 'pi', identity, liveness: 'active', workflowStatus: 'unfinished' },
      limit: 1,
    });

    expect(input.sessions.reconcile).toHaveBeenCalledExactlyOnceWith(['z', 'a'], {
      runtime: 'pi',
      identity,
    });
    expect(input.sessions.list).not.toHaveBeenCalled();
    expect(result.records.map((item) => item.recordId)).toEqual(['a']);
  });

  it('returns recoverable partition diagnostics without exposing source failure details', async () => {
    const diagnostic = {
      runtime: 'claude' as const,
      identity: { domain: 'work', name: 'broken' },
      status: 'malformed' as const,
      code: 'SESSION_PARTITION_UNREADABLE',
    };
    const result = await new SessionApplicationService(
      dependencies({ records: [record('valid')], diagnostics: [diagnostic] }),
    ).list();

    expect(result.records.map((item) => item.recordId)).toEqual(['valid']);
    expect(result.diagnostics).toEqual([diagnostic]);
  });

  it('keeps independently verifiable inventory when lifecycle binding enumeration fails', async () => {
    const input = dependencies({ records: [record('readable')], diagnostics: [] });
    input.nativeBindings.listLifecycleBindingIds.mockRejectedValueOnce(new Error('access denied'));

    const result = await new SessionApplicationService(input).list();

    expect(input.sessions.reconcile).toHaveBeenCalledExactlyOnceWith([], undefined);
    expect(result.records.map((item) => item.recordId)).toEqual(['readable']);
    expect(result.diagnostics).toContainEqual({
      runtime: null,
      identity: null,
      status: 'unavailable',
      code: 'SESSION_LIFECYCLE_ENUMERATION_UNAVAILABLE',
    });
  });

  it('reports an inventory source failure as unknown instead of returning stale active records', async () => {
    const input = dependencies();
    input.sessions.reconcile.mockRejectedValueOnce(new Error('C:/private token=secret'));

    const result = await new SessionApplicationService(input).list({
      filter: { runtime: 'pi', identity: { domain: 'personal', name: 'main' } },
    });

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        runtime: 'pi',
        identity: { domain: 'personal', name: 'main' },
        status: 'unknown',
        code: 'SESSION_INVENTORY_SOURCE_UNKNOWN',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
