import { describe, expect, it } from "vitest";
import { executeWorktreeIncludePlan, planWorktreeIncludes, parseWorktreeInclude, type WorktreeIncludeDependencies } from "./worktree-include.js";

describe(".worktreeinclude parsing", () => {
  it("preserves Git-ignore rules while rejecting absolute and traversing patterns", () => {
    expect(parseWorktreeInclude("# local files\n.env\ncache/**\n!cache/keep.txt\n資料/*.json\n\\!literal\n\\#literal\n")).toEqual([
      ".env", "cache/**", "!cache/keep.txt", "資料/*.json", "\\!literal", "\\#literal",
    ]);
    for (const pattern of ["/rooted", "../secret", "safe/../../secret", "C:/secret", "C:\\secret", "\\\\server\\share", "evil\0path", "evil\rpath"]) {
      expect(() => parseWorktreeInclude(`${pattern}\n`)).toThrowError(expect.objectContaining({ code: "WORKTREE_INCLUDE_PATTERN_UNSAFE" }));
    }
  });
});

describe("include planning", () => {
  it("selects only Git-reported ignored/untracked files with source-checkout precedence and canonical-main fallback", async () => {
    const files = new Map<string, Buffer>([
      ["/main/.worktreeinclude", Buffer.from("local/**\n資料/*.txt\n")],
      ["/source/local/shared.txt", Buffer.from("source")],
      ["/source/資料/空 白.txt", Buffer.from("unicode")],
      ["/main/local/shared.txt", Buffer.from("main old")],
      ["/main/local/fallback.txt", Buffer.from("fallback")],
    ]);
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => {
        calls.push({ args: [...args], cwd });
        return Buffer.from(cwd === "/source" ? "local/shared.txt\0資料/空 白.txt\0" : "local/shared.txt\0local/fallback.txt\0");
      } },
      fs: {
        readFile: async (file) => files.get(file)!,
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: 8 }),
      },
      canonical: { resolve: async (value) => value },
    };

    const plan = await planWorktreeIncludes({ repositoryId: "acme/widgets", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies);

    expect(plan.matches.map(({ path, from }) => ({ path, from }))).toEqual([
      { path: "local/fallback.txt", from: "main" },
      { path: "local/shared.txt", from: "source" },
      { path: "資料/空 白.txt", from: "source" },
    ]);
    expect(calls).toEqual([
      { cwd: "/source", args: ["ls-files", "--others", "--ignored", "--exclude-from=/main/.worktreeinclude", "-z", "--"] },
      { cwd: "/main", args: ["ls-files", "--others", "--ignored", "--exclude-from=/main/.worktreeinclude", "-z", "--"] },
    ]);
  });
});

describe("malicious filesystem boundaries", () => {
  it("rejects an include file whose canonical target escapes the main checkout", async () => {
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async () => Buffer.from("") },
      fs: {
        readFile: async () => Buffer.from("*.env\n"),
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: 6 }),
      },
      canonical: { resolve: async (value) => value.endsWith(".worktreeinclude") ? "/outside/rules" : value },
    };
    await expect(planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies))
      .rejects.toMatchObject({ code: "WORKTREE_INCLUDE_FILE_ESCAPE" });
  });

  it("rejects a matched source whose canonical target escapes the selected checkout", async () => {
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (_args, cwd) => Buffer.from(cwd === "/source" ? "escape.env\0" : "") },
      fs: {
        readFile: async (file) => file.endsWith(".worktreeinclude") ? Buffer.from("*.env\n") : Buffer.from("secret"),
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: 6 }),
      },
      canonical: { resolve: async (value) => value.endsWith("escape.env") ? "/outside/secret.env" : value },
    };
    await expect(planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies))
      .rejects.toMatchObject({ code: "WORKTREE_INCLUDE_SOURCE_ESCAPE" });
  });

  it("rejects a destination parent redirected outside the destination root", async () => {
    let planning = true;
    const writes: string[] = [];
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => {
        if (args.includes("--others")) return Buffer.from(cwd === "/source" ? "nested/secret.env\0" : "");
        throw new Error("untracked");
      } },
      fs: {
        readFile: async (file) => file.endsWith(".worktreeinclude") ? Buffer.from("nested/**\n") : Buffer.from("secret"),
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: 6 }),
        mkdir: async () => { planning = false; },
        exists: async () => false,
        writeFileExclusive: async (file) => { writes.push(file); },
      },
      canonical: { resolve: async (value) => !planning && value === "/dest/nested" ? "/outside" : value },
    };
    const plan = await planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies);
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_DESTINATION_ESCAPE" });
    expect(writes).toEqual([]);
  });

  it("never overwrites a tracked destination", async () => {
    const writes: string[] = [];
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => {
        if (args.includes("--others")) return Buffer.from(cwd === "/source" ? "local.env\0" : "");
        return Buffer.from("local.env\n");
      } },
      fs: {
        readFile: async (file) => file.endsWith(".worktreeinclude") ? Buffer.from("*.env\n") : Buffer.from("secret"),
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: 6 }),
        mkdir: async () => undefined,
        exists: async () => true,
        writeFileExclusive: async (file) => { writes.push(file); },
      },
      canonical: { resolve: async (value) => value },
    };
    const plan = await planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies);
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_TRACKED_DESTINATION" });
    expect(writes).toEqual([]);
  });
});

describe("include copy approval", () => {
  it("rejects an exact pre-existing destination on the first attempt without recovery evidence", async () => {
    const source = new Map([["/source/a.env", Buffer.from("alpha")]]);
    const destination = new Map([["/dest/a.env", Buffer.from("alpha")]]);
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => args.includes("--others") ? Buffer.from(cwd === "/source" ? "a.env\0" : "") : Buffer.alloc(0) },
      fs: {
        readFile: async file => file.endsWith(".worktreeinclude") ? Buffer.from("*.env\n") : source.get(file) ?? destination.get(file) ?? Buffer.from("alpha"),
        lstat: async file => ({ isFile: true, isSymbolicLink: false, isReparsePoint: false, size: (source.get(file) ?? destination.get(file) ?? Buffer.from("*.env\n")).length }),
        mkdir: async () => undefined,
        exists: async file => destination.has(file),
        writeFileExclusive: async () => { throw new Error("must not write"); },
      },
      canonical: { resolve: async value => value },
    };
    const plan = await planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies);
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_DESTINATION_MISMATCH" });
  });

  it("resumes a partial approved copy only when existing destinations exactly match their approved files", async () => {
    const source = new Map([["/source/a.env", Buffer.from("alpha")], ["/source/b.env", Buffer.from("beta")]]);
    const destination = new Map<string, Buffer>();
    let failSecond = true;
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => args.includes("--others") ? Buffer.from(cwd === "/source" ? "a.env\0b.env\0" : "") : Buffer.alloc(0) },
      fs: {
        readFile: async file => file.endsWith(".worktreeinclude") ? Buffer.from("*.env\n") : source.get(file) ?? destination.get(file) ?? Buffer.from("alpha"),
        lstat: async file => ({ isFile: true, isSymbolicLink: false, isReparsePoint: false, size: (source.get(file) ?? destination.get(file) ?? Buffer.from("*.env\n")).length }),
        mkdir: async () => undefined,
        exists: async file => destination.has(file),
        writeFileExclusive: async (file, bytes) => { if (file.endsWith("b.env") && failSecond) throw new Error("disk full"); destination.set(file, Buffer.from(bytes)); },
      },
      canonical: { resolve: async value => value },
    };
    const plan = await planWorktreeIncludes({ repositoryId: "repo", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" }, dependencies);
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies)).rejects.toThrow("disk full");
    expect(destination.get("/dest/a.env")?.toString()).toBe("alpha");

    failSecond = false;
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies, true)).resolves.toMatchObject({ copiedCount: 2 });
    destination.set("/dest/a.env", Buffer.from("alphx"));
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies, true)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_DESTINATION_MISMATCH" });
  });

  it("refuses missing, inexact, and stale human approval before writing", async () => {
    let content = Buffer.from("secret-one");
    const writes: string[] = [];
    const dependencies: WorktreeIncludeDependencies = {
      git: { run: async (args, cwd) => {
        if (args[0] === "ls-files" && args.includes("--others")) return Buffer.from(cwd === "/source" ? "local.env\0" : "");
        throw new Error("untracked destination");
      } },
      fs: {
        readFile: async (file) => file.endsWith(".worktreeinclude") ? Buffer.from("*.env\n") : content,
        lstat: async () => ({ isFile: true, isSymbolicLink: false, size: content.length }),
        mkdir: async () => undefined,
        exists: async () => false,
        writeFileExclusive: async (file) => { writes.push(file); },
      },
      canonical: { resolve: async (value) => value },
    };
    const input = { repositoryId: "repo-identity", sourceRoot: "/source", mainRoot: "/main", destinationRoot: "/dest" };
    const plan = await planWorktreeIncludes(input, dependencies);

    await expect(executeWorktreeIncludePlan(plan, "", dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
    await expect(executeWorktreeIncludePlan(plan, `${plan.approval} `, dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_REQUIRED" });
    content = Buffer.from("secret-two");
    await expect(executeWorktreeIncludePlan(plan, plan.approval, dependencies)).rejects.toMatchObject({ code: "WORKTREE_INCLUDE_APPROVAL_STALE" });
    expect(writes).toEqual([]);
  });
});
