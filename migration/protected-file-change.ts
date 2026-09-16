import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, cp, lstat, mkdir, open, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PilotBackupModule { protectWindowsRoot(root: string): Promise<void> }
const { protectWindowsRoot } = await import(new URL('./pilot-backup.mjs', import.meta.url).href) as PilotBackupModule;
const MAX_BYTES = 1024 * 1024;
const runtime = new WeakMap<ProtectedFileChangePlan, { protect: (file: string) => Promise<void>; fail?: (checkpoint: string) => void | Promise<void> }>();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

type CommonOptions = { target: string; backupRoot: string; projectRoot?: string; protect?: (file: string) => Promise<void>; failureHook?: (checkpoint: string) => void | Promise<void> };
export type PrepareProtectedFileChangeOptions = CommonOptions & ({ transform: (beforeUtf8: string) => string; after?: never; expectedPreHash?: never } | { after: string; expectedPreHash: string; transform?: never });
export interface ProtectedFileChangePlan { projectRoot?: string; version: 1; id: string; state: 'prepared' | 'applying' | 'applied' | 'rolled-back' | 'recovery-incomplete'; target: string; backupRoot: string; backup: string; staged: string; candidate: string; planPath: string; recoveryPath: string; preHash: string; postHash: string; mode: number }
export interface ProtectedTargetRoots { projectRoot?: string; home: string; appData?: string; localAppData?: string; documents: string }
function currentTargetRoots(): ProtectedTargetRoots {
  const home = os.homedir();
  const documents = path.join(home, 'Documents');
  return { home, appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA, documents };
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}
export function isAllowedProtectedTarget(target: string, roots: ProtectedTargetRoots = currentTargetRoots()): boolean {
  if (!path.isAbsolute(target) || !path.isAbsolute(roots.home) || !path.isAbsolute(roots.documents)) return false;
  const absolute = path.resolve(target);
  if (roots.projectRoot && path.isAbsolute(roots.projectRoot) && samePath(absolute, path.join(roots.projectRoot, 'mpxconfig.json'))) return true;
  const candidates = [
    path.join(roots.home, '.bashrc'),
    path.join(roots.home, '.pi', 'agent', 'settings.json'),
    path.join(roots.home, '.pi', 'agent-work', 'settings.json'),
    path.join(roots.home, '.claude', 'settings.json'),
    path.join(roots.home, '.claude-work', 'settings.json'),
    path.join(roots.home, '.claude', 'settings.local.json'),
    path.join(roots.home, '.claude-work', 'settings.local.json'),
    path.join(roots.documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];
  if (roots.appData && path.isAbsolute(roots.appData)) candidates.push(path.join(roots.appData, 'mpx2', 'config.json'));
  if (roots.localAppData && path.isAbsolute(roots.localAppData)) candidates.push(path.join(roots.localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'));
  return candidates.some(candidate => samePath(absolute, candidate));
}
async function rejectLinks(file: string, leaf: 'file' | 'directory' | 'either', allowMissingLeaf = false) {
  const absolute = path.resolve(file); let cursor = absolute;
  for (;;) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`symlink path refused: ${cursor}`);
      if (cursor === absolute && leaf !== 'either' && !(leaf === 'file' ? info.isFile() : info.isDirectory())) throw new Error(`invalid physical path: ${cursor}`);
      if (cursor !== absolute && !info.isDirectory()) throw new Error(`invalid physical path: ${cursor}`);
    } catch (error) { if (!(allowMissingLeaf && cursor === absolute && isMissing(error))) throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
async function physicalTarget(target: string, projectRoot?: string) { if (!isAllowedProtectedTarget(target, { ...currentTargetRoots(), projectRoot })) throw new Error('target is not an explicitly allowed protected configuration file'); await rejectLinks(target, 'file'); }
async function readBounded(file: string, maximum = MAX_BYTES) {
  await rejectLinks(file, 'file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); if (!before.isFile()) throw new Error('not a regular file');
    const output = Buffer.alloc(Math.min(maximum + 1, Number(before.size) + 1)); let offset = 0;
    while (offset < output.length) { const { bytesRead } = await handle.read(output, offset, output.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset > maximum) throw new Error('file exceeds bound');
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || offset !== after.size) throw new Error('file changed while reading');
    return { bytes: output.subarray(0, offset), info: after };
  } finally { await handle.close(); }
}
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if (isMissing(error)) return true; throw error; } }
async function syncDir(dir: string) { const handle = await open(dir, 'r'); try { try { await handle.sync(); } catch (error) { if (!(process.platform === 'win32' && ['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error; } } finally { await handle.close(); } }
async function writeExclusive(file: string, value: Uint8Array | string, mode: number, protect: (file: string) => Promise<void>) { await rejectLinks(file, 'either', true); const handle = await open(file, 'wx', mode); try { await protect(file); await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } }
async function persist(plan: ProtectedFileChangePlan) { await rejectLinks(plan.planPath, 'either', true); const temp = `${plan.planPath}.${randomUUID()}.tmp`; await writeExclusive(temp, `${JSON.stringify(plan, null, 2)}\n`, 0o600, runtime.get(plan)?.protect ?? protectWindowsRoot); await rename(temp, plan.planPath); await syncDir(path.dirname(plan.planPath)); }

export async function prepare(options: PrepareProtectedFileChangeOptions): Promise<ProtectedFileChangePlan> {
  await physicalTarget(options.target, options.projectRoot); if (!path.isAbsolute(options.backupRoot)) throw new Error('backupRoot must be absolute'); await rejectLinks(options.backupRoot, 'either', true);
  if (!await absent(options.backupRoot)) throw new Error('backupRoot already exists');
  const captured = await readBounded(options.target); const before = captured.bytes; new TextDecoder('utf-8', { fatal: true }).decode(before);
  const preHash = digest(before); if (typeof options.after === 'string' && options.expectedPreHash !== preHash) throw new Error('stale precomputed postimage');
  const afterText = typeof options.transform === 'function' ? options.transform(new TextDecoder('utf-8', { fatal: true }).decode(before)) : options.after;
  if (typeof afterText !== 'string') throw new Error('transform must return a string'); const after = Buffer.from(afterText, 'utf8'); if (after.length > MAX_BYTES) throw new Error('postimage exceeds 1 MiB');
  const protect = options.protect ?? protectWindowsRoot; await mkdir(options.backupRoot, { mode: 0o700 }); await protect(options.backupRoot); await rejectLinks(options.backupRoot, 'directory');
  const id = randomUUID(), backupRoot = path.resolve(options.backupRoot), backup = path.join(backupRoot, 'before'), staged = path.join(backupRoot, 'after');
  await writeExclusive(backup, before, captured.info.mode & 0o777, protect); await writeExclusive(staged, after, captured.info.mode & 0o777, protect);
  const recoveryPath = path.join(backupRoot, 'protected-file-change-recovery.mjs'); await rejectLinks(recoveryPath, 'either', true); await cp(fileURLToPath(new URL('./protected-file-change-recovery.mjs', import.meta.url)), recoveryPath, { errorOnExist: true, force: false }); await protect(recoveryPath);
  const plan: ProtectedFileChangePlan = { ...(options.projectRoot ? { projectRoot: path.resolve(options.projectRoot) } : {}), version: 1, id, state: 'prepared', target: path.resolve(options.target), backupRoot, backup, staged, candidate: `${path.resolve(options.target)}.mpx-${id}-candidate`, planPath: path.join(backupRoot, 'protected-file-change-plan.json'), recoveryPath, preHash, postHash: digest(after), mode: captured.info.mode };
  runtime.set(plan, { protect, fail: options.failureHook }); await persist(plan); return plan;
}

export async function apply(plan: ProtectedFileChangePlan): Promise<void> {
  const hooks = runtime.get(plan) ?? { protect: protectWindowsRoot }; if (plan.state !== 'prepared') throw new Error('plan is not prepared');
  await physicalTarget(plan.target, plan.projectRoot); const live = await readBounded(plan.target); if (digest(live.bytes) !== plan.preHash) throw new Error('source drift');
  await rejectLinks(plan.backupRoot, 'directory'); await rejectLinks(plan.planPath, 'file'); await rejectLinks(plan.backup, 'file'); await rejectLinks(plan.staged, 'file'); await rejectLinks(plan.candidate, 'either', true);
  if (!await absent(plan.candidate)) throw new Error('candidate already exists'); const post = (await readBounded(plan.staged)).bytes; if (digest(post) !== plan.postHash) throw new Error('staged postimage drift');
  await writeExclusive(plan.candidate, post, plan.mode & 0o777, hooks.protect); await chmod(plan.candidate, plan.mode & 0o777); if (digest((await readBounded(plan.candidate)).bytes) !== plan.postHash) throw new Error('candidate verification failed');
  await physicalTarget(plan.target, plan.projectRoot); if (digest((await readBounded(plan.target)).bytes) !== plan.preHash) throw new Error('source drift immediately before replace');
  plan.state = 'applying'; await persist(plan); let mutated = false;
  try { await rename(plan.candidate, plan.target); mutated = true; await hooks.fail?.('after-rename'); await syncDir(path.dirname(plan.target)); await hooks.fail?.('after-write'); plan.state = 'applied'; await persist(plan); }
  catch (error) {
    if (!mutated) { plan.state = 'prepared'; await persist(plan); throw error; }
    const failures: unknown[] = [error];
    try {
      const original = (await readBounded(plan.backup)).bytes; if (digest(original) !== plan.preHash) throw new Error('protected backup mismatch');
      await physicalTarget(plan.target, plan.projectRoot); if (digest((await readBounded(plan.target)).bytes) !== plan.postHash) throw new Error('target changed');
      const recovery = `${plan.target}.mpx-${plan.id}-restore`; await writeExclusive(recovery, original, plan.mode & 0o777, hooks.protect);
      await physicalTarget(plan.target, plan.projectRoot); if (digest((await readBounded(plan.target)).bytes) !== plan.postHash) throw new Error('target changed');
      await rename(recovery, plan.target); await syncDir(path.dirname(plan.target)); plan.state = 'rolled-back'; await persist(plan); throw error;
    } catch (compensation) {
      if (compensation === error) throw error;
      failures.push(compensation); plan.state = 'recovery-incomplete'; try { await persist(plan); } catch (persistError) { failures.push(persistError); }
      throw new AggregateError(failures, 'post-write failure; compensation incomplete');
    }
  }
}
