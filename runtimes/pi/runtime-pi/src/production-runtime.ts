import { parseRuntimeCapabilityManifestV1, type RuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import type { GatewayExecutor, McpLaunchDescriptor, ProviderAdapter, RuntimeToolCache, RuntimeToolGatewayOptions } from "@mpx/runtime-tools";
import type { RuntimeAdapter } from "@mpx/dev-services";
import { createPiDevServerCapability } from "./dev-services.js";
import { registerPiRuntimeTools } from "./runtime-tools.js";
import { activatePiSandboxExecutor, type PiRemoteExecutor, type PiToolSetControl } from "./sandbox-executor.js";

export interface PiProductionLaunchBinding {
  readonly launchKey: string;
  readonly worktreeRoot: string;
  readonly assignedPorts: readonly number[];
  readonly executor: "host" | "docker";
}
export interface PiProductionAdapters {
  readonly executor?: GatewayExecutor;
  readonly mcpRoutes: Readonly<Record<string, McpLaunchDescriptor>>;
  readonly providers: readonly ProviderAdapter[];
  readonly devRuntime?: RuntimeAdapter;
  readonly cache?: RuntimeToolCache;
  readonly managedDevServices?: RuntimeToolGatewayOptions["managedDevServices"];
  readonly firecrawlFallback?: boolean;
  readonly hostApproved?: boolean;
  readonly remoteExecutor?: PiRemoteExecutor;
  readonly shutdown?: () => Promise<void>;
}
interface PiApi {
  registerTool(tool: { readonly name: string; readonly label: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>>; execute(id: string, params: unknown): Promise<unknown> }): void;
  replaceModelTools?: PiToolSetControl["replaceModelTools"];
  activeModelTools?: PiToolSetControl["activeModelTools"];
  on?(event: "session_shutdown" | "session_start" | "before_agent_start", handler: () => Promise<void>): void;
}
export interface PiProductionRuntimeInput { readonly pi: PiApi; readonly capability: RuntimeCapabilityManifestV1; readonly launch: PiProductionLaunchBinding; readonly adapters: PiProductionAdapters }

/** Mutable I/O enters only through this launch boundary; the immutable projection contributes authority, never credentials. */
export function activatePiProductionRuntime(input: PiProductionRuntimeInput) {
  const capability = parseRuntimeCapabilityManifestV1(input.capability);
  if (input.launch.launchKey !== capability.launchKey) throw new Error("LAUNCH_BINDING_STALE: production adapters belong to another launch");
  if (input.launch.executor !== capability.executor) throw new Error("EXECUTOR_MISMATCH: launch binding differs from capability authority");
  if (capability.executor === "host" && !input.adapters?.executor) throw new Error("ADAPTER_REQUIRED: host compatibility executor was not supplied");
  if (input.adapters.executor && input.adapters.executor.name !== capability.executor) throw new Error("EXECUTOR_MISMATCH: supplied gateway executor differs from launch authority");
  if (capability.executor === "host" && input.adapters.hostApproved !== true) throw new Error("HOST_EXECUTOR_NOT_APPROVED: host execution requires explicit launch approval");
  if (capability.executor === "docker") {
    if (!input.adapters.remoteExecutor) throw new Error("REMOTE_EXECUTOR_REQUIRED: Docker launches never use host tool fallbacks");
    if (!input.pi.replaceModelTools || !input.pi.activeModelTools) throw new Error("REMOTE_TOOL_REPLACEMENT_REQUIRED: Pi must atomically replace native model tools");
    return activatePiSandboxExecutor({ pi: input.pi as PiApi & PiToolSetControl, executor: "docker", remote: input.adapters.remoteExecutor });
  }
  const dev = createPiDevServerCapability({ launchKey: capability.launchKey, worktree: input.launch.worktreeRoot, ports: input.launch.assignedPorts, executor: capability.executor, ...(input.adapters.devRuntime ? { runtimeAdapter: input.adapters.devRuntime } : {}) });
  let stopped = false;
  const shutdown = async () => { if (stopped) return; stopped = true; await dev.shutdown(); await input.adapters.shutdown?.(); };
  return registerPiRuntimeTools({ pi: input.pi, capability, executor: input.adapters.executor!, mcpRoutes: input.adapters.mcpRoutes ?? {}, providers: input.adapters.providers ?? [], devServer: dev.tool, shutdown, ...(input.adapters.cache ? { cache: input.adapters.cache } : {}), ...(input.adapters.managedDevServices ? { managedDevServices: input.adapters.managedDevServices } : {}), ...(input.adapters.firecrawlFallback === undefined ? {} : { firecrawlFallback: input.adapters.firecrawlFallback }) });
}
