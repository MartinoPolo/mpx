export const PI_RUNTIME_PROFILE_SCHEMA_VERSION = 1 as const;

/** Structural boundary supplied by config composition; runtime-pi does not select providers or models. */
export interface PiModelSelectionV1 {
  readonly schemaVersion: 1;
  readonly runtime: 'pi';
  readonly provider: string;
  readonly defaultModel: string;
  readonly enabledModels: readonly string[];
}

export interface PiRuntimeProfileV1 {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly thinking: 'medium';
  readonly theme: 'dark';
  readonly tuiMode: 'fullscreen';
  readonly terminalProgress: false;
  readonly trust: 'ask';
  readonly capabilityIds: readonly string[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export class PiRuntimeProfileError extends TypeError {
  readonly code = 'PI_RUNTIME_PROFILE_INVALID' as const;

  constructor() {
    super('Pi runtime profile is invalid.');
    this.name = 'PiRuntimeProfileError';
  }
}

function invalidProfile(): never {
  throw new PiRuntimeProfileError();
}

function nonemptyIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('/')
  );
}

function uniqueNonemptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.trim() === item) &&
    new Set(value).size === value.length
  );
}

/** Fail-closed public boundary for projected Pi runtime profiles. */
export function parsePiRuntimeProfileV1(value: unknown): PiRuntimeProfileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidProfile();
  }
  const profile = value as Record<string, unknown>;
  const expectedKeys = [
    'capabilityIds',
    'model',
    'models',
    'provider',
    'schemaVersion',
    'terminalProgress',
    'theme',
    'thinking',
    'trust',
    'tuiMode',
  ];
  if (
    Object.keys(profile).sort().join(',') !== expectedKeys.join(',') ||
    profile.schemaVersion !== PI_RUNTIME_PROFILE_SCHEMA_VERSION ||
    !nonemptyIdentity(profile.provider) ||
    !nonemptyIdentity(profile.model) ||
    !uniqueNonemptyStrings(profile.models) ||
    profile.models.length === 0 ||
    !profile.models.every(
      (identity) =>
        identity.startsWith(`${profile.provider}/`) &&
        identity.length > `${profile.provider}/`.length,
    ) ||
    !profile.models.includes(`${profile.provider}/${profile.model}`) ||
    profile.thinking !== 'medium' ||
    profile.theme !== 'dark' ||
    profile.tuiMode !== 'fullscreen' ||
    profile.terminalProgress !== false ||
    profile.trust !== 'ask' ||
    !uniqueNonemptyStrings(profile.capabilityIds)
  ) {
    return invalidProfile();
  }
  return freeze({
    schemaVersion: PI_RUNTIME_PROFILE_SCHEMA_VERSION,
    provider: profile.provider,
    model: profile.model,
    models: [...profile.models],
    thinking: 'medium',
    theme: 'dark',
    tuiMode: 'fullscreen',
    terminalProgress: false,
    trust: 'ask',
    capabilityIds: [...profile.capabilityIds],
  });
}

/** Account-safe Pi translation only; model identity selection belongs to config composition. */
export function createPiRuntimeProfileV1(
  modelSelection: PiModelSelectionV1,
  capabilityIds: readonly string[],
): PiRuntimeProfileV1 {
  const prefix = `${modelSelection.provider}/`;
  if (
    modelSelection.runtime !== 'pi' ||
    !modelSelection.defaultModel.startsWith(prefix) ||
    !modelSelection.enabledModels.includes(modelSelection.defaultModel)
  ) {
    throw new TypeError('Pi model selection is inconsistent');
  }
  return parsePiRuntimeProfileV1({
    schemaVersion: PI_RUNTIME_PROFILE_SCHEMA_VERSION,
    provider: modelSelection.provider,
    model: modelSelection.defaultModel.slice(prefix.length),
    models: [...modelSelection.enabledModels],
    thinking: 'medium',
    theme: 'dark',
    tuiMode: 'fullscreen',
    terminalProgress: false,
    trust: 'ask',
    capabilityIds: [...capabilityIds],
  });
}
