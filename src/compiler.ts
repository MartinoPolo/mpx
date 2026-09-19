import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  AgentMetadata,
  BuildResult,
  Capability,
  Exposure,
  Harness,
  ModelClass,
  Projection,
  RuntimeProfiles,
  SkillMetadata,
  Thinking,
} from './contracts.js';

const HARNESSES: readonly Harness[] = ['pi', 'claude'];
const MODEL_CLASSES: readonly ModelClass[] = ['mechanical', 'exploration', 'standard', 'advanced', 'frontier'];
const THINKING_LEVELS: readonly Thinking[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CAPABILITIES: readonly Capability[] = ['read', 'search', 'shell', 'write', 'browser', 'context', 'web'];
const EXPOSURES: readonly Exposure[] = ['normal', 'name-only', 'explicit-only'];
const OUTPUT_ROOTS = ['dist/packs', 'dist/pi', 'dist/claude'] as const;
const PLACEHOLDERS = [
  '{{MPX_SKILL_COMMAND}}',
  '{{MPX_SKILL_PREFIX}}',
  '{{MPX_AGENT_PREFIX}}',
  '{{MPX_SHARED_INSTRUCTIONS}}',
  '{{MPX_AGENT_REFERENCES}}',
  '{{MPX_HARNESS}}',
] as const;
const BARE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INCLUDE_PATTERN = /\{\{include:((?:\{\{MPX_(?:SHARED_INSTRUCTIONS|AGENT_REFERENCES)\}\}|[^{}])+)\}\}/g;
const INCLUDE_START = '{{include:';

type Mapping = Record<string, unknown>;
interface SourceFile { relative: string; content: Buffer }
interface ParsedMarkdown { data: Mapping; body: Buffer }

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function joined(...parts: string[]): string {
  return path.posix.join(...parts.map(slash));
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireMapping(value: unknown, where: string): Mapping {
  if (!isMapping(value)) throw new Error(`${where} must be a mapping`);
  return value;
}

function assertExactKeys(value: Mapping, keys: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown field(s): ${unknown.join(', ')}`);
}

function assertBareName(value: unknown, where: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !BARE_NAME.test(value) || value.includes('--')) {
    throw new Error(`${where} must be a safe lowercase bare name`);
  }
}

function textOf(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  const text = content.toString('utf8');
  return Buffer.from(text).equals(content) ? text : undefined;
}

function sortedMapping(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedMapping);
  if (!isMapping(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedMapping(value[key])]));
}

function parseMarkdown(relative: string, content: Buffer): ParsedMarkdown {
  const text = textOf(content);
  if (text === undefined) throw new Error(`${relative} must be UTF-8 Markdown`);
  const opening = /^---\r?\n/.exec(text);
  if (!opening) throw new Error(`${relative} is missing YAML frontmatter`);
  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(text);
  if (!match) throw new Error(`${relative} has unterminated YAML frontmatter`);
  const yamlSource = text.slice(opening[0].length, match.index);
  if (/\{\{[^{}]*\}\}/.test(yamlSource)) throw new Error(`${relative} placeholders are only allowed in bodies`);
  let data: unknown;
  try {
    data = parse(yamlSource);
  } catch (error) {
    throw new Error(`${relative} has invalid YAML frontmatter: ${String(error)}`);
  }
  const closingEnd = match.index + match[0].length;
  const bodyOffset = Buffer.byteLength(text.slice(0, closingEnd), 'utf8');
  return { data: requireMapping(data, `${relative} frontmatter`), body: content.subarray(bodyOffset) };
}

function renderMarkdown(data: Mapping, body: Buffer): Buffer {
  const yaml = stringify(sortedMapping(data), { lineWidth: 0, sortMapEntries: true });
  return Buffer.concat([Buffer.from(`---\n${yaml}---\n`), body]);
}

function metadataBlock(data: Mapping, where: string): { metadata: Mapping; mpx: Mapping } {
  const metadata = requireMapping(data.metadata, `${where} metadata`);
  return { metadata, mpx: requireMapping(metadata.mpx, `${where} metadata.mpx`) };
}

function canonicalNativeMetadata(data: Mapping): Mapping {
  const native = structuredClone(data);
  if (isMapping(native.metadata)) {
    delete native.metadata.mpx;
    if (Object.keys(native.metadata).length === 0) delete native.metadata;
  }
  return native;
}

function skillMetadata(data: Mapping, directoryName: string, where: string): SkillMetadata {
  assertBareName(data.name, `${where} name`);
  if (data.name !== directoryName) throw new Error(`${where} name must match its skill directory`);
  if (`mp-${data.name}`.length > 64) throw new Error(`${where} projected mp- skill name must be at most 64 characters`);
  if (typeof data.description !== 'string' || data.description.trim() === '') throw new Error(`${where} description is required`);
  const { mpx } = metadataBlock(data, where);
  assertExactKeys(mpx, ['schemaVersion', 'skillPacks', 'defaultExposure'], `${where} metadata.mpx`);
  if (mpx.schemaVersion !== 1) throw new Error(`${where} metadata.mpx.schemaVersion must be 1`);
  if (!Array.isArray(mpx.skillPacks) || mpx.skillPacks.length === 0) throw new Error(`${where} skillPacks must be a non-empty array`);
  const packs = mpx.skillPacks.map((pack, index) => {
    assertBareName(pack, `${where} skillPacks[${index}]`);
    return pack;
  });
  if (new Set(packs).size !== packs.length) throw new Error(`${where} skillPacks would create duplicate output paths`);
  if (mpx.defaultExposure !== undefined && !EXPOSURES.includes(mpx.defaultExposure as Exposure)) {
    throw new Error(`${where} defaultExposure is unknown`);
  }
  return { schemaVersion: 1, skillPacks: packs, ...(mpx.defaultExposure === undefined ? {} : { defaultExposure: mpx.defaultExposure as Exposure }) };
}

function agentMetadata(data: Mapping, filename: string, where: string): AgentMetadata {
  assertBareName(data.name, `${where} name`);
  if (data.name !== filename) throw new Error(`${where} name must match its filename`);
  if (typeof data.description !== 'string' || data.description.trim() === '') throw new Error(`${where} description is required`);
  const { mpx } = metadataBlock(data, where);
  assertExactKeys(mpx, ['schemaVersion', 'modelClass', 'thinking', 'capabilities'], `${where} metadata.mpx`);
  if (mpx.schemaVersion !== 1) throw new Error(`${where} metadata.mpx.schemaVersion must be 1`);
  if (!MODEL_CLASSES.includes(mpx.modelClass as ModelClass)) throw new Error(`${where} modelClass is unknown`);
  if (!THINKING_LEVELS.includes(mpx.thinking as Thinking)) throw new Error(`${where} thinking is unknown`);
  if (!Array.isArray(mpx.capabilities)) throw new Error(`${where} capabilities must be an array`);
  const capabilities = mpx.capabilities.map((capability) => {
    if (!CAPABILITIES.includes(capability as Capability)) throw new Error(`${where} capability ${String(capability)} is unknown`);
    return capability as Capability;
  });
  return {
    schemaVersion: 1,
    modelClass: mpx.modelClass as ModelClass,
    thinking: mpx.thinking as Thinking,
    capabilities,
  };
}

function runtimeProfiles(content: Buffer, where: string): RuntimeProfiles {
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw new Error(`${where} is invalid JSON: ${String(error)}`);
  }
  const root = requireMapping(value, where);
  assertExactKeys(root, ['schemaVersion', 'models', 'tools'], where);
  if (root.schemaVersion !== 1) throw new Error(`${where} schemaVersion must be 1`);
  const models = requireMapping(root.models, `${where} models`);
  const tools = requireMapping(root.tools, `${where} tools`);
  assertExactKeys(models, HARNESSES, `${where} models`);
  assertExactKeys(tools, HARNESSES, `${where} tools`);
  for (const harness of HARNESSES) {
    const harnessModels = requireMapping(models[harness], `${where} models.${harness}`);
    const harnessTools = requireMapping(tools[harness], `${where} tools.${harness}`);
    assertExactKeys(harnessModels, MODEL_CLASSES, `${where} models.${harness}`);
    assertExactKeys(harnessTools, CAPABILITIES, `${where} tools.${harness}`);
    for (const modelClass of MODEL_CLASSES) {
      if (typeof harnessModels[modelClass] !== 'string' || harnessModels[modelClass].trim() === '') {
        throw new Error(`${where} models.${harness}.${modelClass} must be a non-empty string`);
      }
    }
    for (const capability of CAPABILITIES) {
      const names = harnessTools[capability];
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || name.trim() === '')) {
        throw new Error(`${where} tools.${harness}.${capability} must be a string array`);
      }
    }
  }
  return value as RuntimeProfiles;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function collectSource(contentRoot: string): Promise<SourceFile[]> {
  const rootInfo = await lstat(contentRoot).catch(() => undefined);
  if (!rootInfo?.isDirectory()) throw new Error(`canonical content directory is missing: ${contentRoot}`);
  if (rootInfo.isSymbolicLink()) throw new Error(`canonical content directory must not be a symlink: ${contentRoot}`);
  const ownedRoot = await realpath(contentRoot);
  const files: SourceFile[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = joined(relativeDirectory, entry.name);
      if (relative === 'agents/archived' || relative === 'skills/archived' || relative === 'skills/unfinished') continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await realpath(absolute).catch(() => '');
        if (!target || !inside(ownedRoot, target)) throw new Error(`source symlink escapes owned content: content/${relative}`);
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) throw new Error(`linked source directories are not supported: content/${relative}`);
        if (!targetInfo.isFile()) throw new Error(`unsupported source symlink: content/${relative}`);
        files.push({ relative, content: await readFile(absolute) });
      } else if (info.isDirectory()) {
        await visit(absolute, relative);
      } else if (info.isFile()) {
        files.push({ relative, content: await readFile(absolute) });
      } else {
        throw new Error(`unsupported canonical source entry: content/${relative}`);
      }
    }
  }

  await visit(contentRoot, '');
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function relativeReference(fromFile: string, targetDirectory: string): string {
  const value = path.posix.relative(path.posix.dirname(fromFile), targetDirectory);
  return value || '.';
}

function sourceLookup(sources: readonly SourceFile[]): Map<string, SourceFile> {
  const result = new Map<string, SourceFile>();
  for (const source of sources) {
    const key = path.posix.normalize(source.relative).toLowerCase();
    const previous = result.get(key);
    if (previous) throw new Error(`case-insensitive source collision: content/${source.relative} conflicts with content/${previous.relative}`);
    result.set(key, source);
  }
  return result;
}

function authoredTarget(from: string, rawTarget: string): string {
  let target = rawTarget.replaceAll('{{MPX_SHARED_INSTRUCTIONS}}', '/instructions/shared')
    .replaceAll('{{MPX_AGENT_REFERENCES}}', '/agents/references')
    .replaceAll('{{MPX_SKILL_PREFIX}}', '');
  target = target.startsWith('/')
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) {
    throw new Error(`authored path escapes content from content/${from}: ${rawTarget}`);
  }
  return target;
}

function replaceEligibleIncludes(markdown: string, replace: (requested: string) => string, where: string): string {
  const visible = maskMarkdownCode(markdown);
  const parts: string[] = [];
  let cursor = 0;
  for (const match of visible.matchAll(INCLUDE_PATTERN)) {
    if (visible.slice(cursor, match.index).includes(INCLUDE_START)) throw new Error(`malformed include in ${where}`);
    parts.push(markdown.slice(cursor, match.index), replace(match[1]!.trim()));
    cursor = match.index! + match[0].length;
  }
  parts.push(markdown.slice(cursor));
  if (visible.slice(cursor).includes(INCLUDE_START)) throw new Error(`malformed include in ${where}`);
  return parts.join('');
}

function expandIncludes(
  relative: string,
  sources: ReadonlyMap<string, SourceFile>,
  stack: readonly string[] = [],
  consumer = relative,
): Buffer {
  const source = sources.get(relative.toLowerCase());
  if (!source) throw new Error(`missing include source: content/${relative}`);
  const text = textOf(source.content);
  if (text === undefined) {
    if (stack.length) throw new Error(`included source must be UTF-8 text: content/${source.relative}`);
    return source.content;
  }
  if (stack.some((item) => item.toLowerCase() === source.relative.toLowerCase())) {
    throw new Error(`include cycle: ${[...stack, source.relative].map((item) => `content/${item}`).join(' -> ')}`);
  }
  const frontmatter = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (frontmatter?.index === 0 && frontmatter[1]!.includes(INCLUDE_START)) {
    throw new Error(`include directives are only allowed in bodies: content/${source.relative}`);
  }
  const rebased = stack.length === 0 ? source.content : rewriteMarkdownTargets(source.content, (raw) => {
    const target = parseLocalTarget(raw);
    if (!target) return raw;
    const canonical = authoredTarget(source.relative, target.path);
    return serializeLocalTarget(path.posix.relative(path.posix.dirname(consumer), canonical) || '.', target);
  });
  const rebasedText = textOf(rebased)!;
  const expanded = replaceEligibleIncludes(rebasedText, (requested) => {
    const target = authoredTarget(source.relative, requested);
    const included = sources.get(target.toLowerCase());
    if (!included) throw new Error(`missing include in content/${source.relative}: ${requested}`);
    return expandIncludes(included.relative, sources, [...stack, source.relative], consumer).toString('utf8');
  }, `content/${source.relative}`);
  return expanded === text ? source.content : Buffer.from(expanded);
}

function replacePlaceholders(content: Buffer, harness: Harness, outputPath: string, canonical = false): Buffer {
  const text = textOf(content);
  if (text === undefined) return content;
  const targetRoot = canonical ? '' : `dist/${harness}`;
  const shared = canonical
    ? relativeReference(outputPath, 'instructions/shared')
    : relativeReference(outputPath, `${targetRoot}/instructions/shared`);
  const references = canonical
    ? relativeReference(outputPath, 'agents/references')
    : relativeReference(outputPath, `${targetRoot}/agents/references`);
  const values: Record<(typeof PLACEHOLDERS)[number], string> = {
    '{{MPX_SKILL_COMMAND}}': harness === 'pi' ? '/skill:mp-' : '/mp-',
    '{{MPX_SKILL_PREFIX}}': canonical ? '' : 'mp-',
    '{{MPX_AGENT_PREFIX}}': 'mpx-',
    '{{MPX_SHARED_INSTRUCTIONS}}': shared,
    '{{MPX_AGENT_REFERENCES}}': references,
    '{{MPX_HARNESS}}': harness,
  };
  // Named compiler placeholders use uppercase identifiers. Vue/React/Handlebars
  // examples are content, not a request to rewrite or discard template syntax.
  const codeMask = maskMarkdownCode(text);
  const replaced = text.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, (token, offset: number) => {
    if (!PLACEHOLDERS.includes(token as (typeof PLACEHOLDERS)[number])) throw new Error(`unknown placeholder ${token} in ${outputPath}`);
    const literalInclude = codeMask[offset] === ' ' && text.lastIndexOf(INCLUDE_START, offset) > text.lastIndexOf('}}', offset);
    return literalInclude ? token : values[token as (typeof PLACEHOLDERS)[number]];
  });
  const validationMask = maskMarkdownCode(replaced);
  for (const match of replaced.matchAll(/\{\{\s*MPX_/g)) {
    const literalInclude = validationMask[match.index!] === ' ' && replaced.lastIndexOf(INCLUDE_START, match.index) > replaced.lastIndexOf('}}', match.index);
    if (!literalInclude) throw new Error(`unresolved or malformed MPX placeholder in ${outputPath}`);
  }
  return replaced === text ? content : Buffer.from(replaced);
}

interface MarkdownTarget { start: number; end: number; raw: string }

function maskMarkdownCode(markdown: string): string {
  const masked = markdown.split('');
  const hide = (start: number, end: number): void => {
    for (let index = start; index < end; index++) if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };
  const frontmatter = /^---\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(markdown);
  if (frontmatter?.index === 0) hide(0, frontmatter[0].length);
  const lines = markdown.matchAll(/.*(?:\n|$)/g);
  let fence: string | undefined;
  for (const line of lines) {
    if (!line[0]) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line[0])?.[1];
    if (fence || marker || /^(?: {4}|\t)/.test(line[0])) hide(line.index!, line.index! + line[0].length);
    if (fence && marker?.startsWith(fence.charAt(0)) && marker.length >= fence.length) fence = undefined;
    else if (!fence && marker) fence = marker;
  }
  const visible = masked.join('');
  for (const match of visible.matchAll(/(`+)[^\n]*?\1/g)) hide(match.index!, match.index! + match[0].length);
  return masked.join('');
}

function markdownTargetSpans(content: Buffer): MarkdownTarget[] {
  const text = textOf(content);
  if (text === undefined) return [];
  const clean = maskMarkdownCode(text);
  const targets: MarkdownTarget[] = [];
  for (const match of clean.matchAll(/!?\[[^\]\n]*\]\(\s*/g)) {
    let cursor = match.index! + match[0].length;
    if (clean[cursor] === '<') {
      const end = clean.indexOf('>', cursor + 1);
      if (end >= 0) targets.push({ start: cursor + 1, end, raw: text.slice(cursor + 1, end) });
      continue;
    }
    const start = cursor;
    let depth = 0;
    for (; cursor < clean.length; cursor++) {
      const char = clean[cursor]!;
      if (char === '\\' && cursor + 1 < clean.length) { cursor++; continue; }
      if ((char === ')' || /\s/.test(char)) && depth === 0) break;
      if (char === '(') depth++;
      if (char === ')') depth--;
    }
    if (cursor > start) targets.push({ start, end: cursor, raw: text.slice(start, cursor) });
  }
  for (const match of clean.matchAll(/<(?:a|img|source)\b[^>]*?\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    const offset = match[0].indexOf(match[2]!);
    const start = match.index! + offset;
    targets.push({ start, end: start + match[2]!.length, raw: text.slice(start, start + match[2]!.length) });
  }
  for (const match of clean.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)) {
    const offset = match[0].lastIndexOf(match[1]!);
    const start = match.index! + offset;
    targets.push({ start, end: start + match[1]!.length, raw: text.slice(start, start + match[1]!.length) });
  }
  return targets.sort((left, right) => left.start - right.start);
}

function markdownTargets(content: Buffer): string[] {
  return markdownTargetSpans(content).map(({ raw }) => raw);
}

interface LocalMarkdownTarget { path: string; suffix: string; angled: boolean }

function parseLocalTarget(raw: string): LocalMarkdownTarget | undefined {
  const angled = raw.startsWith('<') && raw.endsWith('>');
  const target = angled ? raw.slice(1, -1) : raw;
  if (!target || target.startsWith('#') || target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  let suffixStart = target.length;
  for (let index = 0; index < target.length; index++) {
    if (target[index] === '\\') { index++; continue; }
    if (target[index] === '?' || target[index] === '#') { suffixStart = index; break; }
  }
  const authoredPath = target.slice(0, suffixStart);
  if (!authoredPath) return undefined;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(authoredPath);
  } catch {
    decodedPath = authoredPath;
  }
  return {
    path: decodedPath.replace(/\\([() #])/g, '$1').replaceAll('\\', '/'),
    suffix: target.slice(suffixStart),
    angled,
  };
}

function encodeMarkdownPath(targetPath: string): string {
  return targetPath.split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function serializeLocalTarget(targetPath: string, original: LocalMarkdownTarget): string {
  const serialized = `${encodeMarkdownPath(targetPath)}${original.suffix}`;
  return original.angled ? `<${serialized}>` : serialized;
}

function localTarget(raw: string): string | undefined {
  return parseLocalTarget(raw)?.path;
}

function rewriteMarkdownTargets(content: Buffer, rewrite: (raw: string) => string): Buffer {
  const text = textOf(content);
  if (text === undefined) return content;
  let cursor = 0;
  let changed = false;
  const parts: string[] = [];
  for (const target of markdownTargetSpans(content)) {
    const replacement = rewrite(target.raw);
    parts.push(text.slice(cursor, target.start), replacement);
    cursor = target.end;
    changed ||= replacement !== target.raw;
  }
  if (!changed) return content;
  parts.push(text.slice(cursor));
  return Buffer.from(parts.join(''));
}

function bundledDependency(dependency: SourceFile): { destination: string; content: Buffer } {
  const skillMatch = /^skills\/([^/]+)\/SKILL\.md$/.exec(dependency.relative);
  if (!skillMatch) return { destination: `references/${dependency.relative}`, content: dependency.content };
  return {
    destination: `references/skills/${skillMatch[1]}/REFERENCE.md`,
    content: parseMarkdown(`content/${dependency.relative}`, dependency.content).body,
  };
}

function skillSupportFiles(
  skill: SourceFile,
  localSupport: readonly SourceFile[],
  sources: ReadonlyMap<string, SourceFile>,
): { skillContent: Buffer; support: SourceFile[] } {
  const skillRoot = path.posix.dirname(skill.relative);
  const bundled = new Map(localSupport.map((file) => [file.relative.slice(`${skillRoot}/`.length).toLowerCase(), {
    relative: file.relative.slice(`${skillRoot}/`.length), content: file.content,
  }]));
  const origins = new Map(localSupport.map((file) => [file.relative.slice(`${skillRoot}/`.length).toLowerCase(), file.relative.toLowerCase()]));
  const queue: Array<{ source: SourceFile; destination: string; content: Buffer }> = [
    { source: skill, destination: 'SKILL.md', content: skill.content },
    ...localSupport.map((source) => ({ source, destination: source.relative.slice(`${skillRoot}/`.length), content: source.content })),
  ];
  const visited = new Set<string>();
  let skillContent = skill.content;
  const addDependency = (dependency: SourceFile): string => {
    const materialized = bundledDependency(dependency);
    const key = materialized.destination.toLowerCase();
    const previous = bundled.get(key);
    if (previous && origins.get(key) !== dependency.relative.toLowerCase()) {
      throw new Error(`case-insensitive skill bundle collision: ${materialized.destination} conflicts with ${previous.relative}`);
    }
    if (!previous) {
      origins.set(key, dependency.relative.toLowerCase());
      const item = { relative: materialized.destination, content: materialized.content };
      bundled.set(key, item);
      queue.push({ source: dependency, destination: materialized.destination, content: materialized.content });
    }
    return materialized.destination;
  };
  while (queue.length) {
    const current = queue.shift()!;
    const visitKey = `${current.source.relative.toLowerCase()}\0${current.destination.toLowerCase()}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (!current.destination.toLowerCase().endsWith('.md')) continue;
    const rewritten = rewriteMarkdownTargets(current.content, (raw) => {
      const target = parseLocalTarget(raw);
      if (!target) return raw;
      const canonical = authoredTarget(current.source.relative, target.path);
      const direct = sources.get(canonical.toLowerCase());
      const directoryFiles = direct ? [] : [...sources.values()].filter((file) => file.relative.toLowerCase().startsWith(`${canonical.toLowerCase()}/`));
      if (!direct && directoryFiles.length === 0) return raw;
      if (canonical === skillRoot || canonical.startsWith(`${skillRoot}/`)) {
        const destination = canonical === skillRoot ? '.' : canonical.slice(`${skillRoot}/`.length);
        return serializeLocalTarget(path.posix.relative(path.posix.dirname(current.destination), destination) || '.', target);
      }
      for (const dependency of direct ? [direct] : directoryFiles) addDependency(dependency);
      const destination = direct ? bundledDependency(direct).destination : `references/${canonical}`;
      return serializeLocalTarget(path.posix.relative(path.posix.dirname(current.destination), destination) || '.', target);
    });
    if (current.destination !== 'SKILL.md') bundled.set(current.destination.toLowerCase(), { relative: current.destination, content: rewritten });
    else skillContent = rewritten;
  }
  return { skillContent, support: [...bundled.values()].sort((left, right) => left.relative.localeCompare(right.relative)) };
}

function validateReferences(files: readonly { path: string; content: Buffer }[], label: string): void {
  const fileNames = new Set(files.map((file) => path.posix.normalize(file.path).toLowerCase()));
  const directories = new Set<string>();
  for (const name of fileNames) {
    let directory = path.posix.dirname(name);
    while (directory !== '.') {
      directories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.md')) continue;
    for (const raw of markdownTargets(file.content)) {
      const target = localTarget(raw);
      if (!target) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
      if (resolved === '..' || resolved.startsWith('../') || (!fileNames.has(resolved.toLowerCase()) && !directories.has(resolved.toLowerCase()))) {
        throw new Error(`broken local Markdown reference in ${label}/${file.path}: ${raw}`);
      }
    }
  }
}

function nativeSkill(data: Mapping, metadata: SkillMetadata, harness: Harness): Mapping {
  const native = canonicalNativeMetadata(data);
  native.name = `mp-${String(data.name)}`;
  const exposure = metadata.defaultExposure ?? (metadata.skillPacks.every((pack) => pack === 'personal') ? 'explicit-only' : 'normal');
  delete native['disable-model-invocation'];
  if (exposure === 'name-only') native.description = `Loads the ${native.name} skill when explicitly referenced.`;
  if (exposure === 'explicit-only') native['disable-model-invocation'] = true;
  // Both selected harnesses consume the Agent Skills disable-model-invocation field.
  void harness;
  return native;
}

function nativeAgent(data: Mapping, metadata: AgentMetadata, profiles: RuntimeProfiles, harness: Harness): Mapping {
  const native = canonicalNativeMetadata(data);
  for (const field of ['model', 'tools', 'thinking', 'effort']) delete native[field];
  native.name = `mpx-${String(data.name)}`;
  native.model = profiles.models[harness][metadata.modelClass];
  native[harness === 'pi' ? 'thinking' : 'effort'] = metadata.thinking;
  const tools = metadata.capabilities.flatMap((capability) => profiles.tools[harness][capability]);
  native.tools = [...new Set(tools)].join(', ');
  return native;
}

export async function projectContent(root: string): Promise<Projection[]> {
  const contentRoot = path.resolve(root, 'content');
  const collectedSources = await collectSource(contentRoot);
  const collectedByPath = sourceLookup(collectedSources);
  const sources = collectedSources.map((file) => ({ ...file, content: expandIncludes(file.relative, collectedByPath) }));
  const sourceByPath = sourceLookup(sources);
  const profileSource = sourceByPath.get('runtime-profiles.json');
  if (!profileSource) throw new Error('content/runtime-profiles.json is required');
  const profiles = runtimeProfiles(profileSource.content, 'content/runtime-profiles.json');
  const skillDirectories = new Set(sources.filter((file) => file.relative.startsWith('skills/')).map((file) => file.relative.split('/')[1]!));
  for (const directory of skillDirectories) {
    if (!sourceByPath.has(`skills/${directory}/skill.md`)) throw new Error(`content/skills/${directory} is missing SKILL.md`);
  }

  const canonical = sources.map((file) => {
    if (/^(?:skills\/[^/]+\/SKILL|agents\/[^/]+)\.md$/.test(file.relative)) {
      const parsed = parseMarkdown(`content/${file.relative}`, file.content);
      return { path: file.relative, content: renderMarkdown(parsed.data, replacePlaceholders(parsed.body, 'pi', file.relative, true)) };
    }
    return { path: file.relative, content: replacePlaceholders(file.content, 'pi', file.relative, true) };
  });
  validateReferences(canonical, 'content');

  const projections = new Map<string, Projection>();
  function add(outputPath: string, content: Buffer): void {
    const normalized = joined(outputPath);
    if (!OUTPUT_ROOTS.some((outputRoot) => normalized === outputRoot || normalized.startsWith(`${outputRoot}/`))) {
      throw new Error(`projection escapes generated roots: ${normalized}`);
    }
    const key = normalized.toLowerCase();
    const previous = projections.get(key);
    if (previous) throw new Error(`duplicate output ${normalized} conflicts with ${previous.path}`);
    projections.set(key, { path: normalized, content });
  }

  const skills = sources.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.relative));
  for (const skill of skills) {
    const [, directoryName] = /^skills\/([^/]+)\/SKILL\.md$/.exec(skill.relative)!;
    assertBareName(directoryName, `content/${skill.relative} directory`);
    const localSupport = sources.filter((file) => file.relative.startsWith(`skills/${directoryName}/`) && file.relative !== skill.relative);
    const bundled = skillSupportFiles(skill, localSupport, sourceByPath);
    const parsed = parseMarkdown(`content/${skill.relative}`, bundled.skillContent);
    const metadata = skillMetadata(parsed.data, directoryName, `content/${skill.relative}`);
    for (const pack of metadata.skillPacks) {
      for (const harness of HARNESSES) {
        const skillRoot = harness === 'pi'
          ? `dist/packs/${pack}/pi/skills/mp-${directoryName}`
          : `dist/packs/${pack}/claude/.claude/skills/mp-${directoryName}`;
        const outputPath = `${skillRoot}/SKILL.md`;
        const body = replacePlaceholders(parsed.body, harness, outputPath);
        add(outputPath, renderMarkdown(nativeSkill(parsed.data, metadata, harness), body));
        for (const file of bundled.support) {
          const destination = `${skillRoot}/${file.relative}`;
          add(destination, replacePlaceholders(file.content, harness, destination));
        }
      }
    }
  }

  for (const source of sources.filter((file) => /^agents\/[^/]+\.md$/.test(file.relative))) {
    const filename = path.posix.basename(source.relative, '.md');
    assertBareName(filename, `content/${source.relative} filename`);
    const parsed = parseMarkdown(`content/${source.relative}`, source.content);
    const metadata = agentMetadata(parsed.data, filename, `content/${source.relative}`);
    for (const harness of HARNESSES) {
      const destination = `dist/${harness}/agents/mpx-${filename}.md`;
      const body = replacePlaceholders(parsed.body, harness, destination);
      add(destination, renderMarkdown(nativeAgent(parsed.data, metadata, profiles, harness), body));
    }
  }

  const mirrors: Array<{ prefix: string; harnesses: readonly Harness[]; destination: string }> = [
    { prefix: 'agents/references/', harnesses: HARNESSES, destination: 'agents/references' },
    { prefix: 'instructions/shared/', harnesses: HARNESSES, destination: 'instructions/shared' },
    { prefix: 'instructions/pi/', harnesses: ['pi'], destination: 'instructions/pi' },
    { prefix: 'instructions/claude/', harnesses: ['claude'], destination: 'instructions/claude' },
    { prefix: 'rules/', harnesses: HARNESSES, destination: 'rules' },
    { prefix: 'hooks/', harnesses: HARNESSES, destination: 'hooks' },
    { prefix: 'output-styles/', harnesses: HARNESSES, destination: 'output-styles' },
  ];
  for (const mirror of mirrors) {
    for (const source of sources.filter((file) => file.relative.startsWith(mirror.prefix))) {
      const relative = source.relative.slice(mirror.prefix.length);
      for (const harness of mirror.harnesses) {
        const destination = `dist/${harness}/${mirror.destination}/${relative}`;
        add(destination, replacePlaceholders(source.content, harness, destination));
      }
    }
  }

  const result = [...projections.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  validateReferences(result, 'projected output');
  return result;
}

interface OutputState { regular: Map<string, Buffer>; links: Set<string> }

async function outputState(root: string): Promise<OutputState> {
  const state: OutputState = { regular: new Map(), links: new Set() };
  const dist = path.resolve(root, 'dist');
  const distInfo = await lstat(dist).catch(() => undefined);
  if (distInfo?.isSymbolicLink()) throw new Error('linked output directory is not allowed: dist');
  if (distInfo && !distInfo.isDirectory()) throw new Error('dist must be a directory');
  const ownedDist = distInfo ? await realpath(dist) : dist;

  async function visit(absolute: string, relative: string): Promise<void> {
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) return;
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute).catch(() => '');
      if (!target || !inside(ownedDist, target)) throw new Error(`output symlink escapes owned output: ${relative}`);
      const targetInfo = await lstat(target);
      if (targetInfo.isDirectory()) throw new Error(`linked output directory is not allowed: ${relative}`);
      state.links.add(relative);
      return;
    }
    if (info.isFile()) {
      state.regular.set(relative, await readFile(absolute));
      return;
    }
    if (!info.isDirectory()) throw new Error(`unsupported output entry: ${relative}`);
    const entries = await readdir(absolute);
    entries.sort();
    for (const entry of entries) await visit(path.join(absolute, entry), joined(relative, entry));
  }

  for (const outputRoot of OUTPUT_ROOTS) await visit(path.resolve(root, outputRoot), outputRoot);
  return state;
}

function expectedMap(projections: readonly Projection[]): Map<string, Projection> {
  return new Map(projections.map((projection) => [projection.path.toLowerCase(), projection]));
}

export async function checkOutput(root: string): Promise<string[]> {
  const projections = await projectContent(root);
  const expected = expectedMap(projections);
  const actual = await outputState(root);
  const drift = new Set<string>();
  for (const projection of projections) {
    const content = actual.regular.get(projection.path);
    if (!content?.equals(projection.content)) drift.add(projection.path);
  }
  for (const pathName of [...actual.regular.keys(), ...actual.links]) {
    if (!expected.has(pathName.toLowerCase())) drift.add(pathName);
    else if (actual.links.has(pathName)) drift.add(expected.get(pathName.toLowerCase())!.path);
  }
  return [...drift].sort();
}

async function assertWritableDestination(root: string, relative: string): Promise<void> {
  const rootAbsolute = path.resolve(root);
  const destination = path.resolve(root, relative);
  if (!inside(rootAbsolute, destination)) throw new Error(`output destination escapes package root: ${relative}`);
  let current = rootAbsolute;
  for (const component of slash(relative).split('/').slice(0, -1)) {
    current = path.join(current, component);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new Error(`linked output directory is not allowed: ${slash(path.relative(rootAbsolute, current))}`);
    if (info && !info.isDirectory()) break;
  }
}

export async function build(root: string): Promise<BuildResult> {
  const projections = await projectContent(root);
  const expected = expectedMap(projections);
  const actual = await outputState(root);
  const changed = new Set<string>();

  for (const link of actual.links) {
    if (expected.has(link.toLowerCase())) throw new Error(`refusing to clobber output symlink: ${link}`);
  }
  for (const [existing] of actual.regular) {
    if (!expected.has(existing.toLowerCase())) {
      await rm(path.resolve(root, existing));
      changed.add(existing);
    }
  }
  for (const projection of projections) {
    const existing = actual.regular.get(projection.path);
    if (existing?.equals(projection.content)) continue;
    await assertWritableDestination(root, projection.path);
    await mkdir(path.dirname(path.resolve(root, projection.path)), { recursive: true });
    await writeFile(path.resolve(root, projection.path), projection.content);
    changed.add(projection.path);
  }
  return { files: projections.map((projection) => projection.path), changed: [...changed].sort() };
}
