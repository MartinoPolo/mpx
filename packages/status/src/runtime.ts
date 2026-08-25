export type RuntimeStatusFreshnessStateV1 = "current" | "stale" | "unavailable" | "error";
export interface RuntimeStatusFreshnessV1 { state: RuntimeStatusFreshnessStateV1; observedAt: string | null; errorCode: string | null }
export interface RuntimeStatusBindingV1 { launchKey: string; runtimeId: string; repositoryId: string }
export type RuntimeStatusHarnessV1 =
  | { kind: "claude"; version: string | null; surface: "statusline" }
  | { kind: "pi"; version: string | null; surface: "footer" };
interface Group { freshness: RuntimeStatusFreshnessV1 }
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
function freshnessAt(value: unknown, path: string): RuntimeStatusFreshnessV1 {
  const record = objectAt(value, path, ["state", "observedAt", "errorCode"]);
  const state = enumAt(record.state, `${path}.state`, ["current", "stale", "unavailable", "error"] as const);
  const observedAt = nullableTimestampAt(record.observedAt, `${path}.observedAt`);
  const errorCode = nullableIdAt(record.errorCode, `${path}.errorCode`);
  if ((state === "current" || state === "stale") && observedAt === null) fail(`${path}.observedAt`, `present for ${state} freshness`);
  if (state === "unavailable" && (observedAt !== null || errorCode !== null)) fail(path, "empty when unavailable");
  if (state === "error" && errorCode === null) fail(`${path}.errorCode`, "present for error freshness");
  return { state, observedAt, errorCode };
}
function baseGroup(value: unknown, path: string, fields: readonly string[]): [Record<string, unknown>, RuntimeStatusFreshnessV1] { const record = objectAt(value, path, ["freshness", ...fields]); return [record, freshnessAt(record.freshness, `${path}.freshness`)]; }
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
  const [identity, identityFreshness] = baseGroup(root.identity, "identity", ["profile", "label"]);
  const session = objectAtWithOptional(root.session, "session", ["freshness", "elapsedMs", "turns"], ["title"]), sessionFreshness = freshnessAt(session.freshness, "session.freshness");
  const model = objectAtWithOptional(root.model, "model", ["freshness", "modelId", "label", "contextUsedTokens", "contextLimitTokens"], ["effort"]), modelFreshness = freshnessAt(model.freshness, "model.freshness");
  const [location, locationFreshness] = baseGroup(root.location, "location", ["label"]);
  const [repository, repositoryFreshness] = baseGroup(root.repository, "repository", ["name", "branch", "dirty", "ahead", "behind"]);
  const [usage, usageFreshness] = baseGroup(root.usage, "usage", ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]);
  const [cost, costFreshness] = baseGroup(root.cost, "cost", ["currency", "amountMicros"]);
  const [provider, providerFreshness] = baseGroup(root.providerUsage, "providerUsage", ["provider", "used", "limit", "unit", "resetAt"]);
  const [compactions, compactionsFreshness] = baseGroup(root.compactions, "compactions", ["count", "lastAt"]);
  const [subagents, subagentsFreshness] = baseGroup(root.subagents, "subagents", ["active", "completed", "failed"]);
  const [development, developmentFreshness] = baseGroup(root.development, "development", ["services"]);
  const [actions, actionsFreshness] = baseGroup(root.actions, "actions", ["items"]);
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
    schemaVersion: 1, generatedAt: timestampAt(root.generatedAt, "generatedAt"), binding: bindingAt(root.binding), harness: harnessAt(root.harness),
    identity: { freshness: identityFreshness, profile, label: nullableTextAt(identity.label, "identity.label", 64) },
    session: { freshness: sessionFreshness, elapsedMs: integerNullAt(session.elapsedMs, "session.elapsedMs"), turns: integerNullAt(session.turns, "session.turns", 1_000_000), ...(Object.hasOwn(session, "title") ? { title: nullableTextAt(session.title, "session.title", 128) } : {}) },
    model: { freshness: modelFreshness, modelId: nullableIdAt(model.modelId, "model.modelId"), label: nullableTextAt(model.label, "model.label", 64), contextUsedTokens: integerNullAt(model.contextUsedTokens, "model.contextUsedTokens"), contextLimitTokens: integerNullAt(model.contextLimitTokens, "model.contextLimitTokens"), ...(Object.hasOwn(model, "effort") ? { effort: model.effort === null ? null : enumAt(model.effort, "model.effort", ["low", "medium", "high", "max"] as const) } : {}) },
    location: { freshness: locationFreshness, label: nullableTextAt(location.label, "location.label", 128) },
    repository: { freshness: repositoryFreshness, name: nullableTextAt(repository.name, "repository.name", 128), branch: nullableTextAt(repository.branch, "repository.branch", 256), dirty: boolNullAt(repository.dirty, "repository.dirty"), ahead: integerNullAt(repository.ahead, "repository.ahead", 1_000_000), behind: integerNullAt(repository.behind, "repository.behind", 1_000_000) },
    usage: { freshness: usageFreshness, inputTokens: integerNullAt(usage.inputTokens, "usage.inputTokens"), outputTokens: integerNullAt(usage.outputTokens, "usage.outputTokens"), cacheReadTokens: integerNullAt(usage.cacheReadTokens, "usage.cacheReadTokens"), cacheWriteTokens: integerNullAt(usage.cacheWriteTokens, "usage.cacheWriteTokens"), totalTokens: integerNullAt(usage.totalTokens, "usage.totalTokens") },
    cost: { freshness: costFreshness, currency, amountMicros: integerNullAt(cost.amountMicros, "cost.amountMicros") },
    providerUsage: { freshness: providerFreshness, provider: nullableIdAt(provider.provider, "providerUsage.provider"), used: integerNullAt(provider.used, "providerUsage.used"), limit: integerNullAt(provider.limit, "providerUsage.limit"), unit, resetAt: nullableTimestampAt(provider.resetAt, "providerUsage.resetAt") },
    compactions: { freshness: compactionsFreshness, count: integerNullAt(compactions.count, "compactions.count", 1_000_000), lastAt: nullableTimestampAt(compactions.lastAt, "compactions.lastAt") },
    subagents: { freshness: subagentsFreshness, active: integerNullAt(subagents.active, "subagents.active", 100_000), completed: integerNullAt(subagents.completed, "subagents.completed", 1_000_000), failed: integerNullAt(subagents.failed, "subagents.failed", 1_000_000) },
    development: { freshness: developmentFreshness, services }, actions: { freshness: actionsFreshness, items },
  };
}

/** Parses JSON and applies strict RuntimeStatusEnvelopeV1 validation. */
export function parseRuntimeStatusEnvelopeV1Json(text: string): RuntimeStatusEnvelopeV1 {
  try { return parseRuntimeStatusEnvelopeV1(JSON.parse(text) as unknown); }
  catch (error) { if (error instanceof RuntimeStatusEnvelopeValidationError) throw error; throw new RuntimeStatusEnvelopeValidationError("document must be valid JSON"); }
}

export interface RuntimeStatusCapabilitiesV1 { schemaVersion: 1; harness: "claude" | "pi"; surface: "statusline" | "footer"; widths: readonly ["narrow", "wide"]; semanticActions: readonly RuntimeStatusActionIdV1[] }
const CAPABILITIES = {
  claude: Object.freeze({ schemaVersion: 1 as const, harness: "claude" as const, surface: "statusline" as const, widths: Object.freeze(["narrow", "wide"] as const), semanticActions: Object.freeze(["refresh", "show-usage", "open-repository", "show-tasks", "open-review", "show-ci"] as const) }),
  pi: Object.freeze({ schemaVersion: 1 as const, harness: "pi" as const, surface: "footer" as const, widths: Object.freeze(["narrow", "wide"] as const), semanticActions: Object.freeze(["refresh", "show-usage", "open-repository", "show-tasks", "open-review", "show-ci"] as const) }),
};
export function getRuntimeStatusCapabilitiesV1(harness: "claude" | "pi"): RuntimeStatusCapabilitiesV1 { return CAPABILITIES[harness]; }

export type RuntimeStatusGroupNameV1 = "identity" | "session" | "model" | "location" | "repository" | "usage" | "cost" | "providerUsage" | "compactions" | "subagents" | "development" | "actions";
type RuntimeStatusGroups = Pick<RuntimeStatusEnvelopeV1, RuntimeStatusGroupNameV1>;
export interface RuntimeStatusContributionV1 { source: "launch" | "repository" | "runtime"; binding: RuntimeStatusBindingV1; groups: Partial<RuntimeStatusGroups> }
export interface ComposeRuntimeStatusEnvelopeV1Input { generatedAt: string; binding: RuntimeStatusBindingV1; harness: RuntimeStatusHarnessV1; contributions: readonly RuntimeStatusContributionV1[] }
const GROUP_NAMES: readonly RuntimeStatusGroupNameV1[] = ["identity", "session", "model", "location", "repository", "usage", "cost", "providerUsage", "compactions", "subagents", "development", "actions"];
function unavailableGroups(): RuntimeStatusGroups {
  const freshness: RuntimeStatusFreshnessV1 = { state: "unavailable", observedAt: null, errorCode: null };
  return { identity: { freshness, profile: null, label: null }, session: { freshness, elapsedMs: null, turns: null }, model: { freshness, modelId: null, label: null, contextUsedTokens: null, contextLimitTokens: null }, location: { freshness, label: null }, repository: { freshness, name: null, branch: null, dirty: null, ahead: null, behind: null }, usage: { freshness, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null }, cost: { freshness, currency: "USD", amountMicros: null }, providerUsage: { freshness, provider: null, used: null, limit: null, unit: null, resetAt: null }, compactions: { freshness, count: null, lastAt: null }, subagents: { freshness, active: null, completed: null, failed: null }, development: { freshness, services: [] }, actions: { freshness, items: [] } };
}
function sameBinding(a: RuntimeStatusBindingV1, b: RuntimeStatusBindingV1): boolean { return a.launchKey === b.launchKey && a.runtimeId === b.runtimeId && a.repositoryId === b.repositoryId; }
/** Pure composition. Contributions are atomic by group; precedence is runtime > repository > launch. */
export function composeRuntimeStatusEnvelopeV1(input: ComposeRuntimeStatusEnvelopeV1Input): RuntimeStatusEnvelopeV1 {
  const groups = unavailableGroups(); const rank = { launch: 0, repository: 1, runtime: 2 } as const;
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
function staleEnvelope(value: RuntimeStatusEnvelopeV1): RuntimeStatusEnvelopeV1 { const clone = structuredClone(value); for (const name of GROUP_NAMES) if (clone[name].freshness.state === "current") clone[name].freshness.state = "stale"; return clone; }
/** Performs bounded asynchronous reads outside renderers, coalescing concurrent refreshes. */
export function createRuntimeStatusRefreshController(reader: RuntimeStatusEnvelopeReader, options: RuntimeStatusRefreshOptions = {}): RuntimeStatusRefreshController {
  const timeoutMs = options.timeoutMs ?? 1_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError("timeoutMs must be from 1 through 60000");
  let value = options.initial === undefined ? undefined : parseRuntimeStatusEnvelopeV1(options.initial); let pending: Promise<void> | undefined; let active: AbortController | undefined;
  const refresh = (): Promise<void> => {
    if (pending) return pending; active = new AbortController(); const timer = setTimeout(() => active?.abort(new Error("Runtime status refresh timed out")), timeoutMs); timer.unref?.();
    pending = reader.read(active.signal).then((next) => { value = parseRuntimeStatusEnvelopeV1(next); }).catch(() => { if (value) value = staleEnvelope(value); }).finally(() => { clearTimeout(timer); active = undefined; pending = undefined; }); return pending;
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
