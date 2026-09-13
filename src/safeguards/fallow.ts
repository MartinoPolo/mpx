import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PolicyResult } from './contracts.js';
import { gitInvocations, readOnlyPrefix } from './git-command.js';
import { runBounded, type ProcessResult } from './process.js';

const CONFIGS = ['.fallowrc.json', 'fallow.toml'];
export async function repositoryRoot(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 128; depth++) {
    if (await lstat(path.join(current, '.git')).catch(() => undefined)) return current;
    const parent = path.dirname(current); if (current === parent) return undefined; current = parent;
  }
  return undefined;
}
async function smallJson(file: string): Promise<Record<string, unknown>> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid package metadata');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid package metadata');
  return value as Record<string, unknown>;
}
export async function localBin(root: string, name: string): Promise<string | undefined> {
  const file = path.join(root, 'node_modules', '.bin', name);
  return (await stat(file).catch(() => undefined))?.isFile() ? file : undefined;
}
export interface FallowOptions {
  /** Native trust for the effective repository, never trust inferred from mpxconfig. */
  isTrusted: (root: string) => boolean | Promise<boolean>;
  run?: (executable: string, args: string[], cwd: string, timeout: number) => Promise<ProcessResult>;
  timeoutMs?: number;
}
/** Push-only, explicit project opt-in. Incomplete audits warn/allow; valid fail verdicts block. */
export async function evaluateFallow(command: string, cwd: string, options: FallowOptions): Promise<PolicyResult> {
  const { invocations, diagnostics } = gitInvocations(command, cwd);
  const pushes = invocations.filter(call => call.operation === 'push');
  if (pushes.length === 0) return { decision: 'allow', diagnostics: [] };
  const warnings: string[] = []; const blocks: string[] = [];
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000);
  for (const push of pushes) {
    if (!push.cwd) { warnings.push('Fallow skipped: push directory is unresolved; use a literal directory in a separate call.'); continue; }
    const root = await repositoryRoot(push.cwd);
    if (!root) continue;
    try {
      const configured = (await Promise.all(CONFIGS.map(file => stat(path.join(root, file)).catch(() => undefined)))).some(info => info?.isFile());
      if (!configured) continue;
      if (!readOnlyPrefix(push.prefix) || diagnostics.length > 0) {
        blocks.push('Finish state-mutating work in a separate tool call before pushing this Fallow-enabled repository.'); continue;
      }
      if (!await options.isTrusted(root)) { warnings.push('Fallow skipped: effective repository is not natively trusted.'); continue; }
      const pkg: Record<string, unknown> = await smallJson(path.join(root, 'package.json')).catch(() => ({}));
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {};
      const script = ['fallow:audit', 'check:fallow'].find(name => typeof scripts[name] === 'string');
      const bin = await localBin(root, 'fallow');
      const remediation = script ? `Run the project-owned ${script} script.` : 'Install the project-declared Fallow dependency with the repository package manager, then run its local fallow audit --format json --quiet --explain.';
      let args: string[];
      if (script) {
        // Explicit project scripts are the authority; never use a global package-manager runner.
        // Add only this project's .bin to PATH, as a native package-script invocation does.
        const text = scripts[script] as string;
        if (/\b(?:npx|bunx|dlx)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b/i.test(text)) { warnings.push(`Fallow skipped: audit script may download tooling. ${remediation}`); continue; }
        args = ['--noprofile', '--norc', '-c', 'export PATH="$PWD/node_modules/.bin:$PATH"; eval "$1"', 'mpx-fallow', text];
      } else if (bin) args = ['--noprofile', '--norc', '-c', 'exec "$@"', 'mpx-fallow', bin, 'audit', '--format', 'json', '--quiet', '--explain'];
      else { warnings.push(`Fallow skipped: local installation missing. ${remediation}`); continue; }
      if (!bin) { warnings.push(`Fallow skipped: local installation missing (global fallback forbidden). ${remediation}`); continue; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { warnings.push(`Fallow incomplete: deadline exceeded. ${remediation}`); continue; }
      const result = await (options.run ?? runBounded)('bash', args, root, remaining);
      let output: unknown;
      try { output = JSON.parse(result.stdout); } catch { /* Bounded diagnostic below, no raw audit output. */ }
      const verdict = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>).verdict : undefined;
      if (!result.incomplete && verdict === 'fail' && [0, 1].includes(result.code ?? -1)) blocks.push(`Fallow audit failed; push blocked. ${remediation}`);
      else if (result.incomplete || result.code !== 0 || !['pass', 'warn'].includes(String(verdict))) warnings.push(`Fallow incomplete (${result.incomplete ?? (result.code !== 0 ? 'process failure' : 'malformed verdict')}); push allowed, not a passing audit. ${remediation}`);
    } catch { warnings.push('Fallow incomplete: project configuration or audit could not be read; push allowed, not a passing audit. Run the project-owned audit command.'); }
  }
  return { decision: blocks.length ? 'block' : warnings.length ? 'warn' : 'allow', diagnostics: [...new Set([...blocks, ...warnings])] };
}
