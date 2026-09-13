import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

function terminate(executable: string, args: string[], timeout: number): Promise<boolean> {
  return new Promise(resolve => {
    const killer = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill('SIGKILL'); resolve(false); }, timeout);
    killer.once('error', () => { clearTimeout(timer); resolve(false); });
    killer.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function windowsTreeFallback(pid: number, powershell: string, timeout: number): Promise<boolean> {
  // Only process ancestry/IDs are inspected, never command lines or unrelated process contents.
  const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId); $ids=[Collections.Generic.List[int]]::new(); $ids.Add(${pid}); do { $added=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and !$ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId); $added=$true } } } while($added); foreach($id in $ids) { if(Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction Stop } }; if(Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue) { exit 1 }; exit 0`;
  return terminate(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

export interface ProcessResult { code: number | null; stdout: string; incomplete?: string }
/** Bounded execution and tree-termination attempts; failed termination is never reported as success. */
export async function runBounded(executable: string, args: string[], cwd: string, timeoutMs: number, maxBytes = 256 * 1024, windowsSystemRoot = process.env.SystemRoot ?? 'C:/Windows'): Promise<ProcessResult> {
  const windows = process.platform === 'win32';
  const system = join(windowsSystemRoot, 'System32');
  const taskkill = join(system, 'taskkill.exe');
  const powershell = join(system, 'WindowsPowerShell/v1.0/powershell.exe');
  if (windows && !(await Promise.all([taskkill, powershell].map(file => access(file).then(() => true, () => false)))).every(Boolean)) {
    return { code: null, stdout: '', incomplete: 'process-tree termination unavailable; command not started' };
  }
  const reserve = windows ? Math.min(1500, timeoutMs / 2) : 0;
  return new Promise(resolve => {
    const bash = process.platform === 'win32' && /(?:^|[\\/])bash(?:\.exe)?$/i.test(executable);
    const forwarded = bash ? args.map(value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`) : args;
    const child = spawn(executable, forwarded, { cwd, shell: false, windowsVerbatimArguments: bash, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let bytes = 0; let incomplete: string | undefined; let stopping: Promise<void> | undefined;
    const stop = (reason: string) => {
      incomplete ??= reason;
      stopping ??= (async () => {
        if (!child.pid) return;
        if (windows) {
          const killed = await terminate(taskkill, ['/PID', String(child.pid), '/T', '/F'], Math.max(1, reserve / 3)) || await windowsTreeFallback(child.pid, powershell, Math.max(1, reserve * 2 / 3));
          if (!killed) incomplete = `${reason}; process-tree termination FAILED; stop the project tool manually before further edits`;
          child.kill('SIGKILL');
          if (!killed) {
            // A surviving descendant may hold these pipes open after the direct child dies.
            child.stdout.destroy(); child.stderr.destroy();
            finish(null);
          }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      })();
    };
    const timer = setTimeout(() => stop('deadline exceeded'), Math.max(1, timeoutMs - reserve));
    const collect = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop('output limit exceeded');
      else if (output) stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false)); // Never return arbitrary tool stderr/credentials.
    child.once('error', () => { incomplete ??= 'process unavailable'; });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, ...(incomplete ? { incomplete } : {}) });
    };
    child.once('close', async code => { await stopping; finish(code); });
  });
}
