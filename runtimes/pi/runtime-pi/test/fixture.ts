import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeContextV1 } from "@mpx/runtime-contracts";
import { createRuntimeSkillArtifact, inventoryCanonical, resolveManifest } from "@mpx/skills";
import type { RuntimeStatusEnvelopeV1, StatusSnapshotV1 } from "@mpx/status";

const exposures = [["full", "full", "Full skill", "full trigger"], ["named", "name-only", "Named skill", ""], ["explicit", "explicit-only", "Explicit skill", ""], ["off", "off", "Off skill", ""], ["excluded", "full", "Excluded skill", ""]] as const;
export async function fixture() {
  const canonicalRoot = await mkdtemp(path.join(tmpdir(), "pi-skills-"));
  for (const [name, exposure, description, triggers] of exposures) {
    const dir = path.join(canonicalRoot, name); await mkdir(dir);
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${triggers ? `triggers: ${triggers}\n` : ""}metadata:\n  mpx:\n    skillPacks: [${name === "excluded" ? "personal" : "core"}]\n    defaultExposure: ${exposure}\n---\n# ${name}\n`);
  }
  const catalog = await inventoryCanonical(canonicalRoot);
  const currentBinding = { projectId: "p", repositoryId: "repo", contentScope: "scope" };
  const manifest = resolveManifest(catalog, { ...currentBinding, projectId: "p", enabledPacks: ["core"], identity: "id", skillPolicy: "policy", skillPolicyConfig: { skillPacks: ["core"], skillExposure: { default: "full", skills: { named: "name-only", explicit: "explicit-only", off: "off" } } } });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: "pi" });
  const context = createRuntimeContextV1({ launchKey: "launch", launchDescriptor: { reference: "launch.json", digest: "digest" }, manifestKey: manifest.manifestKey, runtimeArtifact: artifact.reference, binding: currentBinding });
  const statusSnapshot: StatusSnapshotV1 = { schemaVersion: 1, project: { id: "sample/app", cwd: "C:/repo" }, worktree: { id: "wt-1", path: "C:/repo", role: "main", branch: "main" }, portResolution: "valid", services: [{ id: "api", mode: "managed", scope: "checkout", protocol: "http", port: 4101, listening: true, conflict: "none", pid: 7 }, { id: "web", mode: "fixed-shared", scope: "project", protocol: "https", port: 4443, listening: false, conflict: "external", pid: null }], diagnostics: [] };
  const at = "2026-08-25T12:00:00.000Z", freshness = { state: "current", observedAt: at, errorCode: null } as const, unavailable = { state: "unavailable", observedAt: null, errorCode: null } as const;
  const runtimeStatusEnvelope: RuntimeStatusEnvelopeV1 = { schemaVersion: 1, generatedAt: at, binding: { launchKey: "launch", runtimeId: "pi", repositoryId: "repo" }, harness: { kind: "pi", version: null, surface: "footer" }, identity: { freshness, profile: "personal", label: "Personal" }, session: { freshness: unavailable, elapsedMs: null, turns: null }, model: { freshness, modelId: "gpt-5.6-sol", label: "Sol", contextUsedTokens: 1000, contextLimitTokens: 272000 }, location: { freshness, label: "worktree" }, repository: { freshness, name: "app", branch: "main", dirty: false, ahead: 0, behind: 0 }, usage: { freshness, inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 }, cost: { freshness, currency: "USD", amountMicros: 0 }, providerUsage: { freshness: unavailable, provider: null, used: null, limit: null, unit: null, resetAt: null }, compactions: { freshness, count: 0, lastAt: null }, subagents: { freshness, active: 0, completed: 0, failed: 0 }, development: { freshness, services: [{ id: "api", state: "listening", port: 4101 }, { id: "web", state: "conflict", port: 4443 }] }, actions: { freshness, items: [{ id: "refresh", enabled: true, narrowLabel: "R", wideLabel: "Refresh" }] } };
  return { context, manifest, artifact, catalog, canonicalRoot, currentBinding, expectedLaunch: { launchKey: "launch", descriptorDigest: "digest" }, statusSnapshot, runtimeStatusEnvelope, launchBanner: "[mpx pi/docker 123456789abc]" };
}
