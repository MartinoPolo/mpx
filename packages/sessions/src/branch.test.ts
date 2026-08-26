import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BranchLeaseStore,
  ConversationBranchService,
  SessionError,
  createClaudeBranchAdapter,
  createPiBranchAdapter,
  planWindowsTerminalTab,
  type BranchRequestV1,
} from "./index.js";

const digest = "a".repeat(64);
const base: BranchRequestV1 = {
  schemaVersion: 1,
  parent: { runtimeQualifiedId: "claude:parent id", nativeSessionRef: { kind: "native-id", value: "parent id" } },
  child: { runtimeQualifiedId: "claude:new", runtime: "claude" },
  launchIdentity: { identity: { domain: "personal", name: "me" }, rootDigest: digest, mode: "interactive", executor: "host" },
  workspace: { selection: "isolated", intent: "modify", cwd: "C:/repo with spaces", projectRef: "project", repositoryRef: "repo", worktreeRef: null, branch: "mpx/session-child" },
  files: { sharing: "isolated", collisionDisclosure: ["same repository history"], duplicateWriterRiskAcknowledged: false },
  terminal: { enabled: false },
};

function dependencies() {
  return {
    inspectWorkspace: vi.fn(async () => ({ exists: true, collisionDisclosure: ["same repository history"] as const })),
    createIsolatedWorktree: vi.fn(async () => ({ cwd: "C:/repo.worktrees/mpx/session-child", worktreeRef: "wt-child" })),
    adapters: { claude: createClaudeBranchAdapter("C:/Program Files/Claude/claude.exe"), pi: createPiBranchAdapter("C:/Program Files/Pi/pi.exe") },
  };
}

describe("conversation branching", () => {
  it("plans a modifying parallel branch in a new isolated worktree by default", async () => {
    const deps = dependencies();
    const plan = await new ConversationBranchService(deps).plan({ ...base, workspace: { ...base.workspace, selection: "default" } });
    expect(plan.workspace).toMatchObject({ selection: "isolated", sharing: "isolated", provision: "new-worktree" });
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("preserves a work identity and immutable launch root/mode/executor in the child plan", async () => {
    const plan = await new ConversationBranchService(dependencies()).plan({ ...base, launchIdentity: { identity: { domain: "work", name: "employee" }, rootDigest: "b".repeat(64), mode: "locked-down", executor: "host" } });
    expect(plan.launchIdentity).toEqual({ identity: { domain: "work", name: "employee" }, rootDigest: "b".repeat(64), mode: "locked-down", executor: "host" });
  });

  it("rejects a missing or deleted repository/worktree during read-only planning", async () => {
    const deps = dependencies(); deps.inspectWorkspace.mockResolvedValue({ exists: false, collisionDisclosure: [] });
    await expect(new ConversationBranchService(deps).plan(base)).rejects.toMatchObject({ code: "SESSION_BRANCH_WORKSPACE_MISSING" });
  });

  it("fails closed for Docker until the selected executor is explicitly admitted", async () => {
    await expect(new ConversationBranchService(dependencies()).plan({ ...base, launchIdentity: { ...base.launchIdentity, executor: "docker" } })).rejects.toMatchObject({ code: "SESSION_BRANCH_EXECUTOR_NOT_ADMITTED" });
  });

  it("requires explicit risk acknowledgement for a shared current checkout", async () => {
    await expect(new ConversationBranchService(dependencies()).plan({ ...base, workspace: { ...base.workspace, selection: "shared" }, files: { ...base.files, sharing: "shared" } })).rejects.toMatchObject({ code: "SESSION_BRANCH_SHARED_RISK_UNACKNOWLEDGED" });
  });

  it("does not provision or acquire a writer lease before digest confirmation", async () => {
    const deps = dependencies(), leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-")));
    const service = new ConversationBranchService(deps, leases), plan = await service.plan(base);
    await expect(service.apply(plan, "b".repeat(64))).rejects.toMatchObject({ code: "SESSION_BRANCH_CONFIRMATION_MISMATCH" });
    expect(deps.createIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("prevents two child sessions from holding a writer lease for one workspace", async () => {
    const leases = new BranchLeaseStore(await mkdtemp(path.join(tmpdir(), "mpx-branch-")));
    const first = await leases.acquire("C:/shared repo", "claude:one");
    await expect(leases.acquire("C:/shared repo", "pi:two")).rejects.toMatchObject({ code: "SESSION_BRANCH_DUPLICATE_WRITER" });
    await first.release();
    await expect(leases.acquire("C:/shared repo", "pi:two")).resolves.toBeDefined();
  });

  it("uses Claude's native fork/resume argv without copying transcripts", () => {
    expect(createClaudeBranchAdapter("C:/Program Files/Claude/claude.exe").plan(base.parent, "C:/repo & work")).toEqual({ executable: "C:/Program Files/Claude/claude.exe", argv: ["--resume", "parent id", "--fork-session"], cwd: "C:/repo & work", nativeTarget: "runtime-created" });
  });

  it("admits a Pi fork only for an identity-stable regular source under the selected root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi root & ")), session = path.join(root, "sessions", "parent.jsonl");
    await mkdir(path.dirname(session)); await writeFile(session, "{}");
    const adapter = createPiBranchAdapter("C:/Program Files/Pi/pi.exe");
    await expect(adapter.plan({ runtimeQualifiedId: "pi:parent", nativeSessionRef: { kind: "root-relative-file", value: "sessions/parent.jsonl" } }, "C:/repo", root)).resolves.toEqual({ executable: "C:/Program Files/Pi/pi.exe", argv: ["--fork", session.replaceAll("\\", "/")], cwd: "C:/repo", nativeTarget: "runtime-created" });
    await expect(adapter.plan({ runtimeQualifiedId: "pi:parent", nativeSessionRef: { kind: "root-relative-file", value: "../escape" } }, "C:/repo", root)).rejects.toMatchObject({ code: "SESSION_BRANCH_PI_TARGET_INVALID" });
  });

  it("emits an optional Windows Terminal tab as executable and argv with no shell text", () => {
    expect(planWindowsTerminalTab({ enabled: true, executable: "C:/Program Files/WindowsApps/wt.exe", cwd: "C:/repo & work", title: "child; title" }, { executable: "C:/Program Files/Pi/pi.exe", argv: ["--fork", "C:/pi root/a.jsonl"], cwd: "C:/repo & work", nativeTarget: "runtime-created" })).toEqual({ executable: "C:/Program Files/WindowsApps/wt.exe", argv: ["new-tab", "--title", "child; title", "--startingDirectory", "C:/repo & work", "--", "C:/Program Files/Pi/pi.exe", "--fork", "C:/pi root/a.jsonl"], cwd: "C:/repo & work" });
    expect(planWindowsTerminalTab({ enabled: false }, { executable: "x", argv: [], cwd: "C:/repo", nativeTarget: "runtime-created" })).toBeNull();
  });
});
