import { describe, expect, it, vi } from 'vitest';
import {
  FakeSandboxWorker,
  PHASE_F2_REMOTE_TOOL_PATHS,
  ProductionRemoteExecutorRegistry,
  attestRemoteToolSet,
  createSandboxHandle,
} from './index.js';

const h = (value: string) => value.repeat(64);
const binding = {
  launchKey: h('a'),
  planKey: h('b'),
  runtimeToolInventorySha256: h('c'),
  capabilitySha256: h('d'),
  identity: { name: 'work', domain: 'work' as const },
  executor: 'docker' as const,
};

describe('production remote executor', () => {
  it('routes every F1 inventory path through one launch-bound sandbox handle and attests the exact set', async () => {
    const worker = new FakeSandboxWorker(
      Object.fromEntries(
        PHASE_F2_REMOTE_TOOL_PATHS.map((path) => [
          path,
          async (input: unknown) => ({ path, input }),
        ]),
      ),
    );
    const handle = createSandboxHandle(binding, worker);
    const registry = new ProductionRemoteExecutorRegistry();
    registry.bind(handle);
    const adapter = registry.forLaunch(binding.launchKey, binding.identity);
    for (const path of PHASE_F2_REMOTE_TOOL_PATHS) {
      await expect(adapter.execute(path, { value: 1 })).resolves.toEqual({
        path,
        input: { value: 1 },
      });
    }
    expect(
      attestRemoteToolSet(
        adapter.attestation(),
        PHASE_F2_REMOTE_TOOL_PATHS,
        binding.runtimeToolInventorySha256,
      ),
    ).toBe(true);
    expect(worker.hostFallbackCalls).toBe(0);
  });

  it('rejects cross-identity, replay, stale handles, widening, and secret-bearing serialization', async () => {
    const worker = new FakeSandboxWorker({ read: async () => 'ok' });
    const registry = new ProductionRemoteExecutorRegistry();
    registry.bind(createSandboxHandle(binding, worker));
    expect(() =>
      registry.forLaunch(binding.launchKey, { name: 'personal', domain: 'personal' }),
    ).toThrow(/IDENTITY/u);
    const adapter = registry.forLaunch(binding.launchKey, binding.identity);
    await expect(
      adapter.execute('read', { path: '/workspace/a' }, { requestId: 'same' }),
    ).resolves.toBe('ok');
    await expect(
      adapter.execute('read', { path: '/workspace/a' }, { requestId: 'same' }),
    ).rejects.toMatchObject({ code: 'REMOTE_REPLAY' });
    await expect(adapter.execute('not-in-inventory', {})).rejects.toMatchObject({
      code: 'REMOTE_TOOL_DENIED',
    });
    await expect(
      adapter.execute('read', { authorization: 'Bearer token-shaped-canary' }),
    ).rejects.toMatchObject({ code: 'REMOTE_PRIVATE_DATA' });
    registry.bind(createSandboxHandle({ ...binding, planKey: h('e') }, worker));
    await expect(adapter.execute('read', {})).rejects.toMatchObject({
      code: 'REMOTE_HANDLE_STALE',
    });
  });

  it('serializes no OAuth/account state into sandbox plans or worker requests', async () => {
    const capture = vi.fn(async () => 'ok');
    const worker = new FakeSandboxWorker({ read: capture });
    const handle = createSandboxHandle(binding, worker);
    await handle.client.execute('read', { path: '/workspace/file' });
    const serialized = JSON.stringify({
      descriptor: handle.descriptor,
      requests: worker.serializedRequests,
    });
    expect(serialized).not.toMatch(
      /PI_CODING_AGENT_DIR|auth\.json|oauth|Bearer|token-shaped-canary|accountRoot|nativeRuntimeRoot/iu,
    );
    expect(worker.scan).toEqual({
      oauthTokenPresent: false,
      piCodingAgentDirPresent: false,
      authJsonPresent: false,
      accountRootPresent: false,
      canaryPresent: false,
    });
  });
});
