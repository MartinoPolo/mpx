import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import {
  parseNativeSessionRefV1,
  parseRuntimeContextV1,
  publishRuntimeArtifact,
  validateRuntimeContext,
  validateSessionLifecycleBindingV1,
  type NativeSessionRefV1,
  type PublishedRuntimeArtifact,
  type PublishedRuntimeArtifactReference,
  type RuntimeBinding,
  type RuntimeContextV1,
} from '@mpx/runtime-contracts';
import {
  inventoryProjectSkills,
  SkillCatalogError,
  verifySkillProjectionPlan,
  type SkillProjectionPlan,
} from '@mpx/skills';
import {
  classifyCompiledSkillSource,
  loadActiveContentProjection,
  verifyCompiledContentTree,
  type CompiledContentTree,
} from '@mpx/content-compiler';
import { parsePiRuntimeProfileV1, type PiRuntimeProfileV1 } from './profile.js';

export * from './profile.js';
export * from './runtime-capabilities.js';

export interface PiProjectionRevalidation {
  readonly directory: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly profile: PiRuntimeProfileV1;
}
const verifiedPiProjections = new WeakSet<object>();
export interface PiPublishedProjection {
  readonly directory: string;
  readonly runtimeContextFile: string;
  readonly profile: PiRuntimeProfileV1;
  readonly artifactKey: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly files: readonly string[];
  readonly fileMap: readonly PiProjectionFile[];
  readonly reused: boolean;
  readonly revalidation: PiProjectionRevalidation;
}
export interface PiInvocationInput {
  executable: string;
  accountRoot: string;
  cwd: string;
  runtimeContext: RuntimeContextV1;
  launchIdentity?: {
    readonly name: string;
    readonly mode: string;
    readonly skillPolicy: string;
  };
  projectProviders?: {
    readonly repository: string;
    readonly issues: string;
    readonly repositoryUrl?: string;
    readonly issuesUrl?: string;
    readonly projectConfigPath?: string;
  };
  accountConfigPath?: string;
  immutableProjectionDirectory?: string;
  profile?: PiRuntimeProfileV1;
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
// fallow-ignore-next-line unused-export -- stable runtime automation contract.
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

function stableProjectionValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableProjectionValue).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableProjectionValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function projectionDigest(value: unknown): string {
  return createHash('sha256').update(stableProjectionValue(value)).digest('hex');
}

interface PiProjectionFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function projectionFilesForInvocation(
  input: PiInvocationInput,
  directory: string,
  reference: PublishedRuntimeArtifactReference | undefined,
): readonly PiProjectionFile[] {
  if (input.projection && verifiedPiProjections.has(input.projection as object)) {
    return input.projection.fileMap;
  }
  if (!reference) {
    throw new Error('published Pi projection reference is required');
  }
  const metadataFile = path.join(directory, '.mpx-runtime-artifact.json');
  try {
    const stat = lstatSync(metadataFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      throw new Error('invalid metadata');
    }
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as {
      schemaVersion?: unknown;
      reference?: PublishedRuntimeArtifactReference;
      fileMap?: Array<{ path?: unknown; sha256?: unknown; bytes?: unknown }>;
    };
    const publishedReference = metadata.reference;
    if (
      metadata.schemaVersion !== 1 ||
      !publishedReference ||
      publishedReference.projectionKey !== reference.projectionKey ||
      publishedReference.fileMapHash !== reference.fileMapHash ||
      publishedReference.launchBinding.launchKey !== reference.launchBinding.launchKey ||
      publishedReference.launchBinding.descriptorDigest !==
        reference.launchBinding.descriptorDigest ||
      publishedReference.launchBinding.runtimeArtifactKey !==
        reference.launchBinding.runtimeArtifactKey ||
      publishedReference.launchBinding.runtime !== reference.launchBinding.runtime ||
      publishedReference.launchBinding.manifestKey !== reference.launchBinding.manifestKey ||
      !Array.isArray(metadata.fileMap)
    ) {
      throw new Error('invalid metadata');
    }
    const fileMap = metadata.fileMap.map((entry) => {
      if (
        !entry ||
        Object.keys(entry).sort().join(',') !== 'bytes,path,sha256' ||
        typeof entry.path !== 'string' ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 0
      ) {
        throw new Error('invalid metadata');
      }
      return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes as number };
    });
    if (
      projectionDigest(fileMap) !== reference.fileMapHash ||
      projectionDigest({
        schemaVersion: 1,
        launchBinding: reference.launchBinding,
        fileMapHash: reference.fileMapHash,
      }) !== reference.projectionKey
    ) {
      throw new Error('invalid metadata');
    }
    return fileMap;
  } catch {
    throw new Error('published Pi projection file map is unavailable or invalid');
  }
}

function managedPromptFile(directory: string, files: readonly PiProjectionFile[]): string {
  const relative = 'instructions/pi/MANAGED_PROMPT.md';
  const matches = files.filter((entry) => entry.path === relative);
  if (matches.length !== 1) {
    throw new Error('published Pi projection does not uniquely bind managed prompt');
  }
  const file = path.join(directory, ...relative.split('/'));
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== matches[0]!.bytes) {
    throw new Error('published Pi managed prompt is missing or changed');
  }
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== matches[0]!.sha256) {
    throw new Error('published Pi managed prompt is missing or changed');
  }
  return absolute(file, 'managed prompt');
}

function compiledAgentsDirectory(directory: string, files: readonly PiProjectionFile[]): string {
  const normalized = new Set<string>();
  let agentFileCount = 0;
  for (const entry of files) {
    const file = entry.path;
    const identity = file.toLowerCase();
    if (normalized.has(identity)) {
      throw new Error('published Pi projection file map collides');
    }
    normalized.add(identity);
    if (/^agents\/[^/]+\.md$/u.test(file)) {
      agentFileCount += 1;
    }
  }
  if (!normalized.has('active-content.json') || agentFileCount === 0) {
    throw new Error('published Pi projection does not contain compiled agents');
  }
  const agents = absolute(path.join(directory, 'agents'), 'compiled agents directory');
  const directoryStat = lstatSync(directory);
  const agentsStat = lstatSync(agents);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !agentsStat.isDirectory() ||
    agentsStat.isSymbolicLink()
  ) {
    throw new Error('compiled agents directory must be an immutable projection directory');
  }
  const relative = path.relative(directory, agents);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('compiled agents directory escapes the published Pi projection');
  }
  return agents;
}

export async function planPiInvocation(input: PiInvocationInput): Promise<PiInvocationPlan> {
  if (
    input.launchIdentity &&
    ![input.launchIdentity.name, input.launchIdentity.mode, input.launchIdentity.skillPolicy].every(
      (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value),
    )
  ) {
    throw new Error('Pi launch identity contains an invalid display field');
  }
  const runtimeContextFile = input.projection?.runtimeContextFile ?? input.runtimeContextFile;
  const profileInput = input.projection?.profile ?? input.profile;
  const profile = profileInput
    ? parsePiRuntimeProfileV1(profileInput)
    : loadPublishedPiProfile(input.immutableProjectionDirectory);
  if (!runtimeContextFile || !profile) {
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
  const activeContentRoot = absolute(
    input.projection?.directory ??
      input.immutableProjectionDirectory ??
      path.dirname(runtimeContextFile),
    'active content root',
  );
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
  const projectionFiles = projectionFilesForInvocation(
    input,
    activeContentRoot,
    projectionReference,
  );
  const agentsDirectory = compiledAgentsDirectory(activeContentRoot, projectionFiles);
  const managedPrompt = managedPromptFile(activeContentRoot, projectionFiles);
  const manifestFileMatches = projectionFiles.filter(
    (entry) => entry.path === 'active-content.json',
  );
  if (manifestFileMatches.length !== 1) {
    throw new Error('published Pi projection does not uniquely bind active-content.json');
  }
  const manifestFile = manifestFileMatches[0]!;
  const manifestPath = path.join(activeContentRoot, 'active-content.json');
  const activeContent = await loadActiveContentProjection({
    root: activeContentRoot,
    manifestPath,
    expected: {
      runtime: 'pi',
      manifestKey: context.manifestKey,
      binding: context.binding,
      manifestFile: { sha256: manifestFile.sha256, byteCount: manifestFile.bytes },
    },
  });
  const projectInventory = await inventoryProjectSkills(absolute(input.cwd, 'cwd'));
  if (projectInventory.diagnostics.length) {
    throw new SkillCatalogError(projectInventory.diagnostics);
  }
  const managedProjectSkills = activeContent.manifest.skills.filter(
    (entry) => classifyCompiledSkillSource(entry) === 'project',
  );
  const managedSourceDirectories = new Set(
    managedProjectSkills.map((entry) => path.dirname(entry.sourcePath).replaceAll('\\', '/')),
  );
  for (const directory of projectInventory.nativeSkillDirectories) {
    const directoryName = path.basename(directory);
    const sourceDirectory = `.agents/skills/${process.platform === 'win32' ? directoryName.toLowerCase() : directoryName}`;
    if (managedSourceDirectories.has(sourceDirectory)) {
      throw new Error('project skill ownership changed since projection; restart required');
    }
  }
  const managedSkillDirectories = managedProjectSkills
    .map((entry) =>
      absolute(
        path.dirname(path.join(activeContentRoot, ...entry.generatedPath.split('/'))),
        'native skill',
      ),
    )
    .sort();
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
      '--no-skills',
      '--no-context-files',
      '--append-system-prompt',
      managedPrompt,
      ...[
        ...managedSkillDirectories,
        ...projectInventory.nativeSkillDirectories.map((directory) =>
          absolute(path.join(directory, 'SKILL.md'), 'native project skill entrypoint'),
        ),
      ].flatMap((skillPath) => ['--skill', skillPath]),
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
      '--use-theme',
      profile.theme,
      ...(resumeFile ? ['--session', resumeFile] : []),
    ],
    env: {
      PI_CODING_AGENT_DIR: accountRoot,
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(context),
      MPX_RUNTIME_CONTEXT_FILE: absolute(runtimeContextFile, 'runtime context'),
      ...(input.launchIdentity
        ? {
            MPX_IDENTITY: input.launchIdentity.name,
            MPX_MODE: input.launchIdentity.mode,
            MPX_SKILL_POLICY: input.launchIdentity.skillPolicy,
          }
        : {}),
      ...(input.projectProviders
        ? {
            MPX_REPOSITORY_PROVIDER: input.projectProviders.repository,
            MPX_ISSUES_PROVIDER: input.projectProviders.issues,
          }
        : {}),
      MPX_REPOSITORY_URL: input.projectProviders?.repositoryUrl ?? '',
      MPX_ISSUES_URL: input.projectProviders?.issuesUrl ?? '',
      MPX_PROJECT_CONFIG_PATH: input.projectProviders?.projectConfigPath
        ? absolute(input.projectProviders.projectConfigPath, 'project config path')
        : '',
      MPX_ACCOUNT_CONFIG_PATH: input.accountConfigPath
        ? absolute(input.accountConfigPath, 'account config path')
        : '',
      MPX_SESSION_SKILLS_DIR: projectionFiles.some((entry) =>
        /^skills\/[^/]+\/SKILL\.md$/u.test(entry.path),
      )
        ? absolute(path.join(activeContentRoot, 'skills'), 'compiled skills directory')
        : '',
      MPX_ACTIVE_CONTENT_ROOT: activeContentRoot,
      MPX_ACTIVE_CONTENT_MANIFEST: manifestPath.replaceAll('\\', '/'),
      MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: JSON.stringify({
        sha256: manifestFile.sha256,
        byteCount: manifestFile.bytes,
      }),
      MPX_COMPILED_AGENTS_DIR: agentsDirectory,
      ...(projectionReference
        ? { MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projectionReference) }
        : {}),
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

export interface PiProjectionBuildInput {
  readonly skillPlan: SkillProjectionPlan;
  readonly compiledContent: CompiledContentTree;
  readonly context: RuntimeContextV1;
  readonly expectedLaunch: { readonly launchKey: string; readonly descriptorDigest: string };
  readonly currentBinding: RuntimeBinding;
  readonly artifactsRoot: string;
  readonly piRuntimeProfile: PiRuntimeProfileV1;
  readonly globalInstructions: string;
  readonly piAppendInstructions: string;
  readonly cwd: string;
  readonly artifactRevalidator?: Parameters<typeof publishRuntimeArtifact>[0]['revalidate'];
}

const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const PROJECT_CONTEXT_CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const;
async function readInstruction(
  file: string,
  options: { readonly expectedTail?: readonly string[]; readonly containmentRoot?: string } = {},
): Promise<Uint8Array> {
  const absoluteFile = path.resolve(file);
  if (absoluteFile !== file) {
    throw new Error('instruction path must be absolute');
  }
  if (options.expectedTail) {
    const tail = absoluteFile.split(path.sep).slice(-options.expectedTail.length).join('/');
    if (tail !== options.expectedTail.join('/')) {
      throw new Error('canonical instruction escaped its expected source directory');
    }
  }
  if (options.containmentRoot) {
    const relative = path.relative(options.containmentRoot, absoluteFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('project instruction escaped cwd ancestry');
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absoluteFile, 'r');
    const initial = await handle.stat(),
      named = await lstat(absoluteFile);
    if (
      !initial.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      initial.dev !== named.dev ||
      initial.ino !== named.ino ||
      initial.size > MAX_INSTRUCTION_BYTES
    ) {
      throw new Error('instruction must be a bounded regular non-symlink file');
    }
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error('instruction changed while reading');
      }
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error('instruction changed while reading');
    }
    const final = await handle.stat(),
      finalNamed = await lstat(absoluteFile),
      resolved = await realpath(absoluteFile);
    if (
      resolved !== absoluteFile ||
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      finalNamed.isSymbolicLink()
    ) {
      throw new Error('instruction changed or escaped while reading');
    }
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
async function projectContext(
  cwdInput: string,
): Promise<Array<{ file: string; bytes: Uint8Array }>> {
  const cwd = path.resolve(cwdInput);
  if (cwd !== cwdInput) {
    throw new Error('cwd must be absolute');
  }
  const root = path.parse(cwd).root;
  const directories: string[] = [];
  for (let current = cwd; ; current = path.dirname(current)) {
    directories.push(current);
    if (current === root) {
      break;
    }
  }
  directories.reverse();
  const selected: Array<{ file: string; bytes: Uint8Array }> = [];
  for (const directory of directories) {
    for (const candidate of PROJECT_CONTEXT_CANDIDATES) {
      const file = path.join(directory, candidate);
      try {
        await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      selected.push({ file, bytes: await readInstruction(file, { containmentRoot: root }) });
      break;
    }
  }
  return selected;
}
function composeManagedPrompt(
  globalInstructions: Uint8Array,
  piAppendInstructions: Uint8Array,
  project: readonly { readonly file: string; readonly bytes: Uint8Array }[],
): Uint8Array {
  const sections = [Buffer.from(globalInstructions), Buffer.from(piAppendInstructions)];
  for (const entry of project) {
    sections.push(Buffer.from(`\n\n## Project context: ${entry.file}\n\n`, 'utf8'));
    sections.push(Buffer.from(entry.bytes));
  }
  return Buffer.concat(
    sections.flatMap((section, index) => (index ? [Buffer.from('\n\n'), section] : [section])),
  );
}
function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
async function emit(root: string, relative: string, content: string | Uint8Array): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
}
function freezeProjection(
  published: PublishedRuntimeArtifact,
  profileInput: PiRuntimeProfileV1,
): PiPublishedProjection {
  const reference = Object.freeze({ ...published.reference });
  const profile = parsePiRuntimeProfileV1(profileInput);
  const directory = path.resolve(published.directory);
  const projection = Object.freeze({
    directory,
    runtimeContextFile: path.join(directory, 'runtime-context.json'),
    profile,
    artifactKey: reference.launchBinding.runtimeArtifactKey,
    reference,
    files: Object.freeze(published.fileMap.map((file) => file.path)),
    fileMap: Object.freeze(published.fileMap.map((file) => Object.freeze({ ...file }))),
    reused: published.reused,
    revalidation: Object.freeze({ directory, reference, profile }),
  });
  verifiedPiProjections.add(projection);
  return projection;
}

export async function buildPiProjection(
  input: PiProjectionBuildInput,
): Promise<PiPublishedProjection> {
  const piRuntimeProfile = parsePiRuntimeProfileV1(input.piRuntimeProfile);
  const skillPlan = verifySkillProjectionPlan(input.skillPlan);
  const compiledContent = verifyCompiledContentTree(input.compiledContent, {
    runtime: 'pi',
    plan: skillPlan,
  });
  const compiledFiles = compiledContent.files.map((file) => ({
    ...file,
    bytes: Uint8Array.from(file.bytes),
  }));
  if (
    compiledContent.manifest.agents.length === 0 ||
    compiledContent.manifest.agents.some(
      (agent) =>
        !compiledFiles.some(
          (file) =>
            file.relativePath === agent.generatedPath &&
            file.sha256 === agent.generatedSha256 &&
            file.byteCount === agent.generatedByteCount,
        ),
    )
  ) {
    throw new Error('Pi projection requires compiler-owned agents in its exact file map');
  }
  if (skillPlan.runtime !== 'pi') {
    throw new Error('Pi projection requires a Pi skill projection plan');
  }
  const context = parseRuntimeContextV1(input.context);
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
    throw new Error(
      `RESTART_REQUIRED: ${validation.diagnostics.map((item) => item.code).join(',')}`,
    );
  }
  const globalInstructions = await readInstruction(input.globalInstructions, {
    expectedTail: ['instructions', 'global', 'AGENTS.md'],
  });
  const piAppendInstructions = await readInstruction(input.piAppendInstructions, {
    expectedTail: ['instructions', 'runtime', 'pi', 'APPEND_SYSTEM.md'],
  });
  const managedPrompt = composeManagedPrompt(
    globalInstructions,
    piAppendInstructions,
    await projectContext(input.cwd),
  );
  const descriptor = {
    schemaVersion: 1,
    runtime: 'pi',
    manifestKey: skillPlan.manifestKey,
    runtimeArtifact: skillPlan.artifactReference,
    runtimeContext: 'runtime-context.json',
    profile: 'runtime-profile.json',
    skills: 'skills',
    agents: 'agents',
  };
  await mkdir(input.artifactsRoot, { recursive: true });
  const staging = await mkdtemp(path.join(input.artifactsRoot, '.pi-build-'));
  try {
    await emit(staging, 'projection.json', jsonFile(descriptor));
    await emit(staging, 'runtime-context.json', jsonFile(context));
    await emit(staging, 'runtime-profile.json', jsonFile(piRuntimeProfile));
    verifyCompiledContentTree(compiledContent, { runtime: 'pi', plan: skillPlan });
    const runtimeOwned = new Set([
      'projection.json',
      'runtime-context.json',
      'runtime-profile.json',
      'instructions/global/agents.md',
      'instructions/runtime/pi/append_system.md',
      'instructions/pi/managed_prompt.md',
    ]);
    for (const file of compiledFiles) {
      if (runtimeOwned.has(file.relativePath.toLowerCase())) {
        throw new Error(`compiled content collides with runtime-owned file ${file.relativePath}`);
      }
      await emit(staging, file.relativePath, file.bytes);
    }
    await emit(staging, 'instructions/global/AGENTS.md', globalInstructions);
    await emit(staging, 'instructions/runtime/pi/APPEND_SYSTEM.md', piAppendInstructions);
    await emit(staging, 'instructions/pi/MANAGED_PROMPT.md', managedPrompt);
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
