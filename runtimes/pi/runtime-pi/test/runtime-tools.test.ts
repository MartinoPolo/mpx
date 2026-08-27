import { expect, it, vi } from "vitest";
import { createRuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import { registerPiRuntimeTools } from "../src/runtime-tools.js";

const sha = (value: string) => value.repeat(64);
const authority = (name: string, routes: string[] = []) => ({ schemaVersion: 1 as const, name, executors: ["docker" as const], routes, network: { mode: "deny-all" as const, destinations: [] }, paidCredits: { allowed: false, maxCredits: 0 }, input: { maxBytes: 4096 }, output: { maxBytes: 4096 }, timeout: { maxMs: 1000 }, cache: { mode: "disabled" as const, maxBytes: 4096 } });
function capability(tools = [authority("mcp", ["mcp:context7"])]) { return createRuntimeCapabilityManifestV1({ runtime: "pi", launchKey: sha("a"), identity: { name: "personal", domain: "personal", nativeRuntimeRootDigest: sha("b") }, binding: { projectId: null, repositoryId: "repo", contentScope: "personal" }, executor: "docker", tools, routes: tools.flatMap(tool => tool.routes), resources: [], mounts: [], destinations: [], skills: [], models: [], nesting: { depth: 0, maxDepth: 0 } }); }

it("registers only selected aggregate tools plus launch-bound dev_server and shuts services down", async () => {
  const registered = new Map<string, any>();
  const shutdown = vi.fn(async () => undefined);
  const projection = registerPiRuntimeTools({
    pi: { registerTool: (tool: any) => registered.set(tool.name, tool), on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") registered.set("shutdown", handler); } },
    capability: capability(),
    executor: { name: "docker", resolveDns: async () => [], requestNetwork: async () => ({ status: 200, headers: {}, body: "" }), executeProcess: async () => ({ output: { server: "context7" } }) },
    mcpRoutes: { context7: { kind: "process", executable: "C:/trusted/context7.exe", argv: [] } }, providers: [],
    devServer: { name: "dev_server", launchKey: sha("a"), description: "dev", execute: vi.fn(async () => ({ state: "ready" })) }, shutdown,
  });
  expect([...registered.keys()].sort()).toEqual(["dev_server", "mcp", "shutdown"]);
  await expect(registered.get("mcp").execute("call", { serverId: "context7", method: "tools/list", params: null })).resolves.toMatchObject({ details: { output: { server: "context7" } } });
  expect(projection.diagnostics).toContainEqual({ code: "RUNTIME_TOOL_UNSUPPORTED", tool: "web_search", phase: "pre-selection" });
  await registered.get("shutdown")();
  expect(shutdown).toHaveBeenCalledOnce();
});
