import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUserConfig, parseRepositoryConfig } from '../src/config.js';
import { piRuntimeBootstrap, syncRuntimeScope } from '../src/runtime-install.js';
import { planAgentLinks, inspectAgentLinks, syncAgentLinks } from '../src/install.js';
import { renderPilotShell } from './pilot-shell.js';
import { replaceDirectoryLink, replaceVerifiedLink } from './pilot-link-copy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const backupArgument = process.argv[2];
const apply = process.argv[3] === '--apply';
if (!backupArgument || !path.isAbsolute(backupArgument) || process.argv.slice(3).some(value => value !== '--apply')) throw new Error('Usage: apply-personal-pilot.ts <absolute-backup-root> [--apply]');
const backup: string = backupArgument;
const summary = JSON.parse(await readFile(path.join(backup, 'summary.json'), 'utf8'));
if (!summary.complete) throw new Error('A complete protected backup is required.');
const home = homedir();
const projects = process.env.MPX_PROJECTS;
const cloned = process.env.MPX_CLONED;
const appdata = process.env.APPDATA;
const work = process.env.MPX_WORK;
if (!projects || !cloned || !appdata || !work || ![projects, cloned, appdata, work].every(value => path.isAbsolute(value))) throw new Error('Verified absolute machine roots are required.');
const account = path.join(home, '.pi/agent');
const shellFile = path.join(home, '.bashrc');
const projectFile = path.join(projects, 'prejemesi/mpxconfig.json');
const configFile = path.join(appdata, 'mpx2/config.json');
const settingsFile = path.join(account, 'settings.json');
const runtimeFile = path.join(account, 'extensions/mpx2.ts');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifests = new Map<string, { sourceMap: Record<string, string>; entries: Array<{ path: string; type: string; sha256?: string; target?: string }> }>();
for (const name of ['routing', 'personal-account', 'legacy-resources']) manifests.set(name, JSON.parse(await readFile(path.join(backup, name, 'manifest.json'), 'utf8')));
async function backedBytes(group: string, source: string, relative = '') {
  const manifest = manifests.get(group)!;
  const sourceRoot = group === 'personal-account' ? account : source;
  const label = manifest.sourceMap[sourceRoot];
  if (!label) throw new Error(`Backup does not cover ${source}.`);
  const entryPath = path.posix.join(label, relative.replaceAll('\\', '/'));
  const entry = manifest.entries.find(value => value.path === entryPath);
  if (!entry || entry.type !== 'file') throw new Error(`A regular backup file is required for ${source}.`);
  const bytes = await readFile(path.join(backup, group, entryPath));
  if (hash(bytes) !== entry.sha256) throw new Error(`Backup hash mismatch for ${source}.`);
  return bytes;
}
async function unchanged(file: string, before: Buffer) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !before.equals(await readFile(file))) throw new Error(`File changed or is linked: ${file}. Refresh/review before applying.`);
}
async function physicalParents(file: string) {
  let directory = path.dirname(file);
  for (;;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Linked or invalid pilot ancestor: ${directory}`);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
async function replace(file: string, before: Buffer | undefined, after: string) {
  await physicalParents(file);
  if (before) await unchanged(file, before);
  else if (await lstat(file).catch(() => undefined)) throw new Error(`New destination already exists: ${file}.`);
  const temporary = `${file}.mpx2-pilot.tmp`;
  await writeFile(temporary, after, { flag: 'wx' });
  try {
    await physicalParents(file);
    if (before) await unchanged(file, before);
    else if (await lstat(file).catch(() => undefined)) throw new Error(`New destination appeared: ${file}.`);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
const beforeShell = await backedBytes('routing', shellFile);
const beforeProject = await backedBytes('routing', projectFile);
const beforeSettings = await backedBytes('personal-account', settingsFile, 'settings.json');
await unchanged(shellFile, beforeShell);
await unchanged(projectFile, beforeProject);
await unchanged(settingsFile, beforeSettings);
const uiCopies: Array<{ path: string; target: string; backupFile: string; sha256: string; bytes: Buffer }> = [];
for (const name of ['subagents.json', 'keybindings.json']) {
  const file = path.join(account, name);
  const entry = manifests.get('personal-account')!.entries.find(value => value.path === `agent/${name}`);
  const current = await readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (entry?.type === 'link') {
    const target = await readlink(file);
    if (target !== entry.target || (await realpath(file)).toLowerCase() !== (await realpath(path.join(projects, 'mpx-pi', name))).toLowerCase()) throw new Error('Legacy UI link changed; review before copying.');
    const saved = manifests.get('legacy-resources')!.entries.find(value => value.path === `mpx-pi/${name}`);
    const backupFile = path.join(backup, 'legacy-resources/mpx-pi', name);
    const bytes = await readFile(backupFile);
    if (!saved || saved.type !== 'file' || hash(bytes) !== saved.sha256 || !current?.equals(bytes)) throw new Error('Legacy UI source differs from its verified backup.');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Legacy UI configuration must be an object.');
    const binding = parsed['tui.input.newLine'];
    if (name === 'keybindings.json' && binding !== undefined && typeof binding !== 'string' && (!Array.isArray(binding) || binding.some(value => typeof value !== 'string'))) throw new Error('Newline bindings require review.');
    uiCopies.push({ path: file, target, backupFile, sha256: saved.sha256!, bytes });
  } else if (entry || current) {
    const bytes = await backedBytes('personal-account', file, name);
    await unchanged(file, bytes);
  }
}
if (await lstat(configFile).catch(() => undefined)) throw new Error('Existing MPX2 user config requires separate review.');
const executable = path.join(root, 'node_modules/.bin/pi');
if (!(await lstat(executable)).isFile()) throw new Error('Pinned native Pi shim is missing.');
const config = {
  accounts: { personal: { pi: account, claude: path.join(home, '.claude') }, work: { pi: path.join(home, '.pi/agent-work'), claude: path.join(home, '.claude-work') } },
  domains: { personal: [projects], work: [work] },
  executables: { pi: executable },
};
for (const pair of Object.values(config.accounts)) for (const directory of Object.values(pair)) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Configured native root is unavailable: ${directory}.`);
}
const project = parseRepositoryConfig({ projectId: 'MartinoPolo/prejemesi', repository: { provider: 'github', remote: 'origin' }, issues: { provider: 'github' }, packageManager: 'pnpm' });
const nextShell = renderPilotShell(beforeShell.toString('utf8'));
const settings = JSON.parse(beforeSettings.toString('utf8'));
const display = path.join(cloned, 'pi-tool-display.worktrees/feat/compact-tool-shell');
await realpath(display);
let displays = 0;
if (!Array.isArray(settings.packages)) throw new Error('Expected native package configuration.');
settings.packages = settings.packages.map((entry: unknown) => {
  if (typeof entry === 'string' && path.isAbsolute(entry) && path.resolve(entry).toLowerCase() === path.resolve(display).toLowerCase()) {
    displays++;
    return { source: entry, extensions: [] };
  }
  return entry;
});
if (displays !== 1) throw new Error('Expected exactly the previously inspected display package entry.');
const sharedSkills = path.join(home, '.agents/skills/mpx');
await realpath(sharedSkills);
if (settings.skills !== undefined && (!Array.isArray(settings.skills) || settings.skills.some((entry: unknown) => typeof entry !== 'string'))) throw new Error('Native skill overrides require review.');
settings.skills = [...new Set([...(settings.skills ?? []), `!${sharedSkills.replaceAll('\\', '/')}/**`])];
const runtime = await syncRuntimeScope(root, config, { account: 'personal', harness: 'pi' }, true);
for (const entry of runtime.entries) {
  if (entry.status === 'conflict' && uiCopies.some(copy => copy.path === entry.destination)) {
    entry.status = 'planned';
    entry.diagnostic = 'Replace verified personal-profile link with private copy; original legacy source remains unchanged.';
  }
}
if (runtime.entries.some(entry => entry.status === 'conflict')) throw new Error(`Runtime preview conflicts: ${JSON.stringify(runtime.entries.filter(entry => entry.status === 'conflict'))}`);
const allAgents = await planAgentLinks(root, config);
const agents = { links: allAgents.links.filter(entry => entry.account === 'personal' && entry.harness === 'pi'), scopes: allAgents.scopes.filter(entry => entry.account === 'personal' && entry.harness === 'pi'), errors: allAgents.errors.filter(entry => entry.harness === 'pi') };
const agentDirectory = path.join(account, 'agents');
let directoryCopy: { path: string; target: string; snapshot: string; preservedPath: string } | undefined;
if ((await lstat(agentDirectory)).isSymbolicLink()) {
  const target = await readlink(agentDirectory);
  const originalEntry = manifests.get('personal-account')!.entries.find(value => value.path === 'agent/agents');
  const legacyDirectory = path.join(projects, 'mpx-pi/agents');
  if (originalEntry?.target !== target || (await realpath(agentDirectory)).toLowerCase() !== (await realpath(legacyDirectory)).toLowerCase()) throw new Error('Legacy agent-directory link changed.');
  const snapshot = path.join(backup, 'legacy-resources/mpx-pi/agents');
  const expected = manifests.get('legacy-resources')!.entries.filter(entry => entry.path.startsWith('mpx-pi/agents/'));
  const actual = await readdir(legacyDirectory, { recursive: true });
  if (actual.length !== expected.length) throw new Error('Legacy agent directory changed since backup.');
  for (const entry of expected) {
    const relative = entry.path.slice('mpx-pi/agents/'.length);
    const source = path.join(legacyDirectory, relative);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !['file', 'directory'].includes(entry.type)) throw new Error('Linked agent support resources require explicit review.');
    if (entry.type === 'file' && (!info.isFile() || hash(await readFile(source)) !== entry.sha256 || hash(await readFile(path.join(snapshot, relative))) !== entry.sha256)) throw new Error('Legacy agent bytes differ from backup.');
  }
  for (const link of agents.links) if (await lstat(path.join(snapshot, path.basename(link.destination))).catch(() => undefined)) throw new Error('Existing specialist name conflicts with the pilot.');
  directoryCopy = { path: agentDirectory, target, snapshot, preservedPath: `${agentDirectory}.mpx2-original-link` };
}
const inspectedAgents = await inspectAgentLinks(agents);
const allowedAgentStates = directoryCopy ? ['missing', 'linked', 'agents-directory-conflict'] : ['missing', 'linked'];
if (!inspectedAgents.ok && inspectedAgents.results.some(entry => !allowedAgentStates.includes(entry.status))) throw new Error('Specialist link conflicts require review.');
if (agents.errors.length) throw new Error('Specialist planning failed.');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const record = { complete: false, root, backup, account, shellFile, projectFile, configFile, runtimeFile, display, sharedSkills, originalLinks: uiCopies.map(({ bytes: _bytes, ...copy }) => copy), originalDirectories: directoryCopy ? [directoryCopy] : [], files: [] as Array<{ path: string; beforeHash?: string; afterHash?: string }>, createdLinks: [
  ...agents.links.filter(entry => !inspectedAgents.results.some(result => result.destination === entry.destination && result.status === 'linked')).map(entry => ({ path: entry.destination, target: entry.source })),
] };
const recordFile = path.join(backup, 'pilot-apply.json');
if (await lstat(recordFile).catch(() => undefined)) throw new Error('Pilot apply record exists; inspect instead of repeating.');
console.log(json({ mode: apply ? 'apply' : 'preview', configFile, projectFile, shellFile, account, runtime: runtime.entries, specialistLinks: agents.links.length, privateAgentDirectoryCopy: directoryCopy?.path, originalMpxAndLegacySources: 'not modified', workAndClaude: 'not modified', orcaDeployment: 'not included' }));
if (apply) {
  await writeFile(recordFile, json(record), { flag: 'wx' });
  const saveRecord = async () => {
    const temporary = `${recordFile}.tmp`;
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(json(record)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, recordFile); } finally { await rm(temporary, { force: true }); }
  };
  try {
  if (runtime.entries.some(entry => entry.destination === runtimeFile && entry.status === 'planned')) record.files.push({ path: runtimeFile, afterHash: hash(piRuntimeBootstrap(root)) });
  record.files.push(
    { path: configFile, afterHash: hash(json(config)) },
    { path: projectFile, beforeHash: hash(beforeProject), afterHash: hash(json(project)) },
    { path: shellFile, beforeHash: hash(beforeShell), afterHash: hash(nextShell) },
  );
  for (const file of [settingsFile, path.join(account, 'subagents.json'), path.join(account, 'keybindings.json')]) {
    const before = await readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    record.files.push({ path: file, beforeHash: before ? hash(before) : undefined });
  }
  await saveRecord();
  await mkdir(path.dirname(configFile), { recursive: true });
  await replace(configFile, undefined, json(config));
  await readUserConfig(configFile);
  for (const copy of uiCopies) await replaceVerifiedLink(copy.path, copy.target, copy.bytes);
  if (directoryCopy) await replaceDirectoryLink(directoryCopy.path, directoryCopy.target, directoryCopy.snapshot);
  await replace(settingsFile, beforeSettings, json(settings));
  await saveRecord();
  const appliedRuntime = await syncRuntimeScope(root, config, { account: 'personal', harness: 'pi' }, false);
  await saveRecord();
  if (!appliedRuntime.ok) throw new Error('Runtime apply failed; inspect protected pilot-apply.json before continuing.');
  const appliedAgents = await syncAgentLinks(agents);
  await saveRecord();
  if (!appliedAgents.ok) throw new Error('Specialist apply failed; inspect protected pilot-apply.json before continuing.');
  await replace(projectFile, beforeProject, json(project));
  await saveRecord();
  await replace(shellFile, beforeShell, nextShell);
  for (const entry of record.files) entry.afterHash = hash(await readFile(entry.path));
  record.complete = true;
  await saveRecord();
  console.log('Personal pilot applied. Open a fresh shell; no Pi session or provider request was started.');
  } catch (error) {
    try {
      await promisify(execFile)(process.execPath, [path.join(root, 'migration/rollback-personal-pilot.mjs'), backup, '--apply'], { timeout: 30_000, maxBuffer: 256 * 1024 });
    } catch {
      throw new Error(`Pilot apply failed and automatic rollback was incomplete. Preserve ${recordFile} and stop before further changes.`, { cause: error });
    }
    throw new Error('Pilot apply failed; compensating rollback completed. No pilot startup is authorized from this failed attempt.', { cause: error });
  }
}
