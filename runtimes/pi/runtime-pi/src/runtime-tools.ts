import {
  activateRuntimeToolGateway,
  RUNTIME_GATEWAY_TOOL_NAMES,
  type GatewayExecutor,
  type McpLaunchDescriptor,
  type ProviderAdapter,
  type RuntimeToolCache,
  type RuntimeToolGatewayOptions,
  type RuntimeToolName,
  type RuntimeToolUnsupportedDiagnostic,
} from "@mpx/runtime-tools";
import { parseRuntimeCapabilityManifestV1, type JsonData, type RuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import type { DevServerToolAdapter } from "@mpx/dev-services";

interface PiToolApi {
  registerTool(tool: { readonly name: string; readonly label: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>>; execute(toolCallId: string, params: any): Promise<unknown> }): void;
  on?(event: "session_shutdown", handler: () => Promise<void>): void;
}
export interface PiRuntimeToolRegistrationInput {
  readonly pi: PiToolApi;
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
const schema = Object.freeze({ type: "object", additionalProperties: false });
function configured(name: RuntimeToolName, input: PiRuntimeToolRegistrationInput): boolean {
  if (name === "mcp") return Object.keys(input.mcpRoutes).length > 0;
  return input.providers.length > 0;
}
/** Registers narrow aggregate contracts; raw MCP server tools and provider routes never enter Pi's tool list. */
export function registerPiRuntimeTools(input: PiRuntimeToolRegistrationInput) {
  const manifest = parseRuntimeCapabilityManifestV1(input.capability);
  if (input.devServer.launchKey !== manifest.launchKey) throw new Error("DEV_SERVER_LAUNCH_STALE: dev_server belongs to another launch");
  const gateway = activateRuntimeToolGateway({ capability: manifest, executor: input.executor, mcpRoutes: input.mcpRoutes, providers: input.providers, ...(input.cache ? { cache: input.cache } : {}), ...(input.firecrawlFallback === undefined ? {} : { firecrawlFallback: input.firecrawlFallback }), ...(input.managedDevServices ? { managedDevServices: input.managedDevServices } : {}) });
  const authorized = new Set(manifest.tools.map(tool => tool.name));
  const available = RUNTIME_GATEWAY_TOOL_NAMES.filter(name => authorized.has(name) && configured(name, input));
  const diagnostics: RuntimeToolUnsupportedDiagnostic[] = RUNTIME_GATEWAY_TOOL_NAMES.filter(name => !available.includes(name)).map(tool => Object.freeze({ code: "RUNTIME_TOOL_UNSUPPORTED", tool, phase: "pre-selection" }));
  for (const name of available) input.pi.registerTool({ name, label: name, description: `Launch-bound ${name} aggregate.`, parameters: schema, async execute(_toolCallId, params) { const result = await gateway[name](params as never); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } });
  input.pi.registerTool({ name: "dev_server", label: "dev_server", description: input.devServer.description, parameters: schema, async execute(_toolCallId, params) { const result = await input.devServer.execute(params); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } });
  input.pi.on?.("session_shutdown", input.shutdown);
  return Object.freeze({ available: Object.freeze(available), diagnostics: Object.freeze(diagnostics), gateway });
}
