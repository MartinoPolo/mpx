import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSandboxWorker, createSandboxHandle } from './production-remote.js';
import {
  connectLaunchPrivateBridge,
  startLaunchPrivateBridge,
  type LaunchPrivateBridge,
} from './launch-private-bridge.js';

const h = (c: string) => c.repeat(64);
const roots: string[] = [];
const bridges: LaunchPrivateBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((item) => item.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function binding(identity: 'personal' | 'work' = 'personal') {
  return {
    launchKey: h('a'),
    planKey: h('b'),
    runtimeToolInventorySha256: h('c'),
    capabilitySha256: h('d'),
    identity: { name: identity, domain: identity },
    executor: 'docker' as const,
  };
}

async function fixture(identity: 'personal' | 'work' = 'personal') {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-private-bridge-'));
  roots.push(root);
  const worker = new FakeSandboxWorker({ read: async (input) => ({ identity, input }) });
  const handle = createSandboxHandle(binding(identity), worker);
  const bridge = await startLaunchPrivateBridge({
    stateRoot: root,
    binding: handle.descriptor,
    client: handle.client,
    requestTimeoutMs: 1000,
  });
  bridges.push(bridge);
  return { root, worker, bridge };
}

describe('launch-private Pi remote executor bridge', () => {
  it('materializes only attestation data with private permissions and carries an attested call', async () => {
    const { bridge } = await fixture();
    const stored = JSON.parse(await readFile(bridge.stateFile, 'utf8'));
    expect(Object.keys(stored).sort()).toEqual([
      'capabilitySha256',
      'endpoint',
      'identity',
      'launchKey',
      'nonce',
      'planKey',
      'runtimeToolInventorySha256',
      'schemaVersion',
    ]);
    expect(JSON.stringify(stored)).not.toMatch(
      /oauth|auth\.json|token|accountRoot|PI_CODING_AGENT_DIR/iu,
    );
    if (process.platform !== 'win32') {
      expect((await lstat(bridge.stateFile)).mode & 0o077).toBe(0);
    }
    await expect(
      connectLaunchPrivateBridge(bridge.config).execute(
        'read',
        { file: 'README.md' },
        { requestId: 'call-1' },
      ),
    ).resolves.toEqual({ identity: 'personal', input: { file: 'README.md' } });
  });

  it('rejects cross-identity, replay, stale nonce, absence, and bounded-message violations', async () => {
    const { bridge } = await fixture();
    const client = connectLaunchPrivateBridge(bridge.config);
    await client.execute('read', {}, { requestId: 'same' });
    await expect(client.execute('read', {}, { requestId: 'same' })).rejects.toMatchObject({
      code: 'REMOTE_REPLAY',
    });
    await expect(
      connectLaunchPrivateBridge({
        ...bridge.config,
        identity: { name: 'work', domain: 'work' },
      }).execute('read', {}),
    ).rejects.toMatchObject({ code: 'BRIDGE_ATTESTATION_FAILED' });
    await expect(
      connectLaunchPrivateBridge({ ...bridge.config, nonce: '0'.repeat(64) }).execute('read', {}),
    ).rejects.toMatchObject({ code: 'BRIDGE_ATTESTATION_FAILED' });
    await expect(
      connectLaunchPrivateBridge({ ...bridge.config, endpoint: 'tcp://127.0.0.1:1' }).execute(
        'read',
        {},
      ),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
    await expect(client.execute('read', { value: 'x'.repeat(1_100_000) })).rejects.toMatchObject({
      code: 'BRIDGE_FRAME_INVALID',
    });
  });

  it('cancels an in-flight remote request', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-private-bridge-'));
    roots.push(root);
    const handle = createSandboxHandle(
      binding(),
      new FakeSandboxWorker({ read: () => new Promise<never>(() => {}) }),
    );
    const bridge = await startLaunchPrivateBridge({
      stateRoot: root,
      binding: handle.descriptor,
      client: handle.client,
      requestTimeoutMs: 1000,
    });
    bridges.push(bridge);
    const abort = new AbortController(),
      call = connectLaunchPrivateBridge(bridge.config).execute(
        'read',
        {},
        { signal: abort.signal },
      );
    abort.abort();
    await expect(call).rejects.toMatchObject({ code: 'REMOTE_CANCELLED' });
  });

  it.each(['listen', 'state-write', 'acl'] as const)(
    'closes startup resources after an injected %s failure so its port is reusable',
    async (stage) => {
      const root = await mkdtemp(path.join(tmpdir(), 'mpx-private-bridge-startup-'));
      roots.push(root);
      let port = 0,
        aclCalls = 0;
      const listen = async (server: Server) => {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            const address = server.address();
            if (address && typeof address !== 'string') {
              port = address.port;
            }
            resolve();
          });
        });
        if (stage === 'listen') {
          throw new Error('injected listen failure');
        }
      };
      const handle = createSandboxHandle(
        binding(),
        new FakeSandboxWorker({ read: async () => ({}) }),
      );
      await expect(
        startLaunchPrivateBridge({
          stateRoot: root,
          binding: handle.descriptor,
          client: handle.client,
          dependencies: {
            listen,
            writeState:
              stage === 'state-write'
                ? async () => {
                    throw new Error('injected state write failure');
                  }
                : undefined,
            restrictAcl:
              stage === 'acl'
                ? async () => {
                    aclCalls++;
                    if (aclCalls === 2) {
                      throw new Error('injected ACL failure');
                    }
                  }
                : undefined,
          },
        }),
      ).rejects.toThrow(/injected/iu);
      expect(port).toBeGreaterThan(0);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      await expect(
        lstat(path.join(root, 'launch-private', binding().launchKey)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('times out and awaits shutdown while cleaning private state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-private-bridge-'));
    roots.push(root);
    const never = vi.fn(() => new Promise<never>(() => {}));
    const handle = createSandboxHandle(binding(), new FakeSandboxWorker({ read: never }));
    const bridge = await startLaunchPrivateBridge({
      stateRoot: root,
      binding: handle.descriptor,
      client: handle.client,
      requestTimeoutMs: 20,
    });
    bridges.push(bridge);
    await expect(
      connectLaunchPrivateBridge(bridge.config).execute('read', {}),
    ).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' });
    await bridge.close();
    bridges.splice(bridges.indexOf(bridge), 1);
    await expect(lstat(bridge.stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
