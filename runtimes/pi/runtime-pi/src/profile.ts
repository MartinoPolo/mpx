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
  return freeze({
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
