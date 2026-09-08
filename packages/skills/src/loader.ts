import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { bareSkillIdentity, parseResolvedSkillManifestV4 } from '@mpx/runtime-contracts';
import {
  SkillCatalogError,
  catalogError,
  type ResolvedManifest,
  type Runtime,
  type RuntimeSkillArtifact,
} from './contracts.js';
import { frontmatter } from './frontmatter.js';
import { contained, directoryDigest, enumerateSkillDirectory } from './inventory.js';
import { validateArtifact } from './artifact.js';

export const MAX_SKILL_BODY_BYTES = 256 * 1024;

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
    const bareIdentity = bareSkillIdentity(entry.identity, 'project');
    if (!bareIdentity) {
      catalogError(
        'SKILL_PROVENANCE_MISMATCH',
        `skill '${request.identity}' has invalid project identity`,
      );
    }
    const expectedSourcePath = path.join(
      entry.source.projectRoot,
      '.agents',
      'skills',
      bareIdentity,
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
