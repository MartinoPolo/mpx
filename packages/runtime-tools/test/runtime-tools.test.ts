import { describe, expect, it, vi } from "vitest";
import { createRuntimeCapabilityManifestV1 } from "@mpx/runtime-contracts";
import { activateRuntimeToolGateway, GatewayError, type GatewayExecutor, type ProviderAdapter, type RuntimeToolCache } from "../src/index.js";

const sha = (c: string) => c.repeat(64);
function manifest(identity = "personal") {
  const authority = (name: string, routes: string[], paid = false) => ({ name, executors: ["docker" as const], routes, network: { mode: "allow-list" as const, destinations: ["search.example.test", "public.example.test", "redirect.example.test", "firecrawl.example.test", "dev.local"] }, paidCredits: { allowed: paid, maxCredits: paid ? 2 : 0 }, input: { maxBytes: 4096 }, output: { maxBytes: 4096 }, timeout: { maxMs: 5000 }, cache: { mode: "read-write" as const, maxBytes: 4096 } });
  return createRuntimeCapabilityManifestV1({ runtime: "pi", launchKey: sha("a"), identity: { name: identity, domain: identity, nativeRuntimeRootDigest: sha(identity === "personal" ? "b" : "c") }, binding: { projectId: null, repositoryId: "repo", contentScope: identity }, executor: "docker", tools: [authority("mcp", ["mcp:docs"]), authority("web_search", ["web:personal"], true), authority("fetch_content", ["web:personal"]), authority("get_search_content", []), authority("source_check", ["web:personal"], true)], routes: ["mcp:docs", "web:personal"], resources: [], mounts: [], destinations: ["search.example.test", "public.example.test", "redirect.example.test", "firecrawl.example.test", "dev.local"], skills: [], models: [], nesting: { depth: 0, maxDepth: 0 } });
}
function executor(overrides: Partial<GatewayExecutor> = {}): GatewayExecutor {
  return { name: "docker", resolveDns: vi.fn(async () => ["93.184.216.34"]), requestNetwork: vi.fn(async () => ({ status: 200, headers: {}, body: "ok" })), executeProcess: vi.fn(async () => ({ output: { ok: true } })), ...overrides };
}
function provider(id = "free", options: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return { id, route: "web:personal", destination: "search.example.test", paidCredits: 0, fallbackOnly: false, async search(input) { return { results: [{ title: input.query, url: "https://public.example.test", snippet: "found" }] }; }, async fetch(input, network) { const response = await network.request({ url: input.url, method: "GET", headers: { authorization: "leak", "x-safe": "yes" } }); return { content: response.body }; }, ...options };
}
const activate = (options: Record<string, unknown> = {}) => activateRuntimeToolGateway({ capability: manifest(), executor: executor(), mcpRoutes: { docs: { kind: "process", executable: "C:/trusted/mcp.exe", argv: [] } }, providers: [provider()], ...options });

describe("immutable MCP gateway", () => {
  it("admits only launch-allowlisted privately materialized MCP server IDs", async () => {
    const gateway = activate();
    await expect(gateway.mcp({ serverId: "docs", method: "tools/call", params: {} })).resolves.toMatchObject({ output: { ok: true } });
    await expect(gateway.mcp({ serverId: "../../settings", method: "tools/call", params: {} })).rejects.toMatchObject({ code: "MCP_ROUTE_DENIED" });
  });

  it("rejects descriptors containing discovery, onboarding, auth, registration, sampling, or elicitation configuration", () => {
    for (const field of ["configPath", "discover", "oauth", "keyring", "registerTools", "sampling", "elicitation"]) {
      expect(() => activate({ mcpRoutes: { docs: { kind: "process", executable: "C:/trusted/mcp.exe", argv: [], [field]: true } } })).toThrowError(GatewayError);
    }
  });

  it("routes MCP process operations only through the selected executor without host fallback", async () => {
    const selected = executor({ executeProcess: vi.fn(async () => { throw new Error("container unavailable"); }) });
    const gateway = activate({ executor: selected });
    await expect(gateway.mcp({ serverId: "docs", method: "tools/list", params: null })).rejects.toThrow("container unavailable");
    expect(selected.executeProcess).toHaveBeenCalledOnce();
  });
});

describe("bounded identity-partitioned web gateway", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1"])("denies SSRF address %s after DNS resolution", async (address) => {
    const selected = executor({ resolveDns: vi.fn(async () => [address]) });
    await expect(activate({ executor: selected }).fetch_content({ url: "https://public.example.test" })).rejects.toMatchObject({ code: "NETWORK_ADDRESS_DENIED" });
    expect(selected.requestNetwork).not.toHaveBeenCalled();
  });

  it("revalidates every redirect and strips sensitive headers", async () => {
    const selected = executor({ requestNetwork: vi.fn(async (request) => request.url.includes("public") ? { status: 302, headers: { location: "https://redirect.example.test/end" }, body: "" } : { status: 200, headers: {}, body: "done" }) });
    const gateway = activate({ executor: selected, providers: [provider("free", { destination: "public.example.test" })] });
    await gateway.fetch_content({ url: "https://public.example.test/start" });
    expect(selected.resolveDns).toHaveBeenCalledTimes(2);
    expect(selected.requestNetwork).toHaveBeenLastCalledWith(expect.objectContaining({ headers: { "x-safe": "yes" } }));
  });

  it("permits an exact managed dev-service host and port but not neighboring loopback routes", async () => {
    const selected = executor({ resolveDns: vi.fn(async () => ["127.0.0.1"]) });
    const gateway = activate({ executor: selected, managedDevServices: [{ host: "dev.local", port: 4310 }], providers: [provider("free", { destination: "dev.local" })] });
    await expect(gateway.fetch_content({ url: "http://dev.local:4310/health" })).resolves.toBeTruthy();
    await expect(gateway.fetch_content({ url: "http://dev.local:4311/health" })).rejects.toMatchObject({ code: "NETWORK_ADDRESS_DENIED" });
  });

  it("rejects an opposite-identity provider route", () => {
    expect(() => activate({ providers: [provider("work", { route: "web:work" })] })).toThrowError(/route/u);
  });

  it("checks identity-partitioned cache before consuming paid provider credits", async () => {
    const values = new Map<string, unknown>(); const cache: RuntimeToolCache = { get: vi.fn(async (partition, key) => values.get(`${partition}:${key}`)), set: vi.fn(async (partition, key, value) => { values.set(`${partition}:${key}`, value); }) };
    const paid = provider("paid", { paidCredits: 1, search: vi.fn(async () => ({ results: [{ title: "paid", url: "https://public.example.test", snippet: "x" }] })) });
    const gateway = activate({ cache, providers: [paid] });
    await gateway.web_search({ query: "same", allowPaidCredits: 1 });
    await gateway.web_search({ query: "same", allowPaidCredits: 1 });
    expect(paid.search).toHaveBeenCalledOnce();
    expect(cache.get).toHaveBeenCalledWith(expect.stringContaining("personal"), expect.any(String));
  });

  it("keeps Firecrawl unavailable by default and uses it only as an explicit fallback", async () => {
    const firecrawl = provider("firecrawl", { fallbackOnly: true, paidCredits: 1, search: vi.fn(async () => ({ results: [{ title: "fallback", url: "https://public.example.test", snippet: "x" }] })) });
    await expect(activate({ providers: [firecrawl] }).web_search({ query: "q", allowPaidCredits: 1 })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const primary = provider("primary", { search: vi.fn(async () => { throw new Error("down"); }) });
    const gateway = activate({ providers: [primary, firecrawl], firecrawlFallback: true });
    await expect(gateway.web_search({ query: "q", allowPaidCredits: 1, fallback: true })).resolves.toMatchObject({ results: [{ title: "fallback" }] });
  });

  it("enforces timeout, result, body and cancellation bounds", async () => {
    const many = provider("many", { search: vi.fn(async () => ({ results: Array.from({ length: 20 }, (_, index) => ({ title: `${index}`, url: "https://public.example.test", snippet: "x" })) })) });
    const gateway = activate({ providers: [many] }); const aborted = new AbortController(); aborted.abort();
    await expect(gateway.web_search({ query: "q", maxResults: 3 })).resolves.toHaveProperty("results.length", 3);
    await expect(gateway.web_search({ query: "q", signal: aborted.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(gateway.fetch_content({ url: `https://public.example.test/${"x".repeat(5000)}` })).rejects.toMatchObject({ code: "INPUT_LIMIT" });
  });

  it("exposes bounded aggregate search-content and source-check contracts", async () => {
    const gateway = activate(); const searched = await gateway.web_search({ query: "claim" });
    await expect(gateway.get_search_content({ responseId: searched.responseId })).resolves.toMatchObject({ results: expect.any(Array) });
    await expect(gateway.source_check({ claim: "claim" })).resolves.toMatchObject({ claim: "claim", sources: expect.any(Array) });
    await expect(gateway.get_search_content({ responseId: "borrowed" })).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });
  });
});
