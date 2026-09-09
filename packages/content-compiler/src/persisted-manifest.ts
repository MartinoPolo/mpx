import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { bareSkillIdentity, parseSkillSelection } from '@mpx/runtime-contracts';
import type {
  CompiledAgentManifestEntry,
  CompiledSkillManifestEntry,
  ContentFeature,
  ContentInspectionManifest,
} from './compiler.js';
import {
  CONTENT_COMPILER_VERSION,
  CONTENT_MANIFEST_SCHEMA_VERSION,
  RUNTIME_PROFILE_SCHEMA_VERSION,
} from './versions.js';

export type ActiveContentErrorCode =
  | 'ACTIVE_CONTENT_UNAVAILABLE'
  | 'ACTIVE_CONTENT_BINDING_INVALID'
  | 'ACTIVE_CONTENT_MANIFEST_INVALID'
  | 'ACTIVE_CONTENT_TAMPERED'
  | 'ACTIVE_CONTENT_UNKNOWN'
  | 'ACTIVE_CONTENT_AMBIGUOUS';

export class ActiveContentError extends Error {
  constructor(
    readonly code: ActiveContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActiveContentError';
  }
}

export interface ActiveContentProjection {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: ContentInspectionManifest;
  readonly realRoot: string;
}

export interface ActiveContentExpectation {
  readonly runtime?: 'pi' | 'claude';
  readonly manifestKey?: string;
  readonly binding?: ContentInspectionManifest['binding'];
  readonly manifestFile?: { readonly sha256: string; readonly byteCount: number };
}

const fail = (code: ActiveContentErrorCode, message: string): never => {
  throw new ActiveContentError(code, message);
};
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};
const exact = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (unknown || missing) {
    fail(
      'ACTIVE_CONTENT_MANIFEST_INVALID',
      unknown
        ? `${label} contains unknown field '${unknown}'.`
        : `${label} is missing '${missing}'.`,
    );
  }
};
const text = (value: unknown, label: string): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536 && !value.includes('\0')
    ? value
    : fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} must be bounded text.`);
const integer = (value: unknown, label: string): number =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} must be a non-negative integer.`);
const digest = (value: unknown, label: string): string => {
  const result = text(value, label);
  return /^[a-f0-9]{64}$/u.test(result)
    ? result
    : fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} must be a SHA-256 digest.`);
};
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} must be an array.`);
  }
  return value.map((item, index) => text(item, `${label}[${index}]`));
};
const parseSelection = (
  value: unknown,
  code: 'ACTIVE_CONTENT_MANIFEST_INVALID' | 'ACTIVE_CONTENT_BINDING_INVALID',
) => parseSkillSelection(value, (_selectionCode, message) => fail(code, message));
const portablePath = (value: unknown, label: string): string => {
  const result = text(value, label).replaceAll('\\', '/');
  const normalized = path.posix.normalize(result);
  if (
    result !== normalized ||
    result.startsWith('/') ||
    /^[A-Za-z]:/u.test(result) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', `${label} is unsafe.`);
  }
  return result;
};

function parseSkill(value: unknown, index: number): CompiledSkillManifestEntry {
  const item = record(value, `skills[${index}]`);
  const required = [
    'identity',
    'exposure',
    'canonicalDescription',
    'effectiveDescription',
    'sourcePath',
    'generatedPath',
    'generatedSha256',
    'bodyByteOffset',
    'omittedOptionalFeatures',
  ];
  const optional = ['capabilities', 'capabilityGrantsApplied', 'capabilityGrantSupport'];
  exact(item, required, optional, `skills[${index}]`);
  if (!['full', 'name-only', 'explicit-only'].includes(String(item.exposure))) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `skills[${index}].exposure is invalid.`);
  }
  const omitted = strings(item.omittedOptionalFeatures, `skills[${index}].omittedOptionalFeatures`);
  if (omitted.some((feature) => !['argument-hint', 'capability-grants'].includes(feature))) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `skills[${index}] has an unknown omitted feature.`);
  }
  const capabilities =
    item.capabilities === undefined
      ? undefined
      : strings(item.capabilities, `skills[${index}].capabilities`);
  if (
    capabilities?.some(
      (capability) => !['read', 'search', 'shell', 'write', 'delegate'].includes(capability),
    )
  ) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `skills[${index}] has an unknown capability.`);
  }
  if (
    item.capabilityGrantsApplied !== undefined &&
    typeof item.capabilityGrantsApplied !== 'boolean'
  ) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `skills[${index}].capabilityGrantsApplied is invalid.`);
  }
  if (
    item.capabilityGrantSupport !== undefined &&
    !['preapproved', 'unsupported'].includes(String(item.capabilityGrantSupport))
  ) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `skills[${index}].capabilityGrantSupport is invalid.`);
  }
  const skill: CompiledSkillManifestEntry = {
    identity: text(item.identity, `skills[${index}].identity`),
    exposure: item.exposure as CompiledSkillManifestEntry['exposure'],
    canonicalDescription: text(item.canonicalDescription, `skills[${index}].canonicalDescription`),
    effectiveDescription: text(item.effectiveDescription, `skills[${index}].effectiveDescription`),
    sourcePath: text(item.sourcePath, `skills[${index}].sourcePath`),
    generatedPath: portablePath(item.generatedPath, `skills[${index}].generatedPath`),
    generatedSha256: digest(item.generatedSha256, `skills[${index}].generatedSha256`),
    bodyByteOffset: integer(item.bodyByteOffset, `skills[${index}].bodyByteOffset`),
    ...(capabilities
      ? { capabilities: capabilities as NonNullable<CompiledSkillManifestEntry['capabilities']> }
      : {}),
    ...(item.capabilityGrantsApplied !== undefined
      ? { capabilityGrantsApplied: item.capabilityGrantsApplied as boolean }
      : {}),
    ...(item.capabilityGrantSupport !== undefined
      ? { capabilityGrantSupport: item.capabilityGrantSupport as 'preapproved' | 'unsupported' }
      : {}),
    omittedOptionalFeatures: omitted as ContentFeature[],
  };
  classifyCompiledSkillSource(skill);
  return skill;
}

function parseAgent(value: unknown, index: number): CompiledAgentManifestEntry {
  const item = record(value, `agents[${index}]`);
  exact(
    item,
    [
      'canonicalIdentity',
      'projectedIdentity',
      'semanticModel',
      'concreteModel',
      'thinking',
      'capabilities',
      'tools',
      'nesting',
      'outputSchema',
      'sourcePath',
      'sourceSha256',
      'sourceByteCount',
      'generatedPath',
      'generatedSha256',
      'generatedByteCount',
    ],
    [],
    `agents[${index}]`,
  );
  if (
    !['mechanical', 'exploration', 'standard', 'advanced', 'frontier'].includes(
      String(item.semanticModel),
    ) ||
    !['low', 'medium', 'high'].includes(String(item.thinking))
  ) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `agents[${index}] model metadata is invalid.`);
  }
  const capabilities = strings(item.capabilities, `agents[${index}].capabilities`);
  if (
    capabilities.some(
      (capability) =>
        !['read', 'search', 'shell', 'write', 'browser', 'context', 'web'].includes(capability),
    )
  ) {
    fail('ACTIVE_CONTENT_MANIFEST_INVALID', `agents[${index}] has an unknown capability.`);
  }
  const nesting = record(item.nesting, `agents[${index}].nesting`);
  exact(nesting, ['canonical', 'projected', 'requiredTools'], [], `agents[${index}].nesting`);
  return {
    canonicalIdentity: text(item.canonicalIdentity, `agents[${index}].canonicalIdentity`),
    projectedIdentity: text(item.projectedIdentity, `agents[${index}].projectedIdentity`),
    semanticModel: item.semanticModel as CompiledAgentManifestEntry['semanticModel'],
    concreteModel: text(item.concreteModel, `agents[${index}].concreteModel`),
    thinking: item.thinking as CompiledAgentManifestEntry['thinking'],
    capabilities: capabilities as CompiledAgentManifestEntry['capabilities'],
    tools: strings(item.tools, `agents[${index}].tools`),
    nesting: {
      canonical: strings(nesting.canonical, `agents[${index}].nesting.canonical`),
      projected: strings(nesting.projected, `agents[${index}].nesting.projected`),
      requiredTools: strings(nesting.requiredTools, `agents[${index}].nesting.requiredTools`),
    },
    outputSchema: text(item.outputSchema, `agents[${index}].outputSchema`),
    sourcePath: text(item.sourcePath, `agents[${index}].sourcePath`),
    sourceSha256: digest(item.sourceSha256, `agents[${index}].sourceSha256`),
    sourceByteCount: integer(item.sourceByteCount, `agents[${index}].sourceByteCount`),
    generatedPath: portablePath(item.generatedPath, `agents[${index}].generatedPath`),
    generatedSha256: digest(item.generatedSha256, `agents[${index}].generatedSha256`),
    generatedByteCount: integer(item.generatedByteCount, `agents[${index}].generatedByteCount`),
  };
}

function parsePersistedContentManifest(source: string): ContentInspectionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'Active content manifest is malformed JSON.');
  }
  const item = record(parsed, 'manifest');
  exact(
    item,
    [
      'schemaVersion',
      'compilerVersion',
      'runtime',
      'profileSchemaVersion',
      'binding',
      'manifestKey',
      'manifestEnvelope',
      'skills',
      'agents',
      'files',
    ],
    [],
    'manifest',
  );
  if (
    item.schemaVersion !== CONTENT_MANIFEST_SCHEMA_VERSION ||
    item.compilerVersion !== CONTENT_COMPILER_VERSION ||
    item.profileSchemaVersion !== RUNTIME_PROFILE_SCHEMA_VERSION
  ) {
    return fail(
      'ACTIVE_CONTENT_MANIFEST_INVALID',
      'Active content manifest uses an unsupported schema or compiler version.',
    );
  }
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'Active content runtime is invalid.');
  }
  const binding = record(item.binding, 'binding');
  exact(binding, ['projectId', 'repositoryId', 'identity', 'selection'], [], 'binding');
  if (binding.projectId !== null && typeof binding.projectId !== 'string') {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'binding.projectId is invalid.');
  }
  const selected = parseSelection(binding.selection, 'ACTIVE_CONTENT_MANIFEST_INVALID');
  const envelope = record(item.manifestEnvelope, 'manifestEnvelope');
  exact(envelope, ['path', 'includedInFileMap'], [], 'manifestEnvelope');
  if (envelope.path !== 'active-content.json' || envelope.includedInFileMap !== false) {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'Manifest self-hash exclusion is invalid.');
  }
  if (!Array.isArray(item.skills) || !Array.isArray(item.agents) || !Array.isArray(item.files)) {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'Manifest collections must be arrays.');
  }
  const files = item.files.map((value, index) => {
    const file = record(value, `files[${index}]`);
    exact(file, ['relativePath', 'sha256', 'byteCount'], [], `files[${index}]`);
    return {
      relativePath: portablePath(file.relativePath, `files[${index}].relativePath`),
      sha256: digest(file.sha256, `files[${index}].sha256`),
      byteCount: integer(file.byteCount, `files[${index}].byteCount`),
    };
  });
  const skills = item.skills.map(parseSkill),
    agents = item.agents.map(parseAgent);
  const paths = files.map((file) => file.relativePath.toLowerCase());
  if (new Set(paths).size !== paths.length || paths.includes('active-content.json')) {
    return fail(
      'ACTIVE_CONTENT_MANIFEST_INVALID',
      'Manifest file map is ambiguous or includes itself.',
    );
  }
  for (const skill of skills) {
    const file = files.find((candidate) => candidate.relativePath === skill.generatedPath);
    if (!file || file.sha256 !== skill.generatedSha256 || skill.bodyByteOffset > file.byteCount) {
      return fail(
        'ACTIVE_CONTENT_MANIFEST_INVALID',
        `Skill '${skill.identity}' is not bound to its file map entry.`,
      );
    }
  }
  for (const agent of agents) {
    const file = files.find((candidate) => candidate.relativePath === agent.generatedPath);
    if (
      !file ||
      file.sha256 !== agent.generatedSha256 ||
      file.byteCount !== agent.generatedByteCount
    ) {
      return fail(
        'ACTIVE_CONTENT_MANIFEST_INVALID',
        `Agent '${agent.canonicalIdentity}' is not bound to its file map entry.`,
      );
    }
  }
  return {
    schemaVersion: CONTENT_MANIFEST_SCHEMA_VERSION,
    compilerVersion: CONTENT_COMPILER_VERSION,
    runtime: item.runtime,
    profileSchemaVersion: RUNTIME_PROFILE_SCHEMA_VERSION,
    binding: {
      projectId: binding.projectId as string | null,
      repositoryId: text(binding.repositoryId, 'binding.repositoryId'),
      identity: text(binding.identity, 'binding.identity'),
      selection: selected,
    },
    manifestKey: text(item.manifestKey, 'manifestKey'),
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills,
    agents,
    files,
  };
}

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

function sameBinding(
  left: ContentInspectionManifest['binding'],
  right: ContentInspectionManifest['binding'],
): boolean {
  const leftPacks = [...left.selection.packs].sort();
  const rightPacks = [...right.selection.packs].sort();
  return (
    left.projectId === right.projectId &&
    left.repositoryId === right.repositoryId &&
    left.identity === right.identity &&
    left.selection.location.name === right.selection.location.name &&
    left.selection.location.canonicalRoot === right.selection.location.canonicalRoot &&
    left.selection.source === right.selection.source &&
    leftPacks.length === rightPacks.length &&
    leftPacks.every((pack, index) => pack === rightPacks[index])
  );
}

function validateExpectation(expected: ActiveContentExpectation): void {
  const keys = Object.keys(expected as object);
  if (keys.some((key) => !['runtime', 'manifestKey', 'binding', 'manifestFile'].includes(key))) {
    fail('ACTIVE_CONTENT_BINDING_INVALID', 'Active content expectation has unknown fields.');
  }
  const boundedText = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 65_536 &&
    !value.includes('\0');
  if (
    expected.runtime !== undefined &&
    expected.runtime !== 'pi' &&
    expected.runtime !== 'claude'
  ) {
    fail('ACTIVE_CONTENT_BINDING_INVALID', 'Expected active content runtime is invalid.');
  }
  if (expected.manifestKey !== undefined && !boundedText(expected.manifestKey)) {
    fail('ACTIVE_CONTENT_BINDING_INVALID', 'Expected active content manifest key is invalid.');
  }
  if (expected.binding !== undefined) {
    const binding = expected.binding as unknown as Record<string, unknown>;
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      Object.keys(binding).sort().join(',') !== 'identity,projectId,repositoryId,selection' ||
      (binding.projectId !== null && !boundedText(binding.projectId)) ||
      !boundedText(binding.repositoryId) ||
      !boundedText(binding.identity)
    ) {
      fail('ACTIVE_CONTENT_BINDING_INVALID', 'Expected active content binding is invalid.');
    }
    parseSelection(binding.selection, 'ACTIVE_CONTENT_BINDING_INVALID');
  }
  if (
    expected.manifestFile !== undefined &&
    (!expected.manifestFile ||
      Object.keys(expected.manifestFile).sort().join(',') !== 'byteCount,sha256' ||
      !/^[a-f0-9]{64}$/u.test(expected.manifestFile.sha256) ||
      !Number.isSafeInteger(expected.manifestFile.byteCount) ||
      expected.manifestFile.byteCount < 0 ||
      expected.manifestFile.byteCount > 16 * 1024 * 1024)
  ) {
    fail(
      'ACTIVE_CONTENT_BINDING_INVALID',
      'Expected active content manifest integrity is invalid.',
    );
  }
}

export function classifyCompiledSkillSource(
  entry: CompiledSkillManifestEntry,
): 'canonical' | 'project' {
  const canonical = bareSkillIdentity(entry.identity, 'canonical');
  if (
    canonical &&
    entry.generatedPath === `skills/${canonical}/SKILL.md` &&
    entry.sourcePath === `content/skills/${canonical}/SKILL.md`
  ) {
    return 'canonical';
  }
  const project = bareSkillIdentity(entry.identity, 'project');
  if (
    project &&
    entry.generatedPath === `project-skills/skills/${project}/SKILL.md` &&
    entry.sourcePath === `.agents/skills/${project}/SKILL.md`
  ) {
    return 'project';
  }
  return fail(
    'ACTIVE_CONTENT_MANIFEST_INVALID',
    `Skill '${entry.identity}' must use an exact canonical bare identity or project 'skill:<name>' identity with its matching source and generated paths.`,
  );
}

async function verifiedRegularFile(input: {
  realRoot: string;
  file: string;
  expected?: { readonly sha256: string; readonly byteCount: number };
  maximumBytes: number;
  code: 'ACTIVE_CONTENT_UNAVAILABLE' | 'ACTIVE_CONTENT_TAMPERED';
  message: string;
}): Promise<Buffer> {
  try {
    const stat = await lstat(input.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > input.maximumBytes ||
      (input.expected && stat.size !== input.expected.byteCount)
    ) {
      throw new Error('file metadata changed');
    }
    const resolved = await realpath(input.file);
    const relative = path.relative(input.realRoot, resolved);
    if (
      !samePath(resolved, input.file) ||
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('file escaped active root');
    }
    const bytes = await readFile(input.file);
    if (
      bytes.byteLength !== stat.size ||
      (input.expected &&
        (bytes.byteLength !== input.expected.byteCount ||
          createHash('sha256').update(bytes).digest('hex') !== input.expected.sha256))
    ) {
      throw new Error('file bytes changed');
    }
    return bytes;
  } catch {
    return fail(input.code, input.message);
  }
}

export async function loadActiveContentProjection(input: {
  root: string | undefined;
  manifestPath: string | undefined;
  expected?: ActiveContentExpectation;
}): Promise<ActiveContentProjection> {
  if (!input.root || !input.manifestPath) {
    return fail(
      'ACTIVE_CONTENT_UNAVAILABLE',
      'Active content is unavailable. Launch Claude or Pi through MPX, then retry.',
    );
  }
  if (
    !path.isAbsolute(input.root) ||
    !path.isAbsolute(input.manifestPath) ||
    !samePath(input.manifestPath, path.join(input.root, 'active-content.json'))
  ) {
    return fail(
      'ACTIVE_CONTENT_BINDING_INVALID',
      'Active content root and manifest bindings disagree. Restart the runtime through MPX.',
    );
  }
  try {
    if (input.expected) {
      validateExpectation(input.expected);
    }
    const rootStat = await lstat(input.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('unsafe active content binding');
    }
    const realRoot = await realpath(input.root);
    if (!samePath(realRoot, input.root)) {
      throw new Error('redirected active content binding');
    }
    const manifestBytes = await verifiedRegularFile({
      realRoot,
      file: input.manifestPath,
      ...(input.expected?.manifestFile ? { expected: input.expected.manifestFile } : {}),
      maximumBytes: 16 * 1024 * 1024,
      code: input.expected?.manifestFile ? 'ACTIVE_CONTENT_TAMPERED' : 'ACTIVE_CONTENT_UNAVAILABLE',
      message: input.expected?.manifestFile
        ? 'Active content manifest bytes changed.'
        : 'Active content manifest cannot be read.',
    });
    const manifest = parsePersistedContentManifest(manifestBytes.toString('utf8'));
    if (
      (input.expected?.runtime !== undefined && input.expected.runtime !== manifest.runtime) ||
      (input.expected?.manifestKey !== undefined &&
        input.expected.manifestKey !== manifest.manifestKey) ||
      (input.expected?.binding !== undefined &&
        !sameBinding(input.expected.binding, manifest.binding))
    ) {
      return fail(
        'ACTIVE_CONTENT_BINDING_INVALID',
        'Active content manifest does not match the expected launch binding.',
      );
    }
    return Object.freeze({
      root: input.root,
      manifestPath: input.manifestPath,
      manifest,
      realRoot,
    });
  } catch (error) {
    if (error instanceof ActiveContentError) {
      throw error;
    }
    return fail(
      'ACTIVE_CONTENT_UNAVAILABLE',
      'Active content cannot be read. Restart Claude or Pi through MPX.',
    );
  }
}

async function verifiedFile(
  active: ActiveContentProjection,
  relativePath: string,
): Promise<Buffer> {
  const represented = active.manifest.files.filter((entry) => entry.relativePath === relativePath);
  if (represented.length !== 1) {
    return fail(
      'ACTIVE_CONTENT_TAMPERED',
      `Manifest does not uniquely represent '${relativePath}'.`,
    );
  }
  const expected = represented[0]!,
    file = path.join(active.root, ...relativePath.split('/'));
  return verifiedRegularFile({
    realRoot: active.realRoot,
    file,
    expected: { sha256: expected.sha256, byteCount: expected.byteCount },
    maximumBytes: 16 * 1024 * 1024,
    code: 'ACTIVE_CONTENT_TAMPERED',
    message: `Active content file '${relativePath}' is missing or changed.`,
  });
}

export async function readActiveContentEntry(
  active: ActiveContentProjection,
  kind: 'skill' | 'agent',
  identity: string,
): Promise<Buffer> {
  const matches =
    kind === 'skill'
      ? active.manifest.skills.filter((entry) => entry.identity === identity)
      : active.manifest.agents.filter(
          (entry) => entry.canonicalIdentity === identity || entry.projectedIdentity === identity,
        );
  if (matches.length === 0) {
    return fail('ACTIVE_CONTENT_UNKNOWN', `Unknown active ${kind} '${identity}'.`);
  }
  if (matches.length !== 1) {
    return fail('ACTIVE_CONTENT_AMBIGUOUS', `Active ${kind} identity '${identity}' is ambiguous.`);
  }
  return verifiedFile(active, matches[0]!.generatedPath);
}

export async function readActiveSkill(
  active: ActiveContentProjection,
  identity: string,
  source?: 'canonical' | 'project',
): Promise<{
  entry: CompiledSkillManifestEntry;
  body: string;
  filePath: string;
  baseDirectory: string;
}> {
  if (source !== undefined && source !== 'canonical' && source !== 'project') {
    return fail('ACTIVE_CONTENT_MANIFEST_INVALID', 'Active skill source is invalid.');
  }
  const matches = active.manifest.skills.filter((entry) => {
    const entrySource = classifyCompiledSkillSource(entry);
    return (
      (source === undefined || source === entrySource) &&
      (entry.identity === identity || bareSkillIdentity(entry.identity, entrySource) === identity)
    );
  });
  if (matches.length === 0) {
    return fail('ACTIVE_CONTENT_UNKNOWN', `Unknown active skill '${identity}'.`);
  }
  if (matches.length !== 1) {
    return fail('ACTIVE_CONTENT_AMBIGUOUS', `Active skill identity '${identity}' is ambiguous.`);
  }
  const entry = matches[0]!;
  const bytes = await verifiedFile(active, entry.generatedPath);
  const filePath = path.join(active.root, ...entry.generatedPath.split('/'));
  return {
    entry,
    body: bytes.subarray(entry.bodyByteOffset).toString('utf8'),
    filePath,
    baseDirectory: path.dirname(filePath),
  };
}

export async function checkActiveContentProjection(
  active: ActiveContentProjection,
): Promise<{ clean: true; checkedFiles: number }> {
  for (const file of active.manifest.files) {
    await verifiedFile(active, file.relativePath);
  }
  return { clean: true, checkedFiles: active.manifest.files.length };
}
