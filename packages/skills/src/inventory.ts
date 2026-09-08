import { isPathWithinRoot } from '@mpx/core';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  SkillCatalogError,
  digest,
  type CanonicalSkill,
  type CatalogSkill,
  type Diagnostic,
  type ProjectSkill,
} from './contracts.js';
import { ID, frontmatter, parseCanonical } from './frontmatter.js';
import { classifyProjectSkill } from './project-skill-classification.js';

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
  onFileBytes?: (relativePath: string, byteCount: number) => void,
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
        if (stat.size > MAX_SKILL_DIRECTORY_BYTES - totalBytes) {
          throw new Error('skill directory exceeds byte limit');
        }
        const relativePath = path.relative(root, candidate).split(path.sep).join('/');
        onFileBytes?.(relativePath, stat.size);
        const bytes = await readExactSkillFile(
          candidate,
          stat,
          MAX_SKILL_DIRECTORY_BYTES - totalBytes,
        );
        totalBytes += bytes.length;
        const file = Object.freeze({
          relativePath,
          bytes,
        });
        files.push(file);
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

export async function contained(root: string, candidate: string): Promise<string> {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isPathWithinRoot(realCandidate, realRoot)) {
    throw new Error(`source escapes inventory root: ${candidate}`);
  }
  return realCandidate;
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
        schemaVersion: value.schemaVersion,
        ...(value.contentVersion ? { contentVersion: value.contentVersion } : {}),
        description: value.description,
        ...(value.triggers ? { triggers: value.triggers } : {}),
        ...(value.argumentHint ? { argumentHint: value.argumentHint } : {}),
        ...(value.capabilities ? { capabilities: value.capabilities } : {}),
        ...(value.author ? { author: value.author } : {}),
        ...(value.version ? { version: value.version } : {}),
        ...(value.category ? { category: value.category } : {}),
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
  /** Undefined means the initial SKILL.md inspection found no entry, not a later read failure. */
  readFile(
    file: string,
    encoding: 'utf8',
    inventoryBytesRemaining?: number,
  ): Promise<string | undefined>;
  enumerateDirectory?(
    directory: string,
    inventoryBytesRemaining: number,
    onFileBytes?: (relativePath: string, byteCount: number) => void,
  ): Promise<readonly SkillDirectoryFile[]>;
}
async function regularProjectDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('project skill inventory roots must be regular directories');
    }
  }
}

const projectSkillFileSystem: ProjectSkillFileSystem = {
  opendir: async (root) => {
    await regularProjectDirectories([path.dirname(root), root]);
    return opendir(root);
  },
  realpath,
  readFile: async (file, encoding, inventoryBytesRemaining = MAX_PROJECT_SKILL_INVENTORY_BYTES) => {
    const directory = path.dirname(file);
    const root = path.dirname(directory);
    await regularProjectDirectories([path.dirname(root), root, directory]);
    const stat = await lstat(file).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      return undefined;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('project SKILL.md must be a regular file');
    }
    if (stat.size > inventoryBytesRemaining) {
      throw new ProjectSkillInventoryByteLimitError('project skill inventory byte limit exceeded');
    }
    return (await readExactSkillFile(file, stat, MAX_SKILL_DIRECTORY_BYTES)).toString(encoding);
  },
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
  _canonical: readonly CanonicalSkill[] = [],
  filesystem: ProjectSkillFileSystem = projectSkillFileSystem,
): Promise<{
  skills: ProjectSkill[];
  nativeSkillDirectories: string[];
  diagnostics: Diagnostic[];
}> {
  const root = path.join(projectRoot, '.agents', 'skills');
  const diagnostics: Diagnostic[] = [];
  const skills: ProjectSkill[] = [];
  const nativeSkillDirectories: string[] = [];
  const acceptedIdentities = new Set<string>();
  let candidates: ProjectSkillDirectoryEntry[];
  try {
    candidates = await projectSkillCandidates(root, filesystem);
  } catch (error) {
    if (error instanceof SkillCatalogError) {
      throw error;
    }
    if (absentInventory(error)) {
      return { skills, nativeSkillDirectories, diagnostics };
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
      await containedProject(projectRoot, root, filesystem);
      const directory = await containedProject(root, path.dirname(file), filesystem);
      const text = await filesystem.readFile(
        file,
        'utf8',
        MAX_PROJECT_SKILL_INVENTORY_BYTES - inventoryBytes,
      );
      if (text === undefined) {
        continue;
      }
      const real = await containedProject(path.dirname(file), file, filesystem);
      const classifiedBytes = Buffer.from(text, 'utf8');
      inventoryBytes += classifiedBytes.length;
      if (inventoryBytes > MAX_PROJECT_SKILL_INVENTORY_BYTES) {
        throw new ProjectSkillInventoryByteLimitError();
      }
      const classification = classifyProjectSkill(text);
      let files: readonly SkillDirectoryFile[];
      let reportedBytes = 0;
      if (filesystem.enumerateDirectory) {
        files = await filesystem.enumerateDirectory(
          directory,
          MAX_PROJECT_SKILL_INVENTORY_BYTES - inventoryBytes + classifiedBytes.length,
          (relativePath, byteCount) => {
            const additionalBytes =
              relativePath === 'SKILL.md'
                ? Math.max(0, byteCount - classifiedBytes.length)
                : byteCount;
            reportedBytes += additionalBytes;
            inventoryBytes += additionalBytes;
          },
        );
      } else {
        files = [{ relativePath: 'SKILL.md', bytes: classifiedBytes }];
      }
      const supplementalBytes = files.reduce(
        (total, item) =>
          total +
          (item.relativePath === 'SKILL.md'
            ? Math.max(0, item.bytes.length - classifiedBytes.length)
            : item.bytes.length),
        0,
      );
      inventoryBytes += supplementalBytes - reportedBytes;
      if (inventoryBytes > MAX_PROJECT_SKILL_INVENTORY_BYTES) {
        throw new ProjectSkillInventoryByteLimitError();
      }
      const skillFile = files.find((item) => item.relativePath === 'SKILL.md');
      if (!skillFile || !skillFile.bytes.equals(classifiedBytes)) {
        throw new Error('project SKILL.md changed after ownership classification');
      }
      if (classification === 'native') {
        nativeSkillDirectories.push(directory);
        continue;
      }
      const { data } = frontmatter(text);
      const name = data.name;
      if (
        typeof name !== 'string' ||
        !ID.test(name) ||
        name !== entry.name ||
        name.startsWith('mpx-') ||
        name.includes(':')
      ) {
        throw new Error(
          `managed project skill name must equal directory name '${entry.name}', use lowercase kebab-case, and must not start with 'mpx-' or contain ':'. Rename the directory and frontmatter name to the same valid value; it will be exposed as /skill:<name>`,
        );
      }
      if (acceptedIdentities.has(name)) {
        const previous = skills.find((skill) => skill.identity === name)!;
        diagnostics.push({
          code: 'PROJECT_SKILL_COLLISION',
          message: `managed project skill '${name}' duplicates /skill:${name} from '${previous.sourcePath}'. Rename one skill directory and its frontmatter name`,
          path: file,
        });
        continue;
      }
      const mpx = (data.metadata as Record<string, unknown> | undefined)?.mpx as
        Record<string, unknown> | undefined;
      const exposure = mpx?.projectExposure;
      if (exposure !== 'full' && exposure !== 'explicit-only') {
        throw new Error(
          "metadata.mpx.projectExposure must be exactly 'full' or 'explicit-only'. Set it to 'full' for model discovery or 'explicit-only' for /skill:<name> invocation only",
        );
      }
      const disabled = data['disable-model-invocation'] === true;
      if ((exposure === 'full' && disabled) || (exposure === 'explicit-only' && !disabled)) {
        throw new Error(
          `managed project exposure mismatch: '${exposure}' requires disable-model-invocation: ${exposure === 'explicit-only' ? 'true' : 'false'}. Update the frontmatter to those matching values`,
        );
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
  return { skills, nativeSkillDirectories, diagnostics };
}

export function isProjectSkill(skill: CatalogSkill): skill is ProjectSkill {
  return 'directoryHash' in skill;
}
export function directoryDigest(files: readonly SkillDirectoryFile[]): string {
  return digest(
    files.map((file) => ({
      path: file.relativePath,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  );
}
export function skillSourceHash(skill: CatalogSkill): string {
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

export function doctor(
  _canonical: readonly CanonicalSkill[],
  project: { skills: ProjectSkill[]; diagnostics: Diagnostic[] },
): Diagnostic[] {
  const diagnostics = [...project.diagnostics];
  for (const skill of project.skills) {
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
