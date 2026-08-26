import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalIssueError, LocalIssueStore, createLocalIssueAdapter, rebuildObsidianIssueViews, rebuildObsidianSessionViews } from "./index.js";

const root = () => mkdtemp(path.join(tmpdir(), "mpx-local-issues-"));

describe("local Markdown issues", () => {
  it("allocates monotonic IDs independently in each configured root", async () => {
    const a = new LocalIssueStore(await root()), b = new LocalIssueStore(await root());
    expect((await a.create({ title: "A", body: "one" })).id).toBe("1");
    expect((await a.create({ title: "B", body: "two" })).id).toBe("2");
    expect((await b.create({ title: "C", body: "three" })).id).toBe("1");
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
    const file = path.join(directory, `${created.id}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace("schemaVersion: 1", "schemaVersion: 1\nfutureKey: {\"enabled\":true}"));
    await store.update(created.id, { title: "new", body: "Changed" });
    const text = await readFile(file, "utf8");
    expect(text).toContain("futureKey: {\"enabled\":true}");
    expect(text).toContain("<!-- mpx:preserve -->\n## Custom\nKeep");
  });

  it("rejects malformed documents and compare-and-swap conflicts after external edits", async () => {
    const directory = await root(), store = new LocalIssueStore(directory);
    await writeFile(path.join(directory, "9.md"), "---\nschemaVersion: nope\n---\nbad");
    await expect(store.view("9")).rejects.toMatchObject({ code: "LOCAL_ISSUE_MALFORMED" });
    const created = await store.create({ title: "A", body: "B" });
    await writeFile(path.join(directory, `${created.id}.md`), (await readFile(path.join(directory, `${created.id}.md`), "utf8")) + "external");
    await expect(store.update(created.id, { title: "C" }, String(created.providerData?.local?.revision))).rejects.toMatchObject({ code: "LOCAL_ISSUE_CONFLICT" });
  });

  it("serializes concurrent creators without duplicate IDs", async () => {
    const directory = await root();
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => new LocalIssueStore(directory).create({ title: String(index), body: "" })));
    expect(created.map(issue => issue.id).sort((a,b)=>Number(a)-Number(b))).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  });

  it("recovers a stale allocation lock without reusing IDs", async () => {
    const directory = await root(), store = new LocalIssueStore(directory, { staleLockMilliseconds: 1 });
    await store.create({ title: "A", body: "" });
    await writeFile(path.join(directory, ".mpx-issues.lock"), JSON.stringify({ pid: 999999, createdAt: 0 }));
    expect((await store.create({ title: "B", body: "" })).id).toBe("2");
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
    await writeFile(path.join(output, "999.md"), "generated");
    await rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "acme/app", resumeBaseUrl: "mpx://resume" });
    const once = await readFile(path.join(output, "1.md"), "utf8");
    await rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "acme/app", resumeBaseUrl: "mpx://resume" });
    expect(await readFile(path.join(output, "1.md"), "utf8")).toBe(once);
    await expect(readFile(path.join(output, "999.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(once).not.toContain("secret body");
    await expect(rebuildObsidianIssueViews(store, { vaultRoot: vault, outputRoot: output, projectId: "../bad", resumeBaseUrl: "javascript:bad" })).rejects.toMatchObject({ code: "LOCAL_VIEW_CONFIG_INVALID" });
  });
});
