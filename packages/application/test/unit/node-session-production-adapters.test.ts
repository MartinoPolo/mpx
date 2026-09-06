import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalNativeRootDigest } from '@mpx/launch';
import { deriveNativeBindingRef, SessionService, SessionStore } from '@mpx/sessions';
import {
  productionSessionDiscoveries,
  productionSessionResumeDependencies,
} from '../../src/node/session-production-adapters.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('discovers enrolled active Pi sessions from only their recorded root and survives restart without reviving stale processes', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-discovery-'));
  roots.push(state);
  const claudeRoot = path.join(state, 'claude-account'),
    piRoot = path.join(state, 'pi-account'),
    registry = path.join(piRoot, 'agent-resurrect', 'active-sessions'),
    foreignRoot = path.join(state, 'foreign');
  await Promise.all([
    mkdir(claudeRoot),
    mkdir(path.join(piRoot, 'sessions'), { recursive: true }),
    mkdir(registry, { recursive: true }),
    mkdir(foreignRoot),
  ]);
  const sessionFile = path.join(piRoot, 'sessions', 'active.jsonl');
  await writeFile(sessionFile, '{}\n');
  const instant = '2025-06-01T12:00:00.000Z';
  await writeFile(
    path.join(registry, 'active.json'),
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'active',
      sessionFile,
      cwd: 'C:/repo',
      name: 'Private title',
      pid: 42,
      processStartedAt: instant,
      registeredAt: instant,
    }),
  );
  const store = new SessionStore(state),
    user = {
      identities: {
        personal: { domain: 'local', runtimeRoots: { claude: claudeRoot, pi: piRoot } },
      },
    } as never;
  const options = {
    piProcessInspector: {
      inspect: async (pid: number) =>
        pid === 42 || pid === 43 ? { startFingerprint: instant } : null,
    },
    clock: () => Date.parse(instant),
  };
  const first = await productionSessionDiscoveries({
    user,
    store,
    environment: { MPX_CLAUDE_EXECUTABLE: '' },
    accountResolver: { resolve: async () => 'account:enrolled' },
    options,
  });
  expect(first.map((item) => item.scanner.runtime)).toEqual(['claude', 'pi']);
  const observations = await new SessionService(store, () => instant).reconcile(first);
  expect(observations).toMatchObject([
    {
      runtime: 'pi',
      runtimeQualifiedId: 'pi:active',
      title: 'Private title',
      source: 'sessions:pi',
    },
  ]);
  expect(JSON.stringify(observations)).not.toContain(piRoot);
  expect(JSON.stringify(observations)).not.toContain(sessionFile);

  const foreignFile = path.join(foreignRoot, 'foreign.jsonl'),
    foreignEntry = path.join(registry, 'foreign.json');
  await writeFile(foreignFile, '{}\n');
  await writeFile(
    foreignEntry,
    JSON.stringify({
      version: 2,
      agent: 'pi',
      sessionId: 'foreign',
      sessionFile: foreignFile,
      cwd: 'C:/foreign',
      pid: 43,
      processStartedAt: instant,
      registeredAt: instant,
    }),
  );
  await expect(
    first.find((item) => item.scanner.runtime === 'pi')!.scanner.scan(),
  ).rejects.toMatchObject({ code: 'PI_SESSION_ROOT_ESCAPE' });
  await rm(foreignEntry);

  const restarted = await productionSessionDiscoveries({
    user,
    store,
    environment: {},
    accountResolver: { resolve: async () => 'account:enrolled' },
    options: { ...options, piProcessInspector: { inspect: async () => null } },
  });
  expect(await store.listNativeBindings()).toHaveLength(2);
  expect(
    (await restarted.find((item) => item.scanner.runtime === 'pi')!.scanner.scan()).sessions,
  ).toEqual([]);
});

it('preserves an exact durable account binding and makes Pi unavailable when account resolution fails', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-resolution-failure-'));
  roots.push(state);
  const piRoot = path.join(state, 'private-pi-root');
  await mkdir(piRoot);
  const store = new SessionStore(state);
  const identity = { domain: 'personal', name: 'main' } as const;
  const recordedRootDigest = canonicalNativeRootDigest(piRoot);
  const prior = {
    schemaVersion: 1 as const,
    ref: deriveNativeBindingRef(identity, 'pi', recordedRootDigest),
    identity,
    runtime: 'pi' as const,
    recordedRootDigest,
    accountBindingRef: 'account:durable-authority',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  };
  await store.saveNativeBinding(prior);
  const inspect = vi.fn(async () => ({ startFingerprint: 'unused' }));

  const discoveries = await productionSessionDiscoveries({
    user: {
      identities: {
        main: {
          domain: 'personal',
          runtimeRoots: { claude: path.join(state, 'claude'), pi: piRoot },
        },
      },
    } as never,
    store,
    environment: {},
    accountResolver: {
      resolve: async (_identity, runtime) => {
        if (runtime === 'pi') {
          throw new Error(`identity/root mismatch at ${piRoot}; credential=private-token`);
        }
        return null;
      },
    },
    options: { piProcessInspector: { inspect } },
  });

  expect((await store.listNativeBindings()).find((binding) => binding.ref === prior.ref)).toEqual(
    prior,
  );
  const result = await discoveries.find((item) => item.scanner.runtime === 'pi')!.scanner.scan();
  expect(result).toEqual({
    status: 'unavailable',
    sessions: [],
    diagnostic: 'PI_DISCOVERY_UNAVAILABLE',
  });
  expect(JSON.stringify(result)).not.toContain(piRoot);
  expect(JSON.stringify(result)).not.toContain('private-token');
  expect(inspect).not.toHaveBeenCalled();
});

it('does not persist an implicit null when initial account resolution throws', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-initial-resolution-failure-'));
  roots.push(state);
  const store = new SessionStore(state);

  await productionSessionDiscoveries({
    user: {
      identities: {
        main: {
          domain: 'personal',
          runtimeRoots: { claude: path.join(state, 'claude'), pi: path.join(state, 'pi') },
        },
      },
    } as never,
    store,
    environment: {},
    accountResolver: {
      resolve: async (_identity, runtime) => {
        if (runtime === 'pi') {
          throw new Error('temporarily unavailable');
        }
        return null;
      },
    },
  });

  expect((await store.listNativeBindings()).map((binding) => binding.runtime)).toEqual(['claude']);
});

it('persists an explicit null account resolution and intentionally disables Pi discovery', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-resolution-null-'));
  roots.push(state);
  const piRoot = path.join(state, 'pi');
  await mkdir(piRoot);
  const store = new SessionStore(state);
  const identity = { domain: 'personal', name: 'main' } as const;
  const recordedRootDigest = canonicalNativeRootDigest(piRoot);
  const ref = deriveNativeBindingRef(identity, 'pi', recordedRootDigest);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref,
    identity,
    runtime: 'pi',
    recordedRootDigest,
    accountBindingRef: 'account:previous',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });

  const discoveries = await productionSessionDiscoveries({
    user: {
      identities: {
        main: {
          domain: 'personal',
          runtimeRoots: { claude: path.join(state, 'claude'), pi: piRoot },
        },
      },
    } as never,
    store,
    environment: {},
    accountResolver: { resolve: async () => null },
  });

  expect((await store.readNativeBinding(ref)).accountBindingRef).toBeNull();
  await expect(
    discoveries.find((item) => item.scanner.runtime === 'pi')!.scanner.scan(),
  ).resolves.toMatchObject({ status: 'unavailable', sessions: [] });
});

it('creates resume dependencies through structural verifier and process seams', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'mpx-production-resume-'));
  roots.push(state);
  const piRoot = path.join(state, 'pi');
  await mkdir(piRoot);
  const store = new SessionStore(state);
  await store.saveNativeBinding({
    schemaVersion: 1,
    ref: 'binding',
    identity: { domain: 'local', name: 'personal' },
    runtime: 'pi',
    recordedRootDigest: 'a'.repeat(64),
    accountBindingRef: 'account',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const verify = async () => 'verified' as const;
  const dependencies = await productionSessionResumeDependencies({
    user: {
      identities: { personal: { domain: 'local', runtimeRoots: { claude: '', pi: piRoot } } },
    } as never,
    store,
    verifier: { verify },
    processes: { inspect: async () => ({ startFingerprint: 'same' }) },
    piTargetVerifier: async () => undefined,
  })({ runtime: 'pi', process: { pid: 42, startFingerprint: 'same' } } as never);

  await expect(dependencies.resolveConfiguredRoot('binding')).resolves.toMatchObject({
    root: piRoot,
    runtime: 'pi',
  });
  await expect(dependencies.verifyAccountBinding?.('account')).resolves.toBe('verified');
  await expect(
    dependencies.verifyNativeTarget(piRoot, { kind: 'native-id', value: 'id' }, 'pi:id'),
  ).resolves.toEqual({ valid: true, activity: 'active' });
});
