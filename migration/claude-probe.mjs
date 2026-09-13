#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const PI = {
  PI_PROVIDER: process.env.PI_PROVIDER ?? null,
  PI_MODEL: process.env.PI_MODEL ?? null,
  PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL ?? null,
};
const VERSION = "2.1.236", MODEL = "claude-native-fixture-model", EFFORT = "low";
const OK = "FIXTURE_OK", OLD = `OLD_CONTEXT_${randomUUID()}`, NEW = `NEW_CONTEXT_${randomUUID()}`;
const SID = randomUUID(), TIMEOUT = 25_000, MAX_OUTPUT = 12 * 1024;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = join(repo, "dist", "packs", "development", "claude");
const source = join(pack, ".claude", "skills", "mp-handoff", "SKILL.md");
let root, server, launches = 0;
const children = new Set(), requests = [];

const text = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => text(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => text(v, out));
  return out.join("\n");
};
const effort = (value, path = "", out = []) => {
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (/effort/i.test(key) && ["string", "number", "boolean"].includes(typeof child)) out.push({ key: here, value: child });
    if (child && typeof child === "object") effort(child, here, out);
  }
  return out.slice(0, 8);
};
const proc = (r) => ({ exitCode: r.code, signal: r.signal, timedOut: r.timedOut,
  stdoutBytes: Buffer.byteLength(r.stdout), stderrBytes: Buffer.byteLength(r.stderr), spawnError: r.error });

async function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const k = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { if (k.exitCode === null) k.kill("SIGKILL"); done(); }, 2_000);
      k.once("close", () => { clearTimeout(timer); done(); });
      k.once("error", () => { clearTimeout(timer); done(); });
    });
  }
  if (child.exitCode === null && child.signalCode === null) try { child.kill("SIGKILL"); } catch {}
}

async function run(exe, args, cwd, env) {
  if (++launches > 5) throw new Error("Claude launch limit exceeded");
  return new Promise((done) => {
    const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const output = { stdout: [], stderr: [], outBytes: 0, errBytes: 0 };
    let timedOut = false, settled = false, fallback;
    const add = (which, chunk, cap) => {
      const key = which === "stdout" ? "outBytes" : "errBytes", room = Math.max(0, cap - output[key]);
      if (room) output[which].push(chunk.subarray(0, room));
      output[key] += chunk.length;
    };
    child.stdout.on("data", (c) => add("stdout", c, 256 * 1024));
    child.stderr.on("data", (c) => add("stderr", c, 64 * 1024));
    const timer = setTimeout(async () => {
      timedOut = true;
      await killTree(child);
      if (!settled) fallback = setTimeout(() => finish(null, child.signalCode, "timeout cleanup did not close stdio"), 3_000);
    }, TIMEOUT);
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(fallback); children.delete(child);
      done({ code, signal, timedOut, error: error ? String(error).slice(0, 300) : null,
        stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") });
    };
    child.once("error", (e) => { fallback = setTimeout(() => finish(null, null, e.message), 1_000); });
    child.once("close", (code, signal) => finish(code, signal));
  });
}

async function gitInit(dir) {
  await new Promise((ok, fail) => {
    const child = spawn("git", ["init", "--quiet", dir], { shell: false, windowsHide: true, stdio: "ignore" });
    children.add(child);
    child.once("error", fail);
    child.once("close", (code) => { children.delete(child); code === 0 ? ok() : fail(new Error(`git init exited ${code}`)); });
  });
}

function environment(account, base) {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!windowsRoot) throw new Error("SystemRoot or WINDIR is required; guessed Windows roots are forbidden");
  const home = join(account, "home"), temp = join(account, "tmp"), drive = parse(tmpdir()).root.replace(/[\\/]$/, "");
  if (!drive) throw new Error("Cannot derive HOMEDRIVE from tmpdir");
  return { SystemRoot: windowsRoot, WINDIR: windowsRoot, PATH: join(windowsRoot, "System32"), PATHEXT: ".COM;.EXE;.BAT;.CMD",
    HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) || "\\",
    APPDATA: join(account, "appdata"), LOCALAPPDATA: join(account, "localappdata"), TEMP: temp, TMP: temp,
    XDG_CONFIG_HOME: join(account, "xdg-config"), XDG_CACHE_HOME: join(account, "xdg-cache"),
    CLAUDE_CONFIG_DIR: join(account, "claude"), ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "sk-ant-api03-DISPOSABLE-LOOPBACK-FAKE-KEY",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", CI: "1", TERM: "dumb" };
}
async function prepare(account) {
  await Promise.all(["home", "tmp", "appdata", "localappdata", "xdg-config", "xdg-cache", "claude"]
    .map((p) => mkdir(join(account, p), { recursive: true })));
}

function startServer() {
  return new Promise((ok, fail) => {
    const fixture = createServer((req, res) => {
      const chunks = []; let bytes = 0;
      req.on("data", (c) => { bytes += c.length; if (bytes <= 1024 * 1024) chunks.push(c); });
      req.on("end", () => {
        let body;
        try { body = bytes <= 1024 * 1024 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch {}
        const path = (req.url || "").split("?")[0]; // Headers/auth are intentionally never read or retained.
        requests.push({ path, body });
        if (!body || !path.endsWith("/messages")) { res.writeHead(body ? 404 : 400, { "content-type": "application/json" }); res.end("{}"); return; }
        const id = `msg_fixture_${requests.length}`, model = body.model || MODEL;
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        const events = [
          ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: OK } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        events.forEach(([event, data]) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); res.end();
      });
    });
    fixture.once("error", fail);
    fixture.listen(0, "127.0.0.1", () => ok(fixture));
  });
}

const streamMeta = (stdout) => {
  const records = stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const init = records.find((r) => r.type === "system" && r.subtype === "init");
  return { responseMarker: text(records.filter((r) => r.type === "assistant" || r.type === "result")).includes(OK),
    sessionId: init?.session_id || null, cwd: init?.cwd || null, model: init?.model || null,
    skills: Array.isArray(init?.skills) ? init.skills.map((s) => typeof s === "string" ? s : s?.name).filter(Boolean).slice(0, 20) : [],
    toolCount: Array.isArray(init?.tools) ? init.tools.length : null };
};
function requestMeta(entries) {
  const entry = entries.find((r) => r.path.endsWith("/messages") && r.body), body = entry?.body || {}, all = text(body.messages), system = text(body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const users = text(messages.filter((message) => message.role === "user"));
  const assistants = text(messages.filter((message) => message.role === "assistant"));
  return { model: typeof body.model === "string" ? body.model : null, effort: effort(body), oldContextMarker: users.includes(OLD),
    newContextMarker: users.includes(NEW), priorAssistant: assistants.includes(OK), tools: Array.isArray(body.tools) ? body.tools.length : 0,
    mpHandoffCommand: all.includes("/mp-handoff") || all.includes("<command-name>mp-handoff</command-name>"),
    mpHandoffExpanded: all.includes("# Session Handoff") && all.includes("HANDOFF.md"),
    generatedSkill: system.includes("mp-handoff"), nativeSkill: system.includes("native-fixture-skill") };
}
async function files(rootPath, name, out = []) {
  let entries; try { entries = await readdir(rootPath, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { const p = join(rootPath, e.name); if (e.isDirectory()) await files(p, name, out); else if (e.name === name) out.push(p); }
  return out.slice(0, 4);
}
async function transcript(account) {
  const found = await files(join(account, "claude", "projects"), `${SID}.jsonl`), samples = [];
  for (const path of found) for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (samples.length < 6) samples.push({ type: r.type ?? null, uuid: r.uuid ?? null, parentUuid: r.parentUuid ?? null,
      sessionId: r.sessionId ?? r.session_id ?? null, cwd: r.cwd ?? null, message: { model: r.message?.model ?? null },
      effortKeys: effort(r).map((x) => x.key), version: r.version ?? null });
  }
  return { found: found.length > 0, files: found.map((p) => relative(account, p).replaceAll("\\", "/")), samples };
}
const args = (settings, project) => ["--bare", "--settings", settings, "--setting-sources", "project", "--add-dir", pack, project,
  "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--no-chrome", "--prompt-suggestions", "false",
  "--print", "--output-format", "stream-json", "--verbose"];
async function closeFixture() {
  if (!server) return;
  await new Promise((done) => { const timer = setTimeout(done, 2_000); server.close(() => { clearTimeout(timer); done(); }); server.closeAllConnections?.(); });
}

async function main() {
  const report = { ...PI, probe: "claude-native-compatibility", expectedVersion: VERSION, actualVersion: null, statuses: {}, phases: {},
    transcriptAfterFirst: null, sourceBytesUnchanged: null, unknownSavedEffort: true, exactGap: null, launches: 0 };
  const selected = process.env.MPX_CLAUDE_EXECUTABLE;
  if (!selected || !isAbsolute(selected)) throw new Error("MPX_CLAUDE_EXECUTABLE must be an absolute path");
  const exe = await realpath(selected); if (!(await stat(exe)).isFile()) throw new Error("Claude executable is not a file");
  root = await mkdtemp(join(tmpdir(), "mpx-claude-probe-"));
  const project = join(root, "project"), a = join(root, "account-a"), b = join(root, "account-b");
  await Promise.all([prepare(a), prepare(b)]); await gitInit(project);
  await mkdir(join(project, ".claude", "skills", "native-fixture-skill"), { recursive: true });
  await writeFile(join(project, ".claude", "skills", "native-fixture-skill", "SKILL.md"), "---\nname: native-fixture-skill\ndescription: Disposable catalog fixture.\n---\nNATIVE_SKILL_MARKER\n");
  const before = await readFile(source); server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`, envA = environment(a, base), envB = environment(b, base);
  const version = await run(exe, ["--version"], project, envA), match = version.stdout.match(/\d+\.\d+\.\d+/);
  report.actualVersion = match?.[0] || null; report.statuses.version = report.actualVersion === VERSION && version.code === 0 ? "passed" : "failed";
  report.phases.version = { process: proc(version), executable: basename(exe) };
  if (report.statuses.version !== "passed") {
    report.sourceBytesUnchanged = before.equals(await readFile(source));
    report.exactGap = "required Claude version unavailable"; return report;
  }
  const settings = JSON.stringify({ hooks: {}, enabledPlugins: {} }), common = args(settings, project);
  const launch = async (name, extra, env) => { const start = requests.length, result = await run(exe, [...common, ...extra], project, env);
    const meta = requestMeta(requests.slice(start)), stream = streamMeta(result.stdout); report.phases[name] = { process: proc(result), request: meta, stream }; return { result, meta, stream }; };
  const first = await launch("initial", ["--model", MODEL, "--effort", EFFORT, "--session-id", SID,
    `/mp-handoff ${OLD}; synthetic only; do not use tools; respond only ${OK}.`], envA);
  const firstGood = first.result.code === 0 && first.stream.responseMarker && first.stream.sessionId === SID && first.meta.model === MODEL && first.meta.effort.some((x) => x.value === EFFORT);
  report.statuses.initialBackend = firstGood ? "passed" : "failed";
  report.statuses.skills = (first.meta.generatedSkill || first.stream.skills.includes("mp-handoff")) &&
    (first.meta.nativeSkill || first.stream.skills.includes("native-fixture-skill")) ? "passed" : "failed";
  report.statuses.leadingHandoff = first.meta.mpHandoffCommand && first.meta.mpHandoffExpanded ? "passed" : "failed";
  report.transcriptAfterFirst = await transcript(a);
  if (!firstGood) { report.exactGap = "first loopback backend launch failed; no repair or relaunch attempted"; report.sourceBytesUnchanged = before.equals(await readFile(source)); return report; }
  const naive = await launch("naiveResume", ["--resume", SID, `${NEW}; respond only ${OK}; do not use tools.`], envA);
  const naiveHistory = naive.result.code === 0 && naive.stream.sessionId === SID && naive.stream.responseMarker && naive.meta.oldContextMarker && naive.meta.newContextMarker && naive.meta.priorAssistant;
  const naiveFidelity = naive.meta.model === MODEL && naive.meta.effort.some((x) => String(x.value) === EFFORT);
  report.statuses.exactIdHistoryResume = naiveHistory ? "passed" : "failed";
  report.statuses.naiveModelEffortFidelity = naiveFidelity ? "passed" : "failed";
  const explicit = await launch("explicitResume", ["--resume", SID, "--model", MODEL, "--effort", EFFORT, `EXPLICIT_${NEW}; respond only ${OK}.`], envA);
  report.statuses.explicitSelectionCorrection = explicit.result.code === 0 && explicit.stream.sessionId === SID && explicit.stream.responseMarker && explicit.meta.oldContextMarker && explicit.meta.priorAssistant && explicit.meta.model === MODEL &&
    explicit.meta.effort.some((x) => String(x.value) === EFFORT) ? "passed" : "failed";
  report.phases.explicitResume.explicitSelectionNotSavedEffortEvidence = true;
  const wrong = await launch("wrongConfigRoot", ["--resume", SID, "WRONG_ROOT; respond only fixture text."], envB);
  report.statuses.accountIsolation = wrong.result.code === 1 && !wrong.result.timedOut && !wrong.result.signal && wrong.meta.model === null && /No conversation found with session ID/i.test(wrong.result.stdout + wrong.result.stderr) ? "passed" : "failed";
  report.sourceBytesUnchanged = before.equals(await readFile(source));
  report.statuses.sourceUnchanged = report.sourceBytesUnchanged ? "passed" : "failed";
  report.launches = launches;
  if (!naiveFidelity) report.exactGap = `naive resume used model ${naive.meta.model ?? "unknown"} and effort ${naive.meta.effort.map((x) => x.value).join(",") || "unknown"}; prior effort remains unknown, while explicit selectors are tested separately`;
  else if (Object.values(report.statuses).includes("failed")) report.exactGap = "one or more compatibility checks failed";
  return report;
}

let report;
try { report = await main(); }
catch (e) { report = { ...PI, probe: "claude-native-compatibility", statuses: {}, phases: {}, exactGap: String(e?.message || e).slice(0, 500) }; }
finally {
  try { await closeFixture(); } catch { if (report && !report.exactGap) report.exactGap = "fixture server cleanup failed"; }
  for (const child of children) await killTree(child).catch(() => { if (report && !report.exactGap) report.exactGap = "owned child cleanup failed"; });
  if (root) try { await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
  catch { if (report && !report.exactGap) report.exactGap = "disposable root cleanup failed"; }
}
report.launches = launches;
let output = JSON.stringify(report);
if (Buffer.byteLength(output) > MAX_OUTPUT && report.transcriptAfterFirst?.samples) {
  report.transcriptAfterFirst.samples = report.transcriptAfterFirst.samples.slice(0, 2);
  output = JSON.stringify(report);
}
if (Buffer.byteLength(output) > MAX_OUTPUT) output = JSON.stringify({ ...PI, probe: report.probe, statuses: report.statuses,
  phases: Object.fromEntries(Object.entries(report.phases || {}).map(([k, v]) => [k, { request: v.request, process: v.process }])),
  transcriptAfterFirst: report.transcriptAfterFirst, sourceBytesUnchanged: report.sourceBytesUnchanged,
  unknownSavedEffort: report.unknownSavedEffort, exactGap: `${report.exactGap || ""}; report compacted to 12KB`, launches });
process.stdout.write(`${output}\n`);
if (report.exactGap || Object.values(report.statuses || {}).includes("failed")) process.exitCode = 1;
