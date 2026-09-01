import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionService, SessionStore } from '@mpx/sessions';
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
