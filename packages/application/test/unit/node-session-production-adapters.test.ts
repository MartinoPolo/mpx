import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { deriveNativeBindingRef, SessionStore } from '@mpx/sessions';
import {
  claudeActivityFromAgentsOutput,
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

it('does not expose a native session discovery adapter', async () => {
  const node = await import('../../src/node/index.js');
  expect(node).not.toHaveProperty('productionSessionDiscoveries');
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
