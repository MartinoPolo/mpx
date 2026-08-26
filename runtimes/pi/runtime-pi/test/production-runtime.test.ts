import { expect, it, vi } from "vitest";
import { createRuntimeCapabilityManifestV1, type ToolAuthorityV1 } from "@mpx/runtime-contracts";
import { activatePiProductionRuntime } from "../src/production-runtime.js";

const sha = (value: string) => value.repeat(64);
const authority = (name: string, routes: string[] = []): ToolAuthorityV1 => ({ schemaVersion: 1, name, executors: ["docker"], routes, network: { mode: "deny-all", destinations: [] }, paidCredits: { allowed: false, maxCredits: 0 }, input: { maxBytes: 4096 }, output: { maxBytes: 4096 }, timeout: { maxMs: 1000 }, cache: { mode: "disabled", maxBytes: 4096 } });
function capability(identity: "personal" | "work", server: string) {
  const tools = [authority("mcp", [`mcp:${server}`])];
  return createRuntimeCapabilityManifestV1({ runtime: "pi", launchKey: sha(identity === "personal" ? "a" : "c"), identity: { name: identity, domain: identity, nativeRuntimeRootDigest: sha("b") }, binding: { projectId: "app", repositoryId: "repo", contentScope: identity }, executor: "docker", tools, routes: tools.flatMap(tool => tool.routes), resources: [], mounts: [], destinations: [], skills: [], models: [], nesting: { depth: 0, maxDepth: 0 } });
}

it.each([["personal", "docs"], ["work", "internal"]] as const)("uses the %s launch executor and route adapters without substituting results", async (identity, server) => {
  const manifest = capability(identity, server);
  const tools = new Map<string, any>();
  const executeProcess = vi.fn(async request => ({ output: { identity, executable: request.executable, method: request.method } }));
  const shutdown = vi.fn(async () => undefined);
  activatePiProductionRuntime({
    pi: { registerTool: tool => tools.set(tool.name, tool), on: (_event, handler) => tools.set("shutdown", handler) }, capability: manifest,
    launch: { launchKey: manifest.launchKey, worktreeRoot: `C:/${identity}/repo`, assignedPorts: [4310], executor: "docker" },
    adapters: { executor: { name: "docker", resolveDns: async () => [], requestNetwork: async () => { throw new Error("not called"); }, executeProcess }, mcpRoutes: { [server]: { kind: "process", executable: `C:/trusted/${server}.exe`, argv: [] } }, providers: [], devRuntime: { kind: "docker", spawn: async () => { throw new Error("not called"); }, probe: async () => false, inspect: async () => undefined, stop: async () => undefined, sleep: async () => undefined, now: () => "2026-01-01T00:00:00.000Z" }, shutdown },
  });
  const result = await tools.get("mcp").execute("call", { serverId: server, method: "tools/list", params: null });
  expect(result.details.output).toEqual({ identity, executable: `C:/trusted/${server}.exe`, method: "tools/list" });
  expect(executeProcess).toHaveBeenCalledOnce();
  await tools.get("shutdown")();
  expect(shutdown).toHaveBeenCalledOnce();
});

it("fails closed when launch authority or an executor adapter is altered", () => {
  const manifest = capability("personal", "docs");
  const pi = { registerTool() {} };
  expect(() => activatePiProductionRuntime({ pi, capability: manifest, launch: { launchKey: manifest.launchKey, worktreeRoot: "C:/repo", assignedPorts: [], executor: "host" }, adapters: {} as never })).toThrow(/EXECUTOR_MISMATCH/u);
  expect(() => activatePiProductionRuntime({ pi, capability: manifest, launch: { launchKey: manifest.launchKey, worktreeRoot: "C:/repo", assignedPorts: [], executor: "docker" }, adapters: {} as never })).toThrow(/ADAPTER_REQUIRED/u);
});
