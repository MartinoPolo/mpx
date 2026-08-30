import {
  EXPOSURES,
  SKILL_PACKS,
  resolveEffectiveSkillPacks,
  type Exposure,
  type SkillPack,
  type SkillPolicyConfig,
} from '@mpx/config';
import { isPathWithinRoot } from '@mpx/core';
import {
  createResolvedSkillManifestV4,
  createRuntimeSkillArtifactReferenceV4,
  parseResolvedSkillManifestV4,
  parseRuntimeSkillArtifactReferenceV4,
  type ResolvedSkillDecisionV4,
  type ResolvedSkillManifestV4,
  RuntimeContractError,
  type RuntimeSkillArtifactReferenceV4,
} from '@mpx/runtime-contracts';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export {
  EXPOSURES,
  SKILL_PACKS,
  type Exposure,
  type SkillPack,
  type SkillPolicyConfig,
} from '@mpx/config';
export type Runtime = 'claude' | 'pi';

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}
export class SkillCatalogError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'));
    this.name = 'SkillCatalogError';
  }
}
export interface CanonicalSkill {
  identity: string;
  description: string;
  triggers?: string;
  skillPacks: SkillPack[];
  defaultExposure: Exposure;
  sourcePath: string;
  realPath: string;
  contentHash: string;
}
export interface ProjectSkill {
  identity: string;
  description: string;
  projectExposure: 'full' | 'explicit-only';
  disableModelInvocation: boolean;
  sourcePath: string;
  realPath: string;
  contentHash: string;
  directoryHash: string;
  projectRoot: string;
  realProjectRoot: string;
}
export type CatalogSkill = CanonicalSkill | ProjectSkill;
export interface ExposureSettings {
  default?: Exposure;
  skills?: Record<string, Exposure>;
}
export interface ResolveOptions {
  repositoryId: string;
  contentScope: string;
  projectId?: string;
  enabledPacks: readonly SkillPack[];
  identity: string;
  skillPolicy: string;
  skillPolicyConfig: SkillPolicyConfig;
  contentScopeExposure?: ExposureSettings;
  projectExposure?: ExposureSettings;
  /** Public command-name mapping. It is resolution input and therefore manifest-key material. */
  mapping?: Readonly<Record<string, string>>;
}
export const SKILL_MANIFEST_SCHEMA_VERSION = 4 as const;
export type ResolvedManifest = ResolvedSkillManifestV4;

export interface RuntimeSkillEntry {
  identity: string;
  publicName: string;
  packs: SkillPack[];
  exposure: Exposure;
  metadataHash: string;
  description?: string;
  triggers?: string;
  source:
    | { kind: 'canonical'; path: string; realPath: string; contentHash: string }
    | {
        kind: 'project';
        path: string;
        realPath: string;
        contentHash: string;
        directoryHash: string;
        projectRoot: string;
        realProjectRoot: string;
      };
  permissions: { humanInvocation: boolean; modelInvocation: boolean };
}
export interface RuntimeSkillArtifact {
  schemaVersion: 4;
  runtime: Runtime;
  manifestKey: string;
  reference: RuntimeSkillArtifactReferenceV4;
  entries: RuntimeSkillEntry[];
}

export const MAX_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_SKILL_SEARCH_RESULTS = 20;
export const MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_HUMAN_SKILL_SEARCH_RESULTS = 20;
export const MAX_SKILL_BODY_BYTES = 256 * 1024;
export const MAX_PROJECT_SKILL_CANDIDATES = 256;
export const MAX_PROJECT_SKILL_DIRECTORY_ENTRIES = 4_096;
export const MAX_PROJECT_SKILL_INVENTORY_BYTES = 16 * 1024 * 1024;
export const MAX_SKILL_DIRECTORY_FILES = 128;
export const MAX_SKILL_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_DIRECTORY_DIRECTORIES = 128;
export const MAX_SKILL_DIRECTORY_DEPTH = 16;
export interface SkillDirectoryFile {
  readonly relativePath: string;
  readonly bytes: Buffer;
}

class ProjectSkillInventoryByteLimitError extends Error {}

async function readExactSkillFile(
  candidate: string,
  stat: Awaited<ReturnType<typeof lstat>>,
  remainingBytes: number,
): Promise<Buffer> {
  if (stat.size > MAX_SKILL_DIRECTORY_BYTES) {
    throw new Error('skill directory file exceeds byte limit');
  }
  if (stat.size > remainingBytes) {
    throw new Error('skill directory exceeds byte limit');
  }
  const handle = await open(candidate, 'r');
  try {
    const initial = await handle.stat();
    const linked = await lstat(candidate);
    if (
      !initial.isFile() ||
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      initial.dev !== stat.dev ||
      initial.ino !== stat.ino ||
      linked.dev !== initial.dev ||
      linked.ino !== initial.ino ||
      initial.size !== stat.size ||
      initial.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error('skill directory file changed while reading');
    }
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error('skill directory file changed while reading');
      }
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, initial.size)).bytesRead !== 0) {
      throw new Error('skill directory file grew while reading');
    }
    const final = await handle.stat();
    const finalLinked = await lstat(candidate);
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      finalLinked.dev !== initial.dev ||
      finalLinked.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      finalLinked.isSymbolicLink()
    ) {
      throw new Error('skill directory file changed while reading');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Snapshots one validated skill directory without following links or special files. */
export async function enumerateSkillDirectory(
  directory: string,
  inventoryBytesRemaining = Number.MAX_SAFE_INTEGER,
): Promise<readonly SkillDirectoryFile[]> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('skill directory must be a regular directory');
  }
  const root = await realpath(directory);
  const files: SkillDirectoryFile[] = [];
  let totalBytes = 0,
    directoryCount = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    const entries = await opendir(current);
    for await (const entry of entries) {
      const candidate = path.join(current, entry.name);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error('skill directory cannot contain symlinks');
      }
      const resolved = await realpath(candidate);
      if (!isPathWithinRoot(resolved, root)) {
        throw new Error('skill directory entry escapes its root');
      }
      if (stat.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > MAX_SKILL_DIRECTORY_DIRECTORIES) {
          throw new Error('skill directory exceeds directory count limit');
        }
        const childDepth = depth + 1;
        if (childDepth > MAX_SKILL_DIRECTORY_DEPTH) {
          throw new Error('skill directory exceeds depth limit');
        }
        await visit(candidate, childDepth);
      } else if (stat.isFile()) {
        if (files.length >= MAX_SKILL_DIRECTORY_FILES) {
          throw new Error('skill directory exceeds file count limit');
        }
        if (stat.size > MAX_SKILL_DIRECTORY_BYTES) {
          throw new Error('skill directory file exceeds byte limit');
        }
        if (stat.size > inventoryBytesRemaining - totalBytes) {
          throw new ProjectSkillInventoryByteLimitError(
            'project skill inventory byte limit exceeded',
          );
        }
        const bytes = await readExactSkillFile(
          candidate,
          stat,
          MAX_SKILL_DIRECTORY_BYTES - totalBytes,
        );
        totalBytes += bytes.length;
        files.push(
          Object.freeze({
            relativePath: path.relative(root, candidate).split(path.sep).join('/'),
            bytes,
          }),
        );
      } else {
        throw new Error('skill directory contains a special file');
      }
    }
  };
  await visit(root, 0);
  files.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  return Object.freeze(files);
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedTop = new Set(['name', 'description', 'triggers', 'metadata']);

function scalar(raw: string): string | boolean | string[] {
  const value = raw.trim();
  if (/[*&!]|<<\s*:/.test(value)) {
    throw new Error('YAML tags, anchors, aliases, and merge keys are forbidden');
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if (/^(null|~|[-+]?\d|\{|\})/i.test(value)) {
    throw new Error('only strings, booleans, and string arrays are supported');
  }
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error('frontmatter closing delimiter is missing');
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];
  for (const [index, line] of normalized.slice(4, end).split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    if (line.includes('\t')) {
      throw new Error(`tabs are forbidden at line ${index + 2}`);
    }
    const match = /^( *)([A-Za-z][A-Za-z0-9-]*):(?: +(.*))?$/.exec(line);
    if (!match) {
      throw new Error(`unsupported YAML at line ${index + 2}`);
    }
    const indent = match[1]!.length;
    if (indent % 2) {
      throw new Error(`indentation must use two spaces at line ${index + 2}`);
    }
    while (stack.at(-1)!.indent >= indent) {
      stack.pop();
    }
    if (indent > stack.at(-1)!.indent + 2) {
      throw new Error(`invalid indentation at line ${index + 2}`);
    }
    const parent = stack.at(-1)!.value;
    const key = match[2]!;
    if (Object.hasOwn(parent, key)) {
      throw new Error(`duplicate YAML key: ${key}`);
    }
    if (match[3] === undefined) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = scalar(match[3]);
    }
  }
  return { data: root, body: normalized.slice(end + 5) };
}

async function contained(root: string, candidate: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isPathWithinRoot(realCandidate, realRoot)) {
    throw new Error(`source escapes inventory root: ${candidate}`);
  }
  return realCandidate;
}

function parseCanonical(
  data: Record<string, unknown>,
  directory: string,
): {
  identity: string;
  description: string;
  triggers?: string;
  packs: SkillPack[];
  exposure: Exposure;
} {
  for (const key of Object.keys(data)) {
    if (!allowedTop.has(key)) {
      throw new Error(`unknown frontmatter key: ${key}`);
    }
  }
  const identity = data.name;
  if (typeof identity !== 'string' || !ID.test(identity) || identity.includes(':')) {
    throw new Error('name must be a lowercase bare kebab identity');
  }
  if (identity !== directory) {
    throw new Error(`identity ${identity} does not agree with directory ${directory}`);
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error('description is required');
  }
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const mpx = metadata?.mpx as Record<string, unknown> | undefined;
  if (
    !metadata ||
    Object.keys(metadata).join() !== 'mpx' ||
    !mpx ||
    Object.keys(mpx).some((k) => !['skillPacks', 'defaultExposure'].includes(k))
  ) {
    throw new Error('metadata.mpx with only skillPacks/defaultExposure is required');
  }
  const packs = mpx.skillPacks;
  if (
    !Array.isArray(packs) ||
    packs.length === 0 ||
    packs.some((p) => !SKILL_PACKS.includes(p as SkillPack))
  ) {
    throw new Error('metadata.mpx.skillPacks contains an unknown pack');
  }
  const exposure = mpx.defaultExposure;
  if (!EXPOSURES.includes(exposure as Exposure)) {
    throw new Error('metadata.mpx.defaultExposure is invalid');
  }
  const result = {
    identity,
    description: data.description,
    packs: [...new Set(packs as SkillPack[])].sort(),
    exposure: exposure as Exposure,
  };
  return typeof data.triggers === 'string' ? { ...result, triggers: data.triggers } : result;
}

export async function inventoryCanonical(root: string): Promise<CanonicalSkill[]> {
  const diagnostics: Diagnostic[] = [];
  const skills: CanonicalSkill[] = [];
  const byReal = new Set<string>();
  const byId = new Map<string, string>();
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(root, entry.name, 'SKILL.md');
    try {
      const real = await contained(root, file);
      if (byReal.has(real)) {
        continue;
      }
      const text = await readFile(real, 'utf8');
      const parsed = frontmatter(text);
      const value = parseCanonical(parsed.data, entry.name);
      const previous = byId.get(value.identity);
      if (previous && previous !== real) {
        throw new Error(`identity collides with ${previous}`);
      }
      byId.set(value.identity, real);
      byReal.add(real);
      skills.push({
        identity: value.identity,
        description: value.description,
        ...(value.triggers ? { triggers: value.triggers } : {}),
        skillPacks: value.packs,
        defaultExposure: value.exposure,
        sourcePath: file,
        realPath: real,
        contentHash: createHash('sha256').update(text).digest('hex'),
      });
    } catch (error) {
      diagnostics.push({
        code: 'SKILL_INVALID',
        message: String((error as Error).message),
        path: file,
      });
    }
  }
  if (diagnostics.length) {
    throw new SkillCatalogError(diagnostics);
  }
  return skills.sort((a, b) => a.identity.localeCompare(b.identity));
}

export interface ProjectSkillDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink?(): boolean;
}
export interface ProjectSkillDirectory {
  [Symbol.asyncIterator](): AsyncIterator<ProjectSkillDirectoryEntry>;
}
export interface ProjectSkillFileSystem {
  opendir(root: string): Promise<ProjectSkillDirectory>;
  realpath(file: string): Promise<string>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  enumerateDirectory?(
    directory: string,
    inventoryBytesRemaining: number,
  ): Promise<readonly SkillDirectoryFile[]>;
}
const projectSkillFileSystem: ProjectSkillFileSystem = {
  opendir,
  realpath,
  readFile: (file, encoding) => readFile(file, encoding),
  enumerateDirectory: enumerateSkillDirectory,
};

async function projectSkillCandidates(
  root: string,
  filesystem: ProjectSkillFileSystem,
): Promise<ProjectSkillDirectoryEntry[]> {
  const directory = await filesystem.opendir(root);
  const iterator = directory[Symbol.asyncIterator]();
  const candidates: ProjectSkillDirectoryEntry[] = [];
  let entriesExamined = 0;
  try {
    while (true) {
      const result = await iterator.next();
      if (result.done) {
        return candidates;
      }
      entriesExamined += 1;
      if (entriesExamined > MAX_PROJECT_SKILL_DIRECTORY_ENTRIES) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_INVENTORY_LIMIT',
            message: `project skill inventory exceeds ${MAX_PROJECT_SKILL_DIRECTORY_ENTRIES} directory entries`,
            path: root,
          },
        ]);
      }
      const entry = result.value;
      if (!entry.isDirectory() && !entry.isSymbolicLink?.()) {
        continue;
      }
      candidates.push(entry);
      if (candidates.length > MAX_PROJECT_SKILL_CANDIDATES) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_INVENTORY_LIMIT',
            message: `project skill inventory exceeds ${MAX_PROJECT_SKILL_CANDIDATES} candidates`,
            path: root,
          },
        ]);
      }
    }
  } finally {
    await iterator.return?.();
  }
}
function absentInventory(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    (error as NodeJS.ErrnoException)?.code === 'ENOTDIR'
  );
}
function inventoryIoFailure(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.code === 'string' && !absentInventory(error);
}
async function containedProject(
  root: string,
  candidate: string,
  filesystem: ProjectSkillFileSystem,
): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([
    filesystem.realpath(root),
    filesystem.realpath(candidate),
  ]);
  if (!isPathWithinRoot(realCandidate, realRoot)) {
    throw new Error(`source escapes inventory root: ${candidate}`);
  }
  return realCandidate;
}
export async function inventoryProjectSkills(
  projectRoot: string,
  canonical: readonly CanonicalSkill[] = [],
  filesystem: ProjectSkillFileSystem = projectSkillFileSystem,
): Promise<{ skills: ProjectSkill[]; diagnostics: Diagnostic[] }> {
  const root = path.join(projectRoot, '.agents', 'skills');
  const diagnostics: Diagnostic[] = [];
  const skills: ProjectSkill[] = [];
  const acceptedIdentities = new Set(canonical.map((x) => x.identity));
  let candidates: ProjectSkillDirectoryEntry[];
  try {
    candidates = await projectSkillCandidates(root, filesystem);
  } catch (error) {
    if (error instanceof SkillCatalogError) {
      throw error;
    }
    if (absentInventory(error)) {
      return { skills, diagnostics };
    }
    throw new SkillCatalogError([
      {
        code: 'PROJECT_SKILL_INVENTORY_FAILED',
        message: String((error as Error).message),
        path: root,
      },
    ]);
  }
  let realProjectRoot: string;
  try {
    realProjectRoot = await filesystem.realpath(projectRoot);
  } catch (error) {
    if (inventoryIoFailure(error)) {
      throw new SkillCatalogError([
        {
          code: 'PROJECT_SKILL_INVENTORY_FAILED',
          message: String((error as Error).message),
          path: root,
        },
      ]);
    }
    realProjectRoot = projectRoot;
  }
  let inventoryBytes = 0;
  for (const entry of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink?.()) {
      diagnostics.push({
        code: 'PROJECT_SKILL_INVALID',
        message: 'project skill directories cannot be symlinks',
        path: path.join(root, entry.name),
      });
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(root, entry.name, 'SKILL.md');
    try {
      const real = await containedProject(root, file, filesystem);
      let files: readonly SkillDirectoryFile[];
      if (filesystem.enumerateDirectory) {
        files = await filesystem.enumerateDirectory(
          path.dirname(real),
          MAX_PROJECT_SKILL_INVENTORY_BYTES - inventoryBytes,
        );
      } else {
        const text = await filesystem.readFile(real, 'utf8');
        files = [{ relativePath: 'SKILL.md', bytes: Buffer.from(text, 'utf8') }];
      }
      const candidateBytes = files.reduce((total, item) => total + item.bytes.length, 0);
      if (candidateBytes > MAX_PROJECT_SKILL_INVENTORY_BYTES - inventoryBytes) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_INVENTORY_LIMIT',
            message: `project skill inventory exceeds ${MAX_PROJECT_SKILL_INVENTORY_BYTES} bytes`,
            path: file,
          },
        ]);
      }
      inventoryBytes += candidateBytes;
      const skillFile = files.find((item) => item.relativePath === 'SKILL.md');
      if (!skillFile) {
        throw new Error('project skill directory has no SKILL.md');
      }
      const text = skillFile.bytes.toString('utf8');
      const { data } = frontmatter(text);
      const name = data.name;
      if (
        typeof name !== 'string' ||
        !ID.test(name) ||
        name !== entry.name ||
        name.startsWith('mpx-') ||
        name.includes(':')
      ) {
        throw new Error('project identity is invalid or attempts /mpx:* namespace');
      }
      if (acceptedIdentities.has(name)) {
        throw new Error('deterministic runtime collision');
      }
      const mpx = (data.metadata as Record<string, unknown> | undefined)?.mpx as
        Record<string, unknown> | undefined;
      const exposure = mpx?.projectExposure;
      if (exposure !== 'full' && exposure !== 'explicit-only') {
        throw new Error('metadata.mpx.projectExposure must be full or explicit-only');
      }
      const disabled = data['disable-model-invocation'] === true;
      if ((exposure === 'full' && disabled) || (exposure === 'explicit-only' && !disabled)) {
        throw new Error('projectExposure and disable-model-invocation mismatch');
      }
      if (typeof data.description !== 'string') {
        throw new Error('description is required');
      }
      acceptedIdentities.add(name);
      skills.push({
        identity: name,
        description: data.description,
        projectExposure: exposure,
        disableModelInvocation: disabled,
        sourcePath: file,
        realPath: real,
        contentHash: createHash('sha256').update(skillFile.bytes).digest('hex'),
        directoryHash: directoryDigest(files),
        projectRoot,
        realProjectRoot,
      });
    } catch (error) {
      if (error instanceof SkillCatalogError) {
        throw error;
      }
      if (error instanceof ProjectSkillInventoryByteLimitError) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_INVENTORY_LIMIT',
            message: `project skill inventory exceeds ${MAX_PROJECT_SKILL_INVENTORY_BYTES} bytes`,
            path: file,
          },
        ]);
      }
      if (inventoryIoFailure(error)) {
        throw new SkillCatalogError([
          {
            code: 'PROJECT_SKILL_INVENTORY_FAILED',
            message: String((error as Error).message),
            path: file,
          },
        ]);
      }
      diagnostics.push({
        code: 'PROJECT_SKILL_INVALID',
        message: String((error as Error).message),
        path: file,
      });
    }
  }
  return { skills, diagnostics };
}

function isProjectSkill(skill: CatalogSkill): skill is ProjectSkill {
  return 'directoryHash' in skill;
}
function directoryDigest(files: readonly SkillDirectoryFile[]): string {
  return digest(
    files.map((file) => ({
      path: file.relativePath,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  );
}
function skillSourceHash(skill: CatalogSkill): string {
  return isProjectSkill(skill)
    ? digest({
        kind: 'project',
        projectRoot: skill.realProjectRoot,
        path: skill.realPath,
        contentHash: skill.contentHash,
        directoryHash: skill.directoryHash,
      })
    : skill.contentHash;
}

function effectiveExposure(
  skill: CanonicalSkill,
  options: ResolveOptions,
): { exposure: Exposure; source: string } {
  const p = options.projectExposure,
    s = options.contentScopeExposure;
  if (p?.skills?.[skill.identity]) {
    return { exposure: p.skills[skill.identity]!, source: 'project skill override' };
  }
  if (p?.default) {
    return { exposure: p.default, source: 'project default' };
  }
  if (s?.skills?.[skill.identity]) {
    return { exposure: s.skills[skill.identity]!, source: 'content-scope skill override' };
  }
  if (s?.default) {
    return { exposure: s.default, source: 'content-scope default' };
  }
  const catalogExposure = {
    exposure: skill.defaultExposure ?? 'name-only',
    source: skill.defaultExposure ? 'canonical default' : 'fallback',
  };
  return catalogExposure;
}

/** Disclosure descends from initial body metadata to name, explicit human lookup, then absence. */
const disclosureRank: Record<Exposure, number> = {
  full: 3,
  'name-only': 2,
  'explicit-only': 1,
  off: 0,
};

function narrower(left: Exposure, right: Exposure): Exposure {
  return disclosureRank[left] <= disclosureRank[right] ? left : right;
}
function policyExposure(
  skill: CatalogSkill,
  options: ResolveOptions,
): { exposure: Exposure; source: string } {
  const policy = options.skillPolicyConfig.skillExposure;
  const selectedPolicyExposure = policy.skills?.[skill.identity] ?? policy.default;
  if (isProjectSkill(skill)) {
    const scopeExposure =
      options.contentScopeExposure?.skills?.[skill.identity] ??
      options.contentScopeExposure?.default ??
      'full';
    const projectExposure =
      options.projectExposure?.skills?.[skill.identity] ??
      options.projectExposure?.default ??
      'full';
    return {
      exposure: [scopeExposure, projectExposure, selectedPolicyExposure].reduce(
        narrower,
        skill.projectExposure as Exposure,
      ),
      source: `project catalog ceiling (${skill.projectExposure}); narrowed by content scope (${scopeExposure}), project (${projectExposure}), and skill policy '${options.skillPolicy}' (${selectedPolicyExposure})`,
    };
  }
  const base = effectiveExposure(skill, options);
  return {
    exposure: narrower(base.exposure, selectedPolicyExposure),
    source: `${base.source}; narrowed by skill policy '${options.skillPolicy}' (${selectedPolicyExposure})`,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function effectiveSkillPacks(options: ResolveOptions): SkillPack[] {
  return resolveEffectiveSkillPacks({
    contentScopeSkillPacks: options.enabledPacks,
    skillPolicySkillPacks: options.skillPolicyConfig.skillPacks,
  });
}

export function resolveManifest(
  catalog: readonly CatalogSkill[],
  options: ResolveOptions,
): ResolvedManifest {
  const enabled = new Set(effectiveSkillPacks(options));
  const resolution = {
    identity: options.identity,
    skillPolicy: options.skillPolicy,
    skillPolicyConfig: options.skillPolicyConfig,
    enabledPacks: [...enabled].sort(),
    contentScopeExposure: options.contentScopeExposure ?? null,
    projectExposure: options.projectExposure ?? null,
    mapping: options.mapping ?? {},
  };
  const decisions: ResolvedSkillDecisionV4[] = catalog.map((skill) => {
    const packIncluded =
      isProjectSkill(skill) || skill.skillPacks.some((pack) => enabled.has(pack));
    const effective = policyExposure(skill, options);
    const off = effective.exposure === 'off';
    const included = packIncluded && !off;
    return {
      identity: skill.identity,
      included,
      exclusionReasons: [
        ...(!packIncluded ? ['pack-excluded'] : []),
        ...(packIncluded && off ? ['off'] : []),
      ],
      exposure: effective.exposure,
      permissions: {
        humanInvocation: included,
        modelInvocation:
          included && (effective.exposure === 'full' || effective.exposure === 'name-only'),
      },
      metadataHash: digest({
        resolution,
        identity: skill.identity,
        description: skill.description,
        triggers: isProjectSkill(skill) ? null : (skill.triggers ?? null),
        origin: isProjectSkill(skill)
          ? {
              kind: 'project',
              projectRoot: skill.realProjectRoot,
              directoryHash: skill.directoryHash,
            }
          : { kind: 'canonical' },
        packs: isProjectSkill(skill) ? [] : [...skill.skillPacks].sort(),
        defaultExposure: isProjectSkill(skill) ? skill.projectExposure : skill.defaultExposure,
        effectiveExposure: effective.exposure,
        exposureSource: effective.source,
      }),
      sourceHash: skillSourceHash(skill),
    };
  });
  return createResolvedSkillManifestV4({
    binding: {
      projectId: options.projectId ?? null,
      repositoryId: options.repositoryId,
      contentScope: options.contentScope,
    },
    decisions,
  });
}

export function explainSkill(
  skill: CatalogSkill,
  options: ResolveOptions,
): { identity: string; included: boolean; exposure?: Exposure; source?: string } {
  const enabled = new Set(effectiveSkillPacks(options));
  const packIncluded = isProjectSkill(skill) || skill.skillPacks.some((pack) => enabled.has(pack));
  if (!packIncluded) {
    return { identity: skill.identity, included: false };
  }
  const result = policyExposure(skill, options);
  return {
    identity: skill.identity,
    included: result.exposure !== 'off',
    exposure: result.exposure,
    source: result.source,
  };
}

export function doctor(
  canonical: readonly CanonicalSkill[],
  project: { skills: ProjectSkill[]; diagnostics: Diagnostic[] },
): Diagnostic[] {
  const diagnostics = [...project.diagnostics];
  const ids = new Set(canonical.map((x) => x.identity));
  for (const skill of project.skills) {
    if (ids.has(skill.identity)) {
      diagnostics.push({
        code: 'SKILL_COLLISION',
        message: `${skill.identity} collides with /mpx:${skill.identity}`,
        path: skill.sourcePath,
      });
    }
    if (skill.projectExposure === 'full') {
      diagnostics.push({
        code: 'PROJECT_SKILL_CONTEXT_COST',
        message: `${skill.identity} opts its description into initial context`,
        path: skill.sourcePath,
      });
    }
  }
  return diagnostics.sort((a, b) =>
    `${a.code}\0${a.path ?? ''}\0${a.message}`.localeCompare(
      `${b.code}\0${b.path ?? ''}\0${b.message}`,
    ),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function artifactFileMap(entries: readonly RuntimeSkillEntry[]): unknown[] {
  return entries
    .map((entry) => ({
      identity: entry.identity,
      publicName: entry.publicName,
      packs: [...entry.packs].sort(),
      exposure: entry.exposure,
      metadataHash: entry.metadataHash,
      description: entry.description ?? null,
      triggers: entry.triggers ?? null,
      source:
        entry.source.kind === 'project'
          ? {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
              directoryHash: entry.source.directoryHash,
              projectRoot: entry.source.projectRoot,
              realProjectRoot: entry.source.realProjectRoot,
            }
          : {
              kind: entry.source.kind,
              path: entry.source.path,
              realPath: entry.source.realPath,
              contentHash: entry.source.contentHash,
            },
      permissions: { ...entry.permissions },
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

export function createRuntimeSkillArtifact(
  manifestValue: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  options: { runtime: Runtime; mapping?: Readonly<Record<string, string>> },
): RuntimeSkillArtifact {
  const manifest = parseResolvedSkillManifestV4(manifestValue);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  if (source.size !== manifest.decisions.length) {
    catalogError(
      'STALE_CATALOG',
      'skill catalog membership no longer matches the resolved manifest',
    );
  }
  for (const decision of manifest.decisions) {
    const skill = source.get(decision.identity);
    if (!skill || skillSourceHash(skill) !== decision.sourceHash) {
      catalogError(
        'STALE_CATALOG',
        `skill '${decision.identity}' no longer matches the resolved manifest`,
      );
    }
  }
  const entries = manifest.decisions
    .filter((decision) => decision.included)
    .map((decision): RuntimeSkillEntry =>
      runtimeEntry(source.get(decision.identity)!, decision, options.mapping ?? {}),
    )
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const fileMapHash = digest(artifactFileMap(entries));
  const artifactKey = digest({
    schemaVersion: 4,
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    fileMapHash,
  });
  const reference = createRuntimeSkillArtifactReferenceV4({
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    artifactKey,
    fileMapHash,
  });
  const artifact: RuntimeSkillArtifact = {
    schemaVersion: 4,
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    reference,
    entries,
  };
  return verifyRuntimeSkillArtifact(artifact, manifest, catalog, options);
}

function catalogError(code: string, message: string): never {
  throw new SkillCatalogError([{ code, message }]);
}
function tampered(reason: string, identity?: string): never {
  throw new RuntimeContractError(
    'RUNTIME_ARTIFACT_TAMPERED',
    'runtime artifact no longer matches its bound resolved manifest',
    { restartRequired: true, reason, ...(identity === undefined ? {} : { identity }) },
  );
}
function runtimeEntry(
  skill: CatalogSkill,
  decision: ResolvedSkillDecisionV4,
  mapping: Readonly<Record<string, string>>,
): RuntimeSkillEntry {
  const project = isProjectSkill(skill);
  return {
    identity: skill.identity,
    publicName:
      mapping[skill.identity] ?? (project ? `/${skill.identity}` : `/mpx:${skill.identity}`),
    packs: project ? [] : [...skill.skillPacks].sort(),
    exposure: decision.exposure,
    metadataHash: decision.metadataHash,
    ...(decision.exposure === 'full'
      ? {
          description: skill.description,
          ...(!project && skill.triggers ? { triggers: skill.triggers } : {}),
        }
      : {}),
    source: project
      ? {
          kind: 'project',
          path: skill.sourcePath,
          realPath: skill.realPath,
          contentHash: skill.contentHash,
          directoryHash: skill.directoryHash,
          projectRoot: skill.projectRoot,
          realProjectRoot: skill.realProjectRoot,
        }
      : {
          kind: 'canonical',
          path: skill.sourcePath,
          realPath: skill.realPath,
          contentHash: skill.contentHash,
        },
    permissions: { ...decision.permissions },
  };
}
function expectedRuntimeEntries(
  manifest: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  mapping: Readonly<Record<string, string>>,
): RuntimeSkillEntry[] {
  const source = new Map<string, CatalogSkill>();
  for (const skill of catalog) {
    if (source.has(skill.identity)) {
      tampered('duplicate-catalog-identity', skill.identity);
    }
    source.set(skill.identity, skill);
  }
  if (source.size !== manifest.decisions.length) {
    tampered('catalog-membership');
  }
  const decisionIds = new Set<string>();
  const entries: RuntimeSkillEntry[] = [];
  for (const decision of manifest.decisions) {
    if (decisionIds.has(decision.identity)) {
      tampered('duplicate-manifest-decision', decision.identity);
    }
    decisionIds.add(decision.identity);
    const skill = source.get(decision.identity);
    if (!skill || skillSourceHash(skill) !== decision.sourceHash) {
      tampered('catalog-source-hash', decision.identity);
    }
    if (!decision.included) {
      continue;
    }
    if (
      decision.exposure === 'off' ||
      decision.exclusionReasons.includes('off') ||
      decision.exclusionReasons.includes('pack-excluded')
    ) {
      tampered('invalid-inclusion-decision', decision.identity);
    }
    entries.push(runtimeEntry(skill, decision, mapping));
  }
  return entries.sort((a, b) => a.identity.localeCompare(b.identity));
}
export function verifyRuntimeSkillArtifact(
  artifact: RuntimeSkillArtifact,
  manifestValue: ResolvedManifest,
  catalog: readonly CatalogSkill[],
  options: { runtime: Runtime; mapping?: Readonly<Record<string, string>> },
): RuntimeSkillArtifact {
  let manifest: ResolvedManifest;
  try {
    manifest = parseResolvedSkillManifestV4(manifestValue);
  } catch {
    return tampered('manifest-invalid');
  }
  if (
    artifact.schemaVersion !== 4 ||
    artifact.runtime !== options.runtime ||
    artifact.manifestKey !== manifest.manifestKey
  ) {
    tampered('artifact-binding');
  }
  const expectedEntries = expectedRuntimeEntries(manifest, catalog, options.mapping ?? {});
  const expectedById = new Map(expectedEntries.map((entry) => [entry.identity, entry]));
  const actualIds = new Set<string>();
  for (const entry of artifact.entries) {
    if (actualIds.has(entry.identity)) {
      tampered('duplicate-entry', entry.identity);
    }
    actualIds.add(entry.identity);
    const expected = expectedById.get(entry.identity);
    if (!expected) {
      tampered('extra-or-excluded-entry', entry.identity);
    }
    for (const field of [
      'publicName',
      'packs',
      'exposure',
      'metadataHash',
      'description',
      'triggers',
      'source',
      'permissions',
    ] as const) {
      if (stable(entry[field]) !== stable(expected[field])) {
        tampered(`${field}-mismatch`, entry.identity);
      }
    }
  }
  for (const expected of expectedEntries) {
    if (!actualIds.has(expected.identity)) {
      tampered('missing-entry', expected.identity);
    }
  }
  if (
    artifact.entries.map((entry) => entry.identity).join('\0') !==
    expectedEntries.map((entry) => entry.identity).join('\0')
  ) {
    tampered('entry-order');
  }
  const fileMapHash = digest(artifactFileMap(expectedEntries));
  const expectedReference = createRuntimeSkillArtifactReferenceV4({
    runtime: options.runtime,
    manifestKey: manifest.manifestKey,
    fileMapHash,
    artifactKey: digest({
      schemaVersion: 4,
      runtime: options.runtime,
      manifestKey: manifest.manifestKey,
      fileMapHash,
    }),
  });
  let reference: RuntimeSkillArtifactReferenceV4;
  try {
    reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference);
  } catch {
    return tampered('reference-invalid');
  }
  if (stable(reference) !== stable(expectedReference)) {
    tampered('file-map-binding');
  }
  return artifact;
}

function validateArtifact(
  artifact: RuntimeSkillArtifact,
  catalog?: readonly CatalogSkill[],
  artifactKey?: string,
): RuntimeSkillArtifact {
  try {
    if (
      artifact.schemaVersion !== 4 ||
      artifact.manifestKey !== artifact.reference.manifestKey ||
      artifact.runtime !== artifact.reference.runtime
    ) {
      throw new Error('schema or binding mismatch');
    }
    const reference = parseRuntimeSkillArtifactReferenceV4(artifact.reference);
    const fileMapHash = digest(artifactFileMap(artifact.entries));
    const calculatedKey = digest({
      schemaVersion: 4,
      runtime: artifact.runtime,
      manifestKey: artifact.manifestKey,
      fileMapHash,
    });
    if (
      reference.fileMapHash !== fileMapHash ||
      reference.artifactKey !== calculatedKey ||
      (artifactKey !== undefined && artifactKey !== reference.artifactKey)
    ) {
      throw new Error('artifact hash mismatch');
    }
    if (catalog) {
      const source = new Map(catalog.map((skill) => [skill.identity, skill]));
      for (const entry of artifact.entries) {
        const skill = source.get(entry.identity);
        if (
          !skill ||
          skill.contentHash !== entry.source.contentHash ||
          (isProjectSkill(skill) &&
            (entry.source.kind !== 'project' || skill.directoryHash !== entry.source.directoryHash))
        ) {
          throw new Error('catalog hash mismatch');
        }
      }
    }
    return artifact;
  } catch {
    return catalogError(
      'STALE_ARTIFACT',
      'runtime operation requires the current exact v4 artifact',
    );
  }
}

export function searchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { artifactKey?: string; runtime?: boolean; limit?: number } = {},
): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_SKILL_SEARCH_QUERY_LENGTH) {
    catalogError(
      'QUERY_TOO_LONG',
      `skill search queries are limited to ${MAX_SKILL_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  validateArtifact(artifact, catalog, options.runtime ? options.artifactKey : undefined);
  const limit = Math.max(
    0,
    Math.min(MAX_SKILL_SEARCH_RESULTS, options.limit ?? MAX_SKILL_SEARCH_RESULTS),
  );
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const source = new Map(catalog.map((x) => [x.identity, x]));
  return artifact.entries
    .filter(
      (entry) =>
        (entry.exposure === 'full' || entry.exposure === 'name-only') &&
        entry.permissions.modelInvocation,
    )
    .flatMap((entry) => {
      const skill = source.get(entry.identity);
      if (!skill) {
        return [];
      }
      const haystack =
        `${skill.identity} ${skill.description} ${isProjectSkill(skill) ? '' : (skill.triggers ?? '')}`.toLowerCase();
      const score = terms.reduce(
        (n, t) => n + (haystack.includes(t) ? (skill.identity.includes(t) ? 3 : 1) : 0),
        0,
      );
      return [
        {
          identity: skill.identity,
          publicName: entry.publicName,
          description: skill.description,
          score,
        },
      ];
    })
    .filter((x) => terms.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity))
    .slice(0, limit);
}

export function modelSearchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { artifactKey: string; limit?: number },
): Array<{ identity: string; publicName: string; description: string; score: number }> {
  return searchSkills(artifact, catalog, query, {
    runtime: true,
    artifactKey: options.artifactKey,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export function humanSearchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { limit?: number } = {},
): Array<{ identity: string; publicName: string; description: string; score: number }> {
  if (query.length > MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH) {
    catalogError(
      'QUERY_TOO_LONG',
      `human skill search queries are limited to ${MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  validateArtifact(artifact, catalog);
  const limit = Math.max(
    0,
    Math.min(MAX_HUMAN_SKILL_SEARCH_RESULTS, options.limit ?? MAX_HUMAN_SKILL_SEARCH_RESULTS),
  );
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  return artifact.entries
    .filter((entry) => entry.permissions.humanInvocation)
    .flatMap((entry) => {
      const skill = source.get(entry.identity);
      if (!skill) {
        return [];
      }
      const haystack =
        `${skill.identity} ${skill.description} ${isProjectSkill(skill) ? '' : (skill.triggers ?? '')}`.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total + (haystack.includes(term) ? (skill.identity.includes(term) ? 3 : 1) : 0),
        0,
      );
      return [
        {
          identity: skill.identity,
          publicName: entry.publicName,
          description: skill.description,
          score,
        },
      ];
    })
    .filter((result) => terms.length === 0 || result.score > 0)
    .sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity))
    .slice(0, limit);
}

export interface HumanSkillName {
  identity: string;
  publicName: string;
}
export function humanListSkills(artifact: RuntimeSkillArtifact): HumanSkillName[] {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.humanInvocation)
    .map(({ identity, publicName }) => ({ identity, publicName }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}
export function humanCompleteSkills(artifact: RuntimeSkillArtifact, prefix: string): string[] {
  const normalized = prefix.toLowerCase();
  return humanListSkills(artifact)
    .map((x) => x.publicName)
    .filter((x) => x.toLowerCase().startsWith(normalized));
}
export function humanSkillDetail(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  identity: string,
): { identity: string; publicName: string; description: string } | undefined {
  validateArtifact(artifact, catalog);
  const entry = artifact.entries.find(
    (x) => x.identity === identity && x.permissions.humanInvocation,
  );
  const skill = catalog.find((x) => x.identity === identity);
  return entry && skill
    ? { identity, publicName: entry.publicName, description: skill.description }
    : undefined;
}
export function initialModelContext(
  artifact: RuntimeSkillArtifact,
): Array<{ identity: string; publicName: string; description?: string; triggers?: string }> {
  validateArtifact(artifact);
  return artifact.entries
    .filter((x) => x.permissions.modelInvocation)
    .map((x) => ({
      identity: x.identity,
      publicName: x.publicName,
      ...(x.exposure === 'full' && x.description ? { description: x.description } : {}),
      ...(x.exposure === 'full' && x.triggers ? { triggers: x.triggers } : {}),
    }));
}

export type SkillInvocation = 'model' | 'human-explicit';
export interface LoadedSkillBody {
  identity: string;
  body: string;
  wrappedBody: string;
  provenance: {
    artifactKey: string;
    contentHash: string;
    invocation: SkillInvocation;
    runtime: Runtime;
    sourcePath: string;
  };
}
export interface SkillBodyRequest {
  canonicalRoot: string;
  manifest: ResolvedManifest;
  artifact: RuntimeSkillArtifact;
  runtime: Runtime;
  identity: string;
  invocation: SkillInvocation;
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export async function loadSkillBody(request: SkillBodyRequest): Promise<LoadedSkillBody> {
  let manifest: ResolvedManifest;
  try {
    manifest = parseResolvedSkillManifestV4(request.manifest);
  } catch {
    return catalogError('STALE_ARTIFACT', 'skill loading requires the current exact v4 manifest');
  }
  validateArtifact(request.artifact);
  if (request.artifact.manifestKey !== manifest.manifestKey) {
    catalogError('STALE_ARTIFACT', 'artifact does not belong to the resolved manifest');
  }
  if (request.runtime !== request.artifact.runtime) {
    catalogError('SKILL_RUNTIME_MISMATCH', 'requested runtime does not match the artifact');
  }
  const entry = request.artifact.entries.find((x) => x.identity === request.identity);
  if (!entry) {
    catalogError(
      'SKILL_NOT_IN_ARTIFACT',
      `skill '${request.identity}' is excluded from the runtime artifact`,
    );
  }
  if (request.invocation !== 'model' && request.invocation !== 'human-explicit') {
    catalogError('SKILL_INVOCATION_INVALID', 'skill invocation must be model or human-explicit');
  }
  const permitted =
    request.invocation === 'model'
      ? entry.permissions.modelInvocation
      : entry.permissions.humanInvocation;
  if (!permitted) {
    catalogError(
      'SKILL_INVOCATION_DENIED',
      `skill '${request.identity}' does not permit ${request.invocation} loading`,
    );
  }
  let currentPath: string;
  if (entry.source.kind === 'canonical') {
    const expectedSourcePath = path.join(request.canonicalRoot, entry.identity, 'SKILL.md');
    try {
      currentPath = await contained(request.canonicalRoot, entry.source.path);
    } catch {
      return catalogError(
        'SKILL_PATH_INVALID',
        `skill '${request.identity}' is outside its canonical root`,
      );
    }
    if (!samePath(entry.source.path, expectedSourcePath)) {
      catalogError(
        'SKILL_PROVENANCE_MISMATCH',
        `skill '${request.identity}' source does not match its canonical identity path`,
      );
    }
  } else {
    const expectedSourcePath = path.join(
      entry.source.projectRoot,
      '.agents',
      'skills',
      entry.identity,
      'SKILL.md',
    );
    if (!samePath(entry.source.path, expectedSourcePath)) {
      catalogError(
        'SKILL_PROVENANCE_MISMATCH',
        `skill '${request.identity}' source does not match its project identity path`,
      );
    }
    try {
      const resolvedProjectRoot = await realpath(entry.source.projectRoot);
      currentPath = await contained(entry.source.projectRoot, entry.source.path);
      if (!samePath(resolvedProjectRoot, entry.source.realProjectRoot)) {
        catalogError(
          'SKILL_PATH_STALE',
          `skill '${request.identity}' project root no longer matches the artifact`,
        );
      }
      if (
        directoryDigest(await enumerateSkillDirectory(path.dirname(currentPath))) !==
        entry.source.directoryHash
      ) {
        catalogError(
          'SKILL_DIRECTORY_STALE',
          `skill '${request.identity}' directory no longer matches the artifact`,
        );
      }
    } catch (error) {
      if (error instanceof SkillCatalogError) {
        throw error;
      }
      return catalogError(
        'SKILL_PATH_INVALID',
        `skill '${request.identity}' is outside its project root or no longer inventory-safe`,
      );
    }
  }
  if (!samePath(currentPath, entry.source.realPath)) {
    catalogError(
      'SKILL_PATH_STALE',
      `skill '${request.identity}' no longer resolves to its artifact path`,
    );
  }
  const text = await readFile(currentPath, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BODY_BYTES) {
    catalogError(
      'SKILL_BODY_TOO_LARGE',
      `skill files are limited to ${MAX_SKILL_BODY_BYTES} bytes`,
    );
  }
  const contentHash = createHash('sha256').update(text).digest('hex');
  if (contentHash !== entry.source.contentHash) {
    catalogError(
      'SKILL_CONTENT_STALE',
      `skill '${request.identity}' content no longer matches the artifact`,
    );
  }
  const body = frontmatter(text).body;
  const artifactKey = request.artifact.reference.artifactKey;
  const provenance = {
    artifactKey,
    contentHash,
    invocation: request.invocation,
    runtime: request.runtime,
    sourcePath:
      entry.source.kind === 'canonical'
        ? `content/skills/${entry.identity}/SKILL.md`
        : path.relative(entry.source.projectRoot, entry.source.path).split(path.sep).join('/'),
  };
  return {
    identity: entry.identity,
    body,
    wrappedBody: `<!-- mpx-skill identity=${entry.identity} origin=${request.invocation} runtime=${request.runtime} artifact=${artifactKey} hash=${contentHash} -->\n${body}<!-- /mpx-skill -->`,
    provenance,
  };
}
