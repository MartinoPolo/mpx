import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  parseRuntimeProfilesV1,
  type RuntimeProfilesV1,
  type SemanticSkillCapabilityV1,
} from '@mpx/config';
import {
  loadCanonicalAgentProjectionInputsV1,
  renderCanonicalAgentDocumentV1,
} from '@mpx/subagents/documents';
import type { AgentCapabilityV1, AgentModelClassV1, AgentThinkingV1 } from '@mpx/subagents';
import {
  enumerateSkillDirectory,
  verifySkillProjectionPlan,
  type Runtime,
  type SkillCapability,
  type SkillProjectionPlan,
} from '@mpx/skills';
import {
  CONTENT_COMPILER_VERSION,
  CONTENT_MANIFEST_SCHEMA_VERSION,
  RUNTIME_PROFILE_SCHEMA_VERSION,
} from './versions.js';

export type ContentFeature = 'argument-hint' | 'capability-grants';
export interface CompileContentInput {
  readonly runtime: Runtime;
  readonly plan: SkillProjectionPlan;
  readonly runtimeProfiles: RuntimeProfilesV1;
  readonly requiredFeatures?: readonly ContentFeature[];
  readonly requiredCapabilityGrants?: readonly SemanticSkillCapabilityV1[];
  readonly sharedInstructionRoot: string;
  readonly agentRoot: string;
}
export interface CompiledContentFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteCount: number;
}
export interface CompiledSkillManifestEntry {
  readonly identity: string;
  readonly exposure: 'full' | 'name-only' | 'explicit-only';
  readonly canonicalDescription: string;
  readonly effectiveDescription: string;
  readonly sourcePath: string;
  readonly generatedPath: string;
  readonly generatedSha256: string;
  /** UTF-8 byte offset of the canonical body within generatedPath. */
  readonly bodyByteOffset: number;
  readonly capabilities?: readonly SkillCapability[];
  readonly capabilityGrantsApplied?: boolean;
  readonly capabilityGrantSupport?: 'preapproved' | 'unsupported';
  readonly omittedOptionalFeatures: readonly ContentFeature[];
}
export interface CompiledAgentManifestEntry {
  readonly canonicalIdentity: string;
  readonly projectedIdentity: string;
  readonly semanticModel: AgentModelClassV1;
  readonly concreteModel: string;
  readonly thinking: AgentThinkingV1;
  readonly capabilities: readonly AgentCapabilityV1[];
  readonly tools: readonly string[];
  readonly nesting: Readonly<{
    readonly canonical: readonly string[];
    readonly projected: readonly string[];
    readonly requiredTools: readonly string[];
  }>;
  readonly outputSchema: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceByteCount: number;
  readonly generatedPath: string;
  readonly generatedSha256: string;
  readonly generatedByteCount: number;
}
export interface ContentInspectionManifest {
  readonly schemaVersion: 1;
  readonly compilerVersion: typeof CONTENT_COMPILER_VERSION;
  readonly runtime: Runtime;
  readonly profileSchemaVersion: 1;
  readonly binding: SkillProjectionPlan['binding'];
  readonly manifestKey: string;
  /** The manifest is an envelope and is deliberately excluded from files to avoid self-hash recursion. */
  readonly manifestEnvelope: Readonly<{ path: 'active-content.json'; includedInFileMap: false }>;
  readonly skills: readonly CompiledSkillManifestEntry[];
  readonly agents: readonly CompiledAgentManifestEntry[];
  readonly files: readonly Readonly<{
    relativePath: string;
    sha256: string;
    byteCount: number;
  }>[];
}
declare const compiledContentTreeBrand: unique symbol;
export interface CompiledContentTree {
  readonly files: readonly CompiledContentFile[];
  readonly manifest: ContentInspectionManifest;
  readonly [compiledContentTreeBrand]: true;
}
export interface VerifyCompiledContentTreeInput {
  readonly runtime: Runtime;
  readonly plan: SkillProjectionPlan;
}

class ContentCompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentCompilerError';
  }
}

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteBookkeeping = (value: string): string => JSON.stringify(value);

function renderedSkill(
  entry: SkillProjectionPlan['entries'][number],
  runtime: Runtime,
  profiles: RuntimeProfilesV1,
): {
  bytes: Uint8Array;
  bodyByteOffset: number;
  effectiveDescription: string;
  omitted: ContentFeature[];
} {
  const effectiveDescription =
    entry.exposure === 'name-only'
      ? profiles.contentTranslation.nameOnlyDescriptionTemplate.replaceAll(
          '{{identity}}',
          entry.identity,
        )
      : entry.canonicalDescription;
  const omitted: ContentFeature[] = [];
  const runtimeProfile = profiles.contentTranslation.runtimes[runtime];
  const lines = ['---', `name: ${entry.identity}`, `description: ${quote(effectiveDescription)}`];
  if (entry.author || entry.version || entry.category) {
    lines.push('metadata:');
    if (entry.author) lines.push(`  author: ${quoteBookkeeping(entry.author)}`);
    if (entry.version) lines.push(`  version: ${quoteBookkeeping(entry.version)}`);
    if (entry.category) lines.push(`  category: ${quoteBookkeeping(entry.category)}`);
  }
  if (entry.argumentHint) {
    if (runtimeProfile.argumentHint === 'supported') {
      lines.push(`${runtimeProfile.frontmatter.argumentHint!}: ${quote(entry.argumentHint)}`);
    } else {
      omitted.push('argument-hint');
    }
  }
  if (entry.exposure === 'explicit-only') {
    lines.push('disable-model-invocation: true');
  }
  if (entry.capabilities?.length && runtimeProfile.capabilities.support === 'preapproved') {
    const tools = [
      ...new Set(
        entry.capabilities.flatMap(
          (capability) => runtimeProfile.capabilities.mappings[capability] ?? [],
        ),
      ),
    ];
    if (tools.length) {
      lines.push(`${runtimeProfile.frontmatter.capabilityGrant!}: ${tools.join(', ')}`);
    }
  } else if (entry.capabilities?.length) {
    omitted.push('capability-grants');
  }
  lines.push('---');
  const header = Buffer.from(`${lines.join('\n')}\n`);
  return {
    bytes: Uint8Array.from(Buffer.concat([header, Buffer.from(entry.body, 'utf8')])),
    bodyByteOffset: header.byteLength,
    effectiveDescription,
    omitted,
  };
}

function safeOutputPath(relativePath: string): string {
  const portable = relativePath.replaceAll('\\', '/');
  const normalized = path.posix.normalize(portable);
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[A-Za-z]:/u.test(portable) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== portable ||
    portable.includes('\0')
  ) {
    throw new ContentCompilerError(`unsafe output path: ${relativePath}`);
  }
  return normalized;
}

function verifyMarkdownClosure(files: readonly CompiledContentFile[]): void {
  const paths = new Set(files.map((file) => file.relativePath.toLowerCase()));
  for (const file of files.filter((candidate) => candidate.relativePath.endsWith('.md'))) {
    const markdown = Buffer.from(file.bytes).toString('utf8');
    const inlineTargets = [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => ({
      raw: match[1]!,
      target: match[1]!,
    }));
    const definitionTargets = [...markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S.*)$/gmu)].map(
      (match) => ({ raw: match[1]!, target: match[1]! }),
    );
    for (const match of [...inlineTargets, ...definitionTargets]) {
      let target = match.target.trim();
      if (target.startsWith('<') && target.includes('>')) {
        target = target.slice(1, target.indexOf('>'));
      } else {
        target = target.split(/\s+["']/u, 1)[0]!;
      }
      target = target.split('#', 1)[0]!.split('?', 1)[0]!;
      if (
        !target ||
        target.startsWith('#') ||
        target.startsWith('/') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
      ) {
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.relativePath), target),
      );
      if (resolved.startsWith('../') || !paths.has(resolved.toLowerCase())) {
        throw new ContentCompilerError(
          `unresolved Markdown reference '${match.raw}' in ${file.relativePath}`,
        );
      }
    }
  }
}

const verifiedTrees = new WeakMap<object, string>();

function stable(value: unknown): string {
  if (value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString('base64'));
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function treeDigest(tree: Pick<CompiledContentTree, 'files' | 'manifest'>): string {
  return hash(Buffer.from(stable({ files: tree.files, manifest: tree.manifest })));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function verifyCompiledContentTree(
  tree: CompiledContentTree,
  expected: VerifyCompiledContentTreeInput,
): CompiledContentTree {
  const recorded = verifiedTrees.get(tree as object);
  if (!recorded) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_UNVERIFIED');
  }
  let plan: SkillProjectionPlan;
  try {
    plan = verifySkillProjectionPlan(expected.plan);
  } catch {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_BINDING_INVALID');
  }
  if (
    tree.manifest.schemaVersion !== CONTENT_MANIFEST_SCHEMA_VERSION ||
    tree.manifest.compilerVersion !== CONTENT_COMPILER_VERSION ||
    tree.manifest.profileSchemaVersion !== RUNTIME_PROFILE_SCHEMA_VERSION ||
    tree.manifest.manifestEnvelope.path !== 'active-content.json' ||
    tree.manifest.manifestEnvelope.includedInFileMap !== false ||
    tree.manifest.runtime !== expected.runtime ||
    plan.runtime !== expected.runtime ||
    tree.manifest.manifestKey !== plan.manifestKey ||
    stable(tree.manifest.binding) !== stable(plan.binding)
  ) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_BINDING_INVALID');
  }
  const files = new Map<string, CompiledContentFile>();
  let previous = '';
  for (const file of tree.files) {
    const safe = safeOutputPath(file.relativePath);
    if (safe !== file.relativePath || previous >= safe || files.has(safe.toLowerCase())) {
      throw new ContentCompilerError('COMPILED_CONTENT_TREE_FILE_MAP_INVALID');
    }
    previous = safe;
    files.set(safe.toLowerCase(), file);
    if (file.byteCount !== file.bytes.byteLength || file.sha256 !== hash(file.bytes)) {
      throw new ContentCompilerError('COMPILED_CONTENT_TREE_CHANGED');
    }
  }
  const represented = tree.files.filter((file) => file.relativePath !== 'active-content.json');
  if (
    tree.manifest.files.length !== represented.length ||
    tree.manifest.files.some((entry, index) => {
      const file = represented[index];
      return (
        !file ||
        entry.relativePath !== file.relativePath ||
        entry.sha256 !== file.sha256 ||
        entry.byteCount !== file.byteCount
      );
    })
  ) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_FILE_MAP_INVALID');
  }
  const envelope = files.get('active-content.json');
  if (
    !envelope ||
    Buffer.from(envelope.bytes).toString('utf8') !== `${JSON.stringify(tree.manifest, null, 2)}\n`
  ) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_MANIFEST_INVALID');
  }
  if (
    tree.manifest.agents.some((agent) => {
      const file = files.get(agent.generatedPath.toLowerCase());
      return (
        agent.generatedPath !== `agents/${agent.projectedIdentity}.md` ||
        agent.sourcePath !== `${agent.canonicalIdentity}.md` ||
        !/^[a-f0-9]{64}$/u.test(agent.sourceSha256) ||
        !Number.isSafeInteger(agent.sourceByteCount) ||
        agent.sourceByteCount < 0 ||
        !file ||
        agent.generatedSha256 !== file.sha256 ||
        agent.generatedByteCount !== file.byteCount ||
        new Set(agent.tools).size !== agent.tools.length ||
        agent.nesting.canonical.length !== agent.nesting.projected.length
      );
    })
  ) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_AGENT_INVALID');
  }
  if (
    tree.manifest.skills.length !== plan.entries.length ||
    tree.manifest.skills.some((skill, index) => {
      const planned = plan.entries[index];
      const file = files.get(skill.generatedPath.toLowerCase());
      return (
        !planned ||
        skill.identity !== planned.identity ||
        skill.generatedPath !== `skills/${skill.identity}/SKILL.md` ||
        !file ||
        skill.generatedSha256 !== file.sha256 ||
        !Number.isSafeInteger(skill.bodyByteOffset) ||
        skill.bodyByteOffset < 0 ||
        skill.bodyByteOffset > file.byteCount ||
        !Buffer.from(file.bytes)
          .subarray(skill.bodyByteOffset)
          .equals(Buffer.from(planned.body, 'utf8'))
      );
    })
  ) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_SKILL_INVALID');
  }
  if (treeDigest(tree) !== recorded) {
    throw new ContentCompilerError('COMPILED_CONTENT_TREE_CHANGED');
  }
  return tree;
}

export async function compileContent(input: CompileContentInput): Promise<CompiledContentTree> {
  const runtimeProfiles = parseRuntimeProfilesV1(JSON.stringify(input.runtimeProfiles));
  const plan = verifySkillProjectionPlan(input.plan);
  if (plan.runtime !== input.runtime) {
    throw new ContentCompilerError(
      `verified plan runtime ${plan.runtime} does not match ${input.runtime}`,
    );
  }
  const selectedProfile = runtimeProfiles.contentTranslation.runtimes[input.runtime];
  for (const feature of input.requiredFeatures ?? []) {
    const support =
      feature === 'argument-hint'
        ? selectedProfile.argumentHint
        : selectedProfile.capabilities.support === 'preapproved'
          ? 'supported'
          : 'unsupported';
    if (support !== 'supported') {
      throw new ContentCompilerError(
        `required feature '${feature}' is unsupported by ${input.runtime}`,
      );
    }
  }
  for (const capability of input.requiredCapabilityGrants ?? []) {
    if (
      selectedProfile.capabilities.support !== 'preapproved' ||
      !selectedProfile.capabilities.mappings[capability]?.length
    ) {
      throw new ContentCompilerError(
        `required capability grant '${capability}' is unavailable in ${input.runtime}`,
      );
    }
  }
  const files = new Map<string, CompiledContentFile>();
  const add = (relativePath: string, bytes: Uint8Array): void => {
    const safe = safeOutputPath(relativePath);
    const collisionKey = safe.toLowerCase();
    if ([...files.keys()].some((candidate) => candidate.toLowerCase() === collisionKey)) {
      throw new ContentCompilerError(`duplicate output path: ${safe}`);
    }
    const snapshot = Uint8Array.from(bytes);
    files.set(safe, {
      relativePath: safe,
      bytes: snapshot,
      sha256: hash(snapshot),
      byteCount: snapshot.byteLength,
    });
  };
  const skills: CompiledSkillManifestEntry[] = [];
  for (const entry of plan.entries) {
    if (entry.exposure === 'off') {
      throw new ContentCompilerError(`off skill entered verified plan: ${entry.identity}`);
    }
    const generatedPath = `skills/${entry.identity}/SKILL.md`;
    const rendered = renderedSkill(entry, input.runtime, runtimeProfiles);
    add(generatedPath, rendered.bytes);
    const generated = files.get(generatedPath)!;
    for (const support of entry.files) {
      add(`skills/${entry.identity}/${support.relativePath}`, support.bytes);
    }
    skills.push({
      identity: entry.identity,
      exposure: entry.exposure,
      canonicalDescription: entry.canonicalDescription,
      effectiveDescription: rendered.effectiveDescription,
      sourcePath: entry.source.provenancePath,
      generatedPath,
      generatedSha256: generated.sha256,
      bodyByteOffset: rendered.bodyByteOffset,
      ...(entry.capabilities?.length
        ? {
            capabilities: [...entry.capabilities],
            capabilityGrantsApplied: selectedProfile.capabilities.support === 'preapproved',
            capabilityGrantSupport: selectedProfile.capabilities.support,
          }
        : {}),
      omittedOptionalFeatures: rendered.omitted,
    });
  }
  const shared = await enumerateSkillDirectory(input.sharedInstructionRoot);
  for (const file of shared) {
    add(`skills/shared/${file.relativePath}`, file.bytes);
  }

  const canonicalAgents = await loadCanonicalAgentProjectionInputsV1(input.agentRoot);
  const agentProfile = runtimeProfiles.agentTranslation.runtimes[input.runtime];
  const canonicalIdentities = canonicalAgents.entries.map((entry) => entry.identity).sort();
  const aliasIdentities = Object.keys(agentProfile.aliases).sort();
  if (
    canonicalIdentities.length !== aliasIdentities.length ||
    canonicalIdentities.some((identity, index) => identity !== aliasIdentities[index])
  ) {
    throw new ContentCompilerError('runtime agent aliases must exactly cover canonical agents');
  }
  const agents: CompiledAgentManifestEntry[] = [];
  for (const entry of canonicalAgents.entries) {
    const metadata = entry.metadata;
    const projectedIdentity = agentProfile.aliases[entry.identity]!;
    const projectedNesting = metadata.nesting.map((identity) => agentProfile.aliases[identity]!);
    const requiredTools = metadata.nesting.length ? agentProfile.nestingRequiredTools : [];
    const tools = [
      ...new Set([
        ...metadata.capabilities.flatMap(
          (capability) => agentProfile.capabilities.mappings[capability],
        ),
        ...requiredTools,
      ]),
    ];
    const concreteModel = runtimeProfiles.models[input.runtime][metadata.modelClass];
    const fields = [
      { name: agentProfile.frontmatter.model, value: quote(concreteModel) },
      { name: agentProfile.frontmatter.thinking, value: quote(metadata.thinking) },
      {
        name: agentProfile.frontmatter.tools,
        value: quote(tools.join(agentProfile.separators.tools)),
      },
      { name: agentProfile.frontmatter.outputSchema, value: quote(metadata.outputSchema) },
      ...(metadata.nesting.length
        ? [
            {
              name: agentProfile.frontmatter.nesting,
              value: quote(projectedNesting.join(agentProfile.separators.nesting)),
            },
          ]
        : []),
    ];
    const generatedPath = `agents/${projectedIdentity}.md`;
    add(
      generatedPath,
      renderCanonicalAgentDocumentV1(entry.document, { name: projectedIdentity, fields }),
    );
    const generated = files.get(generatedPath)!;
    agents.push({
      canonicalIdentity: entry.identity,
      projectedIdentity,
      semanticModel: metadata.modelClass,
      concreteModel,
      thinking: metadata.thinking,
      capabilities: [...metadata.capabilities],
      tools,
      nesting: {
        canonical: [...metadata.nesting],
        projected: projectedNesting,
        requiredTools: [...requiredTools],
      },
      outputSchema: metadata.outputSchema,
      sourcePath: entry.sourcePath,
      sourceSha256: entry.sourceSha256,
      sourceByteCount: entry.sourceByteCount,
      generatedPath,
      generatedSha256: generated.sha256,
      generatedByteCount: generated.byteCount,
    });
  }
  for (const file of canonicalAgents.supportFiles) {
    add(`agents/${file.relativePath}`, file.bytes);
  }
  const byPortablePath = (left: CompiledContentFile, right: CompiledContentFile): number =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
  let sorted = [...files.values()].sort(byPortablePath);
  verifyMarkdownClosure(sorted);
  const manifest: ContentInspectionManifest = {
    schemaVersion: CONTENT_MANIFEST_SCHEMA_VERSION,
    compilerVersion: CONTENT_COMPILER_VERSION,
    runtime: input.runtime,
    profileSchemaVersion: RUNTIME_PROFILE_SCHEMA_VERSION,
    binding: structuredClone(plan.binding),
    manifestKey: plan.manifestKey,
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills,
    agents,
    files: sorted.map(({ relativePath, sha256, byteCount }) => ({
      relativePath,
      sha256,
      byteCount,
    })),
  };
  add('active-content.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  sorted = [...files.values()].sort(byPortablePath);
  const tree = deepFreeze({ files: sorted, manifest }) as unknown as CompiledContentTree;
  verifiedTrees.set(tree, treeDigest(tree));
  return verifyCompiledContentTree(tree, { runtime: input.runtime, plan });
}
