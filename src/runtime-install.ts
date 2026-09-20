import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { Account, Harness, UserConfig } from './contracts.js';

export interface RuntimeScope { account: Account; harness: Harness }
export interface RuntimeInstallEntry { account: Account; harness: Harness; source: string; destination: string; status: 'installed' | 'planned' | 'unchanged' | 'conflict'; diagnostic?: string }
export interface RuntimeInstallResult { ok: boolean; entries: RuntimeInstallEntry[] }
async function physicalDirectory(directory: string): Promise<void> {
  let cursor = path.resolve(directory);
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a physical directory: ${cursor}`);
    const parent = path.dirname(cursor); if (parent === cursor) return; cursor = parent;
  }
}
async function mergeJson(file: string, transform: (current: Record<string, unknown>) => Record<string, unknown>, preview: boolean): Promise<RuntimeInstallEntry['status']> {
  const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)) throw new Error('settings is not a bounded physical file');
  const before = info ? await readFile(file) : undefined;
  const current: unknown = before ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(before)) : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('settings must be a JSON object');
  const next = transform(structuredClone(current) as Record<string, unknown>);
  if (JSON.stringify(current) === JSON.stringify(next)) return 'unchanged';
  if (preview) return 'planned';
  const temporary = `${file}.mpx2-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    await physicalDirectory(path.dirname(file));
    const now = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (now?.isSymbolicLink() || (!!now !== !!info) || (before && !before.equals(await readFile(file)))) throw new Error('settings changed during sync; refresh and retry');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return 'installed';
}
async function ownedLink(source: string, destination: string, preview: boolean, folder = false): Promise<RuntimeInstallEntry['status']> {
  const sourceInfo = await lstat(source);
  if (!(folder ? sourceInfo.isDirectory() : sourceInfo.isFile())) throw new Error('managed source missing or wrong type');
  const directory = path.dirname(destination);
  const parent = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (parent) await physicalDirectory(directory);
  const existing = parent ? await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; }) : undefined;
  if (existing) {
    if (existing.isSymbolicLink() && path.resolve(directory, await readlink(destination)) === path.resolve(source)) return 'unchanged';
    throw new Error('existing entry preserved; replacement needs approval');
  }
  if (preview) return 'planned';
  if (!parent) await mkdir(directory);
  await physicalDirectory(directory);
  await symlink(source, destination, folder ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
  return 'installed';
}
export function piRuntimeBootstrap(root: string): string {
  return `// MPX2-owned Pi runtime registration.\nexport { default } from ${JSON.stringify(path.join(root, 'extensions/pi-runtime.ts').replaceAll('\\', '/'))};\n`;
}
async function ownedPiRuntime(root: string, destination: string, preview: boolean): Promise<RuntimeInstallEntry['status']> {
  if (!(await lstat(path.join(root, 'extensions/pi-runtime.ts'))).isFile()) throw new Error('Pi runtime source is missing.');
  const expected = piRuntimeBootstrap(root);
  const directory = path.dirname(destination);
  const parent = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (parent) await physicalDirectory(directory);
  const existing = parent ? await lstat(destination).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }) : undefined;
  if (existing) {
    if (existing.isFile() && !existing.isSymbolicLink() && existing.size < 64 * 1024 && await readFile(destination, 'utf8') === expected) return 'unchanged';
    throw new Error('Existing runtime registration preserved; replacement needs approval.');
  }
  if (preview) return 'planned';
  if (!parent) await mkdir(directory);
  await physicalDirectory(directory);
  await writeFile(destination, expected, { flag: 'wx' });
  return 'installed';
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function canonicalNodePath(): string { return realpathSync(process.execPath).replaceAll('\\', '/'); }
function canonicalizeOwnedNodeCommand(command: string): string {
  const match = /^'([^']+)' (.+)$/.exec(command);
  if (!match) return command;
  try {
    return realpathSync(match[1]!).replaceAll('\\', '/') === canonicalNodePath() ? `${quote(canonicalNodePath())} ${match[2]}` : command;
  } catch { return command; }
}
function canonicalizeOwnedRegistration(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') return { ...record, command: canonicalizeOwnedNodeCommand(record.command) };
  if (Array.isArray(record.hooks)) return { ...record, hooks: record.hooks.map(canonicalizeOwnedRegistration) };
  return value;
}
function ownedRegistrationEquals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalizeOwnedRegistration(left), canonicalizeOwnedRegistration(right));
}
function buildClaudeHookEntries(root: string, legacy = false): Record<string, unknown[]> {
  const loader = path.join(root, 'node_modules/tsx/dist/loader.mjs');
  const loaderSpecifier = legacy ? loader.replaceAll('\\', '/') : pathToFileURL(loader).href;
  const prefix = `${quote(canonicalNodePath())} --import ${quote(loaderSpecifier)} ${quote(path.join(root, 'src/claude-hooks.ts').replaceAll('\\', '/'))}`;
  return Object.fromEntries([
    ['PreToolUse', 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|apply_patch', 40],
    ['PostToolUse', 'Write|Edit|MultiEdit|NotebookEdit|apply_patch', 6],
    ['SessionStart', 'startup|resume|compact', 5],
    ['UserPromptSubmit', undefined, 5],
  ].map(([event, matcher, timeout]) => [event, [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${prefix} ${event}${!legacy && event === 'PreToolUse' ? ' || exit 2' : ''}`, timeout }] }]]));
}
export function claudeHookEntries(root: string): Record<string, unknown[]> {
  return buildClaudeHookEntries(root);
}

export function claudeStatusLineEntries(root: string): Record<'statusLine' | 'subagentStatusLine', Record<string, string>> {
  const command = (script: string) => `${quote(canonicalNodePath())} ${quote(path.join(root, 'src/claude-statusline/scripts', script).replaceAll('\\', '/'))}`;
  return {
    statusLine: { type: 'command', command: command('status-line.mts') },
    subagentStatusLine: { type: 'command', command: command('subagent-status-line.mts') },
  };
}

const LEGACY_CLAUDE_STATUS_LINES = {
  statusLine: [
    { type: 'command', command: 'node "$HOME/.claude/scripts/status-line.mts"' },
    { type: 'command', command: 'node "$HOME/.claude-work/scripts/status-line.mts"' },
  ],
  subagentStatusLine: [
    { type: 'command', command: 'node "$HOME/.claude/scripts/subagent-status-line.mts"' },
    { type: 'command', command: 'node "$HOME/.claude-work/scripts/subagent-status-line.mts"' },
  ],
} as const;

export function validateRuntimeScope(scope: unknown): RuntimeScope {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('runtime scope must specify account and harness');
  const value = scope as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'account' && key !== 'harness') || typeof value.account !== 'string' || !['personal', 'work'].includes(value.account) || typeof value.harness !== 'string' || !['pi', 'claude'].includes(value.harness)) {
    throw new Error('runtime scope must specify account personal|work and harness pi|claude');
  }
  return { account: value.account as Account, harness: value.harness as Harness };
}

async function runRuntime(root: string, config: UserConfig, preview: boolean, scopes: readonly RuntimeScope[]): Promise<RuntimeInstallResult> {
  const entries: RuntimeInstallEntry[] = [];
  for (const { account, harness } of scopes) {
    const accountRoot = config.accounts[account][harness];
    const perform = async (source: string, destination: string, operation: () => Promise<RuntimeInstallEntry['status']>) => {
      if (!preview && entries.some(entry => entry.status === 'conflict')) return;
      try { await physicalDirectory(accountRoot); entries.push({ account, harness, source, destination, status: await operation() }); }
      catch (error) { entries.push({ account, harness, source, destination, status: 'conflict', diagnostic: error instanceof Error ? error.message : String(error) }); }
    };
    if (harness === 'pi') {
      const source = path.join(root, 'extensions/pi-runtime.ts');
      const destination = path.join(accountRoot, 'extensions/mpx2.ts');
      await perform(source, destination, () => ownedPiRuntime(root, destination, preview));
      await perform('native treeFilterMode', path.join(accountRoot, 'settings.json'), () => mergeJson(path.join(accountRoot, 'settings.json'), current => ({ ...current, treeFilterMode: 'no-tools' }), preview));
      await perform('compact subagent presentation', path.join(accountRoot, 'subagents.json'), () => mergeJson(path.join(accountRoot, 'subagents.json'), current => ({ ...current, showModel: true, widgetMode: 'off', fleetView: false }), preview));
      await perform('native newline keys', path.join(accountRoot, 'keybindings.json'), () => mergeJson(path.join(accountRoot, 'keybindings.json'), current => {
        const value = current['tui.input.newLine'];
        if (value !== undefined && typeof value !== 'string' && (!Array.isArray(value) || value.some(key => typeof key !== 'string'))) throw new Error('invalid native newline binding; preserve and repair explicitly');
        return { ...current, 'tui.input.newLine': [...new Set([...(typeof value === 'string' ? [value] : Array.isArray(value) ? value : []), 'shift+enter', 'ctrl+j', 'ctrl+enter'])] };
      }, preview));
    } else {
      for (const [relative, target, folder] of [['rules', 'rules/mpx2', true], ['output-styles/mpx-terse.md', 'output-styles/mpx-terse.md', false]] as const) {
        const source = path.join(root, 'dist/claude', relative);
        const destination = path.join(accountRoot, target);
        await perform(source, destination, () => ownedLink(source, destination, preview, folder));
      }
      await perform('MPX2 native Claude hook registrations', path.join(accountRoot, 'settings.json'), () => mergeJson(path.join(accountRoot, 'settings.json'), current => {
        if (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks))) throw new Error('invalid hooks object; preserved');
        if (current.permissions !== undefined && (!current.permissions || typeof current.permissions !== 'object' || Array.isArray(current.permissions))) throw new Error('invalid permissions object; preserved');
        const permissions = (current.permissions ?? {}) as Record<string, unknown>;
        if (permissions.defaultMode !== undefined && typeof permissions.defaultMode !== 'string') throw new Error('invalid permissions.defaultMode; preserved');
        const hooks = (current.hooks ?? {}) as Record<string, unknown>;
        const previousRegistrations = buildClaudeHookEntries(root, true);
        for (const [event, expected] of Object.entries(claudeHookEntries(root))) {
          const existing = hooks[event] ?? [];
          if (!Array.isArray(existing)) throw new Error(`invalid ${event} registrations; preserved`);
          const upgraded = existing.map(value => previousRegistrations[event]?.some(previous => ownedRegistrationEquals(value, previous)) || expected.some(entry => ownedRegistrationEquals(value, entry)) ? expected[0] : value);
          hooks[event] = [...upgraded, ...expected.filter(entry => !upgraded.some(value => ownedRegistrationEquals(value, entry)))];
        }
        const statusLines = claudeStatusLineEntries(root);
        const statusLineSettings = Object.fromEntries(Object.entries(statusLines).map(([field, expected]) => {
          const existing = current[field];
          const legacy = LEGACY_CLAUDE_STATUS_LINES[field as keyof typeof LEGACY_CLAUDE_STATUS_LINES];
          return [field, existing === undefined || legacy.some(value => isDeepStrictEqual(value, existing)) || ownedRegistrationEquals(existing, expected) ? expected : existing];
        }));
        return { ...current, ...statusLineSettings, hooks, permissions: { defaultMode: 'default', ...permissions }, outputStyle: 'mpx-terse' };
      }, preview));
    }
  }
  return { ok: entries.every(entry => entry.status !== 'conflict'), entries };
}

async function preflightAndRun(root: string, config: UserConfig, preview: boolean, scopes: readonly RuntimeScope[]): Promise<RuntimeInstallResult> {
  const preflight = await runRuntime(root, config, true, scopes);
  if (preview || !preflight.ok) return preflight;
  return runRuntime(root, config, false, scopes);
}

/** Installs exactly one validated account/harness runtime scope. */
export async function syncRuntimeScope(root: string, config: UserConfig, scope: RuntimeScope, preview = true): Promise<RuntimeInstallResult> {
  return preflightAndRun(root, config, preview, [validateRuntimeScope(scope)]);
}

/** Broad-scope compatibility API: installs all personal/work and Pi/Claude runtime roots. */
export async function syncRuntime(root: string, config: UserConfig, preview = true): Promise<RuntimeInstallResult> {
  return preflightAndRun(root, config, preview, [
    { account: 'personal', harness: 'pi' }, { account: 'personal', harness: 'claude' },
    { account: 'work', harness: 'pi' }, { account: 'work', harness: 'claude' },
  ]);
}
