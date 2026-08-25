import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  createToolRequestEnvelopeV1,
  createToolResultEnvelopeV1,
  parseRuntimeCapabilityManifestV1,
  validateToolCallV1,
  validateToolResultV1,
  type JsonData,
  type RuntimeCapabilityManifestV1,
  type ToolAuthorityV1,
} from "@mpx/runtime-contracts";

export class GatewayError extends Error {
  readonly name = "GatewayError";
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
function fail(code: string, message: string): never { throw new GatewayError(code, message); }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) fail("CANCELLED", "operation was cancelled"); }

export interface GatewayNetworkRequest { readonly url: string; readonly method: "GET" | "POST"; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs: number; readonly maxBodyBytes: number; readonly signal?: AbortSignal }
export interface GatewayNetworkResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
export interface GatewayProcessRequest { readonly executable: string; readonly argv: readonly string[]; readonly environment: Readonly<Record<string, string>>; readonly method: string; readonly params: JsonData; readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal }
export interface GatewayExecutor {
  readonly name: "docker" | "host";
  resolveDns(hostname: string, signal?: AbortSignal): Promise<readonly string[]>;
  requestNetwork(request: GatewayNetworkRequest): Promise<GatewayNetworkResponse>;
  executeProcess(request: GatewayProcessRequest): Promise<{ readonly output: JsonData }>;
}
export type McpLaunchDescriptor =
  | { readonly kind: "process"; readonly executable: string; readonly argv: readonly string[]; readonly environment?: Readonly<Record<string, string>> }
  | { readonly kind: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> };
export interface SearchResult { readonly title: string; readonly url: string; readonly snippet: string }
export interface ProviderSearchResult { readonly results: readonly SearchResult[] }
export interface ProviderFetchResult { readonly content: string; readonly mediaType?: string }
export interface ProviderNetworkAccess { request(input: { url: string; method: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string; signal?: AbortSignal }): Promise<GatewayNetworkResponse> }
export interface ProviderAdapter {
  readonly id: string;
  readonly route: string;
  readonly destination: string;
  readonly paidCredits: number;
  readonly fallbackOnly: boolean;
  search(input: { query: string; maxResults: number; signal?: AbortSignal }, network: ProviderNetworkAccess): Promise<ProviderSearchResult>;
  fetch(input: { url: string; signal?: AbortSignal }, network: ProviderNetworkAccess): Promise<ProviderFetchResult>;
}
export interface RuntimeToolCache { get(partition: string, key: string): Promise<unknown | undefined>; set(partition: string, key: string, value: unknown): Promise<void> }
export interface ManagedDevService { readonly host: string; readonly port: number }
export interface RuntimeToolGatewayOptions {
  readonly capability: RuntimeCapabilityManifestV1;
  readonly executor: GatewayExecutor;
  readonly mcpRoutes: Readonly<Record<string, McpLaunchDescriptor>>;
  readonly providers: readonly ProviderAdapter[];
  readonly cache?: RuntimeToolCache;
  readonly firecrawlFallback?: boolean;
  readonly managedDevServices?: readonly ManagedDevService[];
}
export interface RuntimeToolGateway {
  mcp(input: { serverId: string; method: string; params: JsonData; signal?: AbortSignal }): Promise<{ readonly output: JsonData }>;
  web_search(input: { query: string; provider?: string; maxResults?: number; allowPaidCredits?: number; fallback?: boolean; cache?: boolean; signal?: AbortSignal }): Promise<{ readonly responseId: string; readonly provider: string; readonly results: readonly SearchResult[]; readonly cached: boolean }>;
  fetch_content(input: { url: string; provider?: string; allowPaidCredits?: number; cache?: boolean; signal?: AbortSignal }): Promise<{ readonly responseId: string; readonly provider: string; readonly content: string; readonly mediaType: string | null; readonly cached: boolean }>;
  get_search_content(input: { responseId: string }): Promise<{ readonly results?: readonly SearchResult[]; readonly content?: string }>;
  source_check(input: { claim: string; provider?: string; allowPaidCredits?: number; signal?: AbortSignal }): Promise<{ readonly claim: string; readonly sources: readonly SearchResult[] }>;
}

const MCP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const METHOD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
function exactDescriptor(value: McpLaunchDescriptor): McpLaunchDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("MCP_DESCRIPTOR_INVALID", "descriptor must be an object");
  const keys = Object.keys(value).sort();
  if (value.kind === "process") {
    if (keys.some(key => !["argv", "environment", "executable", "kind"].includes(key)) || (!/^[A-Za-z]:[\\/]/u.test(value.executable) && !value.executable.startsWith("/")) || value.argv.length > 128 || value.argv.some(arg => typeof arg !== "string" || arg.length > 4096)) fail("MCP_DESCRIPTOR_INVALID", "process descriptor contains unsupported or unsafe configuration");
    return Object.freeze({ kind: "process", executable: value.executable, argv: Object.freeze([...value.argv]), ...(value.environment ? { environment: Object.freeze({ ...value.environment }) } : {}) });
  }
  if (value.kind === "http") {
    if (keys.some(key => !["headers", "kind", "url"].includes(key))) fail("MCP_DESCRIPTOR_INVALID", "HTTP descriptor contains unsupported configuration");
    return Object.freeze({ kind: "http", url: value.url, ...(value.headers ? { headers: Object.freeze({ ...value.headers }) } : {}) });
  }
  return fail("MCP_DESCRIPTOR_INVALID", "descriptor kind is unsupported");
}
function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return isIP(address) !== 0;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
}
function authority(manifest: RuntimeCapabilityManifestV1, name: string): ToolAuthorityV1 { return manifest.tools.find(tool => tool.name === name) ?? fail("TOOL_AUTHORITY_DENIED", `aggregate '${name}' is not authorized`); }
function safeText(value: string, maximum: number, code = "INPUT_LIMIT"): string { if (typeof value !== "string" || Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > maximum) fail(code, "text exceeds its bound"); return value; }

export function activateRuntimeToolGateway(options: RuntimeToolGatewayOptions): RuntimeToolGateway {
  const manifest = parseRuntimeCapabilityManifestV1(options.capability);
  if (options.executor.name !== manifest.executor) fail("EXECUTOR_MISMATCH", "gateway executor differs from immutable capability");
  const descriptors = new Map<string, McpLaunchDescriptor>();
  for (const [id, raw] of Object.entries(options.mcpRoutes)) {
    if (!MCP_ID.test(id) || !manifest.routes.includes(`mcp:${id}`)) fail("MCP_ROUTE_DENIED", "MCP descriptor is not selected by this launch");
    descriptors.set(id, exactDescriptor(raw));
  }
  const expectedWebRoute = `web:${manifest.identity.name}`;
  const providers = new Map<string, ProviderAdapter>();
  for (const provider of options.providers) {
    if (!MCP_ID.test(provider.id) || provider.route !== expectedWebRoute || !manifest.routes.includes(provider.route) || !Number.isSafeInteger(provider.paidCredits) || provider.paidCredits < 0) fail("PROVIDER_ROUTE_DENIED", "provider route is not bound to the active identity");
    if (providers.has(provider.id)) fail("PROVIDER_INVALID", "provider IDs must be unique");
    providers.set(provider.id, Object.freeze(provider));
  }
  const partition = `${manifest.identity.domain}:${manifest.identity.name}:${manifest.identity.nativeRuntimeRootDigest}`;
  const content = new Map<string, { results?: readonly SearchResult[]; content?: string }>();
  const managed = new Set((options.managedDevServices ?? []).map(item => `${item.host.toLowerCase()}:${item.port}`));

  function admit(name: string, input: JsonData, values: { route?: string | null; destination?: string | null; paid?: number; cache?: "disabled" | "read-only" | "read-write"; timeout?: number } = {}) {
    const policy = authority(manifest, name); const request = createToolRequestEnvelopeV1({ manifestKey: manifest.manifestKey, launchKey: manifest.launchKey, tool: name, executor: manifest.executor, route: values.route ?? null, destination: values.destination ?? null, paidCredits: values.paid ?? 0, timeoutMs: Math.min(values.timeout ?? policy.timeout.maxMs, policy.timeout.maxMs), cacheMode: values.cache ?? "disabled", input });
    validateToolCallV1(manifest, request); return { policy, request };
  }
  function bounded<T extends JsonData>(name: string, admission: ReturnType<typeof admit>, output: T): T { validateToolResultV1(manifest, admission.request, createToolResultEnvelopeV1({ requestKey: admission.request.requestKey, output, maxOutputBytes: admission.policy.output.maxBytes })); return output; }
  async function networkFor(name: string, provider: ProviderAdapter): Promise<ProviderNetworkAccess> {
    const policy = authority(manifest, name);
    return { request: async input => {
      let url: URL; try { url = new URL(input.url); } catch { return fail("NETWORK_URL_INVALID", "URL is invalid"); }
      if (url.protocol !== "https:" && url.protocol !== "http:") fail("NETWORK_URL_INVALID", "only HTTP(S) is supported");
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        aborted(input.signal); const port = Number(url.port || (url.protocol === "https:" ? 443 : 80)); const dev = managed.has(`${url.hostname.toLowerCase()}:${port}`);
        const addresses = await options.executor.resolveDns(url.hostname, input.signal); aborted(input.signal);
        if (!addresses.length || addresses.some(privateAddress) && !dev) fail("NETWORK_ADDRESS_DENIED", "resolved address is private, local, link-local, or metadata scoped");
        if (!dev && !policy.network.destinations.includes(url.hostname)) fail("TOOL_AUTHORITY_DENIED", "network destination is not authorized");
        const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([key]) => redirects === 0 || !SENSITIVE_HEADERS.has(key.toLowerCase())));
        const response = await options.executor.requestNetwork({ url: url.toString(), method: input.method, headers, ...(input.body === undefined ? {} : { body: input.body }), timeoutMs: Math.min(policy.timeout.maxMs, 30_000), maxBodyBytes: policy.output.maxBytes, ...(input.signal ? { signal: input.signal } : {}) });
        if (jsonBytes(response.body) > policy.output.maxBytes) fail("OUTPUT_LIMIT", "network body exceeds its bound");
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "location")?.[1]; if (!location) return response;
        url = new URL(location, url); if (redirects === 5) fail("REDIRECT_LIMIT", "redirect count exceeds its bound");
      }
      return fail("REDIRECT_LIMIT", "redirect count exceeds its bound");
    } };
  }
  function selectProvider(id: string | undefined, fallback: boolean): ProviderAdapter {
    if (id) {
      const selected = providers.get(id); if (!selected || (selected.fallbackOnly || selected.id === "firecrawl") && !(selected.id === "firecrawl" && options.firecrawlFallback && fallback)) fail("PROVIDER_UNAVAILABLE", "provider is unavailable under current fallback policy"); return selected;
    }
    const selected = [...providers.values()].find(item => !item.fallbackOnly && item.id !== "firecrawl"); if (!selected) fail("PROVIDER_UNAVAILABLE", "no primary provider is configured"); return selected;
  }
  async function cacheGet(tool: string, key: string, enabled: boolean): Promise<unknown | undefined> {
    if (!enabled || !options.cache) return undefined;
    const value = await options.cache.get(partition, key);
    if (value !== undefined && jsonBytes(value) > authority(manifest, tool).cache.maxBytes) fail("CACHE_LIMIT", "cached value exceeds its authority bound");
    return value;
  }
  async function cacheSet(tool: string, key: string, enabled: boolean, value: unknown): Promise<void> {
    if (!enabled || !options.cache) return;
    if (jsonBytes(value) > authority(manifest, tool).cache.maxBytes) fail("CACHE_LIMIT", "cache value exceeds its authority bound");
    await options.cache.set(partition, key, value);
  }

  const gateway: RuntimeToolGateway = {
    async mcp(input) {
      aborted(input.signal); if (!MCP_ID.test(input.serverId) || !METHOD.test(input.method)) fail("MCP_ROUTE_DENIED", "MCP server or method is invalid");
      const descriptor = descriptors.get(input.serverId); if (!descriptor) fail("MCP_ROUTE_DENIED", "MCP server is not privately materialized for this launch");
      const admission = admit("mcp", { method: input.method, params: input.params }, { route: `mcp:${input.serverId}` });
      if (descriptor.kind === "process") {
        const result = await options.executor.executeProcess({ executable: descriptor.executable, argv: descriptor.argv, environment: descriptor.environment ?? {}, method: input.method, params: input.params, timeoutMs: admission.policy.timeout.maxMs, maxOutputBytes: admission.policy.output.maxBytes, ...(input.signal ? { signal: input.signal } : {}) });
        bounded("mcp", admission, result.output); return result;
      }
      const network = await networkFor("mcp", { id: input.serverId, route: `mcp:${input.serverId}`, destination: new URL(descriptor.url).hostname, paidCredits: 0, fallbackOnly: false, search: async () => ({ results: [] }), fetch: async () => ({ content: "" }) });
      const response = await network.request({ url: descriptor.url, method: "POST", headers: { "content-type": "application/json", ...(descriptor.headers ?? {}) }, body: JSON.stringify({ method: input.method, params: input.params }), ...(input.signal ? { signal: input.signal } : {}) });
      let output: JsonData; try { output = JSON.parse(response.body) as JsonData; } catch { fail("MCP_RESPONSE_INVALID", "MCP response is not JSON"); }
      bounded("mcp", admission, output); return { output };
    },
    async web_search(input) {
      aborted(input.signal); const query = safeText(input.query, 4096); const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), 20); const cacheEnabled = input.cache !== false; const key = hash({ operation: "search", query, maxResults, provider: input.provider ?? null });
      const cached = await cacheGet("web_search", key, cacheEnabled) as Omit<Awaited<ReturnType<RuntimeToolGateway["web_search"]>>, "cached"> | undefined; if (cached) return { ...cached, cached: true };
      let selected = selectProvider(input.provider, input.fallback === true); const run = async (provider: ProviderAdapter) => {
        if (provider.paidCredits > (input.allowPaidCredits ?? 0)) fail("PAID_CREDITS_DENIED", "provider exceeds explicit paid-credit budget");
        const admission = admit("web_search", { query, maxResults }, { route: provider.route, destination: provider.destination, paid: provider.paidCredits, cache: cacheEnabled ? "read-write" : "disabled" });
        const found = await provider.search({ query, maxResults, ...(input.signal ? { signal: input.signal } : {}) }, await networkFor("web_search", provider));
        const results = found.results.slice(0, maxResults).map(item => ({ title: safeText(item.title, 1024, "OUTPUT_LIMIT"), url: safeText(item.url, 4096, "OUTPUT_LIMIT"), snippet: safeText(item.snippet, 4096, "OUTPUT_LIMIT") }));
        const responseId = hash({ partition, key, provider: provider.id, results }); const result = bounded("web_search", admission, { responseId, provider: provider.id, results } as unknown as JsonData) as unknown as { responseId: string; provider: string; results: readonly SearchResult[] };
        content.set(responseId, { results }); await cacheSet("web_search", key, cacheEnabled, result); return { ...result, cached: false };
      };
      try { return await run(selected); } catch (error) {
        if (!input.fallback || !options.firecrawlFallback || selected.id === "firecrawl" || error instanceof GatewayError) throw error;
        selected = providers.get("firecrawl") ?? fail("PROVIDER_UNAVAILABLE", "Firecrawl fallback is not configured"); return run(selected);
      }
    },
    async fetch_content(input) {
      aborted(input.signal); safeText(input.url, 4096); const selected = selectProvider(input.provider, false); const cacheEnabled = input.cache !== false; const key = hash({ operation: "fetch", url: input.url, provider: selected.id });
      const cached = await cacheGet("fetch_content", key, cacheEnabled) as Omit<Awaited<ReturnType<RuntimeToolGateway["fetch_content"]>>, "cached"> | undefined; if (cached) return { ...cached, cached: true };
      if (selected.paidCredits > (input.allowPaidCredits ?? 0)) fail("PAID_CREDITS_DENIED", "provider exceeds explicit paid-credit budget");
      const host = new URL(input.url).hostname; const admission = admit("fetch_content", { url: input.url }, { route: selected.route, destination: host, paid: selected.paidCredits, cache: cacheEnabled ? "read-write" : "disabled" });
      const fetched = await selected.fetch({ url: input.url, ...(input.signal ? { signal: input.signal } : {}) }, await networkFor("fetch_content", selected)); const responseId = hash({ partition, key, content: fetched.content });
      const result = bounded("fetch_content", admission, { responseId, provider: selected.id, content: fetched.content, mediaType: fetched.mediaType ?? null } as unknown as JsonData) as unknown as { responseId: string; provider: string; content: string; mediaType: string | null };
      content.set(responseId, { content: result.content }); await cacheSet("fetch_content", key, cacheEnabled, result); return { ...result, cached: false };
    },
    async get_search_content(input) { const admission = admit("get_search_content", { responseId: safeText(input.responseId, 128) }); const found = content.get(input.responseId); if (!found) fail("CONTENT_NOT_FOUND", "content is absent from this identity and launch"); return bounded("get_search_content", admission, found as JsonData) as { results?: readonly SearchResult[]; content?: string }; },
    async source_check(input) { const admission = admit("source_check", { claim: safeText(input.claim, 4096) }); const searched = await gateway.web_search({ query: input.claim, ...(input.provider ? { provider: input.provider } : {}), ...(input.allowPaidCredits === undefined ? {} : { allowPaidCredits: input.allowPaidCredits }), ...(input.signal ? { signal: input.signal } : {}) }); return bounded("source_check", admission, { claim: input.claim, sources: searched.results } as unknown as JsonData) as unknown as { claim: string; sources: readonly SearchResult[] }; },
  };
  return Object.freeze(gateway);
}
