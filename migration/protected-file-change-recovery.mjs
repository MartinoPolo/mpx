#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const MAX_PLAN = 64 * 1024, MAX_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = error => error?.code === 'ENOENT';
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function allowedTarget(file) {
  if (!path.isAbsolute(file)) return false; const absolute = path.resolve(file);
  if (['.bashrc', 'mpxconfig.json'].includes(path.basename(absolute))) return true;
  const appData = process.env.APPDATA;
  return path.basename(absolute) === 'config.json' && typeof appData === 'string' && path.isAbsolute(appData)
    && (process.platform === 'win32' ? absolute.toLowerCase() === path.resolve(appData, 'mpx2/config.json').toLowerCase() : absolute === path.resolve(appData, 'mpx2/config.json'));
}
async function physical(file, kind = 'file', allowMissingLeaf = false) {
  const absolute = path.resolve(file); let cursor = absolute;
  for (;;) {
    try { const info = await lstat(cursor); if (info.isSymbolicLink()) throw new Error(`link path refused: ${cursor}`); if (cursor === absolute && kind !== 'either' && !(kind === 'file' ? info.isFile() : info.isDirectory())) throw new Error(`invalid physical path: ${cursor}`); if (cursor !== absolute && !info.isDirectory()) throw new Error(`non-directory ancestor: ${cursor}`); }
    catch (error) { if (!(allowMissingLeaf && cursor === absolute && missing(error))) throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  } return absolute;
}
async function readBounded(file, maximum) {
  await physical(file, 'file'); const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const first = await handle.stat(); const output = Buffer.alloc(Math.min(maximum + 1, Number(first.size) + 1)); let offset = 0; while (offset < output.length) { const { bytesRead } = await handle.read(output, offset, output.length - offset, null); if (!bytesRead) break; offset += bytesRead; } if (offset > maximum) throw new Error('file exceeds recovery bounds'); const last = await handle.stat(); if (first.dev !== last.dev || first.ino !== last.ino || first.size !== last.size || first.mtimeMs !== last.mtimeMs || offset !== last.size) throw new Error('file changed while reading'); return output.subarray(0, offset); } finally { await handle.close(); }
}
async function syncDirectory(directory) { const handle = await open(directory, 'r'); try { try { await handle.sync(); } catch (error) { if (!(process.platform === 'win32' && ['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code))) throw error; } } finally { await handle.close(); } }
async function protect(file) {
  if (process.platform !== 'win32') return;
  const literal = `'${file.replaceAll("'", "''")}'`; const script = `$ErrorActionPreference='Stop';$p=${literal};$acl=Get-Acl -LiteralPath $p;$acl.SetAccessRuleProtection($true,$false);foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($r)};$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$sys=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');foreach($sid in @($me,$sys)){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow');[void]$acl.AddAccessRule($rule)};Set-Acl -LiteralPath $p -AclObject $acl;if(-not (Get-Acl -LiteralPath $p).AreAccessRulesProtected){throw 'ACL inheritance remains enabled'}`;
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
}
async function writeExclusive(file, bytes, mode) { await physical(file, 'either', true); const handle = await open(file, 'wx', mode); try { await protect(file); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
function validate(plan) {
  const states = ['prepared', 'applying', 'applied', 'rolled-back', 'recovery-incomplete'];
  const keys = ['backup','backupRoot','candidate','id','mode','planPath','postHash','preHash','recoveryPath','staged','state','target','version'];
  if (!plan || Object.getPrototypeOf(plan) !== Object.prototype || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(keys) || plan.version !== 1 || !uuid(plan.id) || !states.includes(plan.state) || !hex(plan.preHash) || !hex(plan.postHash) || !Number.isInteger(plan.mode) || plan.mode < 0 || plan.mode > 0xffffffff) throw new Error('invalid recovery plan');
  for (const key of ['target','backupRoot','backup','staged','candidate','planPath','recoveryPath']) if (typeof plan[key] !== 'string' || !path.isAbsolute(plan[key])) throw new Error('invalid recovery plan');
}
async function persist(plan, planPath) { const temp = `${planPath}.${randomUUID()}.tmp`; await writeExclusive(temp, Buffer.from(`${JSON.stringify(plan, null, 2)}\n`), 0o600); await rename(temp, planPath); await syncDirectory(path.dirname(planPath)); }
export async function recoverProtectedFileChange(planPath, apply = false) {
  if (!path.isAbsolute(planPath)) throw new Error('plan path must be absolute'); planPath = path.resolve(planPath); await physical(planPath, 'file');
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(planPath, MAX_PLAN))); validate(plan);
  const target = path.resolve(plan.target), root = path.dirname(planPath), same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  if (!allowedTarget(target) || !same(plan.backupRoot, root) || !same(plan.backup, path.join(root, 'before')) || !same(plan.staged, path.join(root, 'after')) || !same(plan.planPath, planPath) || !same(plan.recoveryPath, path.join(root, 'protected-file-change-recovery.mjs')) || !same(plan.candidate, `${target}.mpx-${plan.id}-candidate`)) throw new Error('recovery paths escaped protected root');
  await physical(root, 'directory'); await physical(plan.backup, 'file'); await physical(target, 'file');
  const before = await readBounded(plan.backup, MAX_BYTES); if (hash(before) !== plan.preHash) throw new Error('protected backup mismatch');
  const liveHash = hash(await readBounded(target, MAX_BYTES)); if (liveHash === plan.preHash) return { action: 'already-restored', target, applied: false };
  if (liveHash !== plan.postHash) throw new Error('refusing recovery: target is not the owned postimage'); if (!apply) return { action: 'restore', target, applied: false };
  const candidate = `${target}.mpx-recovery-${plan.id}-${randomUUID()}`; await writeExclusive(candidate, before, plan.mode & 0o777);
  await physical(target, 'file'); if (hash(await readBounded(target, MAX_BYTES)) !== plan.postHash) throw new Error('refusing recovery: target changed');
  await rename(candidate, target); await syncDirectory(path.dirname(target)); plan.state = 'rolled-back'; await persist(plan, planPath); return { action: 'restore', target, applied: true };
}
async function cli() { const args = process.argv.slice(2), apply = args.includes('--apply'), positional = args.filter(value => value !== '--apply'); if (positional.length > 1) throw new Error('Usage: protected-file-change-recovery.mjs [absolute-plan.json] [--apply]'); const own = path.dirname(fileURLToPath(import.meta.url)); const result = await recoverProtectedFileChange(positional[0] ?? path.join(own, 'protected-file-change-plan.json'), apply); process.stdout.write(`${result.applied ? 'restored' : result.action === 'already-restored' ? 'already restored' : 'preview: restore available'} ${result.target}\n`); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
