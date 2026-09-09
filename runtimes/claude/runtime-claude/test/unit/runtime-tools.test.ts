import { expect, it, vi } from 'vitest';
import { createRuntimeCapabilityManifest } from '@mpx/runtime-contracts';
import { registerClaudeRuntimeTools } from '../../src/runtime-tools.js';

const sha = (value: string) => value.repeat(64);
const authority = (name: string, routes: string[] = []) => ({
  schemaVersion: 1 as const,
  name,
  executors: ['docker' as const],
  routes,
  network: { mode: 'deny-all' as const, destinations: [] },
  paidCredits: { allowed: false, maxCredits: 0 },
  input: { maxBytes: 4096 },
  output: { maxBytes: 4096 },
  timeout: { maxMs: 1000 },
  cache: { mode: 'disabled' as const, maxBytes: 4096 },
});
const capability = createRuntimeCapabilityManifest({
  runtime: 'claude',
  launchKey: sha('a'),
  identity: { name: 'work', domain: 'work', nativeRuntimeRootDigest: sha('b') },
  binding: {
    projectId: 'app',
    repositoryId: 'repo',
    selection: {
      location: { name: 'work', canonicalRoot: 'C:/work' },
      packs: ['development'],
      source: 'project',
    },
  },
  executor: 'docker',
  tools: [authority('mcp', ['mcp:chrome'])],
  routes: ['mcp:chrome'],
  resources: [],
  mounts: [],
  destinations: [],
  skills: [],
  models: [],
  nesting: { depth: 0, maxDepth: 0 },
});

it('registers Claude aggregate contracts without exposing raw MCP routes and publishes shutdown', async () => {
  const registered = new Map<string, (value: any) => Promise<unknown>>(),
    events: unknown[] = [];
  const shutdown = vi.fn(async () => undefined);
  const result = registerClaudeRuntimeTools({
    register: (name, execute) => registered.set(name, execute),
    publish: (event) => events.push(event),
    capability,
    executor: {
      name: 'docker',
      resolveDns: async () => [],
      requestNetwork: async () => ({ status: 200, headers: {}, body: '' }),
      executeProcess: async () => ({ output: { browser: true } }),
    },
    mcpRoutes: { chrome: { kind: 'process', executable: 'C:/trusted/chrome-mcp.exe', argv: [] } },
    providers: [],
    devServer: {
      name: 'dev_server',
      launchKey: sha('a'),
      description: 'dev',
      execute: async () => ({ state: 'ready' }),
    },
    shutdown,
  });
  expect([...registered.keys()].sort()).toEqual(['dev_server', 'mcp']);
  await expect(
    registered.get('mcp')!({ serverId: 'chrome', method: 'tools/call', params: {} }),
  ).resolves.toEqual({ output: { browser: true } });
  await result.shutdown();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(events).toContainEqual({ type: 'runtime-tools:shutdown', launchKey: sha('a') });
});
