import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface, type Interface, type Key } from 'node:readline';
import type { Account, Harness, LaunchSpec, LaunchWarning, PackSelection, ProjectSelection, UserConfig } from './contracts.js';
import { LAUNCH_WARNING_CODE, sortLaunchWarnings, WARNING_SEVERITY } from './contracts.js';

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
function inside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonical(value: string): Promise<string> {
  return realpath(value).catch(() => resolve(value));
}

interface LocationOwnership { owner?: Account; current: string; main?: string }
async function locationOwnership(cwd: string, mainCheckout: string | undefined, config: UserConfig): Promise<LocationOwnership> {
  const current = await canonical(cwd);
  const main = mainCheckout === undefined ? undefined : await canonical(mainCheckout);
  const locations = [current, ...(main ? [main] : [])];
  const roots = await Promise.all((['personal', 'work'] as const).flatMap(account =>
    config.domains[account].map(async domain => ({ account, path: await canonical(domain) }))));
  const owners = locations.map(location => roots
    .filter(root => inside(location, root.path))
    .sort((left, right) => right.path.length - left.path.length)[0]?.account);
  const owner = owners.includes('work') ? 'work' : owners.includes('personal') ? 'personal' : undefined;
  return { owner, current, ...(main === undefined ? {} : { main }) };
}

function locationDescription(ownership: LocationOwnership): string {
  return ownership.main && ownership.main !== ownership.current
    ? `current path ${ownership.current}; main checkout ${ownership.main}`
    : `current path ${ownership.current}`;
}

export function formatLaunchWarning(warning: LaunchWarning): string {
  const color = warning.severity === WARNING_SEVERITY.red ? '\x1b[31m'
    : warning.severity === WARNING_SEVERITY.orange ? '\x1b[38;5;208m' : '\x1b[33m';
  return `${color}[${warning.code}]: ${warning.message}\x1b[0m`;
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
  const warnings: LaunchWarning[] = [...project.warnings, ...(native ? [] : selection.warnings)];
  const hasConfigurationFailure = project.warnings.some(warning => warning.code === LAUNCH_WARNING_CODE.projectConfigInvalid
    || warning.code === LAUNCH_WARNING_CODE.projectOverrideInvalid
    || warning.code === LAUNCH_WARNING_CODE.projectDiscoveryFailed);
  if (!project.config && !project.configOmitted && !hasConfigurationFailure
    && !project.warnings.some(warning => warning.code === LAUNCH_WARNING_CODE.projectConfigMissing)) {
    warnings.push({ code: LAUNCH_WARNING_CODE.projectConfigMissing, severity: WARNING_SEVERITY.yellow, message: `No project configuration applies to ${cwd}.` });
  }
  const ownership = await locationOwnership(cwd, project.mainCheckout, config);
  const location = locationDescription(ownership);
  if (account === 'personal' && ownership.owner === 'work') {
    warnings.push({ code: LAUNCH_WARNING_CODE.personalInWork, severity: WARNING_SEVERITY.red, message: `Personal account selected for a work-owned location (${location}).` });
  } else if (account === 'work' && ownership.owner === 'personal') {
    warnings.push({ code: LAUNCH_WARNING_CODE.workInPersonal, severity: WARNING_SEVERITY.orange, message: `Work account selected for a personal-owned location (${location}).` });
  } else if (ownership.owner === undefined) {
    warnings.push({ code: LAUNCH_WARNING_CODE.ownershipUnknown, severity: WARNING_SEVERITY.yellow, message: `Location is outside configured personal and work domains; ownership is unknown (${location}).` });
  }
  const normalizedWarnings = sortLaunchWarnings(warnings);
  const env = cleanEnvironment(sourceEnv);
  env[harness === 'pi' ? 'PI_CODING_AGENT_DIR' : 'CLAUDE_CONFIG_DIR'] = accountRoot;
  if (!native) {
    env.MPX_ACCOUNT = account;
    env.MPX_ACTIVE_CONTENT_ROOT = resolve(root);
  }
  const injected: string[] = [];
  if (native) injected.push('--no-extensions');
  else for (const path of selection.paths) injected.push(harness === 'pi' ? '--skill' : '--add-dir', path);
  return {
    executable, args: [...injected, ...args], cwd, env,
    label: native ? 'Native Pi · extension discovery-disabled · explicit extensions may load; see native startup list' : `MPX2 · ${account.toUpperCase()} · ${harness === 'pi' ? 'Pi' : 'Claude'}`,
    warnings: normalizedWarnings,
    requiresConfirmation: normalizedWarnings.length > 0,
  };
}

/** No timeout or noninteractive bypass: acknowledgement is intentionally human-owned. */
type InputListener = (...arguments_: unknown[]) => void;
function isInputListener(value: Function): value is InputListener { return typeof value === 'function'; }

export async function confirmLaunch(spec: Pick<LaunchSpec, 'requiresConfirmation'>, input: NodeJS.ReadStream = process.stdin): Promise<void> {
  if (!spec.requiresConfirmation) return;
  if (!input.isTTY) throw new Error('Launch warning requires an interactive terminal and Enter; launch cancelled.');
  await new Promise<void>((accept, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    const initialInputListeners = new Map(input.eventNames().map(event => [event, input.rawListeners(event)]));
    let addedInputListeners: { event: string | symbol; listener: InputListener }[] = [];
    let readline: Interface | undefined;
    let settled = false;
    const recordAddedInputListeners = () => {
      addedInputListeners = input.eventNames().flatMap(event => {
        const initial = initialInputListeners.get(event) ?? [];
        const seen = new Map<Function, number>();
        return input.rawListeners(event).filter(isInputListener).filter(listener => {
          const occurrence = (seen.get(listener) ?? 0) + 1;
          seen.set(listener, occurrence);
          return occurrence > initial.filter(candidate => candidate === listener).length;
        }).map(listener => ({ event, listener }));
      });
    };
    const restoreInput = (): Error | undefined => {
      let restorationError: Error | undefined;
      try {
        if (Boolean(input.isRaw) !== wasRaw) input.setRawMode(wasRaw);
      } catch (error) {
        restorationError = error instanceof Error ? error : new Error(String(error));
      }
      if (wasFlowing === true) input.resume(); else input.pause();
      return restorationError;
    };
    const cleanup = (): Error | undefined => {
      input.off('keypress', onKeypress);
      input.off('error', onInputError);
      for (const { event, listener } of addedInputListeners) input.removeListener(event, listener);
      let closeError: Error | undefined;
      if (readline) {
        readline.off('line', onLine);
        readline.off('SIGINT', onInterrupt);
        readline.off('close', onClose);
        readline.off('error', onReadlineError);
        try { readline.close(); }
        catch (error) { closeError = error instanceof Error ? error : new Error(String(error)); }
      }
      const restorationError = restoreInput();
      return closeError ?? restorationError;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      const restorationError = cleanup();
      process.stderr.write('\n');
      const failure = error ?? restorationError;
      if (failure) reject(failure); else accept();
    };
    const onLine = (line: string) => { if (line === '') finish(); else readline?.prompt(); };
    const onInterrupt = () => finish(new Error('Launch cancelled (Ctrl+C).'));
    const onClose = () => finish(new Error('Launch cancelled (input closed).'));
    const onReadlineError = (error: Error) => finish(new Error(`Launch cancelled (${error.message}).`));
    const onInputError = (error: Error) => queueMicrotask(() => onReadlineError(error));
    const onKeypress = (_value: string, key: Key) => {
      if (key.name === 'escape') finish(new Error('Launch cancelled (Escape).'));
    };
    input.once('error', onInputError);
    try {
      if (!wasRaw) input.setRawMode(true);
      readline = createInterface({ input, output: process.stderr, terminal: true, escapeCodeTimeout: 50 });
      input.on('keypress', onKeypress);
      readline.on('line', onLine);
      readline.on('SIGINT', onInterrupt);
      readline.on('close', onClose);
      readline.on('error', onReadlineError);
      readline.setPrompt('Press Enter to continue, Ctrl+C or Escape to cancel: ');
      recordAddedInputListeners();
      readline.prompt();
    } catch (error) {
      recordAddedInputListeners();
      finish(error instanceof Error ? error : new Error(String(error)));
    }
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
