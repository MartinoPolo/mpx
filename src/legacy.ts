import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createLaunchSpec } from './launch.js';
import type { LaunchSpec, ProjectSelection, UserConfig } from './contracts.js';
import { inspectNativePackages } from './native-packages.js';

/** Temporary access only. Legacy sources are loaded in place, never copied or modified. */
export async function createLegacyLaunch(root: string, cwd: string, config: UserConfig, project: ProjectSelection, args: string[]): Promise<LaunchSpec> {
  const legacy = config.legacyPi;
  if (!legacy) throw new Error('Legacy Pi is unavailable: configure a separate legacyPi.accountRoot and the retained mpx-pi checkout. No fallback launched.');
  const isolatedRoot = await realpath(legacy.accountRoot);
  for (const account of ['personal', 'work'] as const) {
    if ((await realpath(config.accounts[account].pi)).toLowerCase() === isolatedRoot.toLowerCase()) throw new Error('Legacy Pi must not share either active native account root.');
  }
  const extensionRoot = path.join(legacy.checkout, 'extensions');
  if (!(await stat(path.join(extensionRoot, 'subagents/index.ts')).catch(() => undefined))?.isFile()) throw new Error('Retained legacy mpx-pi installation is unavailable; no fallback launched.');
  const entries = await readdir(extensionRoot, { withFileTypes: true });
  const native = await inspectNativePackages([{ account: 'legacy', root: isolatedRoot }]);
  if (!native.ok) throw new Error('Legacy Pi native packages are missing or filtered in its separate account. Configure that account explicitly; no installation or account fallback was attempted.');
  const extensions: string[] = native.packages.flatMap(item => item.loadTargets);
  const settingsFile = path.join(legacy.checkout, 'settings.json');
  if ((await stat(settingsFile)).size > 1024 * 1024) throw new Error('Legacy package settings exceed the inspection limit.');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as { packages?: unknown };
  const sources = Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === 'string' && path.isAbsolute(value)) : [];
  let foundDisplay = false;
  for (const source of sources) {
    const manifestPath = path.join(source, 'package.json');
    const info = await stat(manifestPath).catch(() => undefined);
    if (!info?.isFile() || info.size > 1024 * 1024) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string; pi?: { extensions?: string[] } };
    if (manifest.name !== 'pi-tool-display') continue;
    for (const relative of manifest.pi?.extensions ?? ['index.ts']) {
      const entry = path.resolve(source, relative);
      if (!(await stat(entry).catch(() => undefined))?.isFile()) throw new Error('Retained legacy tool-display entry is unavailable; no fallback launched.');
      extensions.push(entry); foundDisplay = true;
    }
  }
  if (!foundDisplay) throw new Error('Retained legacy tool-display loading entry is unavailable; no reduced-mode fallback launched.');
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Retired manager entrypoints and the old direct-notification bundle must not execute.
    // Orca is the sole attention owner; agent-resurrect and display/namespace/title
    // integrations remain explicit retained resources.
    if (['dev-server', 'guard-hooks.ts', 'terminal-progress', 'worktree'].includes(entry.name)) continue;
    const file = path.join(extensionRoot, entry.name, ...(entry.isDirectory() ? ['index.ts'] : []));
    const info = (entry.name.endsWith('.ts') || entry.isDirectory()) ? await stat(file).catch(() => undefined) : undefined;
    if (!info?.isFile()) continue;
    if (entry.name === 'footer.ts') {
      if (info.size > 1024 * 1024) throw new Error('Legacy footer exceeds the compatibility inspection limit.');
      const source = await readFile(file, 'utf8');
      const fixed = path.join(homedir(), '.pi', 'agent');
      const fixedRoot = await realpath(fixed).catch(() => path.resolve(fixed));
      if (/function\s+agentDirectory\(\)\s*:\s*string\s*\{\s*return\s+path\.join\(homedir\(\),\s*["']\.pi["'],\s*["']agent["']\);?\s*\}/.test(source) && fixedRoot.toLowerCase() !== isolatedRoot.toLowerCase()) {
        throw new Error('Legacy footer hardcodes ~/.pi/agent outside the separate legacy account. An approved compatibility fix is required; no fallback launched.');
      }
    }
    extensions.push(file);
  }
  const nativeConfig: UserConfig = { ...config, accounts: { ...config.accounts, personal: { ...config.accounts.personal, pi: legacy.accountRoot } } };
  const spec = await createLaunchSpec({ root, cwd, harness: 'pi', account: 'personal', config: nativeConfig, project, selection: { packs: [], paths: [], warnings: [] }, args: [], native: true });
  spec.args.push('--extension', path.join(root, 'extensions/pi-safeguards.ts'));
  for (const extension of extensions) spec.args.push('--extension', extension);
  spec.args.push(...args);
  spec.label = 'LEGACY · Pi · isolated account · retired manager/alert entrypoints excluded · MPX2 command safeguards · formatting manual · see actual native extension list';
  return spec;
}
