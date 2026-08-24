import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  parseResolvedSkillManifestV4,
  parseRuntimeContextV1,
  publishRuntimeArtifact,
  validateRuntimeContext,
  type PublishedRuntimeArtifact,
  type PublishedRuntimeArtifactReference,
  type RuntimeBinding,
  type RuntimeContextV1,
} from "@mpx/runtime-contracts";
import { classifyDangerousCommand, dangerousCommandPolicyModuleSource } from "@mpx/runtime-hooks";
import {
  initialModelContext,
  enumerateSkillDirectory,
  loadSkillBody,
  MAX_SKILL_BODY_BYTES,
  modelSearchSkills,
  verifyRuntimeSkillArtifact,
  type CatalogSkill,
  type LoadedSkillBody,
  type ResolvedManifest,
  type RuntimeSkillArtifact,
} from "@mpx/skills";
import { parseStatusSnapshotV1, renderPiPortSegment, type StatusSnapshotV1 } from "@mpx/status";

export interface PiExtensionAPI {
  registerCommand(name: string, specification: { description?: string; handler(args: string): Promise<void> }): void;
  sendUserMessage(content: readonly { type: "text"; text: string }[]): Promise<unknown>;
}
export interface PiAdapterInput {
  pi: PiExtensionAPI;
  context: RuntimeContextV1;
  manifest: ResolvedManifest;
  artifact: RuntimeSkillArtifact;
  catalog: readonly CatalogSkill[];
  canonicalRoot: string;
  currentBinding: RuntimeBinding;
  expectedLaunch: { launchKey: string; descriptorDigest: string };
}
export interface PiRuntimeAdapter {
  readonly runtime: "pi";
  readonly initialContext: ReturnType<typeof initialModelContext>;
  modelSearch(query: string): ReturnType<typeof modelSearchSkills>;
  loadForModel(identity: string): Promise<LoadedSkillBody>;
}

function restart(diagnostics: readonly { code: string }[]): never {
  throw new Error(`RESTART_REQUIRED: ${diagnostics.map((item) => item.code).join(",")}`);
}
export function renderPiStatusLine(value: unknown, input: { launchBanner: string }): string {
  const snapshot = parseStatusSnapshotV1(value);
  return `${input.launchBanner} | ${renderPiPortSegment(snapshot)}`;
}

export async function createPiRuntimeAdapter(input: PiAdapterInput): Promise<PiRuntimeAdapter> {
  const context = parseRuntimeContextV1(input.context);
  if (context.runtimeArtifact.runtime !== "pi") restart([{ code: "RUNTIME_MISMATCH" }]);
  if (input.artifact.schemaVersion !== 4 || input.artifact.runtime !== "pi" || input.artifact.reference.artifactKey !== context.runtimeArtifact.artifactKey || input.artifact.reference.fileMapHash !== context.runtimeArtifact.fileMapHash) restart([{ code: "ARTIFACT_BINDING_CHANGED" }]);

  const assertBoundSync = (): void => {
    verifyRuntimeSkillArtifact(input.artifact, input.manifest, input.catalog, { runtime: "pi" });
    const rebound = context.launchKey !== input.expectedLaunch.launchKey
      || context.launchDescriptor.digest !== input.expectedLaunch.descriptorDigest
      || context.manifestKey !== input.manifest.manifestKey
      || context.binding.projectId !== input.currentBinding.projectId
      || context.binding.repositoryId !== input.currentBinding.repositoryId
      || context.binding.contentScope !== input.currentBinding.contentScope;
    if (rebound) restart([{ code: "LAUNCH_CONTEXT_CHANGED" }]);
  };
  const assertBound = async (): Promise<void> => {
    assertBoundSync();
    const result = await validateRuntimeContext({ context, expectedLaunch: input.expectedLaunch, expectedManifestKey: input.manifest.manifestKey, expectedRuntimeArtifact: input.artifact.reference, currentBinding: input.currentBinding });
    if (!result.valid) restart(result.diagnostics);
  };
  await assertBound();
  const modelContext = initialModelContext(input.artifact);

  const expand = async (identity: string, invocation: "model" | "human-explicit"): Promise<LoadedSkillBody> => {
    await assertBound();
    return loadSkillBody({ canonicalRoot: input.canonicalRoot, manifest: input.manifest, artifact: input.artifact, runtime: "pi", identity, invocation });
  };

  for (const entry of [...input.artifact.entries].sort((a, b) => a.identity.localeCompare(b.identity))) {
    if (!entry.permissions.humanInvocation) continue;
    if (!entry.publicName.startsWith("/") || entry.publicName.length < 2) restart([{ code: "PUBLIC_NAME_INVALID" }]);
    input.pi.registerCommand(entry.publicName.slice(1), {
      ...(entry.description ? { description: entry.description } : {}),
      handler: async (_args: string) => { const loaded = await expand(entry.identity, "human-explicit"); await input.pi.sendUserMessage([{ type: "text", text: loaded.wrappedBody }]); },
    });
  }

  return {
    runtime: "pi",
    initialContext: modelContext,
    modelSearch: (query) => { assertBoundSync(); return modelSearchSkills(input.artifact, input.catalog, query, { artifactKey: context.runtimeArtifact.artifactKey }); },
    loadForModel: (identity) => expand(identity, "model"),
  };
}

export interface PiProjectionRevalidation { readonly directory: string; readonly reference: PublishedRuntimeArtifactReference }
export interface PiPublishedProjection {
  readonly directory: string; readonly extension: string; readonly runtimeContextFile: string; readonly theme: "green";
  readonly artifactKey: string; readonly reference: PublishedRuntimeArtifactReference; readonly files: readonly string[];
  readonly reused: boolean; readonly revalidation: PiProjectionRevalidation;
}
export interface PiInvocationInput {
  executable: string; accountRoot: string; cwd: string; runtimeContext: RuntimeContextV1; immutableProjectionDirectory?: string; statusSnapshotPath?: string;
  extension?: string; theme?: "green" | "amber"; runtimeContextFile?: string; projection?: PiPublishedProjection; projectionReference?: PublishedRuntimeArtifactReference;
}
export interface PiInvocationPlan { executable: string; cwd: string; args: string[]; env: Record<string, string> }
function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value).replaceAll("\\", "/");
}
export function planPiInvocation(input: PiInvocationInput): PiInvocationPlan {
  const extension = input.projection?.extension ?? input.extension;
  const runtimeContextFile = input.projection?.runtimeContextFile ?? input.runtimeContextFile;
  const theme = input.projection?.theme ?? input.theme;
  if (!extension || !runtimeContextFile || !theme) throw new Error("validated Pi projection is required");
  if (input.projection && (input.projection.revalidation.directory !== input.projection.directory || input.projection.revalidation.reference.projectionKey !== input.projection.reference.projectionKey)) throw new Error("Pi projection revalidation binding is invalid");
  const context = parseRuntimeContextV1(input.runtimeContext);
  return {
    executable: absolute(input.executable, "trusted executable"), cwd: absolute(input.cwd, "cwd"),
    args: ["--no-extensions", "--extension", absolute(extension, "immutable extension"), "--no-skills", "--theme", theme],
    env: { PI_CODING_AGENT_DIR: absolute(input.accountRoot, "native account root"), MPX_RUNTIME: "pi", MPX_RUNTIME_CONTEXT: JSON.stringify(context), MPX_RUNTIME_CONTEXT_FILE: absolute(runtimeContextFile, "runtime context"), ...(input.statusSnapshotPath ? { MPX_STATUS_SNAPSHOT_FILE: absolute(input.statusSnapshotPath, "status snapshot") } : {}), ...((input.projection?.reference ?? input.projectionReference) ? { MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(input.projection?.reference ?? input.projectionReference) } : {}) },
  };
}

export const piSettings = {
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }, terminal: { showTerminalProgress: true },
  tuiMode: "fullscreen", fullscreenScrollbar: "always", theme: "green", enableSkillCommands: false,
  steeringMode: "all", followUpMode: "all", treeFilterMode: "no-tools", doubleEscapeAction: "tree", defaultProjectTrust: "ask",
} as const;
export const piKeybindings = { "app.model.select": "alt+p", "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [], "tui.altScreen.halfPageUp": "pageUp", "tui.altScreen.halfPageDown": "pageDown" } as const;
export function createPiProjection() {
  return {
    settings: piSettings, keybindings: piKeybindings,
    themes: [{ name: "green", status: "active" }, { name: "amber", status: "retained" }] as const,
    adapters: ["compact", "guard", "auto-title", "fullscreen", "footer"] as const,
    subagents: { enabled: false, nestedOrchestration: false, fleetView: false, provenance: "projection/imported provenance only: vendor/subagents/VENDORED.md" },
    accountProfiles: { kind: "projection-only", mutation: "unsupported" },
    unsupported: ["agent-resurrect/session G", "F2 host replacement", "installer/account symlinks", "credential projection"],
  } as const;
}
export interface PiProjectionBuildInput {
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly catalog: readonly CatalogSkill[];
  readonly canonicalRoot: string;
  readonly context: RuntimeContextV1;
  readonly expectedLaunch: { readonly launchKey: string; readonly descriptorDigest: string };
  readonly currentBinding: RuntimeBinding;
  readonly artifactsRoot: string;
  readonly statusSnapshot: StatusSnapshotV1;
  readonly launchBanner: string;
  readonly assetsRoot?: string;
  readonly vendorProvenanceFile?: string;
  readonly artifactRevalidator?: Parameters<typeof publishRuntimeArtifact>[0]["revalidate"];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function jsonFile(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function digest(value: unknown): string { return createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : stable(value)).digest("hex"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function regularText(file: string, label: string): Promise<string> {
  const stat = await lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFile(file, "utf8");
}
async function emit(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: "utf8", flag: "wx" });
}
function piExtensionSource(descriptor: {
  manifestKey: string; artifactKey: string; launchBanner: string; statusSnapshot: string; commandAllowlist: string[]; modelSearchAllowlist: string[];
  entries: Array<{ identity: string; publicName: string; exposure: "full" | "name-only" | "explicit-only" | "off"; contentHash: string; sourcePath: string; commandDescription?: string; canonicalDescription?: string; canonicalTriggers?: string }>;
}): string {
  const data = JSON.stringify(descriptor);
  return [
    'import { createHash } from "node:crypto";',
    'import { lstat, open, opendir, realpath } from "node:fs/promises";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const root = path.dirname(fileURLToPath(import.meta.url));',
    `const projection = ${data};`,
    'function digest(value) { return createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : stable(value)).digest("hex"); }',
    'function stable(value) { if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }',
    'function same(left, right) { return stable(left) === stable(right); }',
    'function restart(code) { throw new Error(`RESTART_REQUIRED: ${code}`); }',
    'function within(rootPath, candidate) { const relative = path.relative(rootPath, candidate); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }',
    'function disclosure() { const lines = projection.entries.filter((entry) => projection.modelSearchAllowlist.includes(entry.identity)).map((entry) => entry.exposure === "full" ? `- ${entry.publicName}: ${entry.canonicalDescription}${entry.canonicalTriggers ? ` (triggers: ${entry.canonicalTriggers})` : ""}` : `- ${entry.publicName}`); return lines.length === 0 ? "" : "\\n\\nMPX skills:\\n" + lines.join("\\n"); }',
    'function score(entry, query) { if (query.length === 0) return 1; const haystack = `${entry.identity} ${entry.canonicalDescription ?? ""} ${entry.canonicalTriggers ?? ""}`.toLowerCase(); if (!haystack.includes(query)) return 0; return entry.identity.toLowerCase().includes(query) ? 3 : 1; }',
    'const MAX_CONTEXT_BYTES = 1024 * 1024, MAX_METADATA_BYTES = 4 * 1024 * 1024, MAX_STATUS_BYTES = 1024 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_AGGREGATE_BYTES = 256 * 1024 * 1024, MAX_FILES = 10000, MAX_DIRECTORIES = 10000, MAX_DEPTH = 64;',
    'async function readBounded(file, maximum, code) { let handle; try { handle=await open(file,"r"); const opened=await handle.stat({bigint:true}), named=await lstat(file,{bigint:true}); if(!opened.isFile()||!named.isFile()||named.isSymbolicLink()||opened.dev!==named.dev||opened.ino!==named.ino||opened.size>BigInt(maximum))restart(code); const size=Number(opened.size),bytes=Buffer.alloc(size);let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(read.bytesRead===0)restart(code);offset+=read.bytesRead;}if((await handle.read(Buffer.alloc(1),0,1,size)).bytesRead!==0)restart(code);const finalOpened=await handle.stat({bigint:true}),finalNamed=await lstat(file,{bigint:true});if(!finalOpened.isFile()||!finalNamed.isFile()||finalNamed.isSymbolicLink()||finalOpened.dev!==opened.dev||finalOpened.ino!==opened.ino||finalNamed.dev!==opened.dev||finalNamed.ino!==opened.ino||finalOpened.size!==opened.size||finalNamed.size!==opened.size||finalOpened.mtimeNs!==opened.mtimeNs||finalOpened.ctimeNs!==opened.ctimeNs||finalNamed.mtimeNs!==named.mtimeNs||finalNamed.ctimeNs!==named.ctimeNs)restart(code);return bytes;}catch{restart(code);}finally{await handle?.close().catch(()=>{});} }',
    'async function readJson(file, code, maximum = MAX_CONTEXT_BYTES) { const text = (await readBounded(file, maximum, code)).toString("utf8"); try { return JSON.parse(text); } catch { restart(code); } }',
    'function expectedProjectionReference(fileMap, reference) { const fileMapHash = digest(fileMap); const projectionKey = digest({ schemaVersion: 1, launchBinding: reference.launchBinding, fileMapHash }); return { projectionKey, launchBinding: reference.launchBinding, fileMapHash }; }',
    'async function validateContext() { const file = await readJson(path.join(root, "runtime-context.json"), "LAUNCH_CONTEXT_CHANGED"); let env; try { env = JSON.parse(process.env.MPX_RUNTIME_CONTEXT ?? "null"); } catch { restart("LAUNCH_CONTEXT_CHANGED"); } if (!same(file, env) || file?.runtimeArtifact?.runtime !== "pi" || file?.launchKey !== env?.launchKey || file?.launchDescriptor?.digest !== env?.launchDescriptor?.digest || file?.manifestKey !== projection.manifestKey || !same(file?.runtimeArtifact, env?.runtimeArtifact) || !same(file?.binding, env?.binding)) restart("LAUNCH_CONTEXT_CHANGED"); return file; }',
    'const metadataControl = /[\\0-\\x1F\\x7F-\\x9F]/u, windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$/iu; function metadataText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && !metadataControl.test(value); } function portableFile(value) { if (!metadataText(value,4096) || value.includes("\\\\") || path.posix.isAbsolute(value)) return false; const parts=value.split("/"); return parts.length<=MAX_DEPTH && parts.every((part)=>part.length>0&&part!=="."&&part!==".."&&part.length<=255&&!/[<>:\"|?*]/u.test(part)&&!/[. ]$/u.test(part)&&!windowsReserved.test(part)); }',
    'async function validateReference() { let expected; try { expected = JSON.parse(process.env.MPX_RUNTIME_PROJECTION_REFERENCE ?? "null"); } catch { restart("ARTIFACT_BINDING_CHANGED"); } const referenceKeys=["projectionKey","launchBinding","fileMapHash"], bindingKeys=["launchKey","descriptorDigest","runtimeArtifactKey","runtime","manifestKey"]; if(!exact(expected,referenceKeys)||!exact(expected.launchBinding,bindingKeys)||!/^[a-f0-9]{64}$/u.test(expected.projectionKey)||!/^[a-f0-9]{64}$/u.test(expected.fileMapHash)||!metadataText(expected.launchBinding.launchKey,256)||!metadataText(expected.launchBinding.descriptorDigest,256)||!metadataText(expected.launchBinding.runtimeArtifactKey,256)||expected.launchBinding.runtime!=="pi"||!metadataText(expected.launchBinding.manifestKey,256)||expected.launchBinding.runtimeArtifactKey!==projection.artifactKey) restart("ARTIFACT_BINDING_CHANGED"); const metadata = await readJson(path.join(root, ".mpx-runtime-artifact.json"), "ARTIFACT_BINDING_CHANGED", MAX_METADATA_BYTES); if(!exact(metadata,["schemaVersion","reference","fileMap"])||metadata.schemaVersion!==1||!exact(metadata.reference,referenceKeys)||!exact(metadata.reference.launchBinding,bindingKeys)||!same(metadata.reference,expected)||!Array.isArray(metadata.fileMap)||metadata.fileMap.length>MAX_FILES) restart("ARTIFACT_BINDING_CHANGED"); let aggregate=0, previous=""; const paths=new Set(), expectedDirectories=new Set([""]); const fileMap=[]; for(const entry of metadata.fileMap){const identity=typeof entry?.path==="string"?entry.path.toLowerCase():"";if(!exact(entry,["path","sha256","bytes"])||!portableFile(entry.path)||entry.path===".mpx-runtime-artifact.json"||paths.has(identity)||(previous&&previous>=entry.path)||!/^[a-f0-9]{64}$/u.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>MAX_FILE_BYTES)restart("ARTIFACT_BINDING_CHANGED"); paths.add(identity);previous=entry.path;aggregate+=entry.bytes; if(!Number.isSafeInteger(aggregate)||aggregate>MAX_AGGREGATE_BYTES)restart("ARTIFACT_BINDING_CHANGED"); const parts=entry.path.split("/"); for(let index=1;index<parts.length;index++)expectedDirectories.add(parts.slice(0,index).join("/")); fileMap.push({path:entry.path,sha256:entry.sha256,bytes:entry.bytes});} if(expectedDirectories.size>MAX_DIRECTORIES)restart("ARTIFACT_BINDING_CHANGED"); if(!same(expectedProjectionReference(fileMap,metadata.reference),metadata.reference))restart("ARTIFACT_BINDING_CHANGED"); return { reference: expected, fileMap, expectedDirectories }; }',
    'async function hashExpected(file, expected) { let handle; try { handle=await open(file,"r"); const opened=await handle.stat(), named=await lstat(file), resolved=await realpath(file); if(!opened.isFile()||!named.isFile()||named.isSymbolicLink()||opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==expected.bytes||!within(root,resolved))restart("ARTIFACT_FILE_MAP_CHANGED"); const hash=createHash("sha256"), buffer=Buffer.alloc(Math.min(64*1024,Math.max(1,expected.bytes))); let offset=0; while(offset<expected.bytes){const read=await handle.read(buffer,0,Math.min(buffer.length,expected.bytes-offset),offset);if(read.bytesRead===0)restart("ARTIFACT_FILE_MAP_CHANGED");hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;} if((await handle.read(buffer,0,1,expected.bytes)).bytesRead!==0)restart("ARTIFACT_FILE_MAP_CHANGED"); const finalNamed=await lstat(file); if(finalNamed.dev!==opened.dev||finalNamed.ino!==opened.ino||hash.digest("hex")!==expected.sha256)restart("ARTIFACT_FILE_MAP_CHANGED"); } catch(error){if(error?.message?.startsWith("RESTART_REQUIRED:"))throw error;restart("ARTIFACT_FILE_MAP_CHANGED");} finally{await handle?.close().catch(()=>{});} }',
    'async function validateProjection() { const metadata=await validateReference(), expectedFiles=new Map(metadata.fileMap.map((entry)=>[entry.path,entry])), seenFiles=new Set(), seenDirectories=new Set([""]), pending=[""]; while(pending.length){const relativeDirectory=pending.pop(), depth=relativeDirectory===""?0:relativeDirectory.split("/").length;if(depth>MAX_DEPTH||seenDirectories.size>MAX_DIRECTORIES)restart("ARTIFACT_FILE_MAP_CHANGED"); const directory=path.join(root,...(relativeDirectory?relativeDirectory.split("/"):[])); let stream;try{stream=await opendir(directory);}catch{restart("ARTIFACT_FILE_MAP_CHANGED");} try{for await(const item of stream){const relative=relativeDirectory?`${relativeDirectory}/${item.name}`:item.name;if(relative===".mpx-runtime-artifact.json")continue;const absolute=path.join(directory,item.name);let stat;try{stat=await lstat(absolute);}catch{restart("ARTIFACT_FILE_MAP_CHANGED");}if(stat.isSymbolicLink())restart("ARTIFACT_SYMLINK");if(stat.isDirectory()){if(!metadata.expectedDirectories.has(relative)||seenDirectories.has(relative))restart("ARTIFACT_FILE_MAP_CHANGED");seenDirectories.add(relative);pending.push(relative);}else if(stat.isFile()){const expected=expectedFiles.get(relative);if(!expected||seenFiles.has(relative))restart("ARTIFACT_FILE_MAP_CHANGED");seenFiles.add(relative);await hashExpected(absolute,expected);}else restart("ARTIFACT_SPECIAL_FILE");}}catch(error){if(error?.message?.startsWith("RESTART_REQUIRED:"))throw error;restart("ARTIFACT_FILE_MAP_CHANGED");}} if(seenFiles.size!==expectedFiles.size||seenDirectories.size!==metadata.expectedDirectories.size)restart("ARTIFACT_FILE_MAP_CHANGED"); }',
    'async function ensureBound() { await validateContext(); return validateReference(); }',
    'async function ensureExpected(relative) { const metadata=await ensureBound(), expected=metadata.fileMap.find((entry)=>entry.path===relative); if(!expected)restart("ARTIFACT_FILE_MAP_CHANGED"); await hashExpected(path.join(root,...relative.split("/")),expected); }',
    'async function ensureSkill(identity) { const metadata=await ensureBound(), prefix=`skills/${identity}/`, selected=metadata.fileMap.filter((entry)=>entry.path.startsWith(prefix));if(!selected.length)restart("SKILL_BODY_INVALID");try{for(const expected of selected)await hashExpected(path.join(root,...expected.path.split("/")),expected);}catch{restart("SKILL_BODY_INVALID");} }',
    'async function ensureFresh() { await validateContext(); await validateProjection(); }',
    'const statusControl = /[\\0-\\x1F\\x7F-\\x9F]/u; const statusId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u; function safeText(value, maximum) { return typeof value === "string" && value.length <= maximum && !statusControl.test(value); } function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join(); }',
    'function parseStatus(x) { if (!exact(x, ["schemaVersion","project","worktree","portResolution","services","diagnostics"]) || x.schemaVersion !== 1 || !exact(x.project,["id","cwd"]) || !safeText(x.project.id,256) || !safeText(x.project.cwd,4096) || !exact(x.worktree,["id","path","role","branch"]) || !(x.worktree.id===null||safeText(x.worktree.id,256)) || !(x.worktree.path===null||safeText(x.worktree.path,4096)) || !(x.worktree.branch===null||safeText(x.worktree.branch,512)) || ![null,"main","linked"].includes(x.worktree.role) || !["valid","missing","invalid","stale"].includes(x.portResolution) || !Array.isArray(x.services) || x.services.length>256 || !Array.isArray(x.diagnostics) || x.diagnostics.length>256) restart("STATUS_SNAPSHOT_INVALID"); const ids=new Set(); for(const s of x.services){if(!exact(s,["id","mode","scope","protocol","port","listening","conflict","pid"])||!statusId.test(s.id)||ids.has(s.id)||!["managed","fixed-shared"].includes(s.mode)||!["checkout","project"].includes(s.scope)||!["http","https","tcp"].includes(s.protocol)||!(s.port===null||Number.isInteger(s.port)&&s.port>=1&&s.port<=65535)||typeof s.listening!=="boolean"||!["none","external","unknown"].includes(s.conflict)||!(s.pid===null||Number.isSafeInteger(s.pid)&&s.pid>=1))restart("STATUS_SNAPSHOT_INVALID");ids.add(s.id)} for(const d of x.diagnostics)if(!exact(d,["code","severity","message","serviceId"])||!statusId.test(d.code)||!["info","warning","error"].includes(d.severity)||!safeText(d.message,1024)||!(d.serviceId===null||statusId.test(d.serviceId)))restart("STATUS_SNAPSHOT_INVALID"); return x; }',
    'async function readStatusBytes(file) { let handle;try{handle=await open(file,"r");const opened=await handle.stat({bigint:true}),named=await lstat(file,{bigint:true});if(!opened.isFile()||!named.isFile()||named.isSymbolicLink()||opened.size>BigInt(MAX_STATUS_BYTES)||named.size>BigInt(MAX_STATUS_BYTES))restart("STATUS_SNAPSHOT_INVALID");const size=Number(opened.size),bytes=Buffer.alloc(size);let offset=0;while(offset<size){const read=await handle.read(bytes,offset,size-offset,offset);if(read.bytesRead===0)restart("STATUS_SNAPSHOT_INVALID");offset+=read.bytesRead;}if((await handle.read(Buffer.alloc(1),0,1,size)).bytesRead!==0)restart("STATUS_SNAPSHOT_INVALID");return bytes;}catch{restart("STATUS_SNAPSHOT_INVALID");}finally{await handle?.close().catch(()=>{});} }',
    'async function readStatusSnapshot(file) { const opened=await readStatusBytes(file),named=await readStatusBytes(file);if(!opened.equals(named))restart("STATUS_SNAPSHOT_INVALID");let value;try{value=JSON.parse(named.toString("utf8"));}catch{restart("STATUS_SNAPSHOT_INVALID");}return parseStatus(value); }',
    'function ports(x) { if (x.portResolution !== "valid") return `ports ${x.portResolution}`; if (!x.services.length) return "ports none"; return "ports " + [...x.services].sort((a,b) => a.id.localeCompare(b.id)).map((s) => `${s.id}:${s.port ?? "?"}${s.conflict === "external" ? "!" : s.conflict === "unknown" ? "?" : s.listening ? "*" : ""}`).join(" "); }',
    'let statusRefresh, statusGeneration=0, statusStopped=true; async function refreshStatus(ctx,generation) { if(statusRefresh)return statusRefresh; const refresh=(async()=>{const file=process.env.MPX_STATUS_SNAPSHOT_FILE??path.join(root,projection.statusSnapshot);const snapshot=await readStatusSnapshot(file);if(statusStopped||generation!==statusGeneration)return;ctx.ui.setStatus("mpx",`${projection.launchBanner} | ${ports(snapshot)}`);})();const tracked=refresh.finally(()=>{if(statusRefresh===tracked)statusRefresh=undefined;});statusRefresh=tracked;return tracked; }',
    'async function body(identity, invocation) { await ensureSkill(identity); const entry = projection.entries.find((item) => item.identity === identity); if (!entry) restart("RUNTIME_ARTIFACT_TAMPERED"); const file = path.join(root, "skills", identity, "body.md"); let handle; try { handle = await open(file, "r"); const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) restart("SKILL_BODY_INVALID"); const resolved = await realpath(file).catch(() => restart("SKILL_BODY_INVALID")); const namedStat = await lstat(file).catch(() => restart("SKILL_BODY_INVALID")); if (!within(root, resolved) || !namedStat.isFile() || namedStat.isSymbolicLink() || namedStat.dev !== stat.dev || namedStat.ino !== stat.ino || namedStat.size !== stat.size) restart("ARTIFACT_ESCAPE"); const bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) restart("SKILL_BODY_INVALID"); offset += read.bytesRead; } if ((await handle.read(Buffer.alloc(1), 0, 1, stat.size)).bytesRead !== 0) restart("SKILL_BODY_INVALID"); const finalStat = await handle.stat(), finalNamedStat = await lstat(file); if (!finalStat.isFile() || finalStat.isSymbolicLink() || !finalNamedStat.isFile() || finalNamedStat.isSymbolicLink() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalNamedStat.dev !== stat.dev || finalNamedStat.ino !== stat.ino || finalStat.size !== stat.size || finalNamedStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs || finalNamedStat.mtimeMs !== namedStat.mtimeMs || finalNamedStat.ctimeMs !== namedStat.ctimeMs || digest(bytes) !== entry.contentHash) restart("SKILL_BODY_INVALID"); const body = parseProjectedBody(bytes); const contentHash = entry.contentHash; return { identity, body, wrappedBody: `<!-- mpx-skill identity=${identity} origin=${invocation} runtime=pi artifact=${projection.artifactKey} hash=${contentHash} -->\n${body}<!-- /mpx-skill -->`, provenance: { artifactKey: projection.artifactKey, contentHash, invocation, runtime: "pi", sourcePath: entry.sourcePath } }; } catch { restart("SKILL_BODY_INVALID"); } finally { await handle?.close().catch(() => {}); } }',
    'function parseProjectedBody(bytes) { const text = bytes.toString("utf8").replaceAll("\\r\\n", "\\n"); if (!text.startsWith("---\\n")) restart("SKILL_BODY_INVALID"); const end = text.indexOf("\\n---\\n", 4); if (end < 0) restart("SKILL_BODY_INVALID"); return text.slice(end + 5); }',
    'function modelEntries() { return projection.entries.filter((entry) => projection.modelSearchAllowlist.includes(entry.identity)); }',
    'function search(query) { const value = String(query ?? "").trim().toLowerCase(); if (value.length > 200) throw new Error("QUERY_TOO_LONG"); return modelEntries().map((entry) => ({ ...entry, score: score(entry, value) })).filter((entry) => value.length === 0 || entry.score > 0).sort((left, right) => right.score - left.score || left.identity.localeCompare(right.identity)).slice(0, 20).map(({ identity, publicName, canonicalDescription, canonicalTriggers, score }) => ({ identity, publicName, description: canonicalDescription ?? `mpx skill ${identity}`, ...(canonicalTriggers ? { triggers: canonicalTriggers } : {}), score })); }',
    'export async function activate(pi) { await ensureFresh(); for (const name of projection.commandAllowlist) { const entry = projection.entries.find((item) => item.publicName.slice(1) === name); pi.registerCommand(name, { ...(entry?.commandDescription ? { description: entry.commandDescription } : {}), handler: async (_args) => { const loaded = await body(entry.identity, "human-explicit"); await pi.sendUserMessage([{ type: "text", text: loaded.wrappedBody }]); } }); } if (typeof pi.registerTool === "function") { pi.registerTool({ name: "mpx_model_search", label: "MPX search", description: "Search available skills.", parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", description: "Search query." } }, required: ["query"] }, async execute(_toolCallId, params) { await ensureBound(); const results = search(params?.query); return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } }; } }); pi.registerTool({ name: "mpx_model_load", label: "MPX load", description: "Load one available skill.", parameters: { type: "object", additionalProperties: false, properties: { identity: { type: "string", description: "Skill identifier." } }, required: ["identity"] }, async execute(_toolCallId, params) { const identity = String(params?.identity ?? ""); if (!projection.modelSearchAllowlist.includes(identity)) throw new Error("SKILL_INVOCATION_DENIED"); const loaded = await body(identity, "model"); return { content: [{ type: "text", text: loaded.wrappedBody }], details: { identity: loaded.identity, provenance: loaded.provenance } }; } }); } if (typeof pi.on === "function") { let statusContext, statusTimer; pi.on("tool_call", async (event) => { if (event?.toolName !== "bash") return; await ensureExpected("dangerous-command-policy.mjs"); const {classifyDangerousCommand}=await import("./dangerous-command-policy.mjs"); const decision = classifyDangerousCommand(event?.input?.command); if (decision.action === "block") return { block: true, reason: `${decision.code}: ${decision.message}` }; }); pi.on("before_agent_start", async (event) => { await ensureBound(); if (statusContext) await refreshStatus(statusContext,statusGeneration); return { systemPrompt: `${String(event?.systemPrompt ?? "")}${disclosure()}` }; }); pi.on("session_start", async (_event, ctx) => { const generation=++statusGeneration;statusStopped=false;statusContext=ctx;await ensureFresh();if(statusStopped||generation!==statusGeneration)return;if(statusTimer){clearInterval(statusTimer);statusTimer=undefined;}const previous=statusRefresh;if(previous)await previous.catch(()=>{});if(statusStopped||generation!==statusGeneration)return;await refreshStatus(ctx,generation);if(statusStopped||generation!==statusGeneration)return;statusTimer=setInterval(() => { void refreshStatus(ctx,generation).catch(() => {if(!statusStopped&&generation===statusGeneration)ctx.ui.setStatus("mpx", `${projection.launchBanner} | ports invalid`);}); }, 1000); statusTimer.unref?.(); }); pi.on("session_shutdown", async () => { statusStopped=true;++statusGeneration;statusContext=undefined;if(statusTimer){clearInterval(statusTimer);statusTimer=undefined;}const pending=statusRefresh;if(pending)await pending.catch(()=>{}); }); } }',
    'export async function modelSearch(query) { await ensureBound(); return search(query); }',
    'export default activate;',
    '',
  ].join('\n');
}
async function realDirectoryRoot(directory: string, label: string): Promise<string> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real non-symlink directory`);
  return realpath(directory);
}
function containsRealPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function copyGeneratedAssets(staging: string, assetsRoot: string, provenanceFile: string): Promise<void> {
  const verifiedAssetsRoot = await realDirectoryRoot(assetsRoot, "Pi generated assets root");
  const agentsRoot = path.join(verifiedAssetsRoot, "agents");
  const themesRoot = path.join(verifiedAssetsRoot, "themes");
  const verifiedAgentsRoot = await realDirectoryRoot(agentsRoot, "Pi generated agents root");
  const verifiedThemesRoot = await realDirectoryRoot(themesRoot, "Pi generated themes root");
  for (const entry of (await readdir(verifiedAgentsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^mpx-[a-z0-9-]+\.md$/u.test(entry.name)) continue;
    const file = path.join(verifiedAgentsRoot, entry.name);
    const resolved = await realpath(file);
    if (!containsRealPath(verifiedAgentsRoot, resolved)) throw new Error("generated agent escapes its verified root");
    const content = await regularText(file, "generated agent");
    if (!content.startsWith("---\n") || !content.includes(`\nname: ${entry.name.slice(0, -3)}\n`)) throw new Error(`invalid generated agent ${entry.name}`);
    await emit(staging, `agents/${entry.name}`, content.replaceAll("\r\n", "\n"));
  }
  for (const theme of ["amber", "green"] as const) {
    const file = path.join(verifiedThemesRoot, `${theme}.json`);
    const resolved = await realpath(file);
    if (!containsRealPath(verifiedThemesRoot, resolved)) throw new Error("generated theme escapes its verified root");
    const content = await regularText(file, "Pi theme");
    await emit(staging, `themes/${theme}.json`, `${JSON.stringify(JSON.parse(content), null, 2)}\n`);
  }
  await emit(staging, "vendor/subagents/VENDORED.md", (await regularText(provenanceFile, "vendor provenance")).replaceAll("\r\n", "\n"));
  await emit(staging, "vendor/subagents/LICENSE", (await regularText(path.join(path.dirname(provenanceFile), "LICENSE"), "vendor license")).replaceAll("\r\n", "\n"));
}
async function validatedSkillBytes(skill: CatalogSkill, loaded: LoadedSkillBody): Promise<Buffer> {
  let handle;
  try {
    handle = await open(skill.sourcePath, "r");
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(skill.sourcePath, { bigint: true });
    const resolved = await realpath(skill.sourcePath);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
      || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.size !== named.size || opened.size > BigInt(MAX_SKILL_BODY_BYTES)
      || !sameFilesystemPath(resolved, skill.realPath)) throw new Error("identity mismatch");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error("short read");
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw new Error("file grew");
    const finalOpened = await handle.stat({ bigint: true });
    const finalNamed = await lstat(skill.sourcePath, { bigint: true });
    if (!finalOpened.isFile() || !finalNamed.isFile() || finalNamed.isSymbolicLink()
      || finalOpened.dev !== opened.dev || finalOpened.ino !== opened.ino
      || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
      || finalOpened.size !== opened.size || finalNamed.size !== opened.size
      || finalOpened.mtimeNs !== opened.mtimeNs || finalOpened.ctimeNs !== opened.ctimeNs
      || finalNamed.mtimeNs !== named.mtimeNs || finalNamed.ctimeNs !== named.ctimeNs
      || digest(bytes) !== loaded.provenance.contentHash) throw new Error("content mismatch");
    return bytes;
  } catch {
    throw new Error(`SKILL_CONTENT_STALE: skill '${skill.identity}' changed during Pi projection`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

function freezeProjection(published: PublishedRuntimeArtifact): PiPublishedProjection {
  const reference = Object.freeze({ ...published.reference });
  const directory = path.resolve(published.directory);
  return Object.freeze({
    directory, extension: path.join(directory, "extension.mjs"), runtimeContextFile: path.join(directory, "runtime-context.json"), theme: "green" as const,
    artifactKey: reference.launchBinding.runtimeArtifactKey, reference, files: Object.freeze(published.fileMap.map((file) => file.path)), reused: published.reused,
    revalidation: Object.freeze({ directory, reference }),
  });
}

export async function buildPiProjection(input: PiProjectionBuildInput): Promise<PiPublishedProjection> {
  const manifest = parseResolvedSkillManifestV4(input.manifest);
  const context = parseRuntimeContextV1(input.context);
  const statusSnapshot = parseStatusSnapshotV1(input.statusSnapshot);
  verifyRuntimeSkillArtifact(input.artifact, manifest, input.catalog, { runtime: "pi" });
  if (input.artifact.schemaVersion !== 4 || input.artifact.runtime !== "pi" || input.artifact.manifestKey !== manifest.manifestKey || input.artifact.reference.artifactKey !== context.runtimeArtifact.artifactKey) throw new Error("Pi projection requires its exact v4 Pi artifact and runtime context");
  const validation = await validateRuntimeContext({ context, expectedLaunch: input.expectedLaunch, expectedManifestKey: manifest.manifestKey, expectedRuntimeArtifact: input.artifact.reference, currentBinding: input.currentBinding });
  if (!validation.valid) restart(validation.diagnostics);
  const catalog = new Map(input.catalog.map((skill) => [skill.identity, skill]));
  const entries: Array<{ identity: string; publicName: string; exposure: "full" | "name-only" | "explicit-only" | "off"; contentHash: string; sourcePath: string; commandDescription?: string; canonicalDescription?: string; canonicalTriggers?: string }> = [];
  const bodies = new Map<string, Buffer>();
  for (const entry of [...input.artifact.entries].sort((a, b) => a.identity.localeCompare(b.identity))) {
    const skill = catalog.get(entry.identity);
    if (!skill) throw new Error(`STALE_CATALOG: missing ${entry.identity}`);
    const invocation = entry.permissions.modelInvocation ? "model" : "human-explicit";
    const loaded = await loadSkillBody({ canonicalRoot: input.canonicalRoot, manifest, artifact: input.artifact, runtime: "pi", identity: entry.identity, invocation });
    bodies.set(entry.identity, await validatedSkillBytes(skill, loaded));
    const triggers = "triggers" in skill ? skill.triggers : undefined;
    entries.push({ identity: entry.identity, publicName: entry.publicName, exposure: entry.exposure, contentHash: loaded.provenance.contentHash, sourcePath: loaded.provenance.sourcePath, ...(entry.permissions.humanInvocation ? { commandDescription: skill.description } : {}), ...(entry.permissions.modelInvocation ? { canonicalDescription: skill.description, ...(triggers ? { canonicalTriggers: triggers } : {}) } : {}) });
  }
  const commandAllowlist = input.artifact.entries.filter((entry) => entry.permissions.humanInvocation).map((entry) => entry.publicName.slice(1)).sort();
  const modelSearchAllowlist = input.artifact.entries.filter((entry) => entry.permissions.modelInvocation).map((entry) => entry.identity).sort();
  const descriptor = { schemaVersion: 1, runtime: "pi", manifestKey: manifest.manifestKey, runtimeArtifact: input.artifact.reference, runtimeContext: "runtime-context.json", extension: "extension.mjs", commandAllowlist, modelSearchAllowlist, settings: "settings.json", keybindings: "keybindings.json", themes: ["green", "amber"], agents: "agents", vendorProvenance: "vendor/subagents/VENDORED.md", statusSnapshot: "status/status-snapshot.json", entries };
  await mkdir(input.artifactsRoot, { recursive: true });
  const staging = await mkdtemp(path.join(input.artifactsRoot, ".pi-build-"));
  try {
    await emit(staging, "projection.json", jsonFile(descriptor));
    await emit(staging, "runtime-context.json", jsonFile(context));
    await emit(staging, "extension.mjs", piExtensionSource({ manifestKey: manifest.manifestKey, artifactKey: input.artifact.reference.artifactKey, launchBanner: input.launchBanner, statusSnapshot: "status/status-snapshot.json", commandAllowlist, modelSearchAllowlist, entries }));
    await emit(staging, "dangerous-command-policy.mjs", `${dangerousCommandPolicyModuleSource}\n`);
    await emit(staging, "status/status-snapshot.json", jsonFile(statusSnapshot));
    await emit(staging, "settings.json", jsonFile(piSettings));
    await emit(staging, "keybindings.json", jsonFile(piKeybindings));
    for (const [identity, body] of bodies) {
      await emit(staging, `skills/${identity}/body.md`, body);
      const skill = catalog.get(identity)!;
      for (const support of await enumerateSkillDirectory(path.dirname(skill.sourcePath))) if (support.relativePath !== "SKILL.md") await emit(staging, `skills/${identity}/${support.relativePath}`, support.bytes);
    }
    await copyGeneratedAssets(staging, input.assetsRoot ?? path.join(packageRoot, "projection"), input.vendorProvenanceFile ?? path.join(packageRoot, "vendor", "subagents", "VENDORED.md"));
    const launchBinding = { launchKey: context.launchKey, descriptorDigest: context.launchDescriptor.digest, runtimeArtifactKey: input.artifact.reference.artifactKey, runtime: "pi" as const, manifestKey: manifest.manifestKey };
    const published = await publishRuntimeArtifact({ sourceRoot: staging, artifactsRoot: input.artifactsRoot, launchBinding, ...(input.artifactRevalidator ? { revalidate: input.artifactRevalidator } : {}) });
    return freezeProjection(published);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function createPiRuntimeProjection(input: PiProjectionBuildInput): Promise<PiPublishedProjection> { return buildPiProjection(input); }

export function guardPiCommand(command: string) { return classifyDangerousCommand(command); }

export interface PiFooterPortAdapter { current(): string; refresh(): Promise<void> }
export function createPiFooterPortAdapter(snapshot: () => Promise<unknown>): PiFooterPortAdapter {
  let rendered = "";
  return { current: () => rendered, refresh: async () => { rendered = renderPiPortSegment(await snapshot()); } };
}

export interface AgentMapping { model: string; tools: readonly string[] }
export interface GeneratePiAgentsInput { source: string; output: string; mappings: Readonly<Record<string, AgentMapping>>; check?: boolean }
function adaptAgent(source: string, mapping: AgentMapping): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || marker < 0) throw new Error("canonical agent must have frontmatter");
  return `${normalized.slice(0, marker)}\nmodel: ${mapping.model}\ntools: ${mapping.tools.join(",")}\n${normalized.slice(marker)}`;
}
export async function generatePiAgents(input: GeneratePiAgentsInput): Promise<{ changed: string[]; drift: string[] }> {
  const names = (await readdir(input.source)).filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name)).sort();
  const changed: string[] = []; const drift: string[] = [];
  if (!input.check) await mkdir(input.output, { recursive: true });
  const generated = new Set(names);
  const extras = (await readdir(input.output).catch(() => [] as string[])).filter((name) => /^mpx-[a-z0-9-]+\.md$/u.test(name) && !generated.has(name)).sort();
  if (input.check) drift.push(...extras); else for (const extra of extras) { await rm(path.join(input.output, extra)); changed.push(extra); }
  for (const name of names) {
    const identity = name.slice(0, -3); const mapping = input.mappings[identity];
    if (!mapping) throw new Error(`missing Pi mapping for ${identity}`);
    const expected = adaptAgent(await readFile(path.join(input.source, name), "utf8"), mapping);
    const target = path.join(input.output, name); const actual = await readFile(target, "utf8").catch(() => undefined);
    if (actual === expected) continue;
    if (input.check) drift.push(name); else { await writeFile(target, expected); changed.push(name); }
  }
  return { changed: changed.sort(), drift: drift.sort() };
}
