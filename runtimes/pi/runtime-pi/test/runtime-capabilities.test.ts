import { describe, expect, it, vi } from 'vitest';
import { createPiRuntimeCapabilityWiring, PI_CAPABILITY_IDS } from '../src/runtime-capabilities.js';

describe('Pi runtime capability wiring', () => {
  it('activates the supported subagent bridge and keeps gateway capabilities explicitly unsupported', () => {
    const register = vi.fn();
    const wiring = createPiRuntimeCapabilityWiring({ activateSubagents: register });
    const pi = {};
    wiring.activate(pi);
    expect(register).toHaveBeenCalledWith(
      pi,
      expect.objectContaining({
        tools: ['Agent', 'get_subagent_result', 'steer_subagent'],
        joins: ['foreground', 'background', 'groups'],
        schedule: 'explicit-only',
        worktree: expect.objectContaining({
          provider: '@mpx/worktrees',
          failure: 'fatal',
          autoCommit: false,
        }),
      }),
    );
    expect(wiring.capabilityIds).toEqual(PI_CAPABILITY_IDS);
    expect(wiring.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'mcp', code: 'SHARED_GATEWAY_UNAVAILABLE' }),
        expect.objectContaining({ capability: 'web', code: 'SHARED_GATEWAY_UNAVAILABLE' }),
      ]),
    );
  });

  it('narrows child authority and partitions private state by identity with bounded nesting', () => {
    const wiring = createPiRuntimeCapabilityWiring({ activateSubagents() {} });
    expect(wiring.subagents).toMatchObject({
      state: 'identity-private',
      transcripts: 'identity-private',
      memory: 'identity-private',
      maxDepth: 2,
      childAuthority: 'narrow-only',
    });
    expect(wiring.subagents.surfaces).toEqual(['notifications', 'fleet', 'widgets']);
  });
});
