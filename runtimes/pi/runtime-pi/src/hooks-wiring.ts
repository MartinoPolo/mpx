export type PiHookFailurePolicy = "open" | "closed" | "report" | "runtime-default" | "ignore";
export interface PiHookBinding { readonly event: "tool_call" | "tool_result" | "session_start" | "session_before_compact" | "agent_settled"; readonly policy: "package-manager" | "dangerous-command" | "precommit-secret" | "fallow" | "post-write" | "post-command" | "machine-session" | "compaction" | "notification"; readonly failure: PiHookFailurePolicy }
const HOOKS: readonly PiHookBinding[] = Object.freeze([
  { event: "tool_call", policy: "package-manager", failure: "open" },
  { event: "tool_call", policy: "dangerous-command", failure: "closed" },
  { event: "tool_call", policy: "precommit-secret", failure: "closed" },
  { event: "tool_call", policy: "fallow", failure: "open" },
  { event: "tool_result", policy: "post-write", failure: "report" },
  { event: "tool_result", policy: "post-command", failure: "open" },
  { event: "session_start", policy: "machine-session", failure: "open" },
  { event: "session_before_compact", policy: "compaction", failure: "runtime-default" },
  { event: "agent_settled", policy: "notification", failure: "ignore" },
]);
/** Declarative Pi event map; concrete handlers call the matching @mpx/runtime-hooks policy function. */
export function createPiHookWiring(): readonly PiHookBinding[] { return HOOKS; }
