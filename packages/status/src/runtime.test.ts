import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  composeRuntimeStatusEnvelopeV1,
  createRuntimeStatusRefreshController,
  getRuntimeStatusCapabilitiesV1,
  parseRuntimeStatusCapabilitiesV1,
  parseRuntimeStatusEnvelopeV1,
  projectRuntimeStatusEnvelopeV1,
  type RuntimeStatusBindingV1,
  type RuntimeStatusEnvelopeV1,
} from "./index.js";

const binding: RuntimeStatusBindingV1 = { launchKey: "launch-123", runtimeId: "runtime-1", repositoryId: "repo-123" };
const unavailable = { source: "derived" as const, state: "unavailable" as const, capturedAt: null, freshUntil: null, diagnostic: null, unavailable: "not reported" };
const current = { source: "native" as const, state: "current" as const, capturedAt: "2025-06-01T12:00:00.000Z", freshUntil: "2025-06-01T12:01:00.000Z", diagnostic: null, unavailable: null };

function envelope(): RuntimeStatusEnvelopeV1 {
  return {
    schemaVersion: 1,
    generatedAt: "2025-06-01T12:00:00.000Z",
    binding,
    harness: { kind: "claude", version: "1.2.3", surface: "statusline" },
    identity: { ...current, profile: "personal", label: "Personal" },
    session: { ...current, elapsedMs: 1000, turns: 2 },
    model: { ...current, modelId: "claude-sonnet", label: "Sonnet", contextUsedTokens: 100, contextLimitTokens: 200000 },
    location: { ...current, label: "mpx" },
    repository: { ...current, name: "mpx", branch: "main", dirty: false, ahead: 0, behind: 0 },
    usage: { ...current, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100 },
    cost: { ...current, currency: "USD", amountMicros: 125000 },
    providerUsage: { ...current, provider: "anthropic", used: 25, limit: 100, unit: "percent", resetAt: "2025-06-01T13:00:00.000Z" },
    compactions: { ...current, count: 1, lastAt: "2025-06-01T11:30:00.000Z" },
    subagents: { ...current, active: 1, completed: 2, failed: 0 },
    development: { ...current, services: [{ id: "web", state: "listening", port: 4102 }] },
    actions: { ...current, items: [{ id: "refresh", enabled: true, narrowLabel: "↻", wideLabel: "Refresh status" }] },
  };
}

describe("RuntimeStatusEnvelopeV1 schema", () => {
  it("requires explicit provenance, state, lifetime, diagnostic, and unavailability metadata on every group", () => {
    const metadata = { source: "native", state: "current", capturedAt: envelope().generatedAt, freshUntil: "2025-06-01T12:01:00.000Z", diagnostic: null, unavailable: null };
    const candidate = structuredClone(envelope()) as unknown as Record<string, unknown>;
    for (const name of ["identity", "session", "model", "location", "repository", "usage", "cost", "providerUsage", "compactions", "subagents", "development", "actions"]) {
      const group = candidate[name] as Record<string, unknown>;
      Object.assign(group, metadata);
    }
    expect(parseRuntimeStatusEnvelopeV1(candidate).identity).toMatchObject(metadata);
  });

  it("parses all Claude/Pi personal/work fixtures with every status group present", async () => {
    for (const name of ["runtime-claude-personal", "runtime-claude-work", "runtime-pi-personal", "runtime-pi-work"]) {
      const parsed = parseRuntimeStatusEnvelopeV1(JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")));
      expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["identity", "session", "model", "location", "repository", "usage", "cost", "providerUsage", "compactions", "subagents", "development", "actions"]));
    }
  });

  it.each([
    ["unknown field", { ...envelope(), secret: "x" }],
    ["version", { ...envelope(), schemaVersion: 2 }],
    ["timestamp", { ...envelope(), generatedAt: "yesterday" }],
    ["range", { ...envelope(), usage: { ...envelope().usage, totalTokens: -1 } }],
    ["string limit", { ...envelope(), repository: { ...envelope().repository, branch: "x".repeat(300) } }],
    ["harness discriminator", { ...envelope(), harness: { kind: "claude", version: "1", surface: "footer" } }],
  ])("rejects strict %s violations", (_name, candidate) => {
    expect(() => parseRuntimeStatusEnvelopeV1(candidate)).toThrow(/runtime status envelope/i);
  });

  it.each(["accountId", "root", "credential", "prompt", "transcriptPath", "rawHeaders"])("rejects privacy field %s", (field) => {
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), [field]: "sensitive" })).toThrow(/runtime status envelope/i);
  });

  it("rejects secrets and machine paths even when placed in an allowed label", () => {
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), location: { ...envelope().location, label: "C:\\Users\\alice\\secret" } })).toThrow(/privacy/i);
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), identity: { ...envelope().identity, label: "Bearer abcdefghijklmnop" } })).toThrow(/privacy/i);
  });

  it("enforces state discriminants and fails closed on the replaced freshness shape", () => {
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), cost: { ...envelope().cost, state: "error", capturedAt: null, freshUntil: null, diagnostic: null, unavailable: null } })).toThrow(/diagnostic/i);
    const { source: _source, state: _state, capturedAt: _capturedAt, freshUntil: _freshUntil, diagnostic: _diagnostic, unavailable: _unavailable, ...values } = envelope().identity;
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), identity: { freshness: { state: "current", observedAt: envelope().generatedAt, errorCode: null }, ...values } })).toThrow(/runtime status envelope/i);
    expect(() => parseRuntimeStatusEnvelopeV1({ ...envelope(), identity: { ...envelope().identity, capturedAt: "2025-06-01T11:59:00.000Z", freshUntil: "2025-06-01T11:59:59.000Z" } })).toThrow(/current/i);
  });

  it("preserves explicit units without floating point currency ambiguity", () => {
    const parsed = parseRuntimeStatusEnvelopeV1(envelope());
    expect(parsed.cost).toMatchObject({ currency: "USD", amountMicros: 125000 });
    expect(parsed.providerUsage.unit).toBe("percent");
  });

  it("strictly validates and freezes the exhaustive per-field capability map", () => {
    const capabilities = getRuntimeStatusCapabilitiesV1("claude");
    expect(parseRuntimeStatusCapabilitiesV1(capabilities)).toEqual(capabilities);
    expect(Object.keys(capabilities.fields)).toHaveLength(35);
    expect(Object.isFrozen(capabilities.fields)).toBe(true);
    expect(capabilities.fields["model.modelId"]).toEqual({ support: "native" });
    expect(capabilities.fields["providerUsage.used"]).toMatchObject({ support: "unsupported", reason: expect.any(String) });
    for (const candidate of [
      { ...capabilities, schemaVersion: 2 },
      { ...capabilities, extra: true },
      { ...capabilities, widths: ["narrow", "wide", "huge"] },
      { ...capabilities, fields: { ...capabilities.fields, "model.modelId": undefined } },
      { ...capabilities, fields: { ...capabilities.fields, "model.modelId": { support: "unsupported", reason: "C:\\Users\\alice" } } },
    ]) expect(() => parseRuntimeStatusCapabilitiesV1(candidate)).toThrow(/capabilit/i);
  });
});

describe("runtime status composition", () => {
  it("rejects launch, runtime, and repository binding mismatches", () => {
    expect(() => composeRuntimeStatusEnvelopeV1({ generatedAt: envelope().generatedAt, binding, harness: envelope().harness, contributions: [{ source: "runtime", binding: { ...binding, repositoryId: "other" }, groups: {} }] })).toThrow(/binding/i);
  });

  it("uses deterministic runtime-over-repository-over-launch group precedence", () => {
    const contributions = [
      { source: "runtime" as const, binding, groups: { location: { ...current, label: "runtime" } } },
      { source: "launch" as const, binding, groups: { location: { ...current, label: "launch" } } },
      { source: "repository" as const, binding, groups: { location: { ...current, label: "repository" } } },
    ];
    const result = composeRuntimeStatusEnvelopeV1({ generatedAt: envelope().generatedAt, binding, harness: envelope().harness, contributions });
    expect(result.location.label).toBe("runtime");
    expect(composeRuntimeStatusEnvelopeV1({ generatedAt: envelope().generatedAt, binding, harness: envelope().harness, contributions: [...contributions].reverse() })).toEqual(result);
  });

  it("keeps absent providers explicitly unavailable", () => {
    const result = composeRuntimeStatusEnvelopeV1({ generatedAt: envelope().generatedAt, binding, harness: envelope().harness, contributions: [] });
    expect(result.providerUsage.state).toBe("unavailable");
    expect(result.development.services).toEqual([]);
  });
});

describe("runtime status refresh and projection", () => {
  it("is single-flight, bounded, abortable, and retains stale prior data after failure", async () => {
    let resolve!: (value: RuntimeStatusEnvelopeV1) => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<RuntimeStatusEnvelopeV1>((done) => { resolve = done; }));
    const controller = createRuntimeStatusRefreshController({ read }, { timeoutMs: 50 });
    const first = controller.refresh();
    const second = controller.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolve(envelope());
    await Promise.all([first, second]);
    expect(controller.current()?.identity.label).toBe("Personal");
    const failed = createRuntimeStatusRefreshController({ read: async () => { throw new Error("offline"); } }, { initial: envelope(), timeoutMs: 50 });
    await expect(failed.refresh()).resolves.toBeUndefined();
    expect(failed.current()?.identity.state).toBe("stale");
    controller.abort();
  });

  it("times out a noncooperative reader, clears single-flight state, and permits a later refresh", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = []; let calls = 0;
      const controller = createRuntimeStatusRefreshController({ read: async signal => { signals.push(signal); calls++; if (calls === 1) return new Promise<never>(() => {}); return envelope(); } }, { initial: envelope(), timeoutMs: 50 });
      const hung = controller.refresh(); await vi.advanceTimersByTimeAsync(50); await expect(hung).resolves.toBeUndefined();
      expect(signals[0]?.aborted).toBe(true); expect(controller.current()?.identity.state).toBe("stale");
      await expect(controller.refresh()).resolves.toBeUndefined(); expect(calls).toBe(2); expect(controller.current()?.identity.state).toBe("current");
    } finally { vi.useRealTimers(); }
  });

  it("exposes harness capabilities and only width-safe semantic actions", () => {
    expect(getRuntimeStatusCapabilitiesV1("claude").surface).toBe("statusline");
    expect(getRuntimeStatusCapabilitiesV1("pi").surface).toBe("footer");
    expect(projectRuntimeStatusEnvelopeV1(envelope(), "narrow").actions).toEqual([{ id: "refresh", enabled: true, label: "↻" }]);
    expect(projectRuntimeStatusEnvelopeV1(envelope(), "wide").actions[0]?.label).toBe("Refresh status");
  });

  it("returns an immutable detached renderer projection without performing I/O", () => {
    const source = envelope();
    const projection = projectRuntimeStatusEnvelopeV1(source, "wide");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(projection.repository).not.toBe(source.repository);
    expect(() => { (projection.repository as { name: string }).name = "changed"; }).toThrow();
    expect(source.repository.name).toBe("mpx");
  });
});
