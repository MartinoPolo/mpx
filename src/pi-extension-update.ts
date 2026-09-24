import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Account, LaunchSpec, UserConfig } from './contracts.js';
import { cleanEnvironment, runLaunch } from './launch.js';

export async function updatePiExtensions(
  config: UserConfig,
  environment: NodeJS.ProcessEnv = process.env,
  run: (spec: LaunchSpec) => Promise<number> = runLaunch,
): Promise<number> {
  const executable = config.executables?.pi ?? environment.MPX_PI_EXECUTABLE;
  if (!executable || !isAbsolute(executable) || !(await stat(executable).catch(() => undefined))?.isFile()) {
    throw new Error(`Missing native pi executable: ${executable ?? '(configure an executable override)'}`);
  }
  const accounts: Account[] = ['personal', 'work'];
  for (const account of accounts) {
    const accountRoot = config.accounts[account].pi;
    if (!(await stat(accountRoot).catch(() => undefined))?.isDirectory()) {
      throw new Error(`Missing ${account} pi account root: ${accountRoot}`);
    }
  }

  for (const account of accounts) {
    const accountRoot = config.accounts[account].pi;
    const env = cleanEnvironment(environment);
    env.PI_CODING_AGENT_DIR = accountRoot;
    const spec: LaunchSpec = {
      executable, args: ['update', '--extensions'], cwd: accountRoot, env,
      label: `Update Pi extensions · ${account}`, warnings: [], requiresConfirmation: false,
    };
    console.error(spec.label);
    const status = await run(spec);
    if (status !== 0) return status;
  }
  return 0;
}
