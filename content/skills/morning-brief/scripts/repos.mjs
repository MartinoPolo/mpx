#!/usr/bin/env node
// Lists every repository under MPX_PROJECTS and MPX_WORK with its remote and whether the project is active, as the
// Alfred control center's Projects page decides it: a commit in the last month, or an open task in the vault's project
// note. A repository with local activity in the window also carries its Git state, linked worktrees included.
// Usage: repos.mjs --since <iso> [--out <file>]
import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const GIT_TIMEOUT_MILLISECONDS = 20_000;
const CONCURRENCY = 8;
const MAXIMUM_COMMITS = 30;
const ACTIVE_DAYS = 30;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const PROJECTS_FOLDER = '_Projekty';
const FORGES = ['github', 'gitlab', 'gerrit'];
const GERRIT_PORT = '29418';

const { values } = parseArgs({ options: { since: { type: 'string' }, out: { type: 'string' } } });
if (!values.since) {
  console.error('Usage: repos.mjs --since <iso> [--out <file>]');
  process.exit(1);
}
const activeSince = new Date(Date.now() - ACTIVE_DAYS * DAY_MILLISECONDS).toISOString();
const roots = [['personal', process.env.MPX_PROJECTS], ['work', process.env.MPX_WORK]]
  .filter(([, path]) => path && isAbsolute(path));
const vaultDirectory = process.env.MPX_OBSIDIAN_VAULT;
const projectNoteFolders = vaultDirectory
  ? (await readdir(join(vaultDirectory, PROJECTS_FOLDER), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];

async function git(directory, ...args) {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], { timeout: GIT_TIMEOUT_MILLISECONDS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function forgeOf(host, port) {
  if (port === GERRIT_PORT || host.includes('gerrit')) return 'gerrit';
  if (host === 'github.com') return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return null;
}

// Where a remote lives: its forge (the repository's mpxconfig.json provider, else read from the host), host, full
// namespace path and web address. The address itself is not kept, as it may carry credentials.
function remoteOf(address, provider) {
  if (!address) return null;
  const scp = address.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+?)$/);
  let host;
  let port = '';
  let path;
  if (scp) {
    [, host, path] = scp;
  } else {
    try {
      const url = new URL(address);
      if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
      ({ hostname: host, port } = url);
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const fullName = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !fullName) return null;
  const forge = FORGES.includes(provider) ? provider : forgeOf(host.toLowerCase(), port);
  return { forge, host: host.toLowerCase(), fullName, web: forge === 'gerrit' ? null : `https://${host.toLowerCase()}/${fullName}` };
}

// As the app reads a project note: an open or started checkbox under its Tasks heading.
function hasOpenTask(noteText) {
  let tasksHeadingLevel = null;
  for (const line of noteText.split('\n')) {
    const heading = line.match(/^﻿?(#{1,6})\s+(.*?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (tasksHeadingLevel !== null && level <= tasksHeadingLevel) tasksHeadingLevel = null;
      if (tasksHeadingLevel === null && /^tasks$/i.test(heading[2])) tasksHeadingLevel = level;
      continue;
    }
    if (tasksHeadingLevel !== null && /^\s*[-*+]\s+\[[ /]\]\s+\S/.test(line)) return true;
  }
  return false;
}

// The project note `_Projekty/<folder>/<folder>.md` named like the repository folder, in any letter case.
async function hasOpenVaultTask(name) {
  const folder = projectNoteFolders.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (!folder) return false;
  return hasOpenTask(await readFile(join(vaultDirectory, PROJECTS_FOLDER, folder, `${folder}.md`), 'utf8').catch(() => ''));
}

async function checkoutState(directory) {
  const [branch, status, counts, lastCommit] = await Promise.all([
    git(directory, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(directory, 'status', '--porcelain=v1'),
    git(directory, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'),
    git(directory, 'log', '-1', '--format=%cI'),
  ]);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [undefined, undefined];
  return { path: directory, branch, lastCommit, changedFiles: status ? status.split('\n').length : 0, ahead, behind, upstream: counts !== undefined };
}

async function repository(domain, directory) {
  const name = directory.split(/[\\/]/).at(-1);
  const configuration = await readJson(join(directory, 'mpxconfig.json'));
  const remoteName = configuration?.repository?.remote || 'origin';
  const [main, remoteAddress, log, monthCommit, worktreeList, openVaultTask] = await Promise.all([
    checkoutState(directory),
    git(directory, 'remote', 'get-url', '--', remoteName),
    git(directory, 'log', '--all', `--since=${values.since}`, `--max-count=${MAXIMUM_COMMITS}`, '--format=%h%x09%an%x09%cI%x09%D%x09%s'),
    git(directory, 'log', '-1', '--no-merges', `--since=${activeSince}`, '--format=%cI', '--branches', 'HEAD'),
    git(directory, 'worktree', 'list', '--porcelain'),
    hasOpenVaultTask(name),
  ]);
  const remote = remoteOf(remoteAddress, configuration?.repository?.provider);
  const active = Boolean(monthCommit) || openVaultTask;
  const worktreePaths = (worktreeList ?? '').split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length)).filter((path) => resolve(path) !== resolve(directory));
  const worktrees = await Promise.all(worktreePaths.map(checkoutState));
  const commits = (log ?? '').split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, references, subject] = line.split('\t');
    return { hash, author, date, references, subject };
  });
  const changedInWindow = main.changedFiles > 0 || (main.ahead ?? 0) > 0 || commits.length > 0
    || worktrees.some((worktree) => worktree.changedFiles > 0 || (worktree.ahead ?? 0) > 0);
  const summary = { name, domain, active, remote, changedInWindow };
  return changedInWindow ? { ...summary, main, worktrees, commits } : summary;
}

const candidates = [];
for (const [domain, root] of roots) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (await stat(join(directory, '.git')).catch(() => undefined)) candidates.push([domain, directory]);
  }
}

const repositories = [];
for (let index = 0; index < candidates.length; index += CONCURRENCY) {
  repositories.push(...await Promise.all(candidates.slice(index, index + CONCURRENCY).map(([domain, directory]) => repository(domain, directory))));
}
const text = `${JSON.stringify({ since: values.since, activeSince, repositories }, null, 2)}\n`;
if (values.out) await writeFile(values.out, text);
else process.stdout.write(text);
