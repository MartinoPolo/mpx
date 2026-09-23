import type { Thinking } from './contracts.js';

export const PI_MODEL_FAMILIES = ['luna', 'sol', 'terra', 'astra'] as const;
export type PiModelFamily = (typeof PI_MODEL_FAMILIES)[number];

export interface AvailablePiModel {
  id: string;
  provider: string;
}

export type PiModelRoutingResult =
  | { kind: 'unrelated' }
  | { kind: 'error'; message: string }
  | { kind: 'resolved'; family: PiModelFamily; model: string };

const FAMILY_SET = new Set<string>(PI_MODEL_FAMILIES);
const VERSIONED_FAMILY_PATTERN = /^gpt-(\d+(?:\.\d+)*)-(luna|sol|terra|astra)$/i;

function isPiModelFamily(value: string): value is PiModelFamily {
  return FAMILY_SET.has(value);
}
export const LUNA_MINIMUM_THINKING: Thinking = 'high';
export const LUNA_ALLOWED_THINKING: readonly Thinking[] = ['high', 'xhigh', 'max'];

export function piFamilyReference(reference: string, profiles: Readonly<Record<string, string>>): { provider: string; family: PiModelFamily } | undefined {
  const normalized = reference.trim().toLowerCase();
  const profiled = Object.hasOwn(profiles, normalized) ? profiles[normalized]?.toLowerCase() : undefined;
  const candidate = profiled ?? normalized;
  const slash = candidate.indexOf('/');
  if (slash >= 0) {
    const provider = candidate.slice(0, slash);
    const modelReference = candidate.slice(slash + 1);
    const family = parseVersionedPiModelFamily(modelReference)?.family ?? modelReference;
    return provider && isPiModelFamily(family) ? { provider, family } : undefined;
  }
  if (!isPiModelFamily(candidate)) return undefined;
  const providers = new Set(
    Object.values(profiles)
      .map(value => value.toLowerCase().split('/'))
      .filter(parts => parts.length === 2
        && (parseVersionedPiModelFamily(parts[1]!)?.family ?? parts[1]) === candidate)
      .map(parts => parts[0]!),
  );
  return providers.size === 1 ? { provider: [...providers][0]!, family: candidate } : undefined;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseVersionedPiModelFamily(modelId: string): { family: PiModelFamily; version: number[] } | undefined {
  const match = VERSIONED_FAMILY_PATTERN.exec(modelId);
  if (!match) return undefined;
  const family = match[2]!.toLowerCase();
  if (!isPiModelFamily(family)) return undefined;
  return {
    family,
    version: match[1]!.split('.').map(Number),
  };
}

export function isPiFamilyModel(model: AvailablePiModel | undefined, family: PiModelFamily): boolean {
  return parseVersionedPiModelFamily(model?.id ?? '')?.family === family;
}

export function resolvePiModelReference(
  input: string,
  profiles: Readonly<Record<string, string>>,
  availableModels: readonly AvailablePiModel[],
): PiModelRoutingResult {
  const normalizedInput = input.trim().toLowerCase();
  const configuredReference = Object.hasOwn(profiles, normalizedInput)
    ? profiles[normalizedInput]?.trim().toLowerCase()
    : undefined;
  const modelReference = configuredReference ?? normalizedInput;
  const slash = modelReference.indexOf('/');
  if (slash >= 0) {
    const provider = modelReference.slice(0, slash);
    const modelId = modelReference.slice(slash + 1);
    const pinned = parseVersionedPiModelFamily(modelId);
    if (pinned) {
      const exact = availableModels.find(model => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId);
      return exact
        ? { kind: 'resolved', family: pinned.family, model: `${exact.provider}/${exact.id}` }
        : { kind: 'error', message: `Required model is unavailable: ${input}` };
    }
  } else {
    const pinned = parseVersionedPiModelFamily(modelReference);
    if (pinned) {
      const profile = piFamilyReference(pinned.family, profiles);
      if (!profile) return { kind: 'error', message: `No provider is configured for model family ${pinned.family}` };
      const exact = availableModels.find(model => model.provider.toLowerCase() === profile.provider && model.id.toLowerCase() === modelReference);
      return exact
        ? { kind: 'resolved', family: pinned.family, model: `${exact.provider}/${exact.id}` }
        : { kind: 'error', message: `Required model is unavailable: ${input}` };
    }
  }

  const reference = piFamilyReference(modelReference, profiles);
  if (!reference) {
    if (isPiModelFamily(normalizedInput) || Object.hasOwn(profiles, normalizedInput)) {
      return { kind: 'error', message: `No unambiguous provider is configured for model reference ${input}` };
    }
    return { kind: 'unrelated' };
  }
  const candidates = availableModels
    .map(model => ({ model, parsed: parseVersionedPiModelFamily(model.id) }))
    .filter(candidate => candidate.model.provider.toLowerCase() === reference.provider && candidate.parsed?.family === reference.family)
    .sort((left, right) => compareVersions(right.parsed!.version, left.parsed!.version));
  const selected = candidates[0]?.model;
  return selected
    ? { kind: 'resolved', family: reference.family, model: `${selected.provider}/${selected.id}` }
    : { kind: 'error', message: `No available ${reference.provider}/${reference.family} model was found` };
}

function isAllowedLunaThinking(thinking: unknown): thinking is Thinking {
  return typeof thinking === 'string' && LUNA_ALLOWED_THINKING.some(level => level === thinking);
}

export function enforceLunaThinking(thinking: unknown): Thinking {
  return isAllowedLunaThinking(thinking) ? thinking : LUNA_MINIMUM_THINKING;
}
