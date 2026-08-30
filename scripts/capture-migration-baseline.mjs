import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { captureDirectoryCandidate, captureFileCandidate } from './capture-baseline-files.mjs';
import { buildDirectoryCandidates, buildFileCandidates } from './capture-baseline-candidates.mjs';

const sourceNames = [
  'mpx-claude-code',
  'mpx-pi',
  'mpx-ports',
  'mpx-worktrees',
  'agent-resurrect',
  'kanbanflow-cli',
];

const now = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
const localAppData = process.env.LOCALAPPDATA;
const projectRoot = process.env.MPX_PROJECTS;
if (!localAppData || !projectRoot) {
  throw new Error('LOCALAPPDATA and MPX_PROJECTS are required');
}

const snapshotRoot = path.join(localAppData, 'mpx', 'migration-snapshots', now);
const filesRoot = path.join(snapshotRoot, 'files');
await mkdir(filesRoot, { recursive: true });
execFileSync(
  'icacls.exe',
  [
    snapshotRoot,
    '/inheritance:r',
    '/grant:r',
    `${process.env.USERNAME}:(OI)(CI)F`,
    'SYSTEM:(OI)(CI)F',
  ],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
);

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `ERROR: ${error.stderr?.toString().trim() || error.message}`;
  }
}

async function hashFile(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
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

  const repositorySnapshotRoot = path.join(snapshotRoot, 'repositories', name);
  await mkdir(repositorySnapshotRoot, { recursive: true });
  const bundlePath = path.join(repositorySnapshotRoot, 'history.bundle');
  execFileSync('git', ['bundle', 'create', bundlePath, '--all'], {
    cwd: repositoryPath,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const trackedPatch = run('git', ['diff', '--binary', 'HEAD'], repositoryPath);
  await writeFile(path.join(repositorySnapshotRoot, 'tracked.patch'), `${trackedPatch}\n`);

  const untrackedOutput = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      cwd: repositoryPath,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const untracked = untrackedOutput.split('\0').filter(Boolean);
  for (const relativePath of untracked) {
    const sourcePath = path.resolve(repositoryPath, relativePath);
    const relative = path.relative(repositoryPath, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Untracked path escaped repository: ${relativePath}`);
    }
    const destinationPath = path.join(repositorySnapshotRoot, 'untracked', relative);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  repositories.push({
    name,
    path: repositoryPath,
    present: true,
    realPath: await realpath(repositoryPath),
    head: run('git', ['rev-parse', 'HEAD'], repositoryPath),
    branch: run('git', ['branch', '--show-current'], repositoryPath),
    status: run('git', ['status', '--short'], repositoryPath),
    remotes: run('git', ['remote', '-v'], repositoryPath),
    bundlePath,
    trackedPatchPath: path.join(repositorySnapshotRoot, 'tracked.patch'),
    untracked,
  });
}

const userHome = homedir();
const candidates = buildFileCandidates({
  userHome,
  localAppData,
  projectRoot,
  obsidianVault: process.env.MPX_OBSIDIAN_VAULT,
});

const directoryCandidates = buildDirectoryCandidates({
  localAppData,
  projectRoot,
  aiGenerated: process.env.MPX_AI_GENERATED,
  obsidianVault: process.env.MPX_OBSIDIAN_VAULT,
  appData: process.env.APPDATA,
});

const files = [];
for (const candidate of candidates) {
  try {
    await lstat(candidate.sourcePath);
    const safeName = candidate.sourcePath.replace(/^([A-Za-z]):/, '$1').replaceAll(/[\\/:]/g, '_');
    files.push(
      await captureFileCandidate({ ...candidate, destinationPath: path.join(filesRoot, safeName) }),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const directories = [];
for (const sourcePath of directoryCandidates) {
  try {
    await lstat(sourcePath);
    const safeName = sourcePath.replace(/^([A-Za-z]):/, '$1').replaceAll(/[\\/:]/g, '_');
    directories.push(
      await captureDirectoryCandidate({
        sourcePath,
        destinationPath: path.join(filesRoot, safeName),
      }),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const piRoot = path.join(userHome, '.pi', 'agent');
const piLinks = [];
const piEntries = [
  'agents',
  'extensions',
  'prompts',
  'themes',
  'settings.json',
  'subagents.json',
  'keybindings.json',
  'APPEND_SYSTEM.md',
  'AGENTS.md',
  'skills',
];
try {
  for (const name of await readdir(path.join(piRoot, 'skills'))) {
    piEntries.push(path.join('skills', name));
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}
for (const name of piEntries) {
  const linkPath = path.join(piRoot, name);
  try {
    const linkStat = await lstat(linkPath);
    piLinks.push({
      path: linkPath,
      type: linkStat.isSymbolicLink()
        ? 'symbolic-link'
        : linkStat.isDirectory()
          ? 'directory'
          : 'file',
      target: linkStat.isSymbolicLink() ? await readlink(linkPath) : undefined,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

const scheduledTaskXml = run('powershell.exe', [
  '-NoProfile',
  '-Command',
  "Export-ScheduledTask -TaskName 'agent-resurrect-autosave' -ErrorAction SilentlyContinue",
]);
if (scheduledTaskXml && !scheduledTaskXml.startsWith('ERROR:')) {
  await writeFile(path.join(snapshotRoot, 'agent-resurrect-autosave.xml'), `${scheduledTaskXml}\n`);
}

const powerShellProfilePaths = run('powershell.exe', [
  '-NoProfile',
  '-Command',
  '$PROFILE | Select-Object * | ConvertTo-Json -Compress',
]);
const scheduledTasks = run('powershell.exe', [
  '-NoProfile',
  '-Command',
  "Get-ScheduledTask | Where-Object { $_.TaskName -match 'mpx|agent|resurrect' -or $_.Actions.Execute -match 'mpx|agent|resurrect' -or $_.Actions.Arguments -match 'mpx|agent|resurrect' } | ForEach-Object { [pscustomobject]@{ TaskName=$_.TaskName; TaskPath=$_.TaskPath; State=[string]$_.State; Actions=$_.Actions | Select-Object Execute,Arguments,WorkingDirectory; Triggers=$_.Triggers | Select-Object Enabled,StartBoundary } } | ConvertTo-Json -Depth 6 -Compress",
]);
const environment = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key]) => key.startsWith('MPX_') || key === 'PATH')
    .map(([key, value]) => [key, value]),
);

const manifest = {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  machine: process.env.COMPUTERNAME,
  repositories,
  files,
  directories,
  piLinks,
  powerShellProfilePaths,
  scheduledTasks,
  environment,
  exclusions: [
    'Claude and Pi native credential, session, and cache contents',
    'Provider tokens and keyring values',
    'Unrelated private notes',
  ],
};
await writeFile(
  path.join(snapshotRoot, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  {
    flag: 'wx',
  },
);

for (const file of files) {
  if ((await hashFile(file.destinationPath)) !== file.sha256) {
    throw new Error(`Restore verification hash mismatch for ${file.sourcePath}`);
  }
}
await writeFile(path.join(snapshotRoot, 'VERIFIED'), `${new Date().toISOString()}\n`, {
  flag: 'wx',
});
console.log(snapshotRoot);
