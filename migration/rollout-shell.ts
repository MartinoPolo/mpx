const MANAGED_START = '# >>> MPX MANAGED LAUNCHERS >>>';
const MANAGED_END = '# <<< MPX MANAGED LAUNCHERS <<<';
const LEGACY_START = '# allow cd after creating a worktree';
const LEGACY_END = 'alias y="yarn"';
const COMMANDS = ['mpx', 'pi', 'piw', 'cc', 'ccw'] as const;

function markerIndex(lines: readonly string[], marker: string): number {
  const matches = lines.flatMap((line, index) => line === marker ? [index] : []);
  if (matches.length !== 1) throw new Error('Launcher layout changed; expected exactly one layout marker.');
  return matches[0]!;
}

function shellLaunchers(): string[] {
  return COMMANDS.map(command => `${command}() { bash "\${MPX_PROJECTS:?${command} requires MPX_PROJECTS}/mpx2/bin/${command}" "$@"; }`);
}

function preserveNewline(source: string, transform: (lines: string[]) => string[]): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return transform(source.replaceAll('\r\n', '\n').split('\n')).join(newline);
}

export function renderFinalCutoverShell(source: string): string {
  return preserveNewline(source, lines => {
    const legacyStart = markerIndex(lines, LEGACY_START);
    const legacyEnd = markerIndex(lines, LEGACY_END);
    const managedStart = markerIndex(lines, MANAGED_START);
    const managedEnd = markerIndex(lines, MANAGED_END);
    if (legacyStart >= legacyEnd || managedStart >= managedEnd) throw new Error('Launcher layout changed; marker order is invalid.');

    const withoutManaged = [...lines.slice(0, managedStart), ...lines.slice(managedEnd + 1)];
    const adjustedLegacyStart = markerIndex(withoutManaged, LEGACY_START);
    const adjustedLegacyEnd = markerIndex(withoutManaged, LEGACY_END);
    const launchers = shellLaunchers();
    const result = [...withoutManaged.slice(0, adjustedLegacyStart), ...launchers, ...withoutManaged.slice(adjustedLegacyEnd)];
    return result
      .filter(line => !/^alias gw(?:r)?=/.test(line))
      .map(line => line === 'alias p0="cd \\"$mpProjectsFolder/mpx-claude-code\\""'
        ? 'alias p0=\'cd "${MPX_PROJECTS:?p0 requires MPX_PROJECTS}/mpx2"\''
        : line);
  });
}

function powershellLaunchers(): string[] {
  return COMMANDS.map(command => `function ${command} { if (-not $env:MPX_PROJECTS -or -not $env:MPX_APPS) { throw '${command} requires MPX_PROJECTS and MPX_APPS' }; & "$env:MPX_APPS/Git/bin/bash.exe" --login "$env:MPX_PROJECTS/mpx2/bin/${command}" @args }`);
}

export function renderFinalPowerShellProfile(source: string): string {
  return preserveNewline(source, lines => {
    const start = markerIndex(lines, MANAGED_START);
    const end = markerIndex(lines, MANAGED_END);
    if (start >= end) throw new Error('Launcher layout changed; marker order is invalid.');
    return [...lines.slice(0, start), MANAGED_START, ...powershellLaunchers(), MANAGED_END, ...lines.slice(end + 1)];
  });
}
