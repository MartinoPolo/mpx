export interface RuntimeToolRegistryEntry { readonly path: string; readonly topLevel: string; readonly category: "aggregate" | "child-operation"; readonly implementation: string }
export const RUNTIME_TOOL_REGISTRY = Object.freeze([
  { path: "mcp", topLevel: "mcp", category: "aggregate", implementation: "packages/runtime-tools/src/index.ts#activateRuntimeToolGateway.mcp" },
  { path: "mcp/:server/:method", topLevel: "mcp", category: "child-operation", implementation: "packages/runtime-tools/src/index.ts#GatewayExecutor.executeProcess|requestNetwork" },
  { path: "web_search", topLevel: "web_search", category: "aggregate", implementation: "packages/runtime-tools/src/index.ts#activateRuntimeToolGateway.web_search" },
  { path: "web_search/:provider/search", topLevel: "web_search", category: "child-operation", implementation: "packages/runtime-tools/src/index.ts#ProviderAdapter.search" },
  { path: "fetch_content", topLevel: "fetch_content", category: "aggregate", implementation: "packages/runtime-tools/src/index.ts#activateRuntimeToolGateway.fetch_content" },
  { path: "fetch_content/:provider/fetch", topLevel: "fetch_content", category: "child-operation", implementation: "packages/runtime-tools/src/index.ts#ProviderAdapter.fetch" },
  { path: "get_search_content", topLevel: "get_search_content", category: "aggregate", implementation: "packages/runtime-tools/src/index.ts#activateRuntimeToolGateway.get_search_content" },
  { path: "get_search_content/:response", topLevel: "get_search_content", category: "child-operation", implementation: "packages/runtime-tools/src/index.ts#launchContentStore" },
  { path: "source_check", topLevel: "source_check", category: "aggregate", implementation: "packages/runtime-tools/src/index.ts#activateRuntimeToolGateway.source_check" },
  { path: "source_check/web_search", topLevel: "source_check", category: "child-operation", implementation: "packages/runtime-tools/src/index.ts#RuntimeToolGateway.web_search" },
  { path: "dev_server", topLevel: "dev_server", category: "aggregate", implementation: "packages/dev-services/src/tool-adapter.ts#createDevServerToolAdapter" },
  ...(["start", "status", "logs", "restart", "stop"] as const).map(action => ({ path: `dev_server/${action}`, topLevel: "dev_server", category: "child-operation" as const, implementation: `packages/dev-services/src/tool-adapter.ts#${action}` })),
] satisfies readonly RuntimeToolRegistryEntry[]);
export const RUNTIME_GATEWAY_TOOL_NAMES = Object.freeze(["mcp", "web_search", "fetch_content", "get_search_content", "source_check"] as const);
export const RUNTIME_TOOL_NAMES = Object.freeze([...RUNTIME_GATEWAY_TOOL_NAMES, "dev_server"] as const);
export type RuntimeToolName = (typeof RUNTIME_GATEWAY_TOOL_NAMES)[number];
