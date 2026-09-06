import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { deriveNativeBindingRef, SessionStore } from '@mpx/sessions';
import {
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '../../src/node/session-production-adapters.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

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
