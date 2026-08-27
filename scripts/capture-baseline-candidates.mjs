import path from "node:path";

function optionalAbsoluteRoot(value, label) {
  if (value === undefined || value === "") return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${label} root must be an absolute path`);
  return value;
}

export function buildDirectoryCandidates({ localAppData, projectRoot, aiGenerated, obsidianVault, appData }) {
  const absoluteAiGenerated = optionalAbsoluteRoot(aiGenerated, "AI-generated assets");
  const absoluteObsidianVault = optionalAbsoluteRoot(obsidianVault, "Obsidian vault");
  const absoluteAppData = optionalAbsoluteRoot(appData, "Application data");
  return [
    path.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "icons"),
    ...(absoluteAiGenerated ? [path.join(absoluteAiGenerated, "_RAYCAST")] : []),
    ...(absoluteObsidianVault ? [path.join(absoluteObsidianVault, "_Projekty", "MpxClaudeCode")] : []),
    path.join(projectRoot, "agent-resurrect", "saves"),
    ...(absoluteAppData ? [
      path.join(absoluteAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Resurrect Agent Sessions.lnk"),
      path.join(absoluteAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Save Agent Sessions.lnk"),
    ] : []),
  ];
}

export function buildFileCandidates({ userHome, localAppData, projectRoot, obsidianVault }) {
  optionalAbsoluteRoot(obsidianVault, "Obsidian vault");
  const personalSettings = path.join(userHome, ".claude", "settings.json");
  const workSettings = path.join(userHome, ".claude-work", "settings.json");
  const allowedSettingsTarget = path.join(projectRoot, "mpx-claude-code");
  const paths = [
    path.join(userHome, ".bashrc"),
    path.join(userHome, ".bash_profile"),
    path.join(userHome, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(userHome, "Documents", "WindowsPowerShell", "profile.ps1"),
    personalSettings,
    path.join(userHome, ".claude", "plugins", "installed_plugins.json"),
    path.join(userHome, ".claude", "plugins", "known_marketplaces.json"),
    workSettings,
    path.join(userHome, ".claude-work", "plugins", "installed_plugins.json"),
    path.join(userHome, ".claude-work", "plugins", "known_marketplaces.json"),
    path.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    path.join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
    ...(obsidianVault ? [
      path.join(obsidianVault, "_Projekty", "Mini Projekty", "Issues", "Active", "mpx-ports.md"),
      path.join(obsidianVault, "_Projekty", "Mini Projekty", "Issues", "Active", "claude-resurrect.md"),
    ] : []),
  ];
  return paths.map(sourcePath => ({
    sourcePath,
    allowedTargetRoots: sourcePath === personalSettings || sourcePath === workSettings ? [allowedSettingsTarget] : [],
  }));
}
