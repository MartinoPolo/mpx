import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Account, Harness, LaunchSpec, PackSelection, ProjectSelection, UserConfig } from './contracts.js';

const retainedMpx = new Set(['MPX_PROJECTS', 'MPX_WORK', 'MPX_CLONED', 'MPX_APPS', 'MPX_ONEDRIVE', 'MPX_AI_GENERATED', 'MPX_OBSIDIAN_VAULT', 'MPX_PI_EXECUTABLE', 'MPX_CLAUDE_EXECUTABLE']);
function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const removed = new Set(['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR']);
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (removed.has(upper) || (upper.startsWith('MPX_') && !retainedMpx.has(upper))) continue;
    // Windows treats environment keys case-insensitively. Normalize owned roots so an
    // inherited case variant cannot shadow a freshly selected account/content value.
    result[retainedMpx.has(upper) ? upper : key] = value;
  }
  return result;
}
function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function createLaunchSpec(options: {
  root: string; cwd: string; harness: Harness; account: Account; config: UserConfig;
  project: ProjectSelection; selection: PackSelection; args: string[];
  env?: NodeJS.ProcessEnv; native?: boolean;
}): Promise<LaunchSpec> {
  const { root, cwd, harness, account, config, project, selection, args, native } = options;
  if (native && harness !== 'pi') throw new Error('The discovery-disabled escape hatch supports Pi only.');
  const sourceEnv = options.env ?? process.env;
  const executable = config.executables?.[harness] ?? sourceEnv[harness === 'pi' ? 'MPX_PI_EXECUTABLE' : 'MPX_CLAUDE_EXECUTABLE'];
  if (!executable || !isAbsolute(executable) || !(await stat(executable).catch(() => undefined))?.isFile()) {
    throw new Error(`Missing native ${harness} executable: ${executable ?? '(configure an executable override)'}`);
  }
  const accountRoot = config.accounts[account][harness];
  if (!(await stat(accountRoot).catch(() => undefined))?.isDirectory()) throw new Error(`Missing ${account} ${harness} account root: ${accountRoot}`);
  const warnings = [...new Set([...project.warnings, ...(native ? [] : selection.warnings)])];
  if (!project.config) warnings.push(`Unregistered directory: ${cwd}. Press Enter to continue; Ctrl+C cancels.`);
  if (account === 'personal' && config.domains.work.some(domain => inside(project.mainCheckout ?? cwd, domain))) {
    warnings.push('Personal account in a known work domain. Press Enter to continue; Ctrl+C cancels.');
  }
  const env = cleanEnvironment(sourceEnv);
  env[harness === 'pi' ? 'PI_CODING_AGENT_DIR' : 'CLAUDE_CONFIG_DIR'] = accountRoot;
  if (!native) {
    env.MPX_ACCOUNT = account;
    env.MPX_ACTIVE_CONTENT_ROOT = resolve(root);
  }
  const injected = harness === 'pi' ? ['--verbose'] : [];
  if (native) injected.push('--no-extensions');
  else for (const path of selection.paths) injected.push(harness === 'pi' ? '--skill' : '--add-dir', path);
  return {
    executable, args: [...injected, ...args], cwd, env,
    label: native ? 'Native Pi · extension discovery-disabled · explicit extensions may load; see native startup list' : `MPX2 · ${account.toUpperCase()} · ${harness === 'pi' ? 'Pi' : 'Claude'}`,
    warnings,
    requiresConfirmation: !project.config || (account === 'personal' && config.domains.work.some(domain => inside(project.mainCheckout ?? cwd, domain))),
  };
}

/** No timeout or noninteractive bypass: acknowledgement is intentionally human-owned. */
export async function confirmLaunch(spec: LaunchSpec, input: NodeJS.ReadStream = process.stdin): Promise<void> {
  if (!spec.requiresConfirmation) return;
  if (!input.isTTY) throw new Error('Launch warning requires an interactive terminal and Enter; launch cancelled.');
  await new Promise<void>((accept, reject) => {
    const rl = createInterface({ input, output: process.stderr, terminal: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (error) reject(error); else accept();
    };
    rl.on('line', line => { if (line === '') finish(); else rl.prompt(); });
    rl.on('SIGINT', () => finish(new Error('Launch cancelled (Ctrl+C).')));
    rl.on('close', () => { if (!settled) finish(new Error('Launch cancelled (input closed).')); });
    rl.setPrompt('Press Enter to continue, Ctrl+C to cancel: ');
    rl.prompt();
  });
}

/** Force CRT quoting: libuv leaves bare LF-containing args unquoted, which MSYS splits. */
function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/** Positional forwarding through Git Bash only for native shell shims; never interpolate caller text. */
export async function runLaunch(spec: LaunchSpec, capture?: (chunk: string) => void): Promise<number> {
  const needsBash = process.platform === 'win32' && !/\.(exe|com)$/i.test(spec.executable);
  const command = needsBash ? 'bash' : spec.executable;
  const args = needsBash ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'mpx2-launch', spec.executable, ...spec.args] : spec.args;
  return new Promise<number>((accept, reject) => {
    const child = spawn(command, needsBash ? args.map(windowsArgument) : args, {
      cwd: spec.cwd, env: spec.env, shell: false, windowsVerbatimArguments: needsBash,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (capture) { child.stdout?.on('data', chunk => capture(String(chunk))); child.stderr?.on('data', chunk => capture(String(chunk))); }
    const interrupt = () => { child.kill('SIGINT'); };
    process.on('SIGINT', interrupt);
    child.once('error', error => { process.off('SIGINT', interrupt); reject(new Error(`Unable to launch ${spec.executable}: ${error.message}`)); });
    child.once('close', (code, signal) => { process.off('SIGINT', interrupt); accept(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}
