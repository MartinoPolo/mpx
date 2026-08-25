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
  it("remains inert in the Pi runtime adapter", async () => {
    const runtimeSource = await readFile(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
    expect(runtimeSource).not.toMatch(/(?:from\s+|import\s*\()\s*["'][^"']*vendor[\\/]subagents/u);
    expect(await readdir(root)).toContain("LICENSE");
  });
});
