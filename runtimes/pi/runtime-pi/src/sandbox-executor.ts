import { RUNTIME_TOOL_INVENTORY_SHA256, RUNTIME_TOOL_REGISTRY } from '@mpx/runtime-tools';

export const PHASE_F2_REMOTE_ATTESTATION_PATHS = Object.freeze(
  RUNTIME_TOOL_REGISTRY.map((entry) => entry.path).sort(),
);
export const PHASE_F2_PI_ACTIVE_TOOLS = Object.freeze(
  [...new Set(RUNTIME_TOOL_REGISTRY.map((entry) => entry.topLevel))].sort(),
);

interface PiModelTool {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  execute?(id: string, input: unknown): Promise<unknown>;
}
export interface PiToolSetControl {
  replaceModelTools(tools: readonly PiModelTool[]): void;
  activeModelTools(): readonly string[];
  on?(event: 'session_start' | 'before_agent_start', handler: () => Promise<void>): void;
}
export interface PiRemoteExecutor {
  execute(path: string, input: unknown): Promise<unknown>;
  attestation(): {
    readonly toolPaths: readonly string[];
    readonly digest: string;
    readonly inventorySha256: string;
  };
}
export interface PiSandboxExecutorActivation {
  readonly mode: 'sandbox-remote' | 'approved-host-compatibility';
  readonly hostFallback: boolean;
  readonly activeTools: readonly string[];
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/**
 * Pi itself remains on the host (TUI, model, OAuth, session and history). For Docker launches this
 * atomically replaces every model-triggerable implementation with launch-bound remote proxies.
 * A Pi integration unable to replace (rather than append) tools is rejected before session start.
 */
export function activatePiSandboxExecutor(input: {
  readonly pi: PiToolSetControl;
  readonly executor: 'docker' | 'host';
  readonly remote?: PiRemoteExecutor;
  readonly hostApproved?: boolean;
}): PiSandboxExecutorActivation {
  if (input.executor === 'host') {
    if (input.hostApproved !== true) {
      throw new Error(
        'HOST_EXECUTOR_NOT_APPROVED: host compatibility is an explicit approved mode',
      );
    }
    return Object.freeze({
      mode: 'approved-host-compatibility',
      hostFallback: true,
      activeTools: Object.freeze([...input.pi.activeModelTools()]),
    });
  }
  if (!input.remote) {
    throw new Error('REMOTE_EXECUTOR_REQUIRED: Docker launch has no host fallback');
  }
  const attested = input.remote.attestation();
  if (
    !same(attested.toolPaths, PHASE_F2_REMOTE_ATTESTATION_PATHS) ||
    attested.inventorySha256 !== RUNTIME_TOOL_INVENTORY_SHA256
  ) {
    throw new Error(
      'REMOTE_TOOL_ATTESTATION_MISMATCH: exact F1 inventory paths and digest are required',
    );
  }
  const proxies = PHASE_F2_PI_ACTIVE_TOOLS.map((name) =>
    Object.freeze({
      name,
      label: name,
      description: `Launch-bound sandbox ${name}.`,
      parameters: Object.freeze({ type: 'object', additionalProperties: true }),
      execute: async (_id: string, params: unknown) => input.remote!.execute(name, params),
    }),
  );
  const reassert = async (): Promise<void> => {
    input.pi.replaceModelTools(proxies);
    if (!same(input.pi.activeModelTools(), PHASE_F2_PI_ACTIVE_TOOLS)) {
      throw new Error('REMOTE_TOOL_SET_MISMATCH: native host tools remain active');
    }
  };
  // Synchronous replacement is mandatory so no session can start with native implementations.
  input.pi.replaceModelTools(proxies);
  if (!same(input.pi.activeModelTools(), PHASE_F2_PI_ACTIVE_TOOLS)) {
    throw new Error('REMOTE_TOOL_SET_MISMATCH: native host tools remain active');
  }
  input.pi.on?.('session_start', reassert);
  input.pi.on?.('before_agent_start', reassert);
  return Object.freeze({
    mode: 'sandbox-remote',
    hostFallback: false,
    activeTools: PHASE_F2_PI_ACTIVE_TOOLS,
  });
}
