import { expect, it, vi } from 'vitest';
import { RUNTIME_TOOL_INVENTORY_SHA256 } from '@mpx/runtime-tools';
import { createRuntimeCapabilityManifestV1, type ToolAuthorityV1 } from '@mpx/runtime-contracts';
import {
  PHASE_F2_PI_ACTIVE_TOOLS,
  PHASE_F2_REMOTE_ATTESTATION_PATHS,
} from '../../src/sandbox-executor.js';
import { activatePiProductionRuntime } from '../../src/production-runtime.js';

const sha = (value: string) => value.repeat(64);
const authority = (name: string): ToolAuthorityV1 => ({
  schemaVersion: 1,
  name,
  executors: ['docker'],
  routes: [],
  network: { mode: 'deny-all', destinations: [] },
  paidCredits: { allowed: false, maxCredits: 0 },
  input: { maxBytes: 4096 },
  output: { maxBytes: 4096 },
  timeout: { maxMs: 1000 },
  cache: { mode: 'disabled', maxBytes: 4096 },
});
function capability(identity: 'personal' | 'work') {
  return createRuntimeCapabilityManifestV1({
    runtime: 'pi',
    launchKey: sha(identity === 'personal' ? 'a' : 'c'),
    identity: { name: identity, domain: identity, nativeRuntimeRootDigest: sha('b') },
    binding: { projectId: 'app', repositoryId: 'repo', contentScope: identity },
    executor: 'docker',
    tools: PHASE_F2_PI_ACTIVE_TOOLS.map(authority),
    routes: [],
    resources: [],
    mounts: [],
    destinations: [],
    skills: [],
    models: [],
    nesting: { depth: 0, maxDepth: 2 },
  });
}
function piControl() {
  let active = ['read', 'bash', 'native-host'];
  const events = new Map<string, () => Promise<void>>();
  return {
    registerTool: vi.fn(),
    replaceModelTools: (tools: readonly { name: string }[]) => {
      active = tools.map((tool) => tool.name);
    },
    activeModelTools: () => active,
    on: (event: string, handler: () => Promise<void>) => events.set(event, handler),
  };
}

it.each(['personal', 'work'] as const)(
  'uses only the %s launch-bound remote executor',
  async (identity) => {
    const manifest = capability(identity),
      pi = piControl(),
      execute = vi.fn(async (path: string, input: unknown) => ({ identity, path, input }));
    const result = activatePiProductionRuntime({
      pi,
      capability: manifest,
      launch: {
        launchKey: manifest.launchKey,
        worktreeRoot: `C:/${identity}/repo`,
        assignedPorts: [4310],
        executor: 'docker',
      },
      adapters: {
        mcpRoutes: {},
        providers: [],
        remoteExecutor: {
          execute,
          attestation: () => ({
            toolPaths: PHASE_F2_REMOTE_ATTESTATION_PATHS,
            digest: sha('d'),
            inventorySha256: RUNTIME_TOOL_INVENTORY_SHA256,
          }),
        },
      },
    });
    expect(result).toMatchObject({ mode: 'sandbox-remote', hostFallback: false });
    expect(pi.activeModelTools()).toEqual(PHASE_F2_PI_ACTIVE_TOOLS);
    expect(pi.registerTool).not.toHaveBeenCalled();
  },
);

it('fails closed when launch authority or the remote replacement adapter is absent', () => {
  const manifest = capability('personal'),
    pi = piControl();
  expect(() =>
    activatePiProductionRuntime({
      pi,
      capability: manifest,
      launch: {
        launchKey: manifest.launchKey,
        worktreeRoot: 'C:/repo',
        assignedPorts: [],
        executor: 'host',
      },
      adapters: {} as never,
    }),
  ).toThrow(/EXECUTOR_MISMATCH/u);
  expect(() =>
    activatePiProductionRuntime({
      pi,
      capability: manifest,
      launch: {
        launchKey: manifest.launchKey,
        worktreeRoot: 'C:/repo',
        assignedPorts: [],
        executor: 'docker',
      },
      adapters: { mcpRoutes: {}, providers: [] },
    }),
  ).toThrow(/REMOTE_EXECUTOR_REQUIRED/u);
  expect(() =>
    activatePiProductionRuntime({
      pi: { registerTool() {} },
      capability: manifest,
      launch: {
        launchKey: manifest.launchKey,
        worktreeRoot: 'C:/repo',
        assignedPorts: [],
        executor: 'docker',
      },
      adapters: {
        mcpRoutes: {},
        providers: [],
        remoteExecutor: {
          execute: async () => null,
          attestation: () => ({
            toolPaths: PHASE_F2_REMOTE_ATTESTATION_PATHS,
            digest: sha('e'),
            inventorySha256: RUNTIME_TOOL_INVENTORY_SHA256,
          }),
        },
      },
    }),
  ).toThrow(/REMOTE_TOOL_REPLACEMENT_REQUIRED/u);
});
