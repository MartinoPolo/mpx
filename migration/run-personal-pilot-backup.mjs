import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { backupPilot, protectWindowsRoot } from './pilot-backup.mjs';

const roots = Object.fromEntries(['MPX_APPS', 'MPX_PROJECTS', 'MPX_CLONED'].map(name => {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute machine root.`);
  return [name, value];
}));
const home = homedir();
const parent = path.join(roots.MPX_APPS, '_backups');
await mkdir(parent, { recursive: true });
const destination = path.join(parent, `mpx2-personal-pilot-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination);
await protectWindowsRoot(destination);
const groups = [
  { name: 'personal-account', sources: [path.join(home, '.pi/agent')] },
  { name: 'routing', sources: [path.join(home, '.bashrc'), path.join(roots.MPX_PROJECTS, 'prejemesi/mpxconfig.json'), path.join(roots.MPX_PROJECTS, 'prejemesi/.mpx/DECISIONS.md')] },
  { name: 'legacy-resources', sources: [path.join(roots.MPX_PROJECTS, 'mpx-pi'), path.join(roots.MPX_CLONED, 'pi-tool-display.worktrees/feat/compact-tool-shell'), await realpath(path.join(home, '.agents/skills/mpx'))] },
  { name: 'installed-mpx-launchers', sources: [path.join(roots.MPX_APPS, 'mpx/bin')] },
];
const summary = { complete: false, destination, groups: [], limitations: ['Per-file snapshot, not a globally atomic live-session snapshot.', 'Links are metadata only; external targets not explicitly listed are not copied.', 'Unmodified native engine and installed MPX release stores remain in place.', 'Routine rollback must preserve newer credentials and conversations.'] };
await writeFile(path.join(destination, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
for (const group of groups) {
  const result = await backupPilot({ sources: group.sources, destinationRoot: path.join(destination, group.name) });
  summary.groups.push({ name: group.name, manifestPath: result.manifestPath, entries: result.manifest.entries.length });
  await writeFile(path.join(destination, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
summary.complete = true;
await writeFile(path.join(destination, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
