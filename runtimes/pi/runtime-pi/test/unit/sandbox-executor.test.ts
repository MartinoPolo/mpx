import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_TOOL_INVENTORY_SHA256 } from '@mpx/runtime-tools';
import {
  PHASE_F2_PI_ACTIVE_TOOLS,
  PHASE_F2_REMOTE_ATTESTATION_PATHS,
  activatePiSandboxExecutor,
} from '../../src/sandbox-executor.js';

function fakePi(initial = ['read', 'write', 'edit', 'bash', 'native_host_escape']) {
  let active = [...initial];
  const events = new Map<string, Array<(...args: any[]) => any>>();
  return {
    replaceModelTools: vi.fn((tools: readonly { name: string }[]) => {
      active = tools.map((tool) => tool.name);
    }),
    activeModelTools: () => [...active],
    on: (name: string, handler: (...args: any[]) => any) =>
      events.set(name, [...(events.get(name) ?? []), handler]),
    emit: async (name: string) => {
      for (const handler of events.get(name) ?? []) {
        await handler();
      }
    },
  };
}

describe('host Pi / sandbox executor split', () => {
  it('removes every native host implementation before start and reasserts exact remote tools before each turn', async () => {
    const pi = fakePi();
    const execute = vi.fn(async (path: string, input: unknown) => ({ path, input }));
    const result = activatePiSandboxExecutor({
      pi,
      executor: 'docker',
      remote: {
        execute,
        attestation: () => ({
          toolPaths: PHASE_F2_REMOTE_ATTESTATION_PATHS,
          digest: 'a'.repeat(64),
          inventorySha256: RUNTIME_TOOL_INVENTORY_SHA256,
        }),
      },
    });
    expect(pi.activeModelTools()).toEqual(PHASE_F2_PI_ACTIVE_TOOLS);
    expect(result.hostFallback).toBe(false);
    pi.replaceModelTools([{ name: 'bash' }, { name: 'native_host_escape' }]);
    await pi.emit('before_agent_start');
    expect(pi.activeModelTools()).toEqual(PHASE_F2_PI_ACTIVE_TOOLS);
    expect(pi.replaceModelTools).toHaveBeenCalledTimes(3); // initial replacement, simulated tamper, per-turn reassertion
  });

  it('keeps explicit approved host compatibility but never silently falls back from Docker', () => {
    const dockerPi = fakePi();
    expect(() => activatePiSandboxExecutor({ pi: dockerPi, executor: 'docker' })).toThrow(
      /REMOTE_EXECUTOR_REQUIRED/u,
    );
    const hostPi = fakePi(['read', 'bash']);
    expect(() =>
      activatePiSandboxExecutor({ pi: hostPi, executor: 'host', hostApproved: false }),
    ).toThrow(/HOST_EXECUTOR_NOT_APPROVED/u);
    const host = activatePiSandboxExecutor({ pi: hostPi, executor: 'host', hostApproved: true });
    expect(host.mode).toBe('approved-host-compatibility');
    expect(hostPi.activeModelTools()).toEqual(['read', 'bash']);
  });
});
