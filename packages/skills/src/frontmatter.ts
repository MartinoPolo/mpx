import {
  EXPOSURES,
  SKILL_CAPABILITIES,
  SKILL_PACKS,
  type Exposure,
  type SkillCapability,
  type SkillPack,
} from './contracts.js';

export const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedTop = new Set(['name', 'description', 'triggers', 'argument-hint', 'metadata']);

function scalar(raw: string): string | boolean | number | string[] {
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
  if (/^[-+]?\d+$/u.test(value)) {
    return Number(value);
  }
  if (/^(null|~|\{|\})/i.test(value)) {
    throw new Error('only strings, booleans, version 1, and string arrays are supported');
  }
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

export function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }
  const closing = /\r?\n---(?:\r?\n)/u.exec(text.slice(3));
  if (!closing) {
    throw new Error('frontmatter closing delimiter is missing');
  }
  const originalEnd = 3 + closing.index;
  const bodyOffset = originalEnd + closing[0].length;
  const normalized = text.slice(0, originalEnd).replace(/\r\n/g, '\n');
  const end = normalized.length;
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
  return { data: root, body: text.slice(bodyOffset) };
}

export function parseCanonical(
  data: Record<string, unknown>,
  directory: string,
): {
  identity: string;
  schemaVersion: 1;
  contentVersion?: 1;
  description: string;
  triggers?: string;
  argumentHint?: string;
  capabilities?: SkillCapability[];
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
    Object.keys(mpx).some(
      (k) =>
        ![
          'schemaVersion',
          'contentVersion',
          'skillPacks',
          'defaultExposure',
          'capabilities',
        ].includes(k),
    )
  ) {
    throw new Error('metadata.mpx is required and contains an unknown field');
  }
  if (mpx.schemaVersion !== 1) {
    throw new Error('metadata.mpx.schemaVersion must be 1');
  }
  if (mpx.contentVersion !== undefined && mpx.contentVersion !== 1) {
    throw new Error('metadata.mpx.contentVersion must be 1 when present');
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
  const argumentHint = data['argument-hint'];
  if (argumentHint !== undefined && (typeof argumentHint !== 'string' || !argumentHint.trim())) {
    throw new Error('argument-hint must be a non-empty string');
  }
  const capabilities = mpx.capabilities;
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.some(
        (capability) => !SKILL_CAPABILITIES.includes(capability as SkillCapability),
      ))
  ) {
    throw new Error('metadata.mpx.capabilities contains an unknown capability');
  }
  return {
    identity,
    schemaVersion: 1,
    ...(mpx.contentVersion === 1 ? { contentVersion: 1 as const } : {}),
    description: data.description,
    ...(typeof data.triggers === 'string' ? { triggers: data.triggers } : {}),
    ...(typeof argumentHint === 'string' ? { argumentHint } : {}),
    ...(Array.isArray(capabilities)
      ? { capabilities: [...new Set(capabilities as SkillCapability[])].sort() }
      : {}),
    packs: [...new Set(packs as SkillPack[])].sort(),
    exposure: exposure as Exposure,
  };
}
