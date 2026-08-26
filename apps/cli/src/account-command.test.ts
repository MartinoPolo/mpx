import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootAttestationService, RootAttestationStore } from "@mpx/sessions";
import { executeAccountCommand, PiAuthAvailabilityProbe } from "./account-command.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mpx-cli-account-")); cleanup.push(root);
  const nativeRoot = path.join(root, "pi-root"); await mkdir(nativeRoot);
  const service = new RootAttestationService(new RootAttestationStore(path.join(root, "state")));
  const user = { identities: { work: { domain: "work", runtimeRoots: { pi: nativeRoot, claude: path.join(root, "claude") } } } } as never;
  const auth = { verify: vi.fn(async () => undefined) };
  return { root, nativeRoot, service, user, auth };
}

describe("account command", () => {
  it("returns a private-safe plan and writes only after exact confirmation", async () => {
    const f = await fixture();
    const planned = await executeAccountCommand({ action: "enroll", identityName: "work" }, { user: f.user, service: f.service, auth: f.auth });
    expect(planned).toMatchObject({ status: "planned", proves: "configured-root-and-registry-state" });
    expect(f.auth.verify).not.toHaveBeenCalled();
    expect(JSON.stringify(planned)).not.toContain(f.nativeRoot);
    expect(JSON.stringify(planned)).not.toContain("ref-");
    await expect(executeAccountCommand({ action: "enroll", identityName: "work", confirmationDigest: "wrong-digest" }, { user: f.user, service: f.service, auth: f.auth })).rejects.toMatchObject({ code: "ACCOUNT_PLAN_STALE" });
    expect(f.auth.verify).not.toHaveBeenCalled();
    await expect(f.service.find({ domain: "work", name: "work" })).resolves.toBeUndefined();
    const committed = await executeAccountCommand({ action: "enroll", identityName: "work", confirmationDigest: String(planned.confirmationDigest) }, { user: f.user, service: f.service, auth: f.auth });
    expect(committed).toEqual({ schemaVersion: 1, operation: "enroll", identity: { domain: "work", name: "work" }, runtime: "pi", mode: "root-attested", status: "enrolled" });
    expect(f.auth.verify).toHaveBeenCalledTimes(1);
  });

  it("lists every configured Pi identity and classifies missing and changed roots", async () => {
    const f = await fixture();
    const otherRoot = path.join(f.root, "other-pi"), changedRoot = path.join(f.root, "changed-pi"); await mkdir(otherRoot); await mkdir(changedRoot);
    const user = { identities: { work: { domain: "work", runtimeRoots: { pi: changedRoot, claude: path.join(f.root, "claude") } }, other: { domain: "personal", runtimeRoots: { pi: otherRoot, claude: path.join(f.root, "other-claude") } } } } as never;
    await f.service.confirm(await f.service.plan("enroll", { domain: "work", name: "work" }, f.nativeRoot));
    const listed = await executeAccountCommand({ action: "list" }, { user, service: f.service, auth: f.auth }) as { accounts: { identity: { name: string }; status: string }[] };
    expect(listed.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: { domain: "work", name: "work" }, status: "root-changed" }),
      expect.objectContaining({ identity: { domain: "personal", name: "other" }, status: "missing" }),
    ]));
    await expect(executeAccountCommand({ action: "status", identityName: "work" }, { user, service: f.service, auth: f.auth })).resolves.toMatchObject({ status: "root-changed" });
  });

  it("lists, reports, and verifies without exposing roots or opaque references", async () => {
    const f = await fixture(); const plan = await f.service.plan("enroll", { domain: "work", name: "work" }, f.nativeRoot); await f.service.confirm(plan);
    const outputs = await Promise.all(["list", "status", "verify"].map(action => executeAccountCommand({ action: action as "list" | "status" | "verify", ...(action === "list" ? {} : { identityName: "work" }) }, { user: f.user, service: f.service, auth: f.auth })));
    expect(outputs[2]).toMatchObject({ status: "verified" }); expect(f.auth.verify).toHaveBeenCalledWith(f.nativeRoot);
    expect(JSON.stringify(outputs)).not.toContain(f.nativeRoot); expect(JSON.stringify(outputs)).not.toContain((await f.service.find({ domain: "work", name: "work" }))!.ref);
  });
});

describe("Pi auth availability", () => {
  it("uses the exact supported argv and configured-root environment", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth" }), stderr: "" }));
    const probe = new PiAuthAvailabilityProbe({ resolve: async () => ({ executable: "C:/trusted/node.exe", argvPrefix: ["C:/trusted/pi.js"] }), run, cwd: "C:/outside", environment: { PATH: "C:/trusted" } });
    await probe.verify("C:/accounts/work");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: "C:/trusted/node.exe", argv: ["C:/trusted/pi.js", "auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"], shell: false, timeoutMs: 15_000, maxOutputBytes: 16_384, environment: expect.objectContaining({ PI_CODING_AGENT_DIR: "C:/accounts/work" }) }));
  });

  it("fails closed on unavailable, malformed, extra, or secret-bearing output", async () => {
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "token=secret" },
      { exitCode: 0, stdout: "not-json", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth", token: "secret" }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ status: "missing", provider: "openai-codex", authType: "oauth" }), stderr: "" },
    ]) {
      const probe = new PiAuthAvailabilityProbe({ resolve: async () => ({ executable: "C:/trusted/pi.exe", argvPrefix: [] }), run: async () => result, cwd: "C:/outside", environment: {} });
      await expect(probe.verify("C:/accounts/work")).rejects.toMatchObject({ code: "ACCOUNT_AUTH_UNAVAILABLE" });
    }
  });
});
