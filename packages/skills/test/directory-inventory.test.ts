import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { enumerateSkillDirectory, MAX_SKILL_DIRECTORY_BYTES, MAX_SKILL_DIRECTORY_DEPTH, MAX_SKILL_DIRECTORY_DIRECTORIES, MAX_SKILL_DIRECTORY_FILES } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "mpx-skill-directory-")); roots.push(value); return value; }

describe("skill directory inventory bounds", () => {
  it("rejects the first file beyond the file-count limit without allocating its contents", async () => {
    const directory = await root();
    await Promise.all(Array.from({ length: MAX_SKILL_DIRECTORY_FILES + 1 }, (_, index) => writeFile(path.join(directory, `file-${index.toString().padStart(3, "0")}`), "xx")));
    const allocate = vi.spyOn(Buffer, "alloc");
    try {
      await expect(enumerateSkillDirectory(directory)).rejects.toThrow("skill directory exceeds file count limit");
      expect(allocate.mock.calls.filter(([size]) => size === 2)).toHaveLength(MAX_SKILL_DIRECTORY_FILES);
    } finally {
      allocate.mockRestore();
    }
  });

  it("rejects aggregate bytes before allocating the file that exceeds the directory limit", async () => {
    const directory = await root(); const chunkBytes = Math.floor(MAX_SKILL_DIRECTORY_BYTES / 2) + 1;
    await writeFile(path.join(directory, "first"), Buffer.alloc(chunkBytes));
    await writeFile(path.join(directory, "second"), Buffer.alloc(chunkBytes));
    const allocate = vi.spyOn(Buffer, "alloc");
    try {
      await expect(enumerateSkillDirectory(directory)).rejects.toThrow("skill directory exceeds byte limit");
      expect(allocate.mock.calls.filter(([size]) => size === chunkBytes)).toHaveLength(1);
    } finally {
      allocate.mockRestore();
    }
  });

  it("rejects an oversized file from stat before reading it", async () => {
    const directory = await root(); await writeFile(path.join(directory, "large"), Buffer.alloc(MAX_SKILL_DIRECTORY_BYTES + 1));
    await expect(enumerateSkillDirectory(directory)).rejects.toThrow("skill directory file exceeds byte limit");
  });

  it("rejects wide and deep empty directory trees", async () => {
    const wide = await root();
    for (let index = 0; index <= MAX_SKILL_DIRECTORY_DIRECTORIES; index += 1) await mkdir(path.join(wide, `d-${index}`));
    await expect(enumerateSkillDirectory(wide)).rejects.toThrow("skill directory exceeds directory count limit");

    const deep = await root(); let current = deep;
    for (let depth = 0; depth <= MAX_SKILL_DIRECTORY_DEPTH; depth += 1) { current = path.join(current, "d"); await mkdir(current); }
    await expect(enumerateSkillDirectory(deep)).rejects.toThrow("skill directory exceeds depth limit");
  });

  it("rejects symlinks even when their targets remain contained", async () => {
    const directory = await root(); const target = path.join(directory, "target"); await writeFile(target, "safe"); await symlink(target, path.join(directory, "link"), "file");
    await expect(enumerateSkillDirectory(directory)).rejects.toThrow("skill directory cannot contain symlinks");
  });
});
