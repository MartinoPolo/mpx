import path from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseNativeSessionRefV1,
  parseRuntimeCapabilityManifestV1,
  parseRuntimeContextV1,
  publishRuntimeArtifact,
  validateRuntimeContext,
  validateSessionLifecycleBindingV1,
  type NativeSessionRefV1,
  type PublishedRuntimeArtifact,
  type PublishedRuntimeArtifactReference,
  type RuntimeBinding,
  type RuntimeCapabilityManifestV1,
  type RuntimeContextV1,
} from '@mpx/runtime-contracts';
import { classifyDangerousCommand, dangerousCommandPolicyModuleSource } from '@mpx/runtime-hooks';
import { RUNTIME_TOOL_NAMES } from '@mpx/runtime-tools';
import {
  MAX_SKILL_SEARCH_QUERY_LENGTH,
  MAX_SKILL_SEARCH_RESULTS,
  loadSkillProjectionBody,
  modelSearchSkillProjection,
  rankSearchCandidatesSource,
  verifySkillProjectionPlan,
  type LoadedSkillBody,
  type SkillProjectionPlan,
} from '@mpx/skills';
import {
  parseRuntimeStatusEnvelopeV1,
  parseStatusSnapshotV1,
  renderPiPortSegment,
  type RuntimeStatusEnvelopeV1,
  type StatusSnapshotV1,
} from '@mpx/status';
import type { GeneratePiAgentsInput } from './agent-generator.js';
import { bundledSource } from './projection-bundle-source.js';
import { parsePiRuntimeProfileV1, profileSettings, type PiRuntimeProfileV1 } from './profile.js';
import { emitProductionBundles } from './projection-bundles.js';
import { renderPiRuntimeStatus } from './runtime-status.js';

export * from './profile.js';
export * from './runtime-capabilities.js';
export * from './runtime-status.js';
export * from './dev-services.js';
export * from './hooks-wiring.js';
export * from './subagent-bridge.js';
export * from './event-coordination.js';
export * from './runtime-tools.js';
export * from './production-runtime.js';
export * from './sandbox-executor.js';
export * from './launch-private-client.js';

export interface PiExtensionAPI {
  registerCommand(
    name: string,
    specification: { description?: string; handler(args: string): Promise<void> },
  ): void;
  sendUserMessage(content: readonly { type: 'text'; text: string }[]): Promise<unknown>;
}
export interface PiAdapterInput {
  pi: PiExtensionAPI;
  context: RuntimeContextV1;
  skillPlan: SkillProjectionPlan;
  currentBinding: RuntimeBinding;
  expectedLaunch: { launchKey: string; descriptorDigest: string };
}
export interface PiRuntimeAdapter {
  readonly runtime: 'pi';
  readonly initialContext: SkillProjectionPlan['initialModelContext'];
  modelSearch(query: string): ReturnType<typeof modelSearchSkillProjection>;
  loadForModel(identity: string): Promise<LoadedSkillBody>;
}

function restart(diagnostics: readonly { code: string }[]): never {
  throw new Error(`RESTART_REQUIRED: ${diagnostics.map((item) => item.code).join(',')}`);
}
export function renderPiStatusLine(value: unknown, input: { launchBanner: string }): string {
  const snapshot = parseStatusSnapshotV1(value);
  return `${input.launchBanner} | ${renderPiPortSegment(snapshot)}`;
}

export async function createPiRuntimeAdapter(input: PiAdapterInput): Promise<PiRuntimeAdapter> {
  const skillPlan = verifySkillProjectionPlan(input.skillPlan);
  const context = parseRuntimeContextV1(input.context);
  if (context.runtimeArtifact.runtime !== 'pi' || skillPlan.runtime !== 'pi') {
    restart([{ code: 'RUNTIME_MISMATCH' }]);
  }
  if (
    skillPlan.artifactReference.artifactKey !== context.runtimeArtifact.artifactKey ||
    skillPlan.artifactReference.fileMapHash !== context.runtimeArtifact.fileMapHash
  ) {
    restart([{ code: 'ARTIFACT_BINDING_CHANGED' }]);
  }

  const assertBoundSync = (): void => {
    verifySkillProjectionPlan(skillPlan);
    const rebound =
      context.launchKey !== input.expectedLaunch.launchKey ||
      context.launchDescriptor.digest !== input.expectedLaunch.descriptorDigest ||
      context.manifestKey !== skillPlan.manifestKey ||
      context.binding.projectId !== input.currentBinding.projectId ||
      context.binding.repositoryId !== input.currentBinding.repositoryId ||
      context.binding.contentScope !== input.currentBinding.contentScope;
    if (rebound) {
      restart([{ code: 'LAUNCH_CONTEXT_CHANGED' }]);
    }
  };
  const assertBound = async (): Promise<void> => {
    assertBoundSync();
    const result = await validateRuntimeContext({
      context,
      expectedLaunch: input.expectedLaunch,
      expectedManifestKey: skillPlan.manifestKey,
      expectedRuntimeArtifact: skillPlan.artifactReference,
      currentBinding: input.currentBinding,
    });
    if (!result.valid) {
      restart(result.diagnostics);
    }
  };
  await assertBound();

  const expand = async (
    identity: string,
    invocation: 'model' | 'human-explicit',
  ): Promise<LoadedSkillBody> => {
    await assertBound();
    return loadSkillProjectionBody(skillPlan, { identity, invocation });
  };

  for (const entry of skillPlan.entries) {
    if (!entry.permissions.humanInvocation) {
      continue;
    }
    if (!entry.publicName.startsWith('/') || entry.publicName.length < 2) {
      restart([{ code: 'PUBLIC_NAME_INVALID' }]);
    }
    input.pi.registerCommand(entry.publicName.slice(1), {
      ...(entry.humanContext?.description ? { description: entry.humanContext.description } : {}),
      handler: async (_args: string) => {
        const loaded = await expand(entry.identity, 'human-explicit');
        await input.pi.sendUserMessage([{ type: 'text', text: loaded.wrappedBody }]);
      },
    });
  }

  return {
    runtime: 'pi',
    initialContext: skillPlan.initialModelContext,
    modelSearch: (query) => {
      assertBoundSync();
      return modelSearchSkillProjection(skillPlan, query, {
        artifactKey: context.runtimeArtifact.artifactKey,
      });
    },
    loadForModel: (identity) => expand(identity, 'model'),
  };
}

export interface PiProjectionRevalidation {
  readonly directory: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly profile: PiRuntimeProfileV1;
}
export interface PiPublishedProjection {
  readonly directory: string;
  readonly extension: string;
  readonly runtimeContextFile: string;
  readonly profile: PiRuntimeProfileV1;
  readonly theme: 'dark';
  readonly artifactKey: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly files: readonly string[];
  readonly reused: boolean;
  readonly revalidation: PiProjectionRevalidation;
}
export interface PiLaunchPrivateBridgeConfig {
  readonly schemaVersion: 1;
  readonly endpoint: string;
  readonly nonce: string;
  readonly launchKey: string;
  readonly identity: { readonly name: string; readonly domain: 'personal' | 'work' };
  readonly planKey: string;
  readonly runtimeToolInventorySha256: string;
  readonly capabilitySha256: string;
}
export interface PiInvocationInput {
  executable: string;
  accountRoot: string;
  cwd: string;
  runtimeContext: RuntimeContextV1;
  immutableProjectionDirectory?: string;
  statusSnapshotPath?: string;
  runtimeStatusEnvelopePath?: string;
  bridge?: PiLaunchPrivateBridgeConfig;
  extension?: string;
  profile?: PiRuntimeProfileV1;
  theme?: 'dark' | 'green' | 'amber';
  runtimeContextFile?: string;
  projection?: PiPublishedProjection;
  projectionReference?: PublishedRuntimeArtifactReference;
  lifecycle?: { readonly eventDirectory: string; readonly binding: unknown };
  resumeTarget?: VerifiedPiResumeTarget;
}
const verifiedPiResumeTargetBrand: unique symbol = Symbol('VerifiedPiResumeTarget');
export interface VerifiedPiResumeTarget {
  readonly file: string;
  readonly [verifiedPiResumeTargetBrand]: true;
}
export type PiResumeTargetErrorCode =
  'PI_RESUME_TARGET_INVALID' | 'PI_RESUME_TARGET_INSPECTION_UNAVAILABLE';
export class PiResumeTargetError extends Error {
  constructor(readonly code: PiResumeTargetErrorCode) {
    super(
      code === 'PI_RESUME_TARGET_INVALID'
        ? 'Pi resume target is invalid.'
        : 'Pi resume target inspection is unavailable.',
    );
  }
}
function resumeTargetFailure(failure: unknown): PiResumeTargetError {
  const code = (failure as NodeJS.ErrnoException)?.code;
  return new PiResumeTargetError(
    code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
      ? 'PI_RESUME_TARGET_INVALID'
      : 'PI_RESUME_TARGET_INSPECTION_UNAVAILABLE',
  );
}
const verifiedPiResumeTargets = new WeakMap<
  object,
  { readonly accountRoot: string; readonly file: string }
>();
export async function verifyPiResumeTarget(
  accountRootInput: string,
  referenceInput: NativeSessionRefV1,
): Promise<VerifiedPiResumeTarget> {
  let accountRoot: string, reference: NativeSessionRefV1;
  try {
    accountRoot = absolute(accountRootInput, 'native account root');
    reference = parseNativeSessionRefV1(referenceInput);
  } catch {
    throw new PiResumeTargetError('PI_RESUME_TARGET_INVALID');
  }
  if (reference.kind !== 'root-relative-file') {
    throw new PiResumeTargetError('PI_RESUME_TARGET_INVALID');
  }
  let rootStat;
  try {
    rootStat = await lstat(accountRoot);
  } catch (failure) {
    throw resumeTargetFailure(failure);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PiResumeTargetError('PI_RESUME_TARGET_INVALID');
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(accountRoot);
  } catch (failure) {
    throw resumeTargetFailure(failure);
  }
  const candidate = path.join(canonicalRoot, ...reference.value.split('/'));
  let handle;
  try {
    handle = await open(candidate, 'r');
    const opened = await handle.stat(),
      named = await lstat(candidate),
      resolved = await realpath(candidate);
    const relative = path.relative(canonicalRoot, resolved);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new PiResumeTargetError('PI_RESUME_TARGET_INVALID');
    }
    const target: VerifiedPiResumeTarget = Object.freeze({
      file: path.normalize(resolved).replaceAll('\\', '/'),
      [verifiedPiResumeTargetBrand]: true as const,
    });
    verifiedPiResumeTargets.set(target, { accountRoot, file: target.file });
    return target;
  } catch (failure) {
    if (failure instanceof PiResumeTargetError) {
      throw failure;
    }
    throw resumeTargetFailure(failure);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
export interface PiInvocationPlan {
  executable: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
}
function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value).replaceAll('\\', '/');
}
function loadPublishedPiProfile(
  directoryInput: string | undefined,
): PiRuntimeProfileV1 | undefined {
  if (!directoryInput) {
    return undefined;
  }
  const directory = absolute(directoryInput, 'immutable projection directory');
  const file = path.join(directory, 'runtime-profile.json');
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      return parsePiRuntimeProfileV1(undefined);
    }
    return parsePiRuntimeProfileV1(JSON.parse(readFileSync(file, 'utf8')));
  } catch (failure) {
    if ((failure as { code?: unknown }).code === 'PI_RUNTIME_PROFILE_INVALID') {
      throw failure;
    }
    return parsePiRuntimeProfileV1(undefined);
  }
}

export function planPiInvocation(input: PiInvocationInput): PiInvocationPlan {
  const extension = input.projection?.extension ?? input.extension;
  const runtimeContextFile = input.projection?.runtimeContextFile ?? input.runtimeContextFile;
  const profileInput = input.projection?.profile ?? input.profile;
  const profile = profileInput
    ? parsePiRuntimeProfileV1(profileInput)
    : loadPublishedPiProfile(input.immutableProjectionDirectory);
  const theme = profile?.theme ?? input.projection?.theme ?? input.theme;
  if (!extension || !runtimeContextFile || !theme) {
    throw new Error('validated Pi projection is required');
  }
  if (
    input.projection &&
    (input.projection.revalidation.directory !== input.projection.directory ||
      input.projection.revalidation.reference.projectionKey !==
        input.projection.reference.projectionKey ||
      JSON.stringify(input.projection.revalidation.profile) !== JSON.stringify(profile))
  ) {
    throw new Error('Pi projection revalidation binding is invalid');
  }
  const context = parseRuntimeContextV1(input.runtimeContext);
  const accountRoot = absolute(input.accountRoot, 'native account root');
  let resumeFile: string | undefined;
  if (input.resumeTarget) {
    const verified = verifiedPiResumeTargets.get(input.resumeTarget as object);
    if (!verified) {
      throw new Error('Pi resume target must be verified by this module');
    }
    if (verified.accountRoot !== accountRoot) {
      throw new Error('Pi resume target belongs to a different account root');
    }
    resumeFile = verified.file;
  }
  const lifecycle = input.lifecycle,
    projectionReference = input.projection?.reference ?? input.projectionReference;
  if (input.bridge) {
    const bridge = input.bridge as unknown as Record<string, unknown>,
      keys = [
        'schemaVersion',
        'endpoint',
        'nonce',
        'launchKey',
        'identity',
        'planKey',
        'runtimeToolInventorySha256',
        'capabilitySha256',
      ];
    const identity = bridge.identity as Record<string, unknown> | undefined;
    if (
      Object.keys(bridge).sort().join(',') !== keys.sort().join(',') ||
      bridge.schemaVersion !== 1 ||
      bridge.launchKey !== context.launchKey ||
      typeof bridge.endpoint !== 'string' ||
      !/^tcp:\/\/127\.0\.0\.1:\d{1,5}$/u.test(bridge.endpoint) ||
      ![
        bridge.nonce,
        bridge.planKey,
        bridge.runtimeToolInventorySha256,
        bridge.capabilitySha256,
      ].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) ||
      !identity ||
      Object.keys(identity).sort().join(',') !== 'domain,name'
    ) {
      throw new Error('launch-private Pi bridge binding is invalid');
    }
  }
  const lifecycleBinding = lifecycle
    ? validateSessionLifecycleBindingV1({
        binding: lifecycle.binding,
        context,
        runtime: 'pi',
        ...(projectionReference ? { projectionReference } : {}),
      })
    : undefined;
  return {
    executable: absolute(input.executable, 'trusted executable'),
    cwd: absolute(input.cwd, 'cwd'),
    args: [
      '--no-extensions',
      '--extension',
      absolute(extension, 'immutable extension'),
      '--no-skills',
      ...(profile
        ? [
            '--provider',
            profile.provider,
            '--model',
            profile.model,
            '--thinking',
            profile.thinking,
            '--tui-mode',
            profile.tuiMode,
          ]
        : []),
      '--theme',
      theme,
      ...(resumeFile ? ['--session', resumeFile] : []),
    ],
    env: {
      PI_CODING_AGENT_DIR: accountRoot,
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(context),
      MPX_RUNTIME_CONTEXT_FILE: absolute(runtimeContextFile, 'runtime context'),
      ...(input.statusSnapshotPath
        ? { MPX_STATUS_SNAPSHOT_FILE: absolute(input.statusSnapshotPath, 'status snapshot') }
        : {}),
      ...(input.runtimeStatusEnvelopePath
        ? {
            MPX_RUNTIME_STATUS_ENVELOPE_FILE: absolute(
              input.runtimeStatusEnvelopePath,
              'runtime status envelope',
            ),
          }
        : {}),
      ...(projectionReference
        ? { MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projectionReference) }
        : {}),
      ...(input.bridge ? { MPX_PI_LAUNCH_PRIVATE_BRIDGE: JSON.stringify(input.bridge) } : {}),
      ...(lifecycle && lifecycleBinding
        ? {
            MPX_SESSION_LIFECYCLE_EVENT_DIR: absolute(
              lifecycle.eventDirectory,
              'lifecycle event directory',
            ),
            MPX_SESSION_LIFECYCLE_BINDING_ID: lifecycleBinding.bindingId,
          }
        : {}),
    },
  };
}

export function createPiProjection(piProfile: PiRuntimeProfileV1) {
  const parsedProfile = parsePiRuntimeProfileV1(piProfile);
  return {
    profile: parsedProfile,
    settings: profileSettings(parsedProfile),
    keybindings: parsedProfile.keybindings,
    themes: [
      { name: 'dark', status: 'active' },
      { name: 'green', status: 'identity-canvas' },
      { name: 'amber', status: 'identity-canvas' },
    ] as const,
    adapters: ['compact', 'guard', 'auto-title', 'fullscreen', 'events', 'footer'] as const,
    subagents: {
      enabled: true,
      nestedOrchestration: true,
      fleetView: true,
      provenance: 'projection/imported provenance only: vendor/subagents/VENDORED.md',
    },
    accountProfiles: { kind: 'projection-only', mutation: 'unsupported' },
    runtimeTools: { aggregates: RUNTIME_TOOL_NAMES, selection: 'launch-bound' },
    unsupported: [
      'agent-resurrect/session G',
      'installer/account symlinks',
      'credential projection',
      'live sbx/auth attestation',
    ],
  } as const;
}
export interface PiProjectionBuildInput {
  readonly skillPlan: SkillProjectionPlan;
  readonly modelMappings: GeneratePiAgentsInput['modelMappings'];
  readonly context: RuntimeContextV1;
  readonly expectedLaunch: { readonly launchKey: string; readonly descriptorDigest: string };
  readonly currentBinding: RuntimeBinding;
  readonly artifactsRoot: string;
  readonly statusSnapshot: StatusSnapshotV1;
  readonly runtimeStatusEnvelope?: RuntimeStatusEnvelopeV1;
  readonly runtimeCapabilityManifest?: RuntimeCapabilityManifestV1;
  readonly piRuntimeProfile: PiRuntimeProfileV1;
  readonly runtimeLaunchBinding?: {
    readonly launchKey: string;
    readonly runtime: 'pi';
    readonly identity: { readonly name: string; readonly domain: string };
    readonly worktreeRoot: string;
    readonly assignedPorts: readonly number[];
    readonly services?: Readonly<Record<string, import('@mpx/dev-services').StartRequest>>;
    readonly executor: 'host' | 'docker';
  };
  readonly launchBanner: string;
  readonly assetsRoot?: string;
  readonly vendorProvenanceFile?: string;
  readonly artifactRevalidator?: Parameters<typeof publishRuntimeArtifact>[0]['revalidate'];
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
async function regularText(file: string, label: string): Promise<string> {
  const stat = await lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return readFile(file, 'utf8');
}
async function emit(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
}
function piExtensionSource(descriptor: {
  manifestKey: string;
  artifactKey: string;
  launchBanner: string;
  runtimeStatusLine: string;
  commandAllowlist: string[];
  modelSearchAllowlist: string[];
  productionCapability?: RuntimeCapabilityManifestV1;
  productionLaunch?: {
    launchKey: string;
    runtime: 'pi';
    identity: { name: string; domain: string };
    worktreeRoot: string;
    assignedPorts: readonly number[];
    services?: Readonly<Record<string, import('@mpx/dev-services').StartRequest>>;
    executor: 'host' | 'docker';
  };
  entries: Array<{
    identity: string;
    publicName: string;
    exposure: 'full' | 'name-only' | 'explicit-only' | 'off';
    contentHash: string;
    sourcePath: string;
    commandDescription?: string;
    canonicalDescription?: string;
    canonicalTriggers?: string;
  }>;
}): string {
  const data = JSON.stringify(descriptor);
  return [
    'import { execFile } from "node:child_process";',
    'import { createHash, randomUUID } from "node:crypto";',
    'import { lstat, open, opendir, realpath, rename, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { createProjectionSubagentRuntime, projectionRuntimePolicies } from "./production-subagents.mjs";',
    'import { parseRuntimeStatusEnvelopeV1 } from "./production-status.mjs";',
    'import { activatePiProductionRuntime } from "./production-runtime.mjs";',
    'import { createLaunchPrivateRemoteExecutor, parseLaunchPrivateClientConfig } from "./launch-private-client.mjs";',
    'const root = path.dirname(fileURLToPath(import.meta.url));',
    `const projection = ${data};`,
    'function digest(value) { return createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : stable(value)).digest("hex"); }',
    'function stable(value) { if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }',
    'function same(left, right) { return stable(left) === stable(right); }',
    'function restart(code) { throw new Error(`RESTART_REQUIRED: ${code}`); }',
    'function within(rootPath, candidate) { const relative = path.relative(rootPath, candidate); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }',
    'function disclosure() { const lines = projection.entries.filter((entry) => projection.modelSearchAllowlist.includes(entry.identity)).map((entry) => entry.exposure === "full" ? `- ${entry.publicName}: ${entry.canonicalDescription}${entry.canonicalTriggers ? ` (triggers: ${entry.canonicalTriggers})` : ""}` : `- ${entry.publicName}`); return lines.length === 0 ? "" : "\\n\\nMPX skills:\\n" + lines.join("\\n"); }',
    `const rankSearchCandidates = ${rankSearchCandidatesSource};`,
    'const MAX_CONTEXT_BYTES = 1024 * 1024, MAX_METADATA_BYTES = 4 * 1024 * 1024, MAX_STATUS_BYTES = 1024 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_AGGREGATE_BYTES = 256 * 1024 * 1024, MAX_FILES = 10000, MAX_DIRECTORIES = 10000, MAX_DEPTH = 64;',
    'async function readBounded(file, maximum, code) { let handle; try { handle=await open(file,"r"); const opened=await handle.stat({bigint:true}), named=await lstat(file,{bigint:true}); if(!opened.isFile()||!named.isFile()||named.isSymbolicLink()||opened.dev!==named.dev||opened.ino!==named.ino||opened.size>BigInt(maximum))restart(code); const size=Number(opened.size),bytes=Buffer.alloc(size);let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(read.bytesRead===0)restart(code);offset+=read.bytesRead;}if((await handle.read(Buffer.alloc(1),0,1,size)).bytesRead!==0)restart(code);const finalOpened=await handle.stat({bigint:true}),finalNamed=await lstat(file,{bigint:true});if(!finalOpened.isFile()||!finalNamed.isFile()||finalNamed.isSymbolicLink()||finalOpened.dev!==opened.dev||finalOpened.ino!==opened.ino||finalNamed.dev!==opened.dev||finalNamed.ino!==opened.ino||finalOpened.size!==opened.size||finalNamed.size!==opened.size||finalOpened.mtimeNs!==opened.mtimeNs||finalOpened.ctimeNs!==opened.ctimeNs||finalNamed.mtimeNs!==named.mtimeNs||finalNamed.ctimeNs!==named.ctimeNs)restart(code);return bytes;}catch{restart(code);}finally{await handle?.close().catch(()=>{});} }',
    'async function readJson(file, code, maximum = MAX_CONTEXT_BYTES) { const text = (await readBounded(file, maximum, code)).toString("utf8"); try { return JSON.parse(text); } catch { restart(code); } }',
    'function expectedProjectionReference(fileMap, reference) { const fileMapHash = digest(fileMap); const projectionKey = digest({ schemaVersion: 1, launchBinding: reference.launchBinding, fileMapHash }); return { projectionKey, launchBinding: reference.launchBinding, fileMapHash }; }',
    'async function validateContext() { const file = await readJson(path.join(root, "runtime-context.json"), "LAUNCH_CONTEXT_CHANGED"); let env; try { env = JSON.parse(process.env.MPX_RUNTIME_CONTEXT ?? "null"); } catch { restart("LAUNCH_CONTEXT_CHANGED"); } if (!same(file, env) || file?.runtimeArtifact?.runtime !== "pi" || file?.launchKey !== env?.launchKey || file?.launchDescriptor?.digest !== env?.launchDescriptor?.digest || file?.manifestKey !== projection.manifestKey || !same(file?.runtimeArtifact, env?.runtimeArtifact) || !same(file?.binding, env?.binding)) restart("LAUNCH_CONTEXT_CHANGED"); return file; }',
    'const metadataControl = /[\\0-\\x1F\\x7F-\\x9F]/u, windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$/iu; function metadataText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && !metadataControl.test(value); } function portableFile(value) { if (!metadataText(value,4096) || value.includes("\\\\") || path.posix.isAbsolute(value)) return false; const parts=value.split("/"); return parts.length<=MAX_DEPTH && parts.every((part)=>part.length>0&&part!=="."&&part!==".."&&part.length<=255&&!/[<>:"|?*]/u.test(part)&&!/[. ]$/u.test(part)&&!windowsReserved.test(part)); }',
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
    'let statusRefresh, statusGeneration=0, statusStopped=true; async function refreshStatus(ctx,generation) { if(statusRefresh)return statusRefresh; const refresh=Promise.resolve().then(async()=>{if(statusStopped||generation!==statusGeneration)return;await refreshProductionStatus(ctx);});const tracked=refresh.finally(()=>{if(statusRefresh===tracked)statusRefresh=undefined;});statusRefresh=tracked;return tracked; }',
    'let lifecycleSequence=0,lifecycleOwner=randomUUID(),lifecycleQueue=Promise.resolve(),lifecycleCaptured=false,lifecycleStopped=false,selfProcessFingerprint;const lifecycleControl=/[\\u0000-\\u001f\\u007f-\\u009f]/u,lifecycleId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u,canonicalWindowsTimestamp=/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{7}Z$/u;function lifecycleText(value,max){return typeof value==="string"&&value.length>0&&value.length<=max&&!lifecycleControl.test(value)?value:null;}function lifecycleContext(event,ctx){return ctx?.sessionManager?ctx:event?.sessionManager?event:event?.context?.sessionManager?event.context:ctx??event?.context;}function getSelfProcessFingerprint(){if(selfProcessFingerprint)return selfProcessFingerprint;selfProcessFingerprint=(async()=>{if(process.platform!=="win32")return "unavailable:windows-process-start";const systemRoot=process.env.SystemRoot??process.env.SYSTEMROOT;if(!systemRoot||!path.isAbsolute(systemRoot))return "unavailable:windows-process-start";const executable=path.join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),script=\'$pidValue=[int]$env:MPX_PID_VALUE; $process=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop; if($null -eq $process -or $process.ProcessId -ne $pidValue -or $null -eq $process.CreationDate){exit 2}; $process.CreationDate.ToUniversalTime().ToString("o")\';try{const output=await new Promise((resolve,reject)=>execFile(executable,["-NoLogo","-NoProfile","-NonInteractive","-Command",script],{env:{SystemRoot:systemRoot,MPX_PID_VALUE:String(process.pid)},shell:false,windowsHide:true,timeout:5000,maxBuffer:65536,encoding:"utf8"},(error,stdout)=>error?reject(error):resolve(stdout)));const value=String(output).trim();return canonicalWindowsTimestamp.test(value)?value:"unavailable:windows-process-start";}catch{return "unavailable:windows-process-start";}})();return selfProcessFingerprint;}async function emitLifecycle(type,ctx,required){const directory=process.env.MPX_SESSION_LIFECYCLE_EVENT_DIR,bindingId=process.env.MPX_SESSION_LIFECYCLE_BINDING_ID;if(directory===undefined&&bindingId===undefined)return false;if(!directory||!path.isAbsolute(directory)||!lifecycleId.test(bindingId??""))restart("LIFECYCLE_BINDING_INVALID");const directoryStat=await lstat(directory).catch(()=>restart("LIFECYCLE_EVENT_DIRECTORY_INVALID"));if(directoryStat.isSymbolicLink()||!directoryStat.isDirectory())restart("LIFECYCLE_EVENT_DIRECTORY_INVALID");const realDirectory=await realpath(directory).catch(()=>restart("LIFECYCLE_EVENT_DIRECTORY_INVALID"));if(path.resolve(realDirectory)!==path.resolve(directory))restart("LIFECYCLE_EVENT_DIRECTORY_INVALID");const manager=ctx?.sessionManager,nativeId=manager?.getSessionId?.(),nativeFile=manager?.getSessionFile?.(),cwd=ctx?.cwd,hasNativeId=nativeId!==undefined&&nativeId!==null,hasNativeFile=nativeFile!==undefined&&nativeFile!==null;if(!hasNativeId||!hasNativeFile){if(required&&(hasNativeId||hasNativeFile))restart("LIFECYCLE_METADATA_INVALID");return false;}if(!lifecycleId.test(nativeId)||!lifecycleText(nativeFile,4096)||!path.isAbsolute(nativeFile)||!lifecycleText(cwd,4096))restart("LIFECYCLE_METADATA_INVALID");const accountRoot=process.env.PI_CODING_AGENT_DIR;if(!accountRoot||!path.isAbsolute(accountRoot))restart("LIFECYCLE_METADATA_INVALID");const rootStat=await lstat(accountRoot).catch(()=>restart("LIFECYCLE_METADATA_INVALID"));if(rootStat.isSymbolicLink()||!rootStat.isDirectory())restart("LIFECYCLE_METADATA_INVALID");const canonicalRoot=await realpath(accountRoot);if(!within(canonicalRoot,path.resolve(nativeFile)))restart("LIFECYCLE_SESSION_ESCAPE");let fileStat;try{fileStat=await lstat(nativeFile)}catch(error){if(!required&&error?.code==="ENOENT")return false;restart("LIFECYCLE_METADATA_INVALID")} if(fileStat.isSymbolicLink()||!fileStat.isFile())restart("LIFECYCLE_METADATA_INVALID");const canonicalFile=await realpath(nativeFile),relative=path.relative(canonicalRoot,canonicalFile).split(path.sep).join("/");if(!portableFile(relative))restart("LIFECYCLE_SESSION_ESCAPE");const title=lifecycleText(manager?.getSessionName?.()??ctx?.sessionName,512),model=lifecycleText(ctx?.model?.id??ctx?.model?.name,128),sequence=++lifecycleSequence,timestamp=new Date().toISOString(),eventId=digest({bindingId,type,sequence,timestamp,pid:process.pid}),event={schemaVersion:1,eventId,bindingId,type,sequence,timestamp,nativeSessionId:nativeId,nativeSessionRef:{kind:"root-relative-file",value:relative},cwd,title,model,effort:null,pid:process.pid,startFingerprint:await getSelfProcessFingerprint()};const target=path.join(directory,`${String(sequence).padStart(12,"0")}-${eventId}.json`),temporary=target+`.tmp-${lifecycleOwner}`;try{await writeFile(temporary,JSON.stringify(event)+"\\n",{flag:"wx"});await rename(temporary,target)}catch{restart("LIFECYCLE_EVENT_WRITE_FAILED");}return true;}function queueLifecycle(type,ctx,required,integrity,captureOnce=false,activeOnly=false){const operation=lifecycleQueue.then(async()=>{if(activeOnly&&lifecycleStopped)return false;if(integrity)await integrity();if(captureOnce&&lifecycleCaptured)return false;const emitted=await emitLifecycle(type,ctx,required);if(captureOnce&&emitted)lifecycleCaptured=true;return emitted;});lifecycleQueue=operation.catch(()=>{});return operation;}',
    'async function body(identity, invocation) { await ensureSkill(identity); const entry = projection.entries.find((item) => item.identity === identity); if (!entry) restart("RUNTIME_ARTIFACT_TAMPERED"); const file = path.join(root, "skills", identity, "body.md"); let handle; try { handle = await open(file, "r"); const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) restart("SKILL_BODY_INVALID"); const resolved = await realpath(file).catch(() => restart("SKILL_BODY_INVALID")); const namedStat = await lstat(file).catch(() => restart("SKILL_BODY_INVALID")); if (!within(root, resolved) || !namedStat.isFile() || namedStat.isSymbolicLink() || namedStat.dev !== stat.dev || namedStat.ino !== stat.ino || namedStat.size !== stat.size) restart("ARTIFACT_ESCAPE"); const bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) restart("SKILL_BODY_INVALID"); offset += read.bytesRead; } if ((await handle.read(Buffer.alloc(1), 0, 1, stat.size)).bytesRead !== 0) restart("SKILL_BODY_INVALID"); const finalStat = await handle.stat(), finalNamedStat = await lstat(file); if (!finalStat.isFile() || finalStat.isSymbolicLink() || !finalNamedStat.isFile() || finalNamedStat.isSymbolicLink() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalNamedStat.dev !== stat.dev || finalNamedStat.ino !== stat.ino || finalStat.size !== stat.size || finalNamedStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs || finalNamedStat.mtimeMs !== namedStat.mtimeMs || finalNamedStat.ctimeMs !== namedStat.ctimeMs || digest(bytes) !== entry.contentHash) restart("SKILL_BODY_INVALID"); const body = parseProjectedBody(bytes); const contentHash = entry.contentHash; return { identity, body, wrappedBody: `<!-- mpx-skill identity=${identity} origin=${invocation} runtime=pi artifact=${projection.artifactKey} hash=${contentHash} -->\n${body}<!-- /mpx-skill -->`, provenance: { artifactKey: projection.artifactKey, contentHash, invocation, runtime: "pi", sourcePath: entry.sourcePath } }; } catch { restart("SKILL_BODY_INVALID"); } finally { await handle?.close().catch(() => {}); } }',
    'function parseProjectedBody(bytes) { const text = bytes.toString("utf8").replaceAll("\\r\\n", "\\n"); if (!text.startsWith("---\\n")) restart("SKILL_BODY_INVALID"); const end = text.indexOf("\\n---\\n", 4); if (end < 0) restart("SKILL_BODY_INVALID"); return text.slice(end + 5); }',
    'function modelEntries() { return projection.entries.filter((entry) => projection.modelSearchAllowlist.includes(entry.identity)); }',
    `function search(query) { const value = String(query ?? ""); if (value.length > ${MAX_SKILL_SEARCH_QUERY_LENGTH}) throw new Error("QUERY_TOO_LONG"); return rankSearchCandidates(modelEntries().map((entry) => ({ identity: entry.identity, publicName: entry.publicName, description: entry.canonicalDescription ?? "", ...(entry.canonicalTriggers ? { triggers: entry.canonicalTriggers } : {}) })), value, undefined, ${MAX_SKILL_SEARCH_RESULTS}); }`,
    'let productionSubagents; let productionStatusTimer;',
    'const productionOutput=(value,details=value)=>({content:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value)}],details});',
    'function productionStatus(value){const parts=[];if(value?.identity?.label)parts.push(value.identity.label);if(value?.model?.label||value?.model?.modelId)parts.push(value.model.label??value.model.modelId);if(value?.repository?.name)parts.push(`${value.repository.name}${value.repository.branch?`@${value.repository.branch}`:""}`);const freshness=["identity","session","model","location","repository","usage","cost","providerUsage","compactions","subagents","development","actions"].map(name=>value?.[name]?.state).filter(state=>state==="stale"||state==="error");if(freshness.length)parts.push([...new Set(freshness)].join("/"));return parts.join(" · ")||projection.runtimeStatusLine;}',
    'async function refreshProductionStatus(ctx){const file=process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE;if(!file){ctx?.ui?.setStatus?.("mpx",projection.runtimeStatusLine);return;}try{const value=parseRuntimeStatusEnvelopeV1(await readJson(file,"RUNTIME_STATUS_INVALID",MAX_STATUS_BYTES));const context=await validateContext();if(value?.binding?.launchKey!==context.launchKey||value?.binding?.repositoryId!==context.binding.repositoryId||value?.harness?.kind!=="pi")restart("RUNTIME_STATUS_BINDING_CHANGED");ctx?.ui?.setStatus?.("mpx",productionStatus(value));}catch(error){ctx?.ui?.setStatus?.("mpx",`${projection.runtimeStatusLine} · error`);}}',
    'async function activateProduction(pi){if(typeof pi.registerTool!=="function")return;let adapters=pi.mpxRuntimeAdapters;if(projection.productionCapability?.executor==="docker"){const bridge=parseLaunchPrivateClientConfig(process.env.MPX_PI_LAUNCH_PRIVATE_BRIDGE,{launchKey:projection.productionLaunch?.launchKey,identity:projection.productionLaunch?.identity,capabilitySha256:projection.productionCapability.manifestKey});adapters={mcpRoutes:{},providers:[],remoteExecutor:createLaunchPrivateRemoteExecutor(bridge)};pi.mpxRuntimeAdapters=adapters;}else if(projection.productionCapability?.executor==="host"){adapters={mcpRoutes:{},providers:[],hostApproved:true};pi.mpxRuntimeAdapters=adapters;}productionSubagents=createProjectionSubagentRuntime(projection.productionCapability,adapters?.remoteExecutor);const register=(name,description,execute)=>pi.registerTool({name,label:name,description,parameters:{type:"object",additionalProperties:true},execute});register("Agent","Launch through the immutable @mpx/subagents lifecycle.",async(_id,p)=>{const agent=await productionSubagents.launch(p??{});return productionOutput(agent,{provider:"@mpx/subagents",runner:"@mpx/subagents",agent});});register("get_subagent_result","Consume a real lifecycle runner result.",async(_id,p)=>{const id=String(p?.id??""),result=await productionSubagents.result(id);return productionOutput(result,{id,result});});register("steer_subagent","Steer a queued or running lifecycle agent.",async(_id,p)=>{const id=String(p?.id??""),message=String(p?.message??"").trim();productionSubagents.steer(id,message);return productionOutput("Steering accepted.",{id});});if(projection.productionCapability){if(!projection.productionLaunch)throw new Error("LAUNCH_BINDING_STALE");if(!pi.mpxRuntimeAdapters)throw new Error("ADAPTER_REQUIRED: launch-bound production adapters were not supplied");activatePiProductionRuntime({pi,capability:projection.productionCapability,launch:projection.productionLaunch,adapters});}if(typeof pi.on!=="function")return;pi.on("tool_call",async(event)=>{if(event?.toolName!=="bash")return;const decision=projectionRuntimePolicies.toolCall(event?.input??{});if(decision.action==="block")return {block:true,reason:`${decision.code}: ${decision.message}`};if(decision.warning)return {warning:decision.warning};});pi.on("tool_result",async(event)=>{if(["write","edit"].includes(String(event?.toolName).toLowerCase()))return {additionalContext:`post-write quality: ${JSON.stringify(projectionRuntimePolicies.postWrite(String(event?.input?.path??"")))}`};if(event?.toolName==="bash"){const context=projectionRuntimePolicies.postCommand(String(event?.input?.command??""),String(event?.result?.stderr??""));if(context)return {additionalContext:context};}});pi.on("session_start",async(_event,ctx)=>{if(productionStatusTimer){clearInterval(productionStatusTimer);productionStatusTimer=undefined;}await ensureFresh();await refreshProductionStatus(ctx);ctx?.ui?.setWidget?.("mpx-fleet",productionSubagents.list());productionStatusTimer=setInterval(()=>{void refreshProductionStatus(ctx);},1000);productionStatusTimer.unref?.();});pi.on("before_agent_start",async(event,ctx)=>{await ensureBound();await refreshProductionStatus(ctx);return {systemPrompt:`${String(event?.systemPrompt??"")}${disclosure()}`};});pi.on("session_before_compact",async event=>{const plan=projectionRuntimePolicies.compact(String(event?.customInstructions??""));return plan.action==="inject"?{instructions:plan.instructions}:undefined;});pi.on("agent_settled",async(_event,ctx)=>{try{projectionRuntimePolicies.notification();ctx?.ui?.notify?.("Agent settled.","info");ctx?.ui?.setWidget?.("mpx-fleet",productionSubagents.list());}catch{}});pi.on("session_shutdown",async()=>{if(productionStatusTimer){clearInterval(productionStatusTimer);productionStatusTimer=undefined;}await productionSubagents.shutdown();});}',
    'export async function activate(pi) { await ensureFresh(); for (const name of projection.commandAllowlist) { const entry = projection.entries.find((item) => item.publicName.slice(1) === name); pi.registerCommand(name, { ...(entry?.commandDescription ? { description: entry.commandDescription } : {}), handler: async (_args) => { const loaded = await body(entry.identity, "human-explicit"); await pi.sendUserMessage([{ type: "text", text: loaded.wrappedBody }]); } }); } if (typeof pi.registerTool === "function") { pi.registerTool({ name: "mpx_model_search", label: "MPX search", description: "Search available skills.", parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", description: "Search query." } }, required: ["query"] }, async execute(_toolCallId, params) { await ensureBound(); const results = search(params?.query); return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } }; } }); pi.registerTool({ name: "mpx_model_load", label: "MPX load", description: "Load one available skill.", parameters: { type: "object", additionalProperties: false, properties: { identity: { type: "string", description: "Skill identifier." } }, required: ["identity"] }, async execute(_toolCallId, params) { const identity = String(params?.identity ?? ""); if (!projection.modelSearchAllowlist.includes(identity)) throw new Error("SKILL_INVOCATION_DENIED"); const loaded = await body(identity, "model"); return { content: [{ type: "text", text: loaded.wrappedBody }], details: { identity: loaded.identity, provenance: loaded.provenance } }; } }); } await activateProduction(pi); if (typeof pi.on === "function") { let statusContext, statusTimer; pi.on("tool_call", async (event) => { if (event?.toolName !== "bash") return; await ensureExpected("dangerous-command-policy.mjs"); const {classifyDangerousCommand}=await import("./dangerous-command-policy.mjs"); const decision = classifyDangerousCommand(event?.input?.command); if (decision.action === "block") return { block: true, reason: `${decision.code}: ${decision.message}` }; }); pi.on("before_agent_start", async (event) => { await ensureBound(); if (statusContext) await refreshStatus(statusContext,statusGeneration); return { systemPrompt: `${String(event?.systemPrompt ?? "")}${disclosure()}` }; }); pi.on("session_start", async (event, ctx) => { const context=lifecycleContext(event,ctx),generation=++statusGeneration;lifecycleCaptured=false;lifecycleStopped=false;statusStopped=false;statusContext=context;await queueLifecycle("start",context,false,ensureFresh,true);if(statusStopped||generation!==statusGeneration)return;if(statusTimer){clearInterval(statusTimer);statusTimer=undefined;}const previous=statusRefresh;if(previous)await previous.catch(()=>{});if(statusStopped||generation!==statusGeneration)return;await refreshStatus(context,generation);if(statusStopped||generation!==statusGeneration)return;statusTimer=setInterval(() => { void refreshStatus(context,generation).catch(() => {if(!statusStopped&&generation===statusGeneration)context.ui.setStatus("mpx", `${projection.launchBanner} | ports invalid`);}); }, 1000); statusTimer.unref?.(); }); pi.on("session_info_changed", async (event,ctx) => { if(lifecycleStopped)return;await queueLifecycle("info",lifecycleContext(event,ctx),false,ensureBound); }); pi.on("agent_settled", async (event,ctx) => { if(lifecycleStopped)return;await queueLifecycle("info",lifecycleContext(event,ctx),false,ensureBound,true,true); }); pi.on("session_shutdown", async (event,ctx) => { lifecycleStopped=true;statusStopped=true;++statusGeneration;statusContext=undefined;if(statusTimer){clearInterval(statusTimer);statusTimer=undefined;}let failure;try{await queueLifecycle("shutdown",lifecycleContext(event,ctx),true,ensureBound);}catch(error){failure=error;}finally{const pending=statusRefresh;if(pending)await pending.catch(()=>{});}if(failure)throw failure; }); } }',
    'export async function modelSearch(query) { await ensureBound(); return search(query); }',
    'export default activate;',
    '',
  ].join('\n');
}
async function realDirectoryRoot(directory: string, label: string): Promise<string> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  return realpath(directory);
}
function containsRealPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
async function copyGeneratedAssets(
  staging: string,
  assetsRoot: string,
  provenanceFile: string,
  modelMappings: GeneratePiAgentsInput['modelMappings'],
): Promise<void> {
  const verifiedAssetsRoot = await realDirectoryRoot(assetsRoot, 'Pi generated assets root');
  const agentsRoot = path.join(verifiedAssetsRoot, 'agents');
  const themesRoot = path.join(verifiedAssetsRoot, 'themes');
  const verifiedAgentsRoot = await realDirectoryRoot(agentsRoot, 'Pi generated agents root');
  const verifiedThemesRoot = await realDirectoryRoot(themesRoot, 'Pi generated themes root');
  for (const entry of (await readdir(verifiedAgentsRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !/^(?:mpx-[a-z0-9-]+|Explore)\.md$/u.test(entry.name)) {
      continue;
    }
    const file = path.join(verifiedAgentsRoot, entry.name);
    const resolved = await realpath(file);
    if (!containsRealPath(verifiedAgentsRoot, resolved)) {
      throw new Error('generated agent escapes its verified root');
    }
    const content = await regularText(file, 'generated agent');
    const expectedName = entry.name === 'Explore.md' ? 'Explore' : entry.name.slice(0, -3);
    const normalized = content.replaceAll('\r\n', '\n');
    const projectedModel = normalized.match(/\nmodel: ([^\n]+)\n/u)?.[1];
    if (
      !normalized.startsWith('---\n') ||
      !normalized.includes(`\nname: ${expectedName}\n`) ||
      !projectedModel ||
      !Object.values(modelMappings.models).includes(projectedModel)
    ) {
      throw new Error(`invalid generated agent ${entry.name}`);
    }
    await emit(staging, `agents/${entry.name}`, normalized);
  }
  for (const theme of ['amber', 'green'] as const) {
    const file = path.join(verifiedThemesRoot, `${theme}.json`);
    const resolved = await realpath(file);
    if (!containsRealPath(verifiedThemesRoot, resolved)) {
      throw new Error('generated theme escapes its verified root');
    }
    const content = await regularText(file, 'Pi theme');
    await emit(
      staging,
      `themes/${theme}.json`,
      `${JSON.stringify(JSON.parse(content), null, 2)}\n`,
    );
  }
  const vendorRoot = await realDirectoryRoot(
    path.dirname(provenanceFile),
    'Pi subagent vendor root',
  );
  async function copyVendor(directory: string, relative = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const source = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await copyVendor(source, child);
      } else if (
        entry.isFile() &&
        /^(?:.*\.ts|LICENSE|VENDORED\.md|SHA256SUMS)$/u.test(entry.name)
      ) {
        await emit(
          staging,
          `vendor/subagents/${child}`,
          (await regularText(source, 'vendored subagent source')).replaceAll('\r\n', '\n'),
        );
      } else if (entry.isSymbolicLink()) {
        throw new Error('Pi subagent vendor may not contain symlinks');
      }
    }
  }
  await copyVendor(vendorRoot);
}
function freezeProjection(
  published: PublishedRuntimeArtifact,
  profileInput: PiRuntimeProfileV1,
): PiPublishedProjection {
  const reference = Object.freeze({ ...published.reference });
  const profile = parsePiRuntimeProfileV1(profileInput);
  const directory = path.resolve(published.directory);
  return Object.freeze({
    directory,
    extension: path.join(directory, 'extension.mjs'),
    runtimeContextFile: path.join(directory, 'runtime-context.json'),
    profile,
    theme: profile.theme,
    artifactKey: reference.launchBinding.runtimeArtifactKey,
    reference,
    files: Object.freeze(published.fileMap.map((file) => file.path)),
    reused: published.reused,
    revalidation: Object.freeze({ directory, reference, profile }),
  });
}

export async function buildPiProjection(
  input: PiProjectionBuildInput,
): Promise<PiPublishedProjection> {
  const piRuntimeProfile = parsePiRuntimeProfileV1(input.piRuntimeProfile);
  const skillPlan = verifySkillProjectionPlan(input.skillPlan);
  if (skillPlan.runtime !== 'pi') {
    throw new Error('Pi projection requires a Pi skill projection plan');
  }
  const context = parseRuntimeContextV1(input.context);
  const statusSnapshot = parseStatusSnapshotV1(input.statusSnapshot);
  const piSettings = profileSettings(piRuntimeProfile);
  const piKeybindings = piRuntimeProfile.keybindings;
  const unavailable = {
    source: 'derived' as const,
    state: 'unavailable' as const,
    capturedAt: null,
    freshUntil: null,
    diagnostic: null,
    unavailable: 'not reported',
  };
  const fallbackStatus: RuntimeStatusEnvelopeV1 = {
    schemaVersion: 1,
    generatedAt: '2000-01-01T00:00:00.000Z',
    binding: {
      launchKey: context.launchKey,
      runtimeId: 'pi',
      repositoryId: context.binding.repositoryId,
    },
    harness: { kind: 'pi', version: null, surface: 'footer' },
    identity: { ...unavailable, profile: null, label: null },
    session: { ...unavailable, elapsedMs: null, turns: null },
    model: {
      ...unavailable,
      modelId: null,
      label: null,
      contextUsedTokens: null,
      contextLimitTokens: null,
    },
    location: { ...unavailable, label: null },
    repository: {
      ...unavailable,
      name: null,
      branch: null,
      dirty: null,
      ahead: null,
      behind: null,
    },
    usage: {
      ...unavailable,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    },
    cost: { ...unavailable, currency: 'USD', amountMicros: null },
    providerUsage: {
      ...unavailable,
      provider: null,
      used: null,
      limit: null,
      unit: null,
      resetAt: null,
    },
    compactions: { ...unavailable, count: null, lastAt: null },
    subagents: { ...unavailable, active: null, completed: null, failed: null },
    development: {
      ...unavailable,
      services: statusSnapshot.services.map((service) => ({
        id: service.id,
        state:
          service.conflict !== 'none' ? 'conflict' : service.listening ? 'listening' : 'stopped',
        port: service.port,
      })),
    },
    actions: { ...unavailable, items: [] },
  };
  const runtimeStatusEnvelope = parseRuntimeStatusEnvelopeV1(
    input.runtimeStatusEnvelope ?? fallbackStatus,
  );
  if (
    runtimeStatusEnvelope.binding.launchKey !== context.launchKey ||
    runtimeStatusEnvelope.binding.repositoryId !== context.binding.repositoryId ||
    runtimeStatusEnvelope.harness.kind !== 'pi'
  ) {
    throw new Error('Pi runtime status envelope belongs to another launch');
  }
  if (
    skillPlan.manifestKey !== context.manifestKey ||
    skillPlan.artifactReference.artifactKey !== context.runtimeArtifact.artifactKey
  ) {
    throw new Error('Pi projection requires its exact v4 Pi artifact and runtime context');
  }
  const validation = await validateRuntimeContext({
    context,
    expectedLaunch: input.expectedLaunch,
    expectedManifestKey: skillPlan.manifestKey,
    expectedRuntimeArtifact: skillPlan.artifactReference,
    currentBinding: input.currentBinding,
  });
  if (!validation.valid) {
    restart(validation.diagnostics);
  }
  const entries: Array<{
    identity: string;
    publicName: string;
    exposure: 'full' | 'name-only' | 'explicit-only' | 'off';
    contentHash: string;
    sourcePath: string;
    commandDescription?: string;
    canonicalDescription?: string;
    canonicalTriggers?: string;
  }> = [];
  for (const entry of skillPlan.entries) {
    entries.push({
      identity: entry.identity,
      publicName: entry.publicName,
      exposure: entry.exposure,
      contentHash: entry.source.contentHash,
      sourcePath: entry.source.provenancePath,
      ...(entry.humanContext?.description
        ? { commandDescription: entry.humanContext.description }
        : {}),
      ...(entry.modelSearchContext?.description
        ? {
            canonicalDescription: entry.modelSearchContext.description,
            ...(entry.modelSearchContext.triggers
              ? { canonicalTriggers: entry.modelSearchContext.triggers }
              : {}),
          }
        : {}),
    });
  }
  const commandAllowlist = skillPlan.entries
    .filter((entry) => entry.permissions.humanInvocation)
    .map((entry) => entry.publicName.slice(1))
    .sort();
  const modelSearchAllowlist = skillPlan.entries
    .filter((entry) => entry.permissions.modelInvocation)
    .map((entry) => entry.identity)
    .sort();
  const productionCapability = input.runtimeCapabilityManifest
    ? parseRuntimeCapabilityManifestV1(input.runtimeCapabilityManifest)
    : undefined;
  const productionLaunch = input.runtimeLaunchBinding;
  if ((productionCapability === undefined) !== (productionLaunch === undefined)) {
    throw new Error('Pi production capability and launch binding must be supplied together');
  }
  if (
    productionCapability &&
    productionLaunch &&
    (productionCapability.runtime !== 'pi' ||
      productionCapability.launchKey !== context.launchKey ||
      productionLaunch.launchKey !== context.launchKey ||
      productionLaunch.runtime !== 'pi' ||
      productionLaunch.executor !== productionCapability.executor ||
      productionLaunch.identity.name !== productionCapability.identity.name ||
      productionLaunch.identity.domain !== productionCapability.identity.domain ||
      productionCapability.binding.projectId !== context.binding.projectId ||
      productionCapability.binding.repositoryId !== context.binding.repositoryId ||
      productionCapability.binding.contentScope !== context.binding.contentScope)
  ) {
    throw new Error('Pi production capability is stale or belongs to another launch');
  }
  const descriptor = {
    schemaVersion: 1,
    runtime: 'pi',
    manifestKey: skillPlan.manifestKey,
    runtimeArtifact: skillPlan.artifactReference,
    runtimeContext: 'runtime-context.json',
    profile: 'runtime-profile.json',
    extension: 'extension.mjs',
    commandAllowlist,
    modelSearchAllowlist,
    ...(productionCapability && productionLaunch ? { productionCapability, productionLaunch } : {}),
    settings: 'settings.json',
    keybindings: 'keybindings.json',
    themes: ['green', 'amber'],
    agents: 'agents',
    vendorProvenance: 'vendor/subagents/VENDORED.md',
    runtimeStatusEnvelope: 'status/runtime-status-envelope-v1.json',
    entries,
  };
  await mkdir(input.artifactsRoot, { recursive: true });
  const staging = await mkdtemp(path.join(input.artifactsRoot, '.pi-build-'));
  try {
    await emit(staging, 'projection.json', jsonFile(descriptor));
    await emit(staging, 'runtime-context.json', jsonFile(context));
    await emit(staging, 'runtime-profile.json', jsonFile(piRuntimeProfile));
    const runtimeStatusLine = renderPiRuntimeStatus(runtimeStatusEnvelope, 'wide');
    await emit(
      staging,
      'extension.mjs',
      piExtensionSource({
        manifestKey: skillPlan.manifestKey,
        artifactKey: skillPlan.artifactReference.artifactKey,
        launchBanner: input.launchBanner,
        runtimeStatusLine,
        commandAllowlist,
        modelSearchAllowlist,
        ...(productionCapability && productionLaunch
          ? { productionCapability, productionLaunch }
          : {}),
        entries,
      }),
    );
    await emitProductionBundles(
      (filename, content) => emit(staging, filename, content),
      bundledSource,
    );
    await emit(staging, 'dangerous-command-policy.mjs', `${dangerousCommandPolicyModuleSource}\n`);
    await emit(staging, 'status/status-snapshot.json', jsonFile(statusSnapshot));
    await emit(staging, 'status/runtime-status-envelope-v1.json', jsonFile(runtimeStatusEnvelope));
    await emit(staging, 'settings.json', jsonFile(piSettings));
    await emit(staging, 'keybindings.json', jsonFile(piKeybindings));
    for (const entry of skillPlan.entries) {
      await emit(staging, `skills/${entry.identity}/body.md`, entry.skillFile.bytes);
      for (const support of entry.files) {
        await emit(staging, `skills/${entry.identity}/${support.relativePath}`, support.bytes);
      }
    }
    await copyGeneratedAssets(
      staging,
      input.assetsRoot ?? path.join(packageRoot, 'projection'),
      input.vendorProvenanceFile ?? path.join(packageRoot, 'vendor', 'subagents', 'VENDORED.md'),
      input.modelMappings,
    );
    const launchBinding = {
      launchKey: context.launchKey,
      descriptorDigest: context.launchDescriptor.digest,
      runtimeArtifactKey: skillPlan.artifactReference.artifactKey,
      runtime: 'pi' as const,
      manifestKey: skillPlan.manifestKey,
    };
    const published = await publishRuntimeArtifact({
      sourceRoot: staging,
      artifactsRoot: input.artifactsRoot,
      launchBinding,
      ...(input.artifactRevalidator ? { revalidate: input.artifactRevalidator } : {}),
    });
    return freezeProjection(published, piRuntimeProfile);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function createPiRuntimeProjection(
  input: PiProjectionBuildInput,
): Promise<PiPublishedProjection> {
  return buildPiProjection(input);
}

export function guardPiCommand(command: string) {
  return classifyDangerousCommand(command);
}

export interface PiFooterPortAdapter {
  current(): string;
  refresh(): Promise<void>;
}
export function createPiFooterPortAdapter(snapshot: () => Promise<unknown>): PiFooterPortAdapter {
  let rendered = '';
  return {
    current: () => rendered,
    refresh: async () => {
      rendered = renderPiPortSegment(await snapshot());
    },
  };
}

export { generatePiAgents, type GeneratePiAgentsInput } from './agent-generator.js';
