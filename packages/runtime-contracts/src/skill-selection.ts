import path from 'node:path';

export type SkillPackName = 'development' | 'personal';

export interface ResolvedSkillSelection {
  readonly location: { readonly name: string; readonly canonicalRoot: string };
  readonly packs: readonly SkillPackName[];
  readonly source: 'project' | 'user-project' | 'user-location';
}

type InvalidSelection = (code: string, message: string) => never;

function record(value: unknown, label: string, invalid: InvalidSelection): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('INVALID_CONTRACT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  invalid: InvalidSelection,
): void {
  const extra = Object.keys(value).find((key) => !expected.includes(key));
  if (extra) {
    invalid('UNKNOWN_FIELD', `${label} contains unknown field '${extra}'`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    invalid('INVALID_CONTRACT', `${label} is missing '${missing}'`);
  }
}

function text(value: unknown, label: string, invalid: InvalidSelection): string {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('INVALID_CONTRACT', `${label} must be a non-empty string`);
  }
  return value;
}

const locationNamePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

function locationName(value: unknown, invalid: InvalidSelection): string {
  const result = text(value, 'selection.location.name', invalid);
  if (result.length > 64 || !locationNamePattern.test(result)) {
    return invalid('INVALID_CONTRACT', 'selection.location.name is invalid');
  }
  return result;
}

function canonicalRoot(value: unknown, invalid: InvalidSelection): string {
  const result = text(value, 'selection.location.canonicalRoot', invalid);
  if (result.length > 4096 || (!path.win32.isAbsolute(result) && !path.posix.isAbsolute(result))) {
    return invalid('INVALID_CONTRACT', 'selection.location.canonicalRoot is invalid');
  }
  return result;
}

export function parseSkillSelection(
  value: unknown,
  invalid: InvalidSelection,
): ResolvedSkillSelection {
  const item = record(value, 'selection', invalid);
  exactKeys(item, ['location', 'packs', 'source'], 'selection', invalid);
  const location = record(item.location, 'selection.location', invalid);
  exactKeys(location, ['name', 'canonicalRoot'], 'selection.location', invalid);
  if (
    !Array.isArray(item.packs) ||
    item.packs.length === 0 ||
    item.packs.some((pack) => pack !== 'development' && pack !== 'personal') ||
    new Set(item.packs).size !== item.packs.length
  ) {
    invalid('INVALID_CONTRACT', 'selection.packs must contain unique supported skill packs');
  }
  if (!['project', 'user-project', 'user-location'].includes(item.source as string)) {
    invalid('INVALID_CONTRACT', 'selection.source is invalid');
  }
  return Object.freeze({
    location: Object.freeze({
      name: locationName(location.name, invalid),
      canonicalRoot: canonicalRoot(location.canonicalRoot, invalid),
    }),
    packs: Object.freeze([...(item.packs as SkillPackName[])].sort()),
    source: item.source as ResolvedSkillSelection['source'],
  });
}
