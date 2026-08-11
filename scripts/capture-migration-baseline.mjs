import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const sourceNames = [
  "mpx-claude-code",
  "mpx-pi",
  "mpx-ports",
  "mpx-worktrees",
  "agent-resurrect",
  "kanbanflow-cli",
];

const now = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const localAppData = process.env.LOCALAPPDATA;
const projectRoot = process.env.MPX_PROJECTS;
if (!localAppData || !projectRoot) throw new Error("LOCALAPPDATA and MPX_PROJECTS are required");

const snapshotRoot = path.join(localAppData, "mpx", "migration-snapshots", now);
const filesRoot = path.join(snapshotRoot, "files");
await mkdir(filesRoot, { recursive: true });

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    return `ERROR: ${error.stderr?.toString().trim() || error.message}`;
  }
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const repositories = [];
for (const name of sourceNames) {
  const repositoryPath = path.join(projectRoot, name);
  try {
    await stat(repositoryPath);
  } catch {
    repositories.push({ name, path: repositoryPath, present: false });
    continue;
  }
  repositories.push({
    name,
    path: repositoryPath,
    present: true,
    realPath: await realpath(repositoryPath),
    head: run("git", ["rev-parse", "HEAD"], repositoryPath),
    branch: run("git", ["branch", "--show-current"], repositoryPath),
    status: run("git", ["status", "--short"], repositoryPath),
    remotes: run("git", ["remote", "-v"], repositoryPath),
  });
}

const userHome = homedir();
const candidates = [
  path.join(userHome, ".bashrc"),
  path.join(userHome, ".bash_profile"),
  path.join(userHome, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
  path.join(userHome, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
  path.join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
  path.join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
];

const files = [];
for (const sourcePath of candidates) {
  try {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) continue;
    const safeName = sourcePath.replace(/^([A-Za-z]):/, "$1").replaceAll(/[\\/:]/g, "_");
    const destinationPath = path.join(filesRoot, safeName);
    await cp(sourcePath, destinationPath, { errorOnExist: true });
    files.push({ sourcePath, destinationPath, sha256: await hashFile(destinationPath) });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const powerShellProfilePaths = run("powershell.exe", [
  "-NoProfile",
  "-Command",
  "$PROFILE | Select-Object * | ConvertTo-Json -Compress",
]);
const scheduledTasks = run("powershell.exe", [
  "-NoProfile",
  "-Command",
  "Get-ScheduledTask | Where-Object { $_.TaskName -match 'mpx|agent|resurrect' -or $_.Actions.Execute -match 'mpx|agent|resurrect' -or $_.Actions.Arguments -match 'mpx|agent|resurrect' } | ForEach-Object { [pscustomobject]@{ TaskName=$_.TaskName; TaskPath=$_.TaskPath; State=[string]$_.State; Actions=$_.Actions | Select-Object Execute,Arguments,WorkingDirectory; Triggers=$_.Triggers | Select-Object Enabled,StartBoundary } } | ConvertTo-Json -Depth 6 -Compress",
]);
const environment = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key]) => key.startsWith("MPX_") || key === "PATH")
    .map(([key, value]) => [key, value]),
);

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  machine: process.env.COMPUTERNAME,
  repositories,
  files,
  powerShellProfilePaths,
  scheduledTasks,
  environment,
  exclusions: [
    "Claude and Pi native credential, session, and cache contents",
    "Provider tokens and keyring values",
    "Unrelated private notes",
  ],
};
await writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
});

for (const file of files) {
  if ((await hashFile(file.destinationPath)) !== file.sha256) {
    throw new Error(`Restore verification hash mismatch for ${file.sourcePath}`);
  }
}
await writeFile(path.join(snapshotRoot, "VERIFIED"), `${new Date().toISOString()}\n`, { flag: "wx" });
console.log(snapshotRoot);
