import { access } from 'node:fs/promises';
import path from 'node:path';
import { comparablePath, homeDirectory, readUserConfig, resolveProject, selectPacks, userConfigFile } from './config.js';
import type { Account } from './contracts.js';

/** The MPX launcher records the pack directories it passed as `--add-dir`, which hooks cannot otherwise see. */
export const PACK_PATHS_ENV = 'MPX_PACK_PATHS';

// The config directory, not an inheritable MPX_ACCOUNT, identifies the account that owns the session.
async function sessionAccount(env: NodeJS.ProcessEnv, accountRoots: Record<Account, string>): Promise<Account | undefined> {
  const configDirectory = await comparablePath(env.CLAUDE_CONFIG_DIR || path.join(homeDirectory(env), '.claude'));
  for (const account of ['personal', 'work'] as const) {
    if (await comparablePath(accountRoots[account]) === configDirectory) return account;
  }
  return undefined;
}

/**
 * Warns when a Claude session lacks the project's MPX pack directories, as when a host such as Orca
 * resumes it with plain `claude`. A missing user configuration or an unknown account stays silent;
 * other failures throw so the hook can report them.
 */
export async function missingClaudePackWarning(options: { root: string; cwd: string; env: NodeJS.ProcessEnv; transcriptPath?: string }): Promise<string | undefined> {
  const { root, cwd, env } = options;
  const configFile = userConfigFile(env);
  if (!configFile || !(await access(configFile).then(() => true, () => false))) return undefined;
  const config = await readUserConfig(configFile, env);
  const account = await sessionAccount(env, { personal: config.accounts.personal.claude, work: config.accounts.work.claude });
  if (!account) return undefined;
  const selection = await selectPacks(root, 'claude', account, await resolveProject(cwd, config), config);
  const loaded = new Set(await Promise.all((env[PACK_PATHS_ENV] ?? '').split(path.delimiter).filter(Boolean).map(comparablePath)));
  const missing: string[] = [];
  for (const [index, directory] of selection.paths.entries()) {
    if (!loaded.has(await comparablePath(directory))) missing.push(selection.packs[index] ?? directory);
  }
  if (!missing.length) return undefined;
  const transcript = options.transcriptPath?.replaceAll('\\', '/');
  // Without a pasteable transcript path, the interactive picker finds the session instead.
  const relaunch = transcript && !/["`$]/.test(transcript)
    ? `mpx resume --launch "${transcript}" --account ${account} --harness claude`
    : 'mpx resume';
  return `MPX packs not loaded in this session: ${missing.join(', ')}. Their skills are unavailable because the session was not started through the MPX launcher. Exit and relaunch with \`${relaunch}\`.`;
}
