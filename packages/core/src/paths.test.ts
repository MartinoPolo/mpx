import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalRealpath, isPathWithinRoot, selectLongestMatchingRoot } from "./paths.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))));

describe("paths", () => {
  it("resolves a canonical real path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mpx-core-")); temporary.push(directory);
    await expect(canonicalRealpath(path.join(directory, "."))).resolves.toBe(path.normalize(await realpath(directory)));
  });
  it("matches complete POSIX segments only", () => {
    expect(isPathWithinRoot("/repo/root/file", "/repo/root", { platform: "linux" })).toBe(true);
    expect(isPathWithinRoot("/repo/root", "/repo/root", { platform: "linux" })).toBe(true);
    expect(isPathWithinRoot("/repo/rooted/file", "/repo/root", { platform: "linux" })).toBe(false);
    expect(isPathWithinRoot("/repo/root/../outside", "/repo/root", { platform: "linux" })).toBe(false);
  });
  it("uses Windows separators and case folding", () => {
    expect(isPathWithinRoot(String.raw`C:\Repo\Root\File`, String.raw`c:\repo\root`, { platform: "win32" })).toBe(true);
    expect(isPathWithinRoot(String.raw`C:\Repo\Rooted`, String.raw`c:\repo\root`, { platform: "win32" })).toBe(false);
    expect(isPathWithinRoot(String.raw`D:\Repo`, String.raw`C:\Repo`, { platform: "win32" })).toBe(false);
  });
  it("selects the longest matching root without changing its spelling", () => {
    expect(selectLongestMatchingRoot(String.raw`C:\Repo\Sub\file`, [String.raw`C:\Repo`, String.raw`c:\repo\sub`], { platform: "win32" })).toBe(String.raw`c:\repo\sub`);
    expect(selectLongestMatchingRoot("/none", ["/repo"], { platform: "linux" })).toBeUndefined();
  });
});
