import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UserConfig } from './contracts.js';

export interface RuntimeInstallEntry { source: string; destination: string; status: 'installed' | 'planned' | 'unchanged' | 'conflict'; diagnostic?: string }
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
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function claudeHookEntries(root: string): Record<string, unknown[]> {
  const prefix = `${quote(process.execPath.replaceAll('\\', '/'))} --import ${quote(path.join(root, 'node_modules/tsx/dist/loader.mjs').replaceAll('\\', '/'))} ${quote(path.join(root, 'src/claude-hooks.ts').replaceAll('\\', '/'))}`;
  return Object.fromEntries([
    ['PreToolUse', 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|apply_patch', 40],
    ['PostToolUse', 'Write|Edit|MultiEdit|NotebookEdit|apply_patch', 6],
    ['SessionStart', 'startup|resume|compact', 5],
    ['UserPromptSubmit', undefined, 5],
  ].map(([event, matcher, timeout]) => [event, [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${prefix} ${event}`, timeout }] }]]));
}
/** Explicit scoped installation. Never disables old entries or changes native packages/authentication. */
export async function syncRuntime(root: string, config: UserConfig, preview = true): Promise<RuntimeInstallResult> {
  const entries: RuntimeInstallEntry[] = [];
  for (const account of ['personal', 'work'] as const) {
    for (const harness of ['pi', 'claude'] as const) {
      const accountRoot = config.accounts[account][harness];
      const perform = async (source: string, destination: string, operation: () => Promise<RuntimeInstallEntry['status']>) => {
        try { await physicalDirectory(accountRoot); entries.push({ source, destination, status: await operation() }); }
        catch (error) { entries.push({ source, destination, status: 'conflict', diagnostic: error instanceof Error ? error.message : String(error) }); }
      };
      if (harness === 'pi') {
        const source = path.join(root, 'extensions/pi-runtime.ts');
        const destination = path.join(accountRoot, 'extensions/mpx2.ts');
        await perform(source, destination, () => ownedLink(source, destination, preview));
        await perform('native treeFilterMode', path.join(accountRoot, 'settings.json'), () => mergeJson(path.join(accountRoot, 'settings.json'), current => ({ ...current, treeFilterMode: 'no-tools' }), preview));
        await perform('upstream running-agent model display', path.join(accountRoot, 'subagents.json'), () => mergeJson(path.join(accountRoot, 'subagents.json'), current => ({ ...current, showModel: true }), preview));
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
          const hooks = (current.hooks ?? {}) as Record<string, unknown>;
          for (const [event, expected] of Object.entries(claudeHookEntries(root))) {
            const existing = hooks[event] ?? [];
            if (!Array.isArray(existing)) throw new Error(`invalid ${event} registrations; preserved`);
            hooks[event] = [...existing, ...expected.filter(entry => !existing.some(value => JSON.stringify(value) === JSON.stringify(entry)))];
          }
          return { ...current, hooks };
        }, preview));
      }
    }
  }
  return { ok: entries.every(entry => entry.status !== 'conflict'), entries };
}
