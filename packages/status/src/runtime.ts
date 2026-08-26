export type RuntimeStatusFreshnessStateV1 = "current" | "stale" | "unavailable" | "error";
export type RuntimeStatusSourceV1 = "native" | "provider" | "derived" | "cache";
export interface RuntimeStatusGroupMetadataV1 { source: RuntimeStatusSourceV1; state: RuntimeStatusFreshnessStateV1; capturedAt: string | null; freshUntil: string | null; diagnostic: string | null; unavailable: string | null }
export interface RuntimeStatusBindingV1 { launchKey: string; runtimeId: string; repositoryId: string }
export type RuntimeStatusHarnessV1 =
  | { kind: "claude"; version: string | null; surface: "statusline" }
  | { kind: "pi"; version: string | null; surface: "footer" };
interface Group extends RuntimeStatusGroupMetadataV1 {}
export interface RuntimeIdentityStatusV1 extends Group { profile: "personal" | "work" | null; label: string | null }
export interface RuntimeSessionStatusV1 extends Group { elapsedMs: number | null; turns: number | null; title?: string | null }
export interface RuntimeModelStatusV1 extends Group { modelId: string | null; label: string | null; contextUsedTokens: number | null; contextLimitTokens: number | null; effort?: "low" | "medium" | "high" | "max" | null }
export interface RuntimeLocationStatusV1 extends Group { label: string | null }
export interface RuntimeRepositoryStatusV1 extends Group { name: string | null; branch: string | null; dirty: boolean | null; ahead: number | null; behind: number | null }
export interface RuntimeUsageStatusV1 extends Group { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null }
export interface RuntimeCostStatusV1 extends Group { currency: "USD"; amountMicros: number | null }
export interface RuntimeProviderUsageStatusV1 extends Group { provider: string | null; used: number | null; limit: number | null; unit: "requests" | "tokens" | "percent" | null; resetAt: string | null }
export interface RuntimeCompactionStatusV1 extends Group { count: number | null; lastAt: string | null }
export interface RuntimeSubagentStatusV1 extends Group { active: number | null; completed: number | null; failed: number | null }
export interface RuntimeDevelopmentServiceV1 { id: string; state: "listening" | "stopped" | "conflict" | "unknown"; port: number | null }
export interface RuntimeDevelopmentStatusV1 extends Group { services: RuntimeDevelopmentServiceV1[] }
export type RuntimeStatusActionIdV1 = "refresh" | "show-usage" | "open-repository" | "show-tasks" | "open-review" | "show-ci";
export interface RuntimeStatusActionV1 { id: RuntimeStatusActionIdV1; enabled: boolean; narrowLabel: string; wideLabel: string }
export interface RuntimeActionsStatusV1 extends Group { items: RuntimeStatusActionV1[] }

export interface RuntimeStatusEnvelopeV1 {
  schemaVersion: 1;
  generatedAt: string;
  binding: RuntimeStatusBindingV1;
  harness: RuntimeStatusHarnessV1;
  identity: RuntimeIdentityStatusV1;
  session: RuntimeSessionStatusV1;
  model: RuntimeModelStatusV1;
  location: RuntimeLocationStatusV1;
  repository: RuntimeRepositoryStatusV1;
  usage: RuntimeUsageStatusV1;
  cost: RuntimeCostStatusV1;
  providerUsage: RuntimeProviderUsageStatusV1;
  compactions: RuntimeCompactionStatusV1;
  subagents: RuntimeSubagentStatusV1;
  development: RuntimeDevelopmentStatusV1;
  actions: RuntimeActionsStatusV1;
}

export class RuntimeStatusEnvelopeValidationError extends Error {
  readonly code = "RUNTIME_STATUS_ENVELOPE_INVALID";
  constructor(message: string) { super(`Invalid runtime status envelope: ${message}.`); this.name = "RuntimeStatusEnvelopeValidationError"; }
}
function fail(path: string, expected: string): never { throw new RuntimeStatusEnvelopeValidationError(`${path} must be ${expected}`); }
function objectAtWithOptional(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object");
  const record = value as Record<string, unknown>, keys = [...required, ...optional];
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${path}.${key}`, "a recognized privacy-safe field");
  for (const key of required) if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "present");
  return record;
}
function objectAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> { return objectAtWithOptional(value, path, keys); }
const CONTROL = /[\0-\x1f\x7f-\x9f]/u;
const PRIVATE_VALUE = /(?:[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|root)\/|\bBearer\s+\S{8}|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu;
function textAt(value: unknown, path: string, max = 128): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || CONTROL.test(value)) fail(path, `a safe string of 1 to ${max} characters`);
  if (PRIVATE_VALUE.test(value)) fail(path, "privacy-safe (no roots or credentials)");
  return value;
}
function nullableTextAt(value: unknown, path: string, max = 128): string | null { return value === null ? null : textAt(value, path, max); }
function idAt(value: unknown, path: string): string { const id = textAt(value, path, 128); if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id)) fail(path, "a bounded identifier"); return id; }
function nullableIdAt(value: unknown, path: string): string | null { return value === null ? null : idAt(value, path); }
function enumAt<T extends string>(value: unknown, path: string, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) fail(path, `one of ${allowed.join(", ")}`); return value as T; }
function boolNullAt(value: unknown, path: string): boolean | null { if (value !== null && typeof value !== "boolean") fail(path, "a boolean or null"); return value as boolean | null; }
function integerNullAt(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(path, `null or an integer from 0 through ${max}`); return value; }
function timestampAt(value: unknown, path: string): string {
  const timestamp = textAt(value, path, 32);
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== timestamp || time < Date.UTC(2000) || time > Date.UTC(2100)) fail(path, "a canonical ISO timestamp from 2000 through 2100");
  return timestamp;
}
function nullableTimestampAt(value: unknown, path: string): string | null { return value === null ? null : timestampAt(value, path); }
const GROUP_METADATA_FIELDS = ["source", "state", "capturedAt", "freshUntil", "diagnostic", "unavailable"] as const;
function metadataAt(record: Record<string, unknown>, path: string): RuntimeStatusGroupMetadataV1 {
  const source = enumAt(record.source, `${path}.source`, ["native", "provider", "derived", "cache"] as const);
  const state = enumAt(record.state, `${path}.state`, ["current", "stale", "unavailable", "error"] as const);
  const capturedAt = nullableTimestampAt(record.capturedAt, `${path}.capturedAt`);
  const freshUntil = nullableTimestampAt(record.freshUntil, `${path}.freshUntil`);
  const diagnostic = nullableIdAt(record.diagnostic, `${path}.diagnostic`);
  const unavailable = nullableTextAt(record.unavailable, `${path}.unavailable`, 128);
  if (state === "current" || state === "stale") {
    if (capturedAt === null) fail(`${path}.capturedAt`, `present for ${state} state`);
    if (freshUntil === null) fail(`${path}.freshUntil`, `present for ${state} state`);
    if (Date.parse(freshUntil) < Date.parse(capturedAt)) fail(`${path}.freshUntil`, "not earlier than capturedAt");
    if (diagnostic !== null || unavailable !== null) fail(path, `diagnostic-free and available for ${state} state`);
  } else if (state === "unavailable") {
    if (capturedAt !== null || freshUntil !== null || diagnostic !== null || unavailable === null) fail(path, "empty except for an unavailable reason when unavailable");
  } else if (freshUntil !== null || diagnostic === null || unavailable !== null) fail(path, "diagnostic-bearing with no freshness or unavailable reason when error");
  return { source, state, capturedAt, freshUntil, diagnostic, unavailable };
}
function baseGroup(value: unknown, path: string, fields: readonly string[]): [Record<string, unknown>, RuntimeStatusGroupMetadataV1] { const record = objectAt(value, path, [...GROUP_METADATA_FIELDS, ...fields]); return [record, metadataAt(record, path)]; }
function bindingAt(value: unknown): RuntimeStatusBindingV1 { const r = objectAt(value, "binding", ["launchKey", "runtimeId", "repositoryId"]); return { launchKey: idAt(r.launchKey, "binding.launchKey"), runtimeId: idAt(r.runtimeId, "binding.runtimeId"), repositoryId: idAt(r.repositoryId, "binding.repositoryId") }; }
function harnessAt(value: unknown): RuntimeStatusHarnessV1 {
  const r = objectAt(value, "harness", ["kind", "version", "surface"]); const kind = enumAt(r.kind, "harness.kind", ["claude", "pi"] as const); const version = nullableTextAt(r.version, "harness.version", 64);
  if (kind === "claude") { if (r.surface !== "statusline") fail("harness.surface", "statusline for Claude"); return { kind, version, surface: "statusline" }; }
  if (r.surface !== "footer") fail("harness.surface", "footer for Pi"); return { kind, version, surface: "footer" };
}

/** Strictly validates, privacy-checks, and independently copies an untrusted envelope. */
export function parseRuntimeStatusEnvelopeV1(value: unknown): RuntimeStatusEnvelopeV1 {
  const keys = ["schemaVersion", "generatedAt", "binding", "harness", "identity", "session", "model", "location", "repository", "usage", "cost", "providerUsage", "compactions", "subagents", "development", "actions"] as const;
  const root = objectAt(value, "runtime status envelope", keys);
  if (root.schemaVersion !== 1) fail("schemaVersion", "the supported version 1");
  const generatedAt = timestampAt(root.generatedAt, "generatedAt");
  const [identity, identityMetadata] = baseGroup(root.identity, "identity", ["profile", "label"]);
  const session = objectAtWithOptional(root.session, "session", [...GROUP_METADATA_FIELDS, "elapsedMs", "turns"], ["title"]), sessionMetadata = metadataAt(session, "session");
  const model = objectAtWithOptional(root.model, "model", [...GROUP_METADATA_FIELDS, "modelId", "label", "contextUsedTokens", "contextLimitTokens"], ["effort"]), modelMetadata = metadataAt(model, "model");
  const [location, locationMetadata] = baseGroup(root.location, "location", ["label"]);
  const [repository, repositoryMetadata] = baseGroup(root.repository, "repository", ["name", "branch", "dirty", "ahead", "behind"]);
  const [usage, usageMetadata] = baseGroup(root.usage, "usage", ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]);
  const [cost, costMetadata] = baseGroup(root.cost, "cost", ["currency", "amountMicros"]);
  const [provider, providerMetadata] = baseGroup(root.providerUsage, "providerUsage", ["provider", "used", "limit", "unit", "resetAt"]);
  const [compactions, compactionsMetadata] = baseGroup(root.compactions, "compactions", ["count", "lastAt"]);
  const [subagents, subagentsMetadata] = baseGroup(root.subagents, "subagents", ["active", "completed", "failed"]);
  const [development, developmentMetadata] = baseGroup(root.development, "development", ["services"]);
  const [actions, actionsMetadata] = baseGroup(root.actions, "actions", ["items"]);
  for (const [name, metadata] of [["identity", identityMetadata], ["session", sessionMetadata], ["model", modelMetadata], ["location", locationMetadata], ["repository", repositoryMetadata], ["usage", usageMetadata], ["cost", costMetadata], ["providerUsage", providerMetadata], ["compactions", compactionsMetadata], ["subagents", subagentsMetadata], ["development", developmentMetadata], ["actions", actionsMetadata]] as const) {
    if (metadata.capturedAt !== null && Date.parse(metadata.capturedAt) > Date.parse(generatedAt)) fail(`${name}.capturedAt`, "not later than generatedAt");
    if (metadata.state === "current" && metadata.freshUntil !== null && Date.parse(metadata.freshUntil) < Date.parse(generatedAt)) fail(`${name}.state`, "current only through freshUntil");
  }
  if (!Array.isArray(development.services) || development.services.length > 64) fail("development.services", "an array of at most 64 services");
  const services = development.services.map((item, index): RuntimeDevelopmentServiceV1 => { const p = `development.services[${index}]`; const r = objectAt(item, p, ["id", "state", "port"]); const port = integerNullAt(r.port, `${p}.port`, 65535); if (port === 0) fail(`${p}.port`, "null or an integer from 1 through 65535"); return { id: idAt(r.id, `${p}.id`), state: enumAt(r.state, `${p}.state`, ["listening", "stopped", "conflict", "unknown"] as const), port }; });
  if (new Set(services.map(({ id }) => id)).size !== services.length) fail("development.services", "unique by id");
  if (!Array.isArray(actions.items) || actions.items.length > 8) fail("actions.items", "an array of at most 8 semantic actions");
  const items = actions.items.map((item, index): RuntimeStatusActionV1 => { const p = `actions.items[${index}]`; const r = objectAt(item, p, ["id", "enabled", "narrowLabel", "wideLabel"]); if (typeof r.enabled !== "boolean") fail(`${p}.enabled`, "a boolean"); return { id: enumAt(r.id, `${p}.id`, ["refresh", "show-usage", "open-repository", "show-tasks", "open-review", "show-ci"] as const), enabled: r.enabled, narrowLabel: textAt(r.narrowLabel, `${p}.narrowLabel`, 4), wideLabel: textAt(r.wideLabel, `${p}.wideLabel`, 32) }; });
  if (new Set(items.map(({ id }) => id)).size !== items.length) fail("actions.items", "unique by semantic action id");
  const profile = identity.profile === null ? null : enumAt(identity.profile, "identity.profile", ["personal", "work"] as const);
  const currency = enumAt(cost.currency, "cost.currency", ["USD"] as const);
  const unit = provider.unit === null ? null : enumAt(provider.unit, "providerUsage.unit", ["requests", "tokens", "percent"] as const);
  return {
    schemaVersion: 1, generatedAt, binding: bindingAt(root.binding), harness: harnessAt(root.harness),
    identity: { ...identityMetadata, profile, label: nullableTextAt(identity.label, "identity.label", 64) },
    session: { ...sessionMetadata, elapsedMs: integerNullAt(session.elapsedMs, "session.elapsedMs"), turns: integerNullAt(session.turns, "session.turns", 1_000_000), ...(Object.hasOwn(session, "title") ? { title: nullableTextAt(session.title, "session.title", 128) } : {}) },
    model: { ...modelMetadata, modelId: nullableIdAt(model.modelId, "model.modelId"), label: nullableTextAt(model.label, "model.label", 64), contextUsedTokens: integerNullAt(model.contextUsedTokens, "model.contextUsedTokens"), contextLimitTokens: integerNullAt(model.contextLimitTokens, "model.contextLimitTokens"), ...(Object.hasOwn(model, "effort") ? { effort: model.effort === null ? null : enumAt(model.effort, "model.effort", ["low", "medium", "high", "max"] as const) } : {}) },
    location: { ...locationMetadata, label: nullableTextAt(location.label, "location.label", 128) },
    repository: { ...repositoryMetadata, name: nullableTextAt(repository.name, "repository.name", 128), branch: nullableTextAt(repository.branch, "repository.branch", 256), dirty: boolNullAt(repository.dirty, "repository.dirty"), ahead: integerNullAt(repository.ahead, "repository.ahead", 1_000_000), behind: integerNullAt(repository.behind, "repository.behind", 1_000_000) },
    usage: { ...usageMetadata, inputTokens: integerNullAt(usage.inputTokens, "usage.inputTokens"), outputTokens: integerNullAt(usage.outputTokens, "usage.outputTokens"), cacheReadTokens: integerNullAt(usage.cacheReadTokens, "usage.cacheReadTokens"), cacheWriteTokens: integerNullAt(usage.cacheWriteTokens, "usage.cacheWriteTokens"), totalTokens: integerNullAt(usage.totalTokens, "usage.totalTokens") },
    cost: { ...costMetadata, currency, amountMicros: integerNullAt(cost.amountMicros, "cost.amountMicros") },
    providerUsage: { ...providerMetadata, provider: nullableIdAt(provider.provider, "providerUsage.provider"), used: integerNullAt(provider.used, "providerUsage.used"), limit: integerNullAt(provider.limit, "providerUsage.limit"), unit, resetAt: nullableTimestampAt(provider.resetAt, "providerUsage.resetAt") },
    compactions: { ...compactionsMetadata, count: integerNullAt(compactions.count, "compactions.count", 1_000_000), lastAt: nullableTimestampAt(compactions.lastAt, "compactions.lastAt") },
    subagents: { ...subagentsMetadata, active: integerNullAt(subagents.active, "subagents.active", 100_000), completed: integerNullAt(subagents.completed, "subagents.completed", 1_000_000), failed: integerNullAt(subagents.failed, "subagents.failed", 1_000_000) },
    development: { ...developmentMetadata, services }, actions: { ...actionsMetadata, items },
  };
}

/** Parses JSON and applies strict RuntimeStatusEnvelopeV1 validation. */
export function parseRuntimeStatusEnvelopeV1Json(text: string): RuntimeStatusEnvelopeV1 {
  try { return parseRuntimeStatusEnvelopeV1(JSON.parse(text) as unknown); }
  catch (error) { if (error instanceof RuntimeStatusEnvelopeValidationError) throw error; throw new RuntimeStatusEnvelopeValidationError("document must be valid JSON"); }
}

export type RuntimeStatusCapabilitySupportV1 = "native" | "adapter" | "derived" | "unsupported";
export type RuntimeStatusFieldV1 =
  | "identity.profile" | "identity.label" | "session.elapsedMs" | "session.turns" | "session.title"
  | "model.modelId" | "model.label" | "model.contextUsedTokens" | "model.contextLimitTokens" | "model.effort" | "location.label"
  | "repository.name" | "repository.branch" | "repository.dirty" | "repository.ahead" | "repository.behind"
  | "usage.inputTokens" | "usage.outputTokens" | "usage.cacheReadTokens" | "usage.cacheWriteTokens" | "usage.totalTokens"
  | "cost.currency" | "cost.amountMicros" | "providerUsage.provider" | "providerUsage.used" | "providerUsage.limit" | "providerUsage.unit" | "providerUsage.resetAt"
  | "compactions.count" | "compactions.lastAt" | "subagents.active" | "subagents.completed" | "subagents.failed" | "development.services" | "actions.items";
export type RuntimeStatusFieldCapabilityV1 = { readonly support: "native" | "adapter" | "derived" } | { readonly support: "unsupported"; readonly reason: string };
export interface RuntimeStatusCapabilitiesV1 { readonly schemaVersion: 1; readonly harness: "claude" | "pi"; readonly surface: "statusline" | "footer"; readonly widths: readonly ["narrow", "wide"]; readonly semanticActions: readonly RuntimeStatusActionIdV1[]; readonly fields: Readonly<Record<RuntimeStatusFieldV1, RuntimeStatusFieldCapabilityV1>> }
const RUNTIME_STATUS_FIELDS = ["identity.profile","identity.label","session.elapsedMs","session.turns","session.title","model.modelId","model.label","model.contextUsedTokens","model.contextLimitTokens","model.effort","location.label","repository.name","repository.branch","repository.dirty","repository.ahead","repository.behind","usage.inputTokens","usage.outputTokens","usage.cacheReadTokens","usage.cacheWriteTokens","usage.totalTokens","cost.currency","cost.amountMicros","providerUsage.provider","providerUsage.used","providerUsage.limit","providerUsage.unit","providerUsage.resetAt","compactions.count","compactions.lastAt","subagents.active","subagents.completed","subagents.failed","development.services","actions.items"] as const satisfies readonly RuntimeStatusFieldV1[];
const ALL_ACTIONS = ["refresh", "show-usage", "open-repository", "show-tasks", "open-review", "show-ci"] as const;
const unsupported = (reason: string): RuntimeStatusFieldCapabilityV1 => ({ support: "unsupported", reason });
function capabilityFields(overrides: Partial<Record<RuntimeStatusFieldV1, RuntimeStatusFieldCapabilityV1>>): Record<RuntimeStatusFieldV1, RuntimeStatusFieldCapabilityV1> { return Object.fromEntries(RUNTIME_STATUS_FIELDS.map(field => [field, overrides[field] ?? { support: "adapter" }])) as Record<RuntimeStatusFieldV1, RuntimeStatusFieldCapabilityV1>; }
const claudeFields = capabilityFields({
  "session.elapsedMs": { support: "native" }, "session.turns": unsupported("Claude statusline does not report turn count"), "session.title": { support: "native" },
  "model.modelId": { support: "native" }, "model.label": { support: "native" }, "model.contextUsedTokens": { support: "native" }, "model.contextLimitTokens": { support: "native" }, "model.effort": { support: "native" },
  "location.label": { support: "derived" }, "usage.inputTokens": { support: "native" }, "usage.outputTokens": { support: "native" }, "usage.cacheReadTokens": { support: "native" }, "usage.cacheWriteTokens": { support: "native" }, "usage.totalTokens": { support: "derived" }, "cost.currency": { support: "derived" }, "cost.amountMicros": { support: "native" },
  "providerUsage.provider": unsupported("Claude statusline does not expose provider quota"), "providerUsage.used": unsupported("Claude statusline does not expose provider quota"), "providerUsage.limit": unsupported("Claude statusline does not expose provider quota"), "providerUsage.unit": unsupported("Claude statusline does not expose provider quota"), "providerUsage.resetAt": unsupported("Claude statusline does not expose provider quota"),
  "compactions.count": unsupported("Claude statusline does not report compactions"), "compactions.lastAt": unsupported("Claude statusline does not report compactions"),
});
const piFields = capabilityFields({
  "session.elapsedMs": { support: "derived" }, "session.turns": unsupported("Pi footer does not report turn count"), "session.title": { support: "adapter" },
  "model.modelId": { support: "native" }, "model.label": { support: "native" }, "model.contextUsedTokens": { support: "native" }, "model.contextLimitTokens": { support: "native" }, "model.effort": unsupported("Pi does not expose Claude effort"),
  "location.label": { support: "derived" }, "usage.totalTokens": { support: "derived" }, "cost.currency": { support: "derived" }, "cost.amountMicros": unsupported("Pi does not expose native session cost"),
});
function parseFieldCapability(value: unknown, path: string): RuntimeStatusFieldCapabilityV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "a capability object");
  const item = value as Record<string, unknown>, support = enumAt(item.support, `${path}.support`, ["native", "adapter", "derived", "unsupported"] as const);
  const expected = support === "unsupported" ? ["support", "reason"] : ["support"];
  for (const key of Object.keys(item)) if (!expected.includes(key)) fail(`${path}.${key}`, "a recognized capability field");
  for (const key of expected) if (!Object.hasOwn(item, key)) fail(`${path}.${key}`, "present");
  return support === "unsupported" ? { support, reason: textAt(item.reason, `${path}.reason`, 160) } : { support };
}
/** Strictly validates and deeply freezes the complete renderer capability contract. */
export function parseRuntimeStatusCapabilitiesV1(value: unknown): RuntimeStatusCapabilitiesV1 {
  const root = objectAt(value, "runtime status capabilities", ["schemaVersion", "harness", "surface", "widths", "semanticActions", "fields"]);
  if (root.schemaVersion !== 1) fail("runtime status capabilities.schemaVersion", "the supported version 1");
  const harness = enumAt(root.harness, "runtime status capabilities.harness", ["claude", "pi"] as const), surface = enumAt(root.surface, "runtime status capabilities.surface", ["statusline", "footer"] as const);
  if ((harness === "claude" && surface !== "statusline") || (harness === "pi" && surface !== "footer")) fail("runtime status capabilities.surface", `the ${harness} surface`);
  if (!Array.isArray(root.widths) || root.widths.length !== 2 || root.widths[0] !== "narrow" || root.widths[1] !== "wide") fail("runtime status capabilities.widths", "exactly narrow and wide");
  if (!Array.isArray(root.semanticActions) || root.semanticActions.length > ALL_ACTIONS.length) fail("runtime status capabilities.semanticActions", "a bounded semantic action array");
  const semanticActions = root.semanticActions.map((action, index) => enumAt(action, `runtime status capabilities.semanticActions[${index}]`, ALL_ACTIONS));
  if (new Set(semanticActions).size !== semanticActions.length) fail("runtime status capabilities.semanticActions", "unique");
  const fields = objectAt(root.fields, "runtime status capabilities.fields", RUNTIME_STATUS_FIELDS);
  const parsedFields = Object.fromEntries(RUNTIME_STATUS_FIELDS.map(field => [field, parseFieldCapability(fields[field], `runtime status capabilities.fields.${field}`)])) as Record<RuntimeStatusFieldV1, RuntimeStatusFieldCapabilityV1>;
  return deepFreeze({ schemaVersion: 1, harness, surface, widths: ["narrow", "wide"], semanticActions, fields: parsedFields });
}
const CAPABILITIES = {
  claude: parseRuntimeStatusCapabilitiesV1({ schemaVersion: 1, harness: "claude", surface: "statusline", widths: ["narrow", "wide"], semanticActions: ALL_ACTIONS, fields: claudeFields }),
  pi: parseRuntimeStatusCapabilitiesV1({ schemaVersion: 1, harness: "pi", surface: "footer", widths: ["narrow", "wide"], semanticActions: ALL_ACTIONS, fields: piFields }),
};
export function getRuntimeStatusCapabilitiesV1(harness: "claude" | "pi"): RuntimeStatusCapabilitiesV1 { return CAPABILITIES[harness]; }
export type RuntimeStatusGroupNameV1 = "identity" | "session" | "model" | "location" | "repository" | "usage" | "cost" | "providerUsage" | "compactions" | "subagents" | "development" | "actions";
type RuntimeStatusGroups = Pick<RuntimeStatusEnvelopeV1, RuntimeStatusGroupNameV1>;
export interface RuntimeStatusContributionV1 { source: "cache" | "launch" | "repository" | "runtime"; binding: RuntimeStatusBindingV1; groups: Partial<RuntimeStatusGroups> }
export interface ComposeRuntimeStatusEnvelopeV1Input { generatedAt: string; binding: RuntimeStatusBindingV1; harness: RuntimeStatusHarnessV1; contributions: readonly RuntimeStatusContributionV1[] }
const GROUP_NAMES: readonly RuntimeStatusGroupNameV1[] = ["identity", "session", "model", "location", "repository", "usage", "cost", "providerUsage", "compactions", "subagents", "development", "actions"];
function unavailableGroups(): RuntimeStatusGroups {
  const unavailable: RuntimeStatusGroupMetadataV1 = { source: "derived", state: "unavailable", capturedAt: null, freshUntil: null, diagnostic: null, unavailable: "not reported" };
  return { identity: { ...unavailable, profile: null, label: null }, session: { ...unavailable, elapsedMs: null, turns: null }, model: { ...unavailable, modelId: null, label: null, contextUsedTokens: null, contextLimitTokens: null }, location: { ...unavailable, label: null }, repository: { ...unavailable, name: null, branch: null, dirty: null, ahead: null, behind: null }, usage: { ...unavailable, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null }, cost: { ...unavailable, currency: "USD", amountMicros: null }, providerUsage: { ...unavailable, provider: null, used: null, limit: null, unit: null, resetAt: null }, compactions: { ...unavailable, count: null, lastAt: null }, subagents: { ...unavailable, active: null, completed: null, failed: null }, development: { ...unavailable, services: [] }, actions: { ...unavailable, items: [] } };
}
function sameBinding(a: RuntimeStatusBindingV1, b: RuntimeStatusBindingV1): boolean { return a.launchKey === b.launchKey && a.runtimeId === b.runtimeId && a.repositoryId === b.repositoryId; }
/** Pure composition. Contributions are atomic by group; precedence is runtime > repository > launch > cache. */
export function composeRuntimeStatusEnvelopeV1(input: ComposeRuntimeStatusEnvelopeV1Input): RuntimeStatusEnvelopeV1 {
  const groups = unavailableGroups(); const rank = { cache: 0, launch: 1, repository: 2, runtime: 3 } as const;
  if (new Set(input.contributions.map(({ source }) => source)).size !== input.contributions.length) throw new RuntimeStatusEnvelopeValidationError("contribution sources must be unique for deterministic precedence");
  for (const contribution of [...input.contributions].sort((a, b) => rank[a.source] - rank[b.source])) {
    if (!sameBinding(input.binding, contribution.binding)) throw new RuntimeStatusEnvelopeValidationError(`${contribution.source} binding must match launch/runtime/repository binding`);
    for (const name of GROUP_NAMES) if (contribution.groups[name] !== undefined) Object.assign(groups, { [name]: contribution.groups[name] });
  }
  return parseRuntimeStatusEnvelopeV1({ schemaVersion: 1, generatedAt: input.generatedAt, binding: input.binding, harness: input.harness, ...groups });
}

export interface RuntimeStatusEnvelopeReader { read(signal: AbortSignal): Promise<unknown> }
export interface RuntimeStatusRefreshController { current(): RuntimeStatusEnvelopeV1 | undefined; refresh(): Promise<void>; abort(): void }
export interface RuntimeStatusRefreshOptions { timeoutMs?: number; initial?: RuntimeStatusEnvelopeV1 }
function staleEnvelope(value: RuntimeStatusEnvelopeV1): RuntimeStatusEnvelopeV1 { const clone = structuredClone(value); for (const name of GROUP_NAMES) if (clone[name].state === "current") clone[name].state = "stale"; return clone; }
/** Performs bounded asynchronous reads outside renderers, coalescing concurrent refreshes. */
export function createRuntimeStatusRefreshController(reader: RuntimeStatusEnvelopeReader, options: RuntimeStatusRefreshOptions = {}): RuntimeStatusRefreshController {
  const timeoutMs = options.timeoutMs ?? 1_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError("timeoutMs must be from 1 through 60000");
  let value = options.initial === undefined ? undefined : parseRuntimeStatusEnvelopeV1(options.initial); let pending: Promise<void> | undefined; let active: AbortController | undefined;
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    const controller = new AbortController(); active = controller; let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const error = new Error("Runtime status refresh timed out"); controller.abort(error); reject(error); }, timeoutMs); timer.unref?.(); });
    let read: Promise<void>; try { read = reader.read(controller.signal).then(next => { value = parseRuntimeStatusEnvelopeV1(next); }); } catch (error) { read = Promise.reject(error); }
    pending = Promise.race([read, timeout]).catch(() => { if (value) value = staleEnvelope(value); }).finally(() => { clearTimeout(timer); if (active === controller) active = undefined; pending = undefined; }); return pending;
  };
  return { current: () => value, refresh, abort() { active?.abort(); } };
}

export interface RuntimeStatusProjectionV1 { readonly generatedAt: string; readonly harness: RuntimeStatusHarnessV1; readonly identity: RuntimeIdentityStatusV1; readonly session: RuntimeSessionStatusV1; readonly model: RuntimeModelStatusV1; readonly location: RuntimeLocationStatusV1; readonly repository: RuntimeRepositoryStatusV1; readonly usage: RuntimeUsageStatusV1; readonly cost: RuntimeCostStatusV1; readonly providerUsage: RuntimeProviderUsageStatusV1; readonly compactions: RuntimeCompactionStatusV1; readonly subagents: RuntimeSubagentStatusV1; readonly development: RuntimeDevelopmentStatusV1; readonly actions: readonly { readonly id: RuntimeStatusActionIdV1; readonly enabled: boolean; readonly label: string }[] }
function deepFreeze<T>(value: T): T { if (typeof value === "object" && value !== null && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
/** Creates a detached renderer-only view. It is synchronous, immutable, and has no I/O authority or binding identifiers. */
export function projectRuntimeStatusEnvelopeV1(value: RuntimeStatusEnvelopeV1, width: "narrow" | "wide"): RuntimeStatusProjectionV1 {
  const parsed = parseRuntimeStatusEnvelopeV1(value); const { binding: _binding, schemaVersion: _schemaVersion, actions, ...safe } = parsed;
  return deepFreeze({ ...safe, actions: actions.items.map(({ id, enabled, narrowLabel, wideLabel }) => ({ id, enabled, label: width === "narrow" ? narrowLabel : wideLabel })) });
}
