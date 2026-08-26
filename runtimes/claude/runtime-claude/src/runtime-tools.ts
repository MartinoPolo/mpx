import { activateRuntimeToolGateway, RUNTIME_GATEWAY_TOOL_NAMES, type GatewayExecutor, type McpLaunchDescriptor, type ProviderAdapter, type RuntimeToolCache, type RuntimeToolGatewayOptions, type RuntimeToolName, type RuntimeToolUnsupportedDiagnostic } from "@mpx/runtime-tools";
import { parseRuntimeCapabilityManifestV1, type RuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import type { DevServerToolAdapter } from "@mpx/dev-services";

export interface ClaudeRuntimeToolRegistrationInput {
  readonly register: (name: RuntimeToolName | "dev_server", execute: (input: any) => Promise<unknown>) => void;
  readonly publish: (event: Readonly<Record<string, unknown>>) => void;
  readonly capability: RuntimeCapabilityManifestV1;
  readonly executor: GatewayExecutor;
  readonly mcpRoutes: Readonly<Record<string, McpLaunchDescriptor>>;
  readonly providers: readonly ProviderAdapter[];
  readonly cache?: RuntimeToolCache;
  readonly firecrawlFallback?: boolean;
  readonly managedDevServices?: RuntimeToolGatewayOptions["managedDevServices"];
  readonly devServer: DevServerToolAdapter;
  readonly shutdown: () => Promise<void>;
}
function configured(name: RuntimeToolName, input: ClaudeRuntimeToolRegistrationInput): boolean { return name === "mcp" ? Object.keys(input.mcpRoutes).length > 0 : input.providers.length > 0; }
/** Binds Claude model tools to the same aggregate gateway used by Pi; raw routes remain private launch material. */
export function registerClaudeRuntimeTools(input: ClaudeRuntimeToolRegistrationInput) {
  const manifest = parseRuntimeCapabilityManifestV1(input.capability);
  if (manifest.runtime !== "claude") throw new Error("RUNTIME_MISMATCH: Claude tool projection requires a Claude capability manifest");
  if (input.devServer.launchKey !== manifest.launchKey) throw new Error("DEV_SERVER_LAUNCH_STALE: dev_server belongs to another launch");
  const gateway = activateRuntimeToolGateway({ capability: manifest, executor: input.executor, mcpRoutes: input.mcpRoutes, providers: input.providers, ...(input.cache ? { cache: input.cache } : {}), ...(input.firecrawlFallback === undefined ? {} : { firecrawlFallback: input.firecrawlFallback }), ...(input.managedDevServices ? { managedDevServices: input.managedDevServices } : {}) });
  const authorized = new Set(manifest.tools.map(tool => tool.name));
  const available = RUNTIME_GATEWAY_TOOL_NAMES.filter(name => authorized.has(name) && configured(name, input));
  const diagnostics: RuntimeToolUnsupportedDiagnostic[] = RUNTIME_GATEWAY_TOOL_NAMES.filter(name => !available.includes(name)).map(tool => Object.freeze({ code: "RUNTIME_TOOL_UNSUPPORTED", tool, phase: "pre-selection" }));
  for (const name of available) input.register(name, value => gateway[name](value as never));
  input.register("dev_server", value => input.devServer.execute(value));
  const shutdown = async () => { await input.shutdown(); input.publish(Object.freeze({ type: "runtime-tools:shutdown", launchKey: manifest.launchKey })); };
  return Object.freeze({ available: Object.freeze(available), diagnostics: Object.freeze(diagnostics), gateway, shutdown });
}
