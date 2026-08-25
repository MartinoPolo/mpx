import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../vendor/subagents");
describe("subagent vendor provenance", () => {
  it("matches the pinned SHA-256 manifest without mutable machine roots", async () => {
    const manifest = await readFile(path.join(root, "SHA256SUMS"), "utf8");
    for (const line of manifest.trim().split(/\r?\n/u)) {
      const [expected, relative] = line.split("  ");
      const content = await readFile(path.join(root, relative!));
      expect(createHash("sha256").update(content).digest("hex"), relative).toBe(expected);
      expect(content.toString("utf8"), relative).not.toMatch(/[A-Za-z]:[\\/]_MP_(?:projects|work|github_cloned|apps)/iu);
    }
  });
  it("is projected as reviewed source while activation uses the provider-neutral bridge", async () => {
    const bridgeSource = await readFile(path.resolve(import.meta.dirname, "../src/subagent-bridge.ts"), "utf8");
    expect(bridgeSource).toContain('from "@mpx/subagents"');
    expect(await readdir(root)).toContain("LICENSE");
  });
});
