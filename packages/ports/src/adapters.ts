import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export interface PortHold { release(): Promise<void> }
export interface ProcessFingerprint { pid: number; startedAt: string }
export interface ProcessInfo { pid: number; startedAt?: string; processName?: string; executable?: string; projectPath?: string }
export interface ListenerInfo { port: number; pid?: number; address?: string; processName?: string; executable?: string; projectPath?: string; startedAt?: string }
export interface PortPlatformAdapter {
  holdAvailablePorts(ports: readonly number[]): Promise<PortHold>;
  inspectListeners(ports?: readonly number[]): Promise<readonly ListenerInfo[]>;
  killProcess(fingerprint: ProcessFingerprint): Promise<void>;
  inspectProcess(pid: number): Promise<ProcessInfo | undefined>;
}
export interface WorktreeInfo { path: string; head?: string; branch?: string; detached?: true; prunable?: string; role: "main" | "linked" }
export interface WorktreeIdentity extends WorktreeInfo { repositoryId: string; worktreeId: string; commonGitPath: string; gitAdminPath: string }
export interface GitWorktreeAdapter {
  identify(cwd: string): Promise<WorktreeIdentity>;
  list(cwd: string): Promise<readonly WorktreeIdentity[]>;
}

export function parseWorktreePorcelainZ(input: string): WorktreeInfo[] {
  const records: Array<Record<string, string | true>> = [];
  let current: Record<string, string | true> | undefined;
  for (const field of input.split("\0")) {
    if (!field) continue;
    const space = field.indexOf(" "); const key = space < 0 ? field : field.slice(0, space); const value = space < 0 ? true : field.slice(space + 1);
    if (key === "worktree") { if (current) records.push(current); current = { worktree: value }; }
    else if (current) current[key] = value;
  }
  if (current) records.push(current);
  return records.map((record, index) => ({
    path: String(record.worktree),
    ...(typeof record.HEAD === "string" ? { head: record.HEAD } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(record.detached === true ? { detached: true as const } : {}),
    ...(typeof record.prunable === "string" ? { prunable: record.prunable } : {}),
    role: index === 0 ? "main" as const : "linked" as const,
  }));
}
const hash = (value: string) => createHash("sha256").update(value.toLowerCase()).digest("hex");
const execFile = promisify(execFileCallback);

export class RealGitWorktreeAdapter implements GitWorktreeAdapter {
  async identify(cwd: string): Promise<WorktreeIdentity> {
    const list = await this.list(cwd); const canonicalCwd = await realpath(cwd);
    const found = list.find((item) => path.normalize(item.path).toLowerCase() === path.normalize(canonicalCwd).toLowerCase() || canonicalCwd.toLowerCase().startsWith(`${path.normalize(item.path).toLowerCase()}${path.sep}`));
    if (!found) throw new Error(`Git did not report a worktree containing ${cwd}`); return found;
  }
  async list(cwd: string): Promise<WorktreeIdentity[]> {
    const [{ stdout }, { stdout: commonOutput }] = await Promise.all([
      execFile("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
      execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }),
    ]);
    const commonGitPath = await realpath(commonOutput.trim()); const repositoryId = hash(path.normalize(commonGitPath));
    return Promise.all(parseWorktreePorcelainZ(stdout).map(async (item) => {
      const canonicalPath = await realpath(item.path);
      const { stdout: adminOutput } = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: canonicalPath, encoding: "utf8" });
      const gitAdminPath = await realpath(adminOutput.trim());
      return { ...item, path: canonicalPath, commonGitPath, gitAdminPath, repositoryId, worktreeId: hash(path.normalize(gitAdminPath)) };
    }));
  }
}
