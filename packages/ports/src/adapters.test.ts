import { describe, expect, it } from "vitest";
import { parseWorktreePorcelainZ } from "./index.js";

describe("git worktree porcelain parser", () => {
  it("parses nul-delimited worktree records without splitting paths containing spaces", () => {
    const input = "worktree C:/repo with spaces\0HEAD abc123\0branch refs/heads/main\0\0worktree C:/linked tree\0HEAD def456\0detached\0\0";
    expect(parseWorktreePorcelainZ(input)).toEqual([
      { path: "C:/repo with spaces", head: "abc123", branch: "refs/heads/main", role: "main" },
      { path: "C:/linked tree", head: "def456", detached: true, role: "linked" },
    ]);
  });
});
