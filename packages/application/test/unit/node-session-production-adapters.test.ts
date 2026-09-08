import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { UserConfig } from '@mpx/config';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { deriveNativeBindingRef, SessionStore } from '@mpx/sessions';
import {
  claudeActivityFromAgentsOutput,
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '../../src/node/session-production-adapters.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

it('recognizes only current-shape interactive Claude agents as active', () => {
  const output = JSON.stringify({
    agents: [
      { kind: 'background', sessionId: 'background', cwd: 'C:/repo', pid: 41 },
      { kind: 'interactive', sessionId: 'current', cwd: 'C:/repo', pid: 42 },
    ],
  });

  expect(claudeActivityFromAgentsOutput(output, 'current')).toBe('active');
  expect(claudeActivityFromAgentsOutput(output, 'background')).toBe('inactive');
});

async function fixture() {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-session-adapters-'));
  roots.push(state);
  const claude = path.join(state, 'claude');
  const pi = path.join(state, 'pi');
  await Promise.all([mkdir(claude), mkdir(pi)]);
  return {
    state,
    claude,
    pi,
    user: { identities: { main: { domain: 'personal', runtimeRoots: { claude, pi } } } } as never,
  };
}

it('saves deterministic native tuples and admits Pi discovery after exact-root and auth checks', async () => {
  const f = await fixture();
  const store = new SessionStore(f.state);
  const verifyRoot = vi.fn(async () => undefined);
  const verifyAuth = vi.fn(async () => undefined);
  const discoveries = await productionSessionDiscoveries({
    user: f.user,
    store,
    environment: {},
    options: {
      exactNativeRootVerifier: { verify: verifyRoot },
      piAuthVerifier: { verify: verifyAuth },
      piProcessInspector: { inspect: async () => null },
    },
  });
  const digest = canonicalNativeRootDigest(f.pi);
  const expected = deriveNativeBindingRef({ domain: 'personal', name: 'main' }, 'pi', digest);
  expect(await store.readNativeBinding(expected)).toMatchObject({
    identity: { domain: 'personal', name: 'main' },
    runtime: 'pi',
    recordedRootDigest: digest,
  });
  expect(verifyRoot).toHaveBeenCalledWith(f.pi);
  expect(verifyAuth).toHaveBeenCalledWith(f.pi);
  expect(
    (await discoveries.find((item) => item.context.runtime === 'pi')!.scanner.scan()).status,
  ).toBe('available');
});

it('restricts Pi discovery before touching Claude roots or creating Claude bindings and scanners', async () => {
  const f = await fixture();
  const store = new SessionStore(f.state);
  const claudeRoot = vi.fn(() => {
    throw new Error('Claude root must not be resolved');
  });
  const verifyRoot = vi.fn(async () => undefined);
  const verifyAuth = vi.fn(async () => undefined);
  const discoveries = await productionSessionDiscoveries({
    user: {
      identities: {
        main: {
          domain: 'personal',
          runtimeRoots: {
            get claude() {
              return claudeRoot();
            },
            pi: f.pi,
          },
        },
      },
    } as unknown as UserConfig,
    store,
    environment: {},
    scope: { runtime: 'pi' },
    options: {
      exactNativeRootVerifier: { verify: verifyRoot },
      piAuthVerifier: { verify: verifyAuth },
    },
  });

  expect(claudeRoot).not.toHaveBeenCalled();
  expect(discoveries.map((item) => item.scanner.runtime)).toEqual(['pi']);
  expect((await store.listNativeBindings()).map((binding) => binding.runtime)).toEqual(['pi']);
  expect(verifyRoot).toHaveBeenCalledExactlyOnceWith(f.pi);
  expect(verifyAuth).toHaveBeenCalledExactlyOnceWith(f.pi);
});

it('restricts Claude discovery before Pi root resolution and preflight', async () => {
  const f = await fixture();
  const piRoot = vi.fn(() => {
    throw new Error('Pi root must not be resolved');
  });
  const verifyRoot = vi.fn(async () => undefined);
  const verifyAuth = vi.fn(async () => undefined);
  const discoveries = await productionSessionDiscoveries({
    user: {
      identities: {
        main: {
          domain: 'personal',
          runtimeRoots: {
            claude: f.claude,
            get pi() {
              return piRoot();
            },
          },
        },
      },
    } as unknown as UserConfig,
    store: new SessionStore(f.state),
    environment: {},
    scope: { runtime: 'claude' },
    options: {
      exactNativeRootVerifier: { verify: verifyRoot },
      piAuthVerifier: { verify: verifyAuth },
    },
  });

  expect(discoveries.map((item) => item.scanner.runtime)).toEqual(['claude']);
  expect(piRoot).not.toHaveBeenCalled();
  expect(verifyRoot).not.toHaveBeenCalled();
  expect(verifyAuth).not.toHaveBeenCalled();
});

it.each(['personal', 'work'] as const)(
  'matches both identity name and %s domain before touching any other roots',
  async (domain) => {
    const f = await fixture();
    const store = new SessionStore(f.state);
    const otherRoots = vi.fn(() => {
      throw new Error('Unselected identity roots must not be resolved');
    });
    const verifyRoot = vi.fn(async () => undefined);
    const verifyAuth = vi.fn(async () => undefined);
    const discoveries = await productionSessionDiscoveries({
      user: {
        identities: {
          main: { domain: 'personal', runtimeRoots: { claude: f.claude, pi: f.pi } },
          other: {
            domain,
            get runtimeRoots() {
              return otherRoots();
            },
          },
        },
      } as unknown as UserConfig,
      store,
      environment: {},
      scope: { identity: { domain, name: 'main' } },
      options: {
        exactNativeRootVerifier: { verify: verifyRoot },
        piAuthVerifier: { verify: verifyAuth },
      },
    });

    expect(otherRoots).not.toHaveBeenCalled();
    if (domain === 'personal') {
      expect(discoveries.map((item) => item.context)).toEqual([
        expect.objectContaining({ identity: { domain, name: 'main' }, runtime: 'claude' }),
        expect.objectContaining({ identity: { domain, name: 'main' }, runtime: 'pi' }),
      ]);
      expect(verifyRoot).toHaveBeenCalledExactlyOnceWith(f.pi);
      expect(verifyAuth).toHaveBeenCalledExactlyOnceWith(f.pi);
    } else {
      expect(discoveries).toEqual([]);
      expect(await store.listNativeBindings()).toEqual([]);
      expect(verifyRoot).not.toHaveBeenCalled();
      expect(verifyAuth).not.toHaveBeenCalled();
    }
  },
);

it('keeps unfiltered discovery across every identity and runtime when one Pi route fails preflight', async () => {
  const f = await fixture();
  const otherPi = path.join(f.state, 'other-pi');
  await mkdir(otherPi);
  const verifyRoot = vi.fn(async (root: string) => {
    if (root === f.pi) {
      throw new Error('private root failure');
    }
  });
  const verifyAuth = vi.fn(async () => undefined);
  const store = new SessionStore(f.state);
  const discoveries = await productionSessionDiscoveries({
    user: {
      identities: {
        other: {
          domain: 'work',
          runtimeRoots: { claude: path.join(f.state, 'other-claude'), pi: otherPi },
        },
        main: { domain: 'personal', runtimeRoots: { claude: f.claude, pi: f.pi } },
      },
    } as unknown as UserConfig,
    store,
    environment: {},
    options: {
      exactNativeRootVerifier: { verify: verifyRoot },
      piAuthVerifier: { verify: verifyAuth },
    },
  });

  expect(discoveries.map(({ context }) => [context.identity.name, context.runtime])).toEqual([
    ['main', 'claude'],
    ['main', 'pi'],
    ['other', 'claude'],
    ['other', 'pi'],
  ]);
  expect(await store.listNativeBindings()).toHaveLength(4);
  expect(verifyRoot.mock.calls).toEqual([[f.pi], [otherPi]]);
  expect(verifyAuth).toHaveBeenCalledExactlyOnceWith(otherPi);
  expect(await discoveries[1]!.scanner.scan()).toEqual({
    status: 'unavailable',
    sessions: [],
    diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
  });
  expect((await discoveries[3]!.scanner.scan()).status).toBe('available');
});

it('returns sanitized unavailable Pi discovery without scanning when live preflight fails', async () => {
  const f = await fixture();
  const scan = vi.fn(async () => null);
  const discoveries = await productionSessionDiscoveries({
    user: f.user,
    store: new SessionStore(f.state),
    environment: {},
    options: {
      exactNativeRootVerifier: {
        verify: async () => {
          throw new Error(`unsafe ${f.pi}`);
        },
      },
      piAuthVerifier: { verify: async () => undefined },
      piProcessInspector: { inspect: scan },
    },
  });
  const result = await discoveries.find((item) => item.context.runtime === 'pi')!.scanner.scan();
  expect(result).toEqual({
    status: 'unavailable',
    sessions: [],
    diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
  });
  expect(JSON.stringify(result)).not.toContain(f.pi);
  expect(scan).not.toHaveBeenCalled();
});

it('fails Pi resume root resolution closed before discovery when the exact root is unsafe', async () => {
  const f = await fixture();
  const store = new SessionStore(f.state);
  const identity = { domain: 'personal', name: 'main' };
  const digest = canonicalNativeRootDigest(f.pi);
  const ref = deriveNativeBindingRef(identity, 'pi', digest);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref,
    identity,
    runtime: 'pi',
    recordedRootDigest: digest,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const verifyAuth = vi.fn(async () => undefined);
  const dependencies = await productionSessionResumeDependencies({
    user: f.user,
    store,
    exactNativeRootVerifier: {
      verify: async () => {
        throw new Error('unsafe root');
      },
    },
    piAuthVerifier: { verify: verifyAuth },
  })({ runtime: 'pi', process: null } as never);

  await expect(dependencies.resolveConfiguredRoot(ref)).rejects.toThrow('unsafe root');
  expect(verifyAuth).not.toHaveBeenCalled();
});

it('fails Pi resume root resolution when auth is unavailable after the root succeeds', async () => {
  const f = await fixture();
  const store = new SessionStore(f.state);
  const identity = { domain: 'personal', name: 'main' };
  const digest = canonicalNativeRootDigest(f.pi);
  const ref = deriveNativeBindingRef(identity, 'pi', digest);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref,
    identity,
    runtime: 'pi',
    recordedRootDigest: digest,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const verifyRoot = vi.fn(async () => undefined);
  const dependencies = await productionSessionResumeDependencies({
    user: f.user,
    store,
    exactNativeRootVerifier: { verify: verifyRoot },
    piAuthVerifier: {
      verify: async () => {
        throw new Error('oauth unavailable');
      },
    },
  })({ runtime: 'pi', process: null } as never);

  await expect(dependencies.resolveConfiguredRoot(ref)).rejects.toThrow('oauth unavailable');
  expect(verifyRoot).toHaveBeenCalledWith(f.pi);
});

it('resolves resume only from configured identity/runtime/root digest after native verification', async () => {
  const f = await fixture();
  const store = new SessionStore(f.state);
  const identity = { domain: 'personal', name: 'main' };
  const digest = canonicalNativeRootDigest(f.pi);
  const ref = deriveNativeBindingRef(identity, 'pi', digest);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref,
    identity,
    runtime: 'pi',
    recordedRootDigest: digest,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const dependencies = await productionSessionResumeDependencies({
    user: f.user,
    store,
    exactNativeRootVerifier: { verify: async () => undefined },
    piAuthVerifier: { verify: async () => undefined },
  })({
    runtime: 'pi',
    process: null,
  } as never);
  await expect(dependencies.resolveConfiguredRoot(ref)).resolves.toMatchObject({
    root: f.pi,
    canonicalRootDigest: digest,
  });
  expect('verifyAccountBinding' in dependencies).toBe(false);
});

it('reports persisted inactive Pi records without process evidence as inactive after target verification', async () => {
  const f = await fixture();
  const verifyTarget = vi.fn(async () => undefined);
  const inspect = vi.fn(async () => undefined);
  const dependencies = await productionSessionResumeDependencies({
    user: f.user,
    store: new SessionStore(f.state),
    piTargetVerifier: verifyTarget,
    processes: { inspect },
  })({ runtime: 'pi', liveness: 'inactive', process: null } as never);
  const ref = { kind: 'root-relative-file' as const, value: 'sessions/session.jsonl' };

  await expect(dependencies.verifyNativeTarget(f.pi, ref, 'pi:session')).resolves.toEqual({
    valid: true,
    activity: 'inactive',
  });
  expect(verifyTarget).toHaveBeenCalledExactlyOnceWith(f.pi, ref);
  expect(inspect).not.toHaveBeenCalled();
});

it.each(['unknown', 'active'] as const)(
  'keeps persisted %s Pi records without process evidence unavailable after target verification',
  async (liveness) => {
    const f = await fixture();
    const verifyTarget = vi.fn(async () => undefined);
    const inspect = vi.fn(async () => undefined);
    const dependencies = await productionSessionResumeDependencies({
      user: f.user,
      store: new SessionStore(f.state),
      piTargetVerifier: verifyTarget,
      processes: { inspect },
    })({ runtime: 'pi', liveness, process: null } as never);
    const ref = { kind: 'root-relative-file' as const, value: 'sessions/session.jsonl' };

    await expect(dependencies.verifyNativeTarget(f.pi, ref, 'pi:session')).resolves.toEqual({
      valid: true,
      activity: 'unavailable',
    });
    expect(verifyTarget).toHaveBeenCalledExactlyOnceWith(f.pi, ref);
    expect(inspect).not.toHaveBeenCalled();
  },
);
