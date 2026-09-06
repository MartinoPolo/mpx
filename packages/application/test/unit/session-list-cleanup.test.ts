import { describe, expect, it, vi } from 'vitest';
import { SessionApplicationService } from '../../src/session-application-service.js';

const record = (id: string) => ({ recordId: id }) as never;

describe('SessionApplicationService list recovery', () => {
  it('consumes lifecycle events, reconciles configured discoveries, and returns deterministic records with bounded diagnostics', async () => {
    const scan = vi.fn(async () => ({
      status: 'malformed' as const,
      sessions: [],
      diagnostic: 'PRIVATE scanner output that must not escape',
    }));
    const consumePending = vi.fn(async () => 1);
    const reconcile = vi.fn(async () => []);
    const service = new SessionApplicationService({
      sessions: {
        list: vi.fn(async () => [record('z'), record('a')]),
        show: vi.fn(),
        reconcile,
      },
      nativeBindings: { listLifecycleBindingIds: vi.fn(async () => ['b']) },
      consumePending,
      discoveries: vi.fn(async () => [
        {
          scanner: { runtime: 'claude' as const, scan },
          context: {
            identity: { domain: 'personal' as const, name: 'main' },
            nativeBindingRef: 'binding',
            runtime: 'claude' as const,
          },
        },
      ]),
      projectResurrectionRecord: vi.fn(),
      planResume: vi.fn(),
      verifyResumeConfirmation: vi.fn(),
    });

    const result = await service.list();

    expect(consumePending).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.any(Array), ['b']);
    expect(result.records.map((item) => item.recordId)).toEqual(['a', 'z']);
    expect(result.diagnostics).toEqual([
      {
        runtime: 'claude',
        identity: { domain: 'personal', name: 'main' },
        status: 'malformed',
        code: 'SESSION_DISCOVERY_MALFORMED',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
