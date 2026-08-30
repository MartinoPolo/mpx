export const PI_CAPABILITY_IDS = Object.freeze([
  'pi.subagents.agent',
  'pi.subagents.result',
  'pi.subagents.steer',
  'pi.subagents.groups',
  'pi.subagents.schedule-explicit',
  'pi.subagents.worktree',
  'pi.subagents.notifications',
  'pi.subagents.fleet',
  'pi.subagents.widgets',
  'pi.runtime-hooks',
  'pi.dev-server',
  'pi.runtime-status',
] as const);

export interface PiSubagentBridgePolicy {
  readonly tools: readonly ['Agent', 'get_subagent_result', 'steer_subagent'];
  readonly joins: readonly ['foreground', 'background', 'groups'];
  readonly schedule: 'explicit-only';
  readonly worktree: {
    readonly provider: '@mpx/worktrees';
    readonly failure: 'fatal';
    readonly autoCommit: false;
  };
  readonly state: 'identity-private';
  readonly transcripts: 'identity-private';
  readonly memory: 'identity-private';
  readonly maxDepth: 2;
  readonly childAuthority: 'narrow-only';
  readonly surfaces: readonly ['notifications', 'fleet', 'widgets'];
}
export interface UnsupportedCapabilityDiagnostic {
  readonly capability: 'mcp' | 'web';
  readonly code: 'SHARED_GATEWAY_UNAVAILABLE';
  readonly message: string;
}
export interface PiCapabilityWiring {
  readonly capabilityIds: typeof PI_CAPABILITY_IDS;
  readonly subagents: PiSubagentBridgePolicy;
  readonly diagnostics: readonly UnsupportedCapabilityDiagnostic[];
  activate(pi: unknown): void;
}
export interface PiCapabilityDependencies {
  activateSubagents(pi: unknown, policy: PiSubagentBridgePolicy): void;
}

const SUBAGENT_POLICY: PiSubagentBridgePolicy = Object.freeze({
  tools: Object.freeze(['Agent', 'get_subagent_result', 'steer_subagent'] as const),
  joins: Object.freeze(['foreground', 'background', 'groups'] as const),
  schedule: 'explicit-only',
  worktree: Object.freeze({ provider: '@mpx/worktrees', failure: 'fatal', autoCommit: false }),
  state: 'identity-private',
  transcripts: 'identity-private',
  memory: 'identity-private',
  maxDepth: 2,
  childAuthority: 'narrow-only',
  surfaces: Object.freeze(['notifications', 'fleet', 'widgets'] as const),
});
const DIAGNOSTICS = Object.freeze(
  (['mcp', 'web'] as const).map((capability) =>
    Object.freeze({
      capability,
      code: 'SHARED_GATEWAY_UNAVAILABLE' as const,
      message: `${capability} is intentionally disabled until the shared gateway API lands.`,
    }),
  ),
);

/** Thin activation boundary around the supported vendored Pi bridge. Policy is immutable and integration dependencies are injected. */
export function createPiRuntimeCapabilityWiring(
  dependencies: PiCapabilityDependencies,
): PiCapabilityWiring {
  return Object.freeze({
    capabilityIds: PI_CAPABILITY_IDS,
    subagents: SUBAGENT_POLICY,
    diagnostics: DIAGNOSTICS,
    activate(pi: unknown) {
      dependencies.activateSubagents(pi, SUBAGENT_POLICY);
    },
  });
}
