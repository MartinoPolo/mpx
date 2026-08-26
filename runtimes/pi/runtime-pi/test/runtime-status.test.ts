import { expect, it } from "vitest";
import { createPiRuntimeStatusAdapter, renderPiRuntimeStatus } from "../src/runtime-status.js";
import type { RuntimeStatusEnvelopeV1 } from "@mpx/status";

const now = "2026-08-25T12:00:00.000Z";
const fresh = { source: "native", state: "current", capturedAt: now, freshUntil: "2026-08-25T12:01:00.000Z", diagnostic: null, unavailable: null } as const;
const envelope: RuntimeStatusEnvelopeV1 = {
  schemaVersion: 1, generatedAt: now, binding: { launchKey: "launch", runtimeId: "pi", repositoryId: "repo" }, harness: { kind: "pi", version: "0.84.3", surface: "footer" },
  identity: { ...fresh, profile: "personal", label: "Personal" }, session: { ...fresh, elapsedMs: 60000, turns: 3 },
  model: { ...fresh, modelId: "gpt-5.6-sol", label: "Sol", contextUsedTokens: 1000, contextLimitTokens: 272000 }, location: { ...fresh, label: "worktree" },
  repository: { ...fresh, name: "mpx", branch: "feat/pi", dirty: true, ahead: 1, behind: 0 }, usage: { ...fresh, inputTokens: 800, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 1000 },
  cost: { ...fresh, currency: "USD", amountMicros: 123000 }, providerUsage: { ...fresh, provider: "openai-codex", used: 12, limit: 100, unit: "percent", resetAt: null },
  compactions: { ...fresh, count: 1, lastAt: now }, subagents: { ...fresh, active: 2, completed: 3, failed: 0 },
  development: { ...fresh, services: [{ id: "web", state: "listening", port: 4310 }] }, actions: { ...fresh, items: [{ id: "refresh", enabled: true, narrowLabel: "↻", wideLabel: "Refresh" }] },
};

it("renders the privacy-safe runtime envelope while preserving Pi actions", async () => {
  let resolve!: (value: unknown) => void;
  const adapter = createPiRuntimeStatusAdapter({ read: () => new Promise(r => { resolve = r; }) });
  expect(adapter.render("wide")).toBe("");
  const pending = adapter.refresh(); resolve(envelope); await pending;
  const rendered = adapter.render("wide");
  expect(rendered).toContain("Personal · Sol · mpx@feat/pi* · 1k/272k · $0.12 · quota 12/100% · cmp 1 · agents 2/3 · web:4310 · Refresh");
  expect(rendered).not.toContain("launch");
  expect(renderPiRuntimeStatus(envelope, "narrow")).toContain("↻");
});
