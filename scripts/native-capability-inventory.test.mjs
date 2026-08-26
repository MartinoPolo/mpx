import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectInventory } from "./native-capability-inventory.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-native-inventory-"));
  const claude = path.join(root, "claude-personal");
  const pi = path.join(root, "pi-personal");
  await mkdir(path.join(claude, "plugins", "cache", "mpx"), { recursive: true });
  await writeFile(path.join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "mpx@local": [{ scope: "user", installPath: path.join(claude, "plugins", "cache", "mpx"), version: "1.2.3" }] } }));
  await writeFile(path.join(claude, "plugins", "cache", "mpx", "plugin.json"), JSON.stringify({ name: "mpx", version: "1.2.3", commands: ["commands/review.md"], agents: ["agents/checker.md"] }));
  await mkdir(path.join(pi, "node_modules", "@mpx", "runtime-pi"), { recursive: true });
  await writeFile(path.join(pi, "package.json"), JSON.stringify({ name: "pi-native", private: true, dependencies: { "@mpx/runtime-pi": "1.2.3" } }));
  await writeFile(path.join(pi, "node_modules", "@mpx", "runtime-pi", "package.json"), JSON.stringify({ name: "@mpx/runtime-pi", version: "1.2.3", pi: { extensions: ["extensions/mpx.ts"], skills: ["skills/review"] } }));
  return { root, claude, pi };
}

describe("privacy-safe native capability inventory", () => {
  it("projects only package identity, exact version, named routes, redacted source, and comparison", async () => {
    const f = await fixture();
    try {
      const result = await collectInventory({ roots: [{ identity: "personal", runtime: "claude", path: f.claude }, { identity: "personal", runtime: "pi", path: f.pi }], declarations: [{ runtime: "claude", id: "mpx@local", version: "1.2.3", capabilityRoutes: ["agent:checker", "command:review"] }, { runtime: "pi", id: "@mpx/runtime-pi", version: "1.2.3", capabilityRoutes: ["extension:mpx", "skill:review"] }] });
      expect(result.entries).toEqual([
        { identity: "personal", runtime: "claude", id: "mpx@local", version: "1.2.3", capabilityRoutes: ["agent:checker", "command:review"], source: "${personal.claude}/plugins/cache/mpx/plugin.json", classification: "matched" },
        { identity: "personal", runtime: "pi", id: "@mpx/runtime-pi", version: "1.2.3", capabilityRoutes: ["extension:mpx", "skill:review"], source: "${personal.pi}/node_modules/@mpx/runtime-pi/package.json", classification: "matched" },
      ]);
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(result.roots[0].digest).toMatch(/^[a-f0-9]{64}$/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("classifies missing, extra, and version/route mismatches without copying state", async () => {
    const f = await fixture();
    try {
      const result = await collectInventory({ roots: [{ identity: "personal", runtime: "claude", path: f.claude }, { identity: "personal", runtime: "pi", path: f.pi }], declarations: [{ runtime: "claude", id: "mpx@local", version: "9.9.9", capabilityRoutes: [] }, { runtime: "pi", id: "not-installed", version: "1.0.0", capabilityRoutes: [] }] });
      expect(result.summary).toEqual({ matched: 0, missing: 1, extra: 1, unsupported: 1 });
      expect(result.entries.map((entry) => entry.classification).sort()).toEqual(["extra", "missing", "unsupported"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects a symlink in an allowlisted metadata path", async () => {
    const f = await fixture();
    try {
      const target = path.join(f.root, "outside.json");
      await writeFile(target, JSON.stringify({ name: "@mpx/runtime-pi", version: "1.2.3", pi: {} }));
      await rm(path.join(f.pi, "node_modules", "@mpx", "runtime-pi", "package.json"));
      await symlink(target, path.join(f.pi, "node_modules", "@mpx", "runtime-pi", "package.json"));
      await expect(collectInventory({ roots: [{ identity: "personal", runtime: "pi", path: f.pi }], declarations: [] })).rejects.toThrow(/SYMLINK_REJECTED/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects unknown metadata schemas rather than inspecting arbitrary config", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.pi, "package.json"), JSON.stringify({ name: "pi-native", private: true, dependencies: {}, scripts: { leak: "secret" } }));
      await expect(collectInventory({ roots: [{ identity: "personal", runtime: "pi", path: f.pi }], declarations: [] })).rejects.toThrow(/UNKNOWN_SCHEMA/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
