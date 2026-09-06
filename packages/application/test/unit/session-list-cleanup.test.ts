import { describe, expect, it, vi } from 'vitest';
import {
  SessionApplicationService,
  type SessionDiscoveryInput,
} from '../../src/session-application-service.js';

const record = (id: string) => ({ recordId: id }) as never;

function dependencies(discoveries?: () => Promise<readonly SessionDiscoveryInput[]>) {
  return {
    sessions: {
      list: vi.fn(async () => [record('durable')]),
      show: vi.fn(),
      reconcile: vi.fn(async () => []),
    },
    nativeBindings: { listLifecycleBindingIds: vi.fn(async () => []) },
    consumePending: vi.fn(async () => 0),
    ...(discoveries ? { discoveries } : {}),
    projectResurrectionRecord: vi.fn(),
    planResume: vi.fn(),
    verifyResumeConfirmation: vi.fn(),
  };
}

describe('SessionApplicationService list recovery', () => {
  it.each([
    {
      name: 'no discovery factory',
      discoveries: undefined,
      expected: { runtime: null, identity: null, status: 'unavailable' },
    },
    {
      name: 'discovery factory throw',
      discoveries: async () => {
        throw new Error('C:/private/factory token=factory-secret');
      },
      expected: { runtime: null, identity: null, status: 'unavailable' },
    },
    {
      name: 'scanner unavailable',
      discoveries: async () => [
        {
          scanner: {
            runtime: 'pi' as const,
            scan: async () => ({
              status: 'unavailable' as const,
              sessions: [
                {
                  nativeSessionId: 'scanner-secret',
                  nativeSessionRef: { kind: 'native-id' as const, value: 'scanner-secret' },
                  cwd: 'C:/private/scanner-output',
                  title: 'credential scanner-secret',
                  pid: 42,
                  startFingerprint: 'scanner-secret',
                },
              ],
              diagnostic: 'C:/private/scanner raw diagnostic credential=scanner-secret',
            }),
          },
        },
      ],
      expected: { runtime: 'pi', identity: null, status: 'unavailable' },
    },
    {
      name: 'scanner throw',
      discoveries: async () => [
        {
          scanner: {
            runtime: 'claude' as const,
            scan: async () => {
              throw new Error('C:/private/throw credential=throw-secret');
            },
          },
        },
      ],
      expected: { runtime: 'claude', identity: null, status: 'unavailable' },
    },
    {
      name: 'malformed scanner output',
      discoveries: async () => [
        {
          scanner: {
            runtime: 'pi' as const,
            scan: async () => ({
              status: 'malformed' as const,
              sessions: [],
              diagnostic: 'C:/private/malformed bearer malformed-secret',
            }),
          },
        },
      ],
      expected: { runtime: 'pi', identity: null, status: 'malformed' },
    },
  ])(
    'returns durable records and sanitized diagnostics for $name',
    async ({ discoveries, expected }) => {
      const result = await new SessionApplicationService(dependencies(discoveries)).list();

      expect(result.records.map((item) => item.recordId)).toEqual(['durable']);
      expect(result.diagnostics).toEqual([
        {
          ...expected,
          code:
            expected.status === 'malformed'
              ? 'SESSION_DISCOVERY_MALFORMED'
              : 'SESSION_DISCOVERY_UNAVAILABLE',
        },
      ]);
      const serialized = JSON.stringify(result);
      for (const privateValue of [
        'C:/private',
        'raw diagnostic',
        'credential',
        'secret',
        'bearer',
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    },
  );

  it('sorts before bounding diagnostics so discovery order cannot change public output', async () => {
    const discoveries = Array.from({ length: 130 }, (_, index) => ({
      scanner: {
        runtime: (index % 2 === 0 ? 'pi' : 'claude') as 'pi' | 'claude',
        scan: async () => ({
          status: 'unavailable' as const,
          sessions: [],
          diagnostic: `private-${index}`,
        }),
      },
      context: {
        identity: {
          domain: 'personal' as const,
          name: `identity-${String(index).padStart(3, '0')}`,
        },
        nativeBindingRef: `binding-${index}`,
        runtime: (index % 2 === 0 ? 'pi' : 'claude') as 'pi' | 'claude',
      },
    }));
    const forward = await new SessionApplicationService(
      dependencies(async () => discoveries),
    ).list();
    const reverse = await new SessionApplicationService(
      dependencies(async () => [...discoveries].reverse()),
    ).list();

    expect(forward.diagnostics).toHaveLength(128);
    expect(reverse.diagnostics).toEqual(forward.diagnostics);
  });
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
