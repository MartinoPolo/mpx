import { execFile as execFileCallback } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { revalidateRuntimeArtifact } from "@mpx/runtime-contracts";
import { createRuntimeSkillArtifact, loadSkillBody } from "@mpx/skills";
import { buildClaudePlugin } from "../../../claude/runtime-claude/src/index.js";
import { buildPiProjection, createPiRuntimeProjection, planPiInvocation, renderPiStatusLine } from "../src/index.js";
import { fixture } from "./fixture.js";

const execFile = promisify(execFileCallback);
const originalRuntimeContext = process.env.MPX_RUNTIME_CONTEXT;
const originalProjectionReference = process.env.MPX_RUNTIME_PROJECTION_REFERENCE;
afterEach(() => {
  if (originalRuntimeContext === undefined) delete process.env.MPX_RUNTIME_CONTEXT; else process.env.MPX_RUNTIME_CONTEXT = originalRuntimeContext;
  if (originalProjectionReference === undefined) delete process.env.MPX_RUNTIME_PROJECTION_REFERENCE; else process.env.MPX_RUNTIME_PROJECTION_REFERENCE = originalProjectionReference;
});

describe("production Pi projection", () => {
  it("preserves the shared lazy loader canonical hash and normalized provenance wrapper", async () => {
    const f = await fixture();
    const projection = await buildPiProjection({ ...f, artifactsRoot: await mkdtemp(path.join(tmpdir(), "pi-provenance-")) });
    const module = await import(pathToFileURL(projection.extension).href);
    let loadTool: { execute(id: string, params: { identity: string }): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }> } | undefined;
    const pi = {
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: { identity: string }): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }> }) { if (tool.name === "mpx_model_load") loadTool = tool; },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate(pi);
    const projected = await loadTool!.execute("load", { identity: "full" });
    const canonical = await loadSkillBody({ canonicalRoot: f.canonicalRoot, manifest: f.manifest, artifact: f.artifact, runtime: "pi", identity: "full", invocation: "model" });
    const claudeArtifact = createRuntimeSkillArtifact(f.manifest, f.catalog, { runtime: "claude" });
    const claude = await loadSkillBody({ canonicalRoot: f.canonicalRoot, manifest: f.manifest, artifact: claudeArtifact, runtime: "claude", identity: "full", invocation: "model" });
    expect(projected.content[0]!.text).toBe(canonical.wrappedBody);
    expect(projected.details.provenance).toEqual(canonical.provenance);
    expect({ body: canonical.body, contentHash: canonical.provenance.contentHash, sourcePath: canonical.provenance.sourcePath }).toEqual({ body: claude.body, contentHash: claude.provenance.contentHash, sourcePath: claude.provenance.sourcePath });
  });

  it("publishes an immutable deterministic self-contained policy projection", async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "pi-projections-"));
    const input = { ...f, artifactsRoot };

    const first = await buildPiProjection(input);
    const second = await createPiRuntimeProjection(input);

    expect(second).toEqual({ ...first, reused: true });
    expect(Object.isFrozen(first)).toBe(true);
    expect(await revalidateRuntimeArtifact(first.revalidation.directory, first.revalidation.reference)).toMatchObject({ valid: true });
    expect(first.files).toEqual(expect.arrayContaining([
      "extension.mjs", "runtime-context.json", "projection.json", "settings.json", "keybindings.json", "status/status-snapshot.json",
      "themes/green.json", "themes/amber.json", "vendor/subagents/VENDORED.md", "vendor/subagents/LICENSE",
    ]));
    expect(first.files.some((file) => file.startsWith("agents/mpx-") && file.endsWith(".md"))).toBe(true);
    expect(first.files).not.toEqual(expect.arrayContaining([expect.stringMatching(/(?:^|\/)SKILL\.md$|(?:^|\/)pnpm-lock\.yaml$/u)]));

    const descriptor = JSON.parse(await readFile(path.join(first.directory, "projection.json"), "utf8")) as Record<string, unknown>;
    expect(descriptor).toMatchObject({ schemaVersion: 1, runtime: "pi", commandAllowlist: ["mpx:explicit", "mpx:full", "mpx:named"], modelSearchAllowlist: ["full", "named"] });
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(f.canonicalRoot);
    expect(serialized).not.toMatch(/credential|session|nativeSkillAliases/iu);
    expect(await readFile(first.extension, "utf8")).not.toContain(f.canonicalRoot);
    expect((await readdir(path.join(first.directory, "skills"))).sort()).toEqual(["explicit", "full", "named"]);
    expect(await readFile(path.join(first.directory, "status", "status-snapshot.json"), "utf8")).toBe(`${JSON.stringify(f.statusSnapshot, null, 2)}\n`);
  });

  it("copies canonical support assets and binds their bytes into full projection revalidation", async () => {
    const f = await fixture();
    await mkdir(path.join(f.canonicalRoot, "full", "references"));
    await writeFile(path.join(f.canonicalRoot, "full", "references", "guide.txt"), "trusted support\n");
    await writeFile(path.join(f.canonicalRoot, "full", "script.js"), "export default 1;\n");
    const projection = await buildPiProjection({ ...f, artifactsRoot: await mkdtemp(path.join(tmpdir(), "pi-support-")) });
    expect(await readFile(path.join(projection.directory, "skills", "full", "references", "guide.txt"), "utf8")).toBe("trusted support\n");
    expect(projection.files).toContain("skills/full/script.js");
    await writeFile(path.join(projection.directory, "skills", "full", "script.js"), "tampered\n");
    await expect(revalidateRuntimeArtifact(projection.directory, projection.reference)).resolves.toMatchObject({ valid: false });
  });

  it("rejects symlinked generated-assets roots before reading agents or themes", async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "pi-projections-"));
    const assetsTarget = await mkdtemp(path.join(tmpdir(), "pi-assets-target-"));
    await mkdir(path.join(assetsTarget, "agents"));
    await mkdir(path.join(assetsTarget, "themes"));
    const linkedAssetsRoot = path.join(await mkdtemp(path.join(tmpdir(), "pi-assets-link-")), "projection-link");
    await symlink(assetsTarget, linkedAssetsRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(buildPiProjection({ ...f, artifactsRoot, assetsRoot: linkedAssetsRoot })).rejects.toThrow(/assets|symlink/i);
  });

  it("plans Pi from projection revalidation data and a private native account root", async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "pi-projections-"));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const plan = planPiInvocation({ executable: "C:/trusted/pi.cmd", projection, accountRoot: "C:/private/pi/account-a", runtimeContext: f.context, cwd: "C:/repo" });
    expect(plan.args).toEqual(["--no-extensions", "--extension", projection.extension.replaceAll("\\", "/"), "--no-skills", "--theme", "green"]);
    expect(plan.env).toEqual({ PI_CODING_AGENT_DIR: "C:/private/pi/account-a", MPX_RUNTIME: "pi", MPX_RUNTIME_CONTEXT: JSON.stringify(f.context), MPX_RUNTIME_CONTEXT_FILE: projection.runtimeContextFile.replaceAll("\\", "/"), MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projection.reference) });
    expect(projection.revalidation).toEqual({ directory: projection.directory, reference: projection.reference });
  });

  it("matches the generated Claude status script exactly for the same snapshot", async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "pi-projections-"));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const agentsRoot = await mkdtemp(path.join(tmpdir(), "claude-agents-"));
    await writeFile(path.join(agentsRoot, "mpx-checker.md"), "---\nname: mpx-checker\ndescription: Check things\n---\nAGENT BODY\n");
    const claudeOutput = path.join(await mkdtemp(path.join(tmpdir(), "claude-projection-")), "plugin");
    await buildClaudePlugin({ manifest: f.manifest, artifact: createRuntimeSkillArtifact(f.manifest, f.catalog, { runtime: "claude" }), catalog: f.catalog, canonical: f.canonicalRoot, agents: agentsRoot, outputRoot: claudeOutput, statusSnapshot: f.statusSnapshot, launchBanner: f.launchBanner, runtimeContext: f.context });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    let piStatus = "";
    const pi = { registerCommand() {}, registerTool() {}, on(name: string, handler: (...args: unknown[]) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); }, sendUserMessage: async () => undefined };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate(pi);
    await events.get("session_start")![0]!({}, { ui: { setStatus: (_key: string, text: string) => { piStatus = text; } } });
    expect(piStatus).toBe((await execFile(process.execPath, [path.join(claudeOutput, "status", "status-line.mjs")])).stdout);
  });

  it("activates the generated extension with current tool, disclosure, command, status, and restart semantics", async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), "pi-projections-"));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const module = await import(pathToFileURL(projection.extension).href);
    const commands = new Map<string, { description?: string; handler(args: string): Promise<void> }>();
    const tools = new Map<string, { name: string; label: string; description: string; parameters: unknown; execute(toolCallId: string, params: unknown): Promise<unknown> }>();
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const sent: string[] = [];
    const statusCalls: Array<[string, string]> = [];
    const pi = {
      registerCommand(name: string, specification: { description?: string; handler(args: string): Promise<void> }) { commands.set(name, specification); },
      registerTool(definition: { name: string; label: string; description: string; parameters: unknown; execute(toolCallId: string, params: unknown): Promise<unknown> }) { tools.set(definition.name, definition); },
      on(name: string, handler: (...args: unknown[]) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
      sendUserMessage: async (content: readonly { type: "text"; text: string }[]) => { sent.push(content[0]!.text); },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const liveStatus = path.join(artifactsRoot, "live-status.json");
    await writeFile(liveStatus, JSON.stringify(f.statusSnapshot));
    process.env.MPX_STATUS_SNAPSHOT_FILE = liveStatus;

    await expect(module.activate(pi)).resolves.toBeUndefined();
    expect([...commands.keys()]).toEqual(["mpx:explicit", "mpx:full", "mpx:named"]);
    expect([...tools.keys()]).toEqual(["mpx_model_search", "mpx_model_load"]);
    expect(events.has("before_agent_start")).toBe(true);
    expect(events.has("session_start")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);

    const beforeAgentStart = events.get("before_agent_start")![0]!;
    expect(await beforeAgentStart({ systemPrompt: "BASE" })).toEqual({ systemPrompt: "BASE\n\nMPX skills:\n- /mpx:full: Full skill (triggers: full trigger)\n- /mpx:named" });

    const sessionStart = events.get("session_start")![0]!;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await sessionStart({}, { ui: { setStatus: (key: string, text: string) => { statusCalls.push([key, text]); } } });
    await sessionStart({}, { ui: { setStatus: (key: string, text: string) => { statusCalls.push([key, text]); } } });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(statusCalls).toEqual([
      ["mpx", renderPiStatusLine(f.statusSnapshot, { launchBanner: f.launchBanner })],
      ["mpx", renderPiStatusLine(f.statusSnapshot, { launchBanner: f.launchBanner })],
    ]);
    await writeFile(liveStatus, JSON.stringify({ ...f.statusSnapshot, portResolution: "missing", services: [] }));
    await beforeAgentStart({ systemPrompt: "BASE" });
    expect(statusCalls.at(-1)).toEqual(["mpx", `${f.launchBanner} | ports missing`]);
    await events.get("session_shutdown")![0]!();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    clearIntervalSpy.mockRestore();

    await expect(tools.get("mpx_model_search")!.execute("tool-1", { query: "" })).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify([{ identity: "full", publicName: "/mpx:full", description: "Full skill", triggers: "full trigger", score: 1 }, { identity: "named", publicName: "/mpx:named", description: "Named skill", score: 1 }]) }],
      details: { results: [{ identity: "full", publicName: "/mpx:full", description: "Full skill", triggers: "full trigger", score: 1 }, { identity: "named", publicName: "/mpx:named", description: "Named skill", score: 1 }] },
    });
    await expect(tools.get("mpx_model_load")!.execute("tool-2", { identity: "full" })).resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("identity=full") }], details: { identity: "full", provenance: { invocation: "model" } } });
    await expect(tools.get("mpx_model_load")!.execute("tool-3", { identity: "explicit" })).rejects.toThrow(/SKILL_INVOCATION_DENIED|RESTART_REQUIRED/u);

    await commands.get("mpx:explicit")!.handler("ignore /mpx:full prose");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("identity=explicit");
    expect(sent[0]).toContain("origin=human-explicit");

    await writeFile(path.join(projection.directory, "skills", "full", "body.md"), "changed\n");
    await expect(tools.get("mpx_model_load")!.execute("tool-4", { identity: "full" })).rejects.toThrow(/RESTART_REQUIRED/u);

    await writeFile(path.join(projection.directory, ".mpx-runtime-artifact.json"), `${JSON.stringify({ schemaVersion: 1, reference: projection.reference, fileMap: [] }, null, 2)}\n`);
    await expect(beforeAgentStart({ systemPrompt: "BASE" })).rejects.toThrow(/RESTART_REQUIRED/u);

    process.env.MPX_RUNTIME_CONTEXT = "{bad";
    await expect(beforeAgentStart({ systemPrompt: "BASE" })).rejects.toThrow(/RESTART_REQUIRED/u);

    delete process.env.MPX_RUNTIME_CONTEXT;
    delete process.env.MPX_STATUS_SNAPSHOT_FILE;
    await expect(tools.get("mpx_model_search")!.execute("tool-5", { query: "full" })).rejects.toThrow(/RESTART_REQUIRED/u);
  });
});
