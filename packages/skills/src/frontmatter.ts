import { EXPOSURES, SKILL_PACKS, type Exposure, type SkillPack } from './contracts.js';

export const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

export function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
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

export function parseCanonical(
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
