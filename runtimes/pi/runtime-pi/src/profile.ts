export const PI_RUNTIME_PROFILE_SCHEMA_VERSION = 1 as const;

export interface PiRuntimeProfileV1 {
  readonly schemaVersion: 1;
  readonly provider: "openai-codex";
  readonly model: "gpt-5.6-sol";
  readonly models: readonly ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"];
  readonly thinking: "medium";
  readonly theme: "dark";
  readonly tuiMode: "fullscreen";
  readonly terminalProgress: false;
  readonly trust: "ask";
  readonly keybindings: Readonly<Record<string, string | readonly string[]>>;
  readonly capabilityIds: readonly string[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Account-safe projection settings only. Native Pi auth, sessions, trust decisions and caches never enter this profile. */
export function createPiRuntimeProfileV1(capabilityIds: readonly string[] = []): PiRuntimeProfileV1 {
  return freeze({
    schemaVersion: PI_RUNTIME_PROFILE_SCHEMA_VERSION,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    models: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"],
    thinking: "medium",
    theme: "dark",
    tuiMode: "fullscreen",
    terminalProgress: false,
    trust: "ask",
    keybindings: {
      "app.model.select": "alt+p",
      "app.model.cycleBackward": "shift+ctrl+p",
      "tui.altScreen.pageUp": [],
      "tui.altScreen.pageDown": [],
      "tui.altScreen.halfPageUp": "pageUp",
      "tui.altScreen.halfPageDown": "pageDown",
      "tui.altScreen.top": [],
      "tui.altScreen.bottom": [],
    },
    capabilityIds: [...capabilityIds],
  });
}

export function profileSettings(profile: PiRuntimeProfileV1) {
  return freeze({
    defaultProvider: profile.provider, defaultModel: profile.model, enabledModels: profile.models,
    defaultThinkingLevel: profile.thinking,
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    terminal: { showTerminalProgress: profile.terminalProgress }, tuiMode: profile.tuiMode,
    fullscreenScrollbar: "always", theme: profile.theme, enableSkillCommands: false,
    steeringMode: "all", followUpMode: "all", treeFilterMode: "no-tools", doubleEscapeAction: "tree",
    defaultProjectTrust: profile.trust, enableInstallTelemetry: false,
  });
}
