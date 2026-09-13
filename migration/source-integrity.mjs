// Migration-only observation: Git-visible external sources, never account stores.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
}

async function snapshot({ repositories = [], files = [] }) {
  const digest = createHash('sha256');
  const targets = new Set(files.map(file => path.resolve(file)));
  for (const repository of repositories) {
    const root = git(repository, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    digest.update(root);
    digest.update(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    // Include the index independently: identical worktree bytes do not imply an unchanged index.
    digest.update(git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']));
    try { digest.update(git(root, ['symbolic-ref', '--quiet', 'HEAD'])); }
    catch (error) { if (error.status !== 1) throw error; digest.update('detached'); }
    const names = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
    if (names.length > 30_000) throw new Error('External source snapshot exceeds file-count bound.');
    for (const name of names) targets.add(path.resolve(root, name));
    // HEAD itself is absent in an unborn disposable test repository.
    try { digest.update(git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])); }
    catch (error) { if (error.status !== 1) throw error; digest.update('unborn'); }
  }
  let bytes = 0;
  for (const file of [...targets].sort()) {
    digest.update(file); digest.update('\0');
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) { digest.update('absent'); continue; }
    if (info.isSymbolicLink()) { digest.update('link:'); digest.update(await readlink(file)); continue; }
    if (!info.isFile()) throw new Error(`Unsupported external source entry: ${file}`);
    bytes += info.size;
    if (bytes > 256 * 1024 * 1024) throw new Error('External source snapshot exceeds byte bound.');
    digest.update(String(info.mode)); digest.update('\0'); digest.update(await readFile(file));
  }
  return digest.digest('hex');
}

/** Detect source changes even when the probe fails. This is not an OS write sandbox. */
export async function withSourceIntegrity(targets, run) {
  const before = await snapshot(targets);
  let result;
  const failures = [];
  try { result = await run(); } catch (error) { failures.push(error); }
  try {
    if (await snapshot(targets) !== before) throw new Error('External Git-visible source integrity changed during probe.');
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  return result;
}
