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
  readonly keybindings: Readonly<Record<string, string | readonly string[]>>;
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
    'keybindings',
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
  const keybindings = profile.keybindings;
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
    !keybindings ||
    typeof keybindings !== 'object' ||
    Array.isArray(keybindings) ||
    !Object.entries(keybindings).every(
      ([key, binding]) =>
        key.length > 0 &&
        (typeof binding === 'string' ||
          (Array.isArray(binding) && binding.every((item) => typeof item === 'string'))),
    ) ||
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
    keybindings: Object.fromEntries(
      Object.entries(keybindings).map(([key, binding]) => [
        key,
        Array.isArray(binding) ? [...binding] : binding,
      ]),
    ),
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
    keybindings: {
      'app.model.select': 'alt+p',
      'app.model.cycleBackward': 'shift+ctrl+p',
      'tui.altScreen.pageUp': [],
      'tui.altScreen.pageDown': [],
      'tui.altScreen.halfPageUp': 'pageUp',
      'tui.altScreen.halfPageDown': 'pageDown',
      'tui.altScreen.top': [],
      'tui.altScreen.bottom': [],
    },
    capabilityIds: [...capabilityIds],
  });
}

export function profileSettings(profile: PiRuntimeProfileV1) {
  return freeze({
    defaultProvider: profile.provider,
    defaultModel: profile.model,
    enabledModels: profile.models,
    defaultThinkingLevel: profile.thinking,
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    terminal: { showTerminalProgress: profile.terminalProgress },
    tuiMode: profile.tuiMode,
    fullscreenScrollbar: 'always',
    theme: profile.theme,
    enableSkillCommands: false,
    steeringMode: 'all',
    followUpMode: 'all',
    treeFilterMode: 'no-tools',
    doubleEscapeAction: 'tree',
    defaultProjectTrust: profile.trust,
    enableInstallTelemetry: false,
  });
}
