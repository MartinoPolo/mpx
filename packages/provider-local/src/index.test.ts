import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalIssueError, LocalIssueStore, createLocalIssueAdapter, rebuildObsidianIssueViews, rebuildObsidianSessionViews } from "./index.js";

const root = () => mkdtemp(path.join(tmpdir(), "mpx-local-issues-"));
const fixture = fileURLToPath(new URL("lock-process-fixture.mjs", import.meta.url));
const waitFor = (child: ChildProcess, type: string) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for child ${type}`)); }, 2_000);
  const message = (value: unknown) => { if ((value as { type?: unknown })?.type === type) { cleanup(); resolve(); } };
  const exit = (code: number | null) => { cleanup(); reject(new Error(`Child exited before ${type}: ${code}`)); };
  const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
  child.on("message", message); child.on("exit", exit);
});

describe("local Markdown issues", () => {
  it("allocates monotonic IDs independently in each configured root", async () => {
    const a = new LocalIssueStore(await root()), b = new LocalIssueStore(await root());
    expect((await a.create({ title: "A", body: "one" })).id).toBe("1");
    expect((await a.create({ title: "B", body: "two" })).id).toBe("2");
    expect((await b.create({ title: "C", body: "three" })).id).toBe("1");
  });

  it("uses zero-padded slug filenames, a lookup index, and stable title renames", async () => {
    const directory = await root(), store = new LocalIssueStore(directory, { projectId: "acme/app" });
    const issue = await store.create({ title: "Hello, World!", body: "" });
    expect(await readFile(path.join(directory, ".mpx-index.json"), "utf8")).toContain('"1":"000001-hello-world.md"');
    await store.update(issue.id, { title: "Renamed Title" });
    await expect(readFile(path.join(directory, "000001-hello-world.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.view("1")).title).toBe("Renamed Title");
    expect(await readFile(path.join(directory, "000001-renamed-title.md"), "utf8")).toContain('project: "acme/app"');
  });

  it("round-trips the complete versioned issue schema and preserves unknown content", async () => {
    const directory = await root(), store = new LocalIssueStore(directory, { projectId: "acme/app" });
    const created = await store.create({ title: "Schema", body: "Plan body", kind: "feature", priority: "high", assignees: ["alice"], plan: "ship", effort: "3d", capture: "inbox" });
    await store.create({ title: "Related", body: "" });
    await store.update(created.id, { localState: "doing", related: ["2"], blockedBy: [], blocks: [] });
    const local = (await store.view(created.id)).providerData.local;
    expect(local).toMatchObject({ project: "acme/app", kind: "feature", priority: "high", assignees: ["alice"], localState: "doing", plan: "ship", effort: "3d", capture: "inbox", related: ["2"], blockedBy: [], blocks: [] });
  });

  it("fails visibly with typed diagnostics when a dependency reference is missing", async () => {
    const directory = await root(), store = new LocalIssueStore(directory);
    const created = await store.create({ title: "Broken", body: "" });
    const file = path.join(directory, "000001-broken.md");
    await writeFile(file, (await readFile(file, "utf8")).replace('blockedBy: []', 'blockedBy: ["99"]'));
    await expect(store.view(created.id)).rejects.toMatchObject({ code: "LOCAL_ISSUE_REFERENCE_MISSING", details: { issueId: "1", referenceId: "99", relationship: "blockedBy" } });
    await expect(store.update(created.id, { title: "Nope" })).rejects.toMatchObject({ code: "LOCAL_ISSUE_REFERENCE_MISSING" });
  });

  it("round-trips relationships and derives the dependency frontier, including cycles", async () => {
    const store = new LocalIssueStore(await root());
    await store.create({ title: "one", body: "" });
    await store.create({ title: "two", body: "" });
    await store.create({ title: "three", body: "" });
    await store.setDependency("3", "2", true);
    await store.setDependency("2", "1", true);
    expect((await store.view("3")).providerData?.local).toMatchObject({ dependencies: { dependsOn: ["2"], frontier: ["1"] } });
    await store.setDependency("1", "3", true);
    expect((await store.view("3")).providerData?.local).toMatchObject({ dependencies: { cycle: true, frontier: [] } });
  });

  it("preserves unknown frontmatter and trailing body sections when editing known fields", async () => {
    const directory = await root(), store = new LocalIssueStore(directory);
    const created = await store.create({ title: "old", body: "Main\n\n<!-- mpx:preserve -->\n## Custom\nKeep" });
    const file = path.join(directory, "000001-old.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("schemaVersion: 2", "schemaVersion: 2\nfutureKey: {\"enabled\":true}"));
    await store.update(created.id, { title: "new", body: "Changed" });
    const text = await readFile(path.join(directory, "000001-new.md"), "utf8");
    expect(text).toContain("futureKey: {\"enabled\":true}");
    expect(text).toContain("<!-- mpx:preserve -->\n## Custom\nKeep");
  });

  it("rejects malformed documents and compare-and-swap conflicts after external edits", async () => {
    const directory = await root(), store = new LocalIssueStore(directory);
    await writeFile(path.join(directory, "000009-bad.md"), "---\nschemaVersion: nope\n---\nbad");
    await writeFile(path.join(directory, ".mpx-index.json"), JSON.stringify({ schemaVersion: 1, next: 10, files: { "9": "000009-bad.md" } }));
    await expect(store.view("9")).rejects.toMatchObject({ code: "LOCAL_ISSUE_MALFORMED" });
    const created = await store.create({ title: "A", body: "B" });
    const createdPath=path.join(directory, "000010-a.md");
    await writeFile(createdPath, (await readFile(createdPath, "utf8")) + "external");
    await expect(store.update(created.id, { title: "C" }, String(created.providerData?.local?.revision))).rejects.toMatchObject({ code: "LOCAL_ISSUE_CONFLICT" });
  });

  it("serializes concurrent creators without duplicate IDs", async () => {
    const directory = await root();
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => new LocalIssueStore(directory).create({ title: String(index), body: "" })));
    expect(created.map(issue => issue.id).sort((a,b)=>Number(a)-Number(b))).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  });

  it("refreshes its lease during a two-process long operation so a contender cannot steal it", async () => {
    const directory = await root(), child = fork(fixture, ["hold", directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await waitFor(child, "locked");
      const ownerPath=path.join(directory,".mpx-issues.lock","owner.json"),acquired=JSON.parse(await readFile(ownerPath,"utf8")) as {acquiredAt:number;heartbeatAt:number};
      const refreshDeadline=Date.now()+2_000;let refreshed=acquired;
      while(refreshed.heartbeatAt===acquired.heartbeatAt&&Date.now()<refreshDeadline){await new Promise(resolve=>setTimeout(resolve,10));refreshed=JSON.parse(await readFile(ownerPath,"utf8")) as typeof acquired;}
      expect(refreshed.heartbeatAt).toBeGreaterThan(acquired.heartbeatAt);
      await expect(new LocalIssueStore(directory, { staleLockMilliseconds: 2_000, lockTimeoutMilliseconds: 40, lockRetryMilliseconds: 2 }).create({ title: "contender", body: "" })).rejects.toMatchObject({ code: "LOCAL_ISSUE_LOCK_TIMEOUT" });
      child.send("release"); await waitFor(child, "finished");
      expect((await new LocalIssueStore(directory).create({ title: "next", body: "" })).id).toBe("2");
    } finally { child.kill(); }
  });

  it("takes over a crashed process lock without reusing its committed ID", async () => {
    const directory = await root(), child = fork(fixture, ["crash", directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await waitFor(child, "locked");
    await new Promise<void>(resolve => child.exitCode === null ? child.once("exit", () => resolve()) : resolve());
    expect((await new LocalIssueStore(directory, { staleLockMilliseconds: 10, lockTimeoutMilliseconds: 500 }).create({ title: "after crash", body: "" })).id).toBe("2");
  });

  it("propagates malformed owner metadata as a typed lock failure instead of treating it as missing", async () => {
    const directory = await root(), lock = path.join(directory, ".mpx-issues.lock");
    await mkdir(lock); await writeFile(path.join(lock, "owner.json"), "{partial");
    await expect(new LocalIssueStore(directory, { lockTimeoutMilliseconds: 20 }).create({ title: "blocked", body: "" })).rejects.toMatchObject({ code: "LOCAL_ISSUE_LOCK_INVALID" });
    await expect(readFile(path.join(directory, ".mpx-index.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates owner access failures as typed lock I/O errors", async () => {
    const directory = await root(), lock = path.join(directory, ".mpx-issues.lock");
    await mkdir(path.join(lock, "owner.json"), { recursive: true });
    await expect(new LocalIssueStore(directory).create({ title: "blocked", body: "" })).rejects.toMatchObject({ code: "LOCAL_ISSUE_LOCK_IO" });
  });

  it("reports heartbeat loss during a post-commit release as lock release pending without inviting a duplicate mutation", async () => {
    const directory = await root(), lock = path.join(directory, ".mpx-issues.lock"), displaced = `${lock}.displaced`;
    let unblock!: () => void, callbackStarted!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { callbackStarted = resolve; });
    const holding = new LocalIssueStore(directory, { staleLockMilliseconds: 15, lockHeartbeatMilliseconds: 1, lockToken: () => "holder", onChanged: async () => { callbackStarted(); await blocked; } }).create({ title: "holder", body: "" });
    await started;
    for (let attempt = 0;; attempt++) { try { await rename(lock, displaced); break; } catch (error) { if (attempt === 20 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await new Promise(resolve => setTimeout(resolve, 2)); } }
    await mkdir(lock); await writeFile(path.join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, token: "replacement", pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() }));
    await new Promise(resolve => setTimeout(resolve, 20));
    unblock();
    expect(await holding).toMatchObject({ id: "1", providerData: { local: { lockReleasePending: true, diagnostics: ["LOCAL_ISSUE_LOCK_RELEASE_PENDING"] } } });
    expect((await new LocalIssueStore(directory).view("1")).title).toBe("holder");
    expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"))).toMatchObject({ token: "replacement" });
    await rm(lock, { recursive: true, force: true }); await rm(displaced, { recursive: true, force: true });
  });

  it("retries transient compare-token release access failures without reporting pending", async () => {
    const directory = await root(); let attempts = 0;
    const issue = await new LocalIssueStore(directory, { beforeLockReleaseAttempt: () => { if (++attempts < 3) throw Object.assign(new Error("busy"), { code: "EACCES" }); } }).create({ title: "once", body: "" });
    expect(issue.providerData.local).not.toHaveProperty("lockReleasePending");
    expect(attempts).toBe(3);
  });

  it("records the exact quarantine obligation before a successful release rename and survives owner-read EACCES", async () => {
    const directory = await root(), token = "read-denied", pending = path.join(directory, ".mpx-lock-release-pending.json");
    let recorded: { schemaVersion: number; token: string; quarantinePath: string } | undefined;
    const committed = await new LocalIssueStore(directory, {
      lockToken: () => token,
      beforeLockQuarantineReadAttempt: async () => {
        recorded = JSON.parse(await readFile(pending, "utf8")) as typeof recorded;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }).create({ title: "first", body: "" });
    expect(committed).toMatchObject({ id: "1", providerData: { local: { lockReleasePending: true, diagnostics: ["LOCAL_ISSUE_LOCK_RELEASE_PENDING"] } } });
    expect(recorded).toEqual({ schemaVersion: 1, token, quarantinePath: path.join(directory, `.mpx-issues.lock.release-${token}`) });
    await expect(readFile(recorded!.quarantinePath, "utf8")).rejects.toBeDefined();
    await new LocalIssueStore(directory).view("1");
    await expect(readFile(pending, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a failed quarantine removal across process restart until exact cleanup succeeds", async () => {
    const directory = await root(), pending = path.join(directory, ".mpx-lock-release-pending.json");
    const committed = await new LocalIssueStore(directory, {
      lockToken: () => "remove-denied",
      beforeLockQuarantineRemoveAttempt: () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); },
    }).create({ title: "first", body: "" });
    expect(committed).toMatchObject({ providerData: { local: { lockReleasePending: true } } });
    const obligation = JSON.parse(await readFile(pending, "utf8")) as { quarantinePath: string };
    expect(await readFile(path.join(obligation.quarantinePath, "owner.json"), "utf8")).toContain("remove-denied");
    expect((await new LocalIssueStore(directory).create({ title: "second", body: "" })).id).toBe("2");
    await expect(readFile(obligation.quarantinePath, "utf8")).rejects.toBeDefined();
    await expect(readFile(pending, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never clears a pending release when restarted quarantine cleanup still fails", async () => {
    const directory = await root(), pending = path.join(directory, ".mpx-lock-release-pending.json");
    await new LocalIssueStore(directory, { lockToken: () => "held", beforeLockQuarantineRemoveAttempt: () => { throw Object.assign(new Error("busy"), { code: "EACCES" }); } }).create({ title: "first", body: "" });
    const obligation = await readFile(pending, "utf8");
    await expect(new LocalIssueStore(directory, { beforeLockQuarantineRemoveAttempt: () => { throw Object.assign(new Error("busy"), { code: "EACCES" }); } }).view("1")).rejects.toMatchObject({ code: "LOCAL_ISSUE_LOCK_IO" });
    expect(await readFile(pending, "utf8")).toBe(obligation);
    expect((await new LocalIssueStore(directory).view("1")).id).toBe("1");
    await expect(readFile(pending, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a non-fatal pending projection diagnostic when the post-commit callback fails", async () => {
    const directory = await root(), changed = async () => { throw new Error("projection offline"); };
    const created = await new LocalIssueStore(directory, { onChanged: changed }).create({ title: "committed once", body: "" });
    expect(created).toMatchObject({ id: "1", providerData: { local: { projectionRebuildPending: true, diagnostics: ["LOCAL_ISSUE_PROJECTION_REBUILD_PENDING"] } } });
    expect((await new LocalIssueStore(directory).list()).map(issue => issue.id)).toEqual(["1"]);
  });

  it("uses deterministic lease time and atomic takeover for a dead owner", async () => {
    const directory = await root(), lock = path.join(directory, ".mpx-issues.lock");
    await mkdir(lock); await writeFile(path.join(lock, "owner.json"), JSON.stringify({ schemaVersion: 1, token: "dead", pid: 4242, acquiredAt: 10, heartbeatAt: 20 }));
    let now = 100;
    const issue = await new LocalIssueStore(directory, { now: () => now++, isProcessAlive: () => false, lockToken: (() => { let value=0; return () => `token-${++value}`; })(), staleLockMilliseconds: 50 }).create({ title: "takeover", body: "" });
    expect(issue.id).toBe("1");
  });

  it("does not let a stale releaser remove a replacement lock with another token", async () => {
    const directory = await root(), lock = path.join(directory, ".mpx-issues.lock");
    let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
    const holding = new LocalIssueStore(directory, { lockToken: () => "old-token", onChanged: async()=>blocked }).create({ title:"old", body:"" });
    while(true){try{await readFile(path.join(lock,"owner.json"));break;}catch{await new Promise(resolve=>setTimeout(resolve,1));}}
    await rename(lock,`${lock}.removed`);await mkdir(lock);await writeFile(path.join(lock,"owner.json"),JSON.stringify({schemaVersion:1,token:"replacement",pid:process.pid,acquiredAt:Date.now(),heartbeatAt:Date.now()}));
    unblock();expect(await holding).toMatchObject({id:"1",providerData:{local:{lockReleasePending:true,diagnostics:["LOCAL_ISSUE_LOCK_RELEASE_PENDING"]}}});
    expect(JSON.parse(await readFile(path.join(lock,"owner.json"),"utf8"))).toMatchObject({token:"replacement"});
    await rm(lock,{recursive:true,force:true});await rm(`${lock}.removed`,{recursive:true,force:true});
  });

  it("rejects symlink roots and malicious identifiers", async () => {
    const target = await root(), parent = await root(), link = path.join(parent, "linked");
    await symlink(target, link, "junction");
    await expect(new LocalIssueStore(link).list()).rejects.toBeInstanceOf(LocalIssueError);
    await expect(new LocalIssueStore(target).view("../secret")).rejects.toMatchObject({ code: "LOCAL_ISSUE_PATH_UNSAFE" });
  });

  it("exposes current provider contracts and reports unsupported promotion structurally", async () => {
    const adapter = createLocalIssueAdapter({ root: await root() });
    const created = await adapter.invoke({ providerId: "local", capability: "issue.create", input: { title: "T", body: "B" } as never });
    expect(created).toMatchObject({ id: "1", state: "open" });
    await expect(adapter.invoke({ providerId: "local", capability: "issue.move", input: { id: "1", destination: "board" } as never })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("generates privacy-safe session projections with validated resume links", async () => {
    const vault=await root(),output=path.join(vault,"MPX","Sessions");
    await rebuildObsidianSessionViews([{id:"session-1",projectId:"acme/app",status:"active",title:"Work",resumeUrl:"mpx://resume?session=session-1",privateSummary:"never project"}],{vaultRoot:vault,outputRoot:output});
    const text=await readFile(path.join(output,"session-1.md"),"utf8");
    expect(text).toContain("[Resume](mpx://resume?session=session-1)");
    expect(text).not.toContain("never project");
  });

  it("rebuilds privacy-safe vault projections idempotently and removes stale generated views", async () => {
    const issues = await root(), vault = await root(), store = new LocalIssueStore(issues);
    await store.create({ title: "Visible", body: "secret body" });
    const output = path.join(vault, "MPX", "Issues");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "000999-stale.md"), "generated");
    await rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "acme/app", resumeBaseUrl: "mpx://resume" });
    const once = await readFile(path.join(output, "000001-visible.md"), "utf8");
    await rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "acme/app", resumeBaseUrl: "mpx://resume" });
    expect(await readFile(path.join(output, "000001-visible.md"), "utf8")).toBe(once);
    await expect(readFile(path.join(output, "000999-stale.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(once).not.toContain("secret body");
    await expect(rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "../bad", resumeBaseUrl: "javascript:bad" })).rejects.toMatchObject({ code: "LOCAL_VIEW_CONFIG_INVALID" });
  });
});
