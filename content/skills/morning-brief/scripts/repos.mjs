#!/usr/bin/env node
// Reports local Git state for every repository under MPX_PROJECTS and MPX_WORK, including linked
// worktrees. Usage: repos.mjs --since <iso> [--out <file>]
import { execFile } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const GIT_TIMEOUT_MILLISECONDS = 20_000;
const CONCURRENCY = 8;
const MAXIMUM_COMMITS = 30;

const { values } = parseArgs({ options: { since: { type: 'string' }, out: { type: 'string' } } });
if (!values.since) {
  console.error('Usage: repos.mjs --since <iso> [--out <file>]');
  process.exit(1);
}
const roots = [['personal', process.env.MPX_PROJECTS], ['work', process.env.MPX_WORK]]
  .filter(([, path]) => path && isAbsolute(path));

async function git(directory, ...args) {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], { timeout: GIT_TIMEOUT_MILLISECONDS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function webUrl(remote) {
  if (!remote) return undefined;
  const scp = remote.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(remote);
    if (url.port === '29418') return undefined;
    return `https://${url.hostname}${url.pathname.replace(/\.git$/, '')}`;
  } catch {
    return undefined;
  }
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
  const [main, remote, log, worktreeList] = await Promise.all([
    checkoutState(directory),
    git(directory, 'remote', 'get-url', 'origin'),
    git(directory, 'log', '--all', `--since=${values.since}`, `--max-count=${MAXIMUM_COMMITS}`, '--format=%h%x09%an%x09%cI%x09%D%x09%s'),
    git(directory, 'worktree', 'list', '--porcelain'),
  ]);
  const worktreePaths = (worktreeList ?? '').split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length)).filter((path) => resolve(path) !== resolve(directory));
  const worktrees = await Promise.all(worktreePaths.map(checkoutState));
  const commits = (log ?? '').split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, references, subject] = line.split('\t');
    return { hash, author, date, references, subject };
  });
  const active = main.changedFiles > 0 || (main.ahead ?? 0) > 0 || commits.length > 0
    || worktrees.some((worktree) => worktree.changedFiles > 0 || (worktree.ahead ?? 0) > 0);
  return { name: directory.split(/[\\/]/).at(-1), domain, remote, web: webUrl(remote), active, main, worktrees, commits };
}

const candidates = [];
for (const [domain, root] of roots) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (await stat(join(directory, '.git')).catch(() => undefined)) candidates.push([domain, directory]);
  }
}

const results = [];
for (let index = 0; index < candidates.length; index += CONCURRENCY) {
  results.push(...await Promise.all(candidates.slice(index, index + CONCURRENCY).map(([domain, directory]) => repository(domain, directory))));
}
const report = {
  since: values.since,
  active: results.filter((result) => result.active),
  quiet: results.filter((result) => !result.active).map(({ name, domain }) => ({ name, domain })),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) await writeFile(values.out, text);
else process.stdout.write(text);
