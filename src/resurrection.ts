import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchSpec } from './contracts.js';
import type { PreparedResumeLaunch } from './resume-launch.js';

const FORBIDDEN_PERMISSION_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--permission-mode=bypassPermissions',
]);

export interface PreparedResurrectionLaunch {
  plan: PreparedResumeLaunch['plan'];
  verification: PreparedResumeLaunch['verification'];
  spec: LaunchSpec;
}

export interface OrcaTerminalCreateRecipe {
  executable: 'orca';
  argv: string[];
  workspace: string;
  title: string;
  command: string;
  launch: PreparedResurrectionLaunch;
}

function samePath(left: string, right: string): boolean {
  return win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase() ===
    win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();
}

function hasExactSuffix(values: string[], suffix: string[]): boolean {
  return suffix.length <= values.length && suffix.every((value, index) =>
    values[values.length - suffix.length + index] === value);
}

function forbiddenArgument(argument: string): boolean {
  return FORBIDDEN_PERMISSION_FLAGS.has(argument) ||
    argument.startsWith('--permission-mode=bypassPermissions');
}

/**
 * Adapt the already prepared MPX2 Pi resume without rediscovery, a session
 * registry, legacy ownership markers, or a wrapper/alias round trip.
 */
export function adaptPreparedPiResurrection(prepared: PreparedResumeLaunch): PreparedResurrectionLaunch {
  const { plan, spec, verification } = prepared;
  if (plan.harness !== 'pi') throw new Error('Agent Resurrect native adapter currently supports verified Pi resumes only');
  if (!verification.verified) throw new Error('Agent Resurrect refuses an unverified Pi resume preparation');
  if (!samePath(plan.cwd, spec.cwd)) throw new Error('Prepared resurrection cwd does not match its native launch specification');
  if (!hasExactSuffix(spec.args, plan.args)) throw new Error('Prepared resurrection launch does not contain the exact resume arguments');
  if (spec.args.some(forbiddenArgument)) throw new Error('Prepared resurrection must not replay permission-bypass flags');
  if (!samePath(spec.env.PI_CODING_AGENT_DIR ?? '', plan.accountRoot)) {
    throw new Error('Prepared resurrection account root does not match its native launch environment');
  }
  return {
    plan,
    verification: { ...verification, observed: verification.observed ? {
      ...verification.observed,
      availableThinking: [...verification.observed.availableThinking],
    } : undefined },
    spec: {
      ...spec,
      args: [...spec.args],
      env: { ...spec.env },
      warnings: [...spec.warnings],
    },
  };
}

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Orca launch values must not contain NUL');
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function environmentMap(env: NodeJS.ProcessEnv): Map<string, { key: string; value: string }> {
  const result = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result.set(key.toUpperCase(), { key, value });
  }
  return result;
}

/** Build a Bash command that transforms ambientEnv into the exact prepared process environment. */
export function buildPreparedLaunchCommand(
  launch: PreparedResurrectionLaunch,
  ambientEnv: NodeJS.ProcessEnv = process.env,
): string {
  const ambient = environmentMap(ambientEnv);
  const selected = environmentMap(launch.spec.env);
  const managed = (key: string) => key.startsWith('MPX_') || ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR'].includes(key);
  for (const key of new Set([...ambient.keys(), ...selected.keys()])) {
    if (!managed(key) && ambient.get(key)?.value !== selected.get(key)?.value) throw new Error('Orca recipe cannot serialize unrelated environment changes or credentials; verify the terminal environment separately.');
  }
  const unset = [...ambient.entries()]
    .filter(([upper, entry]) => managed(upper) && (!selected.has(upper) || selected.get(upper)!.key !== entry.key))
    .map(([, entry]) => entry.key)
    .sort((left, right) => left.localeCompare(right));
  const assign = [...selected.entries()]
    .filter(([upper, entry]) => {
      const prior = ambient.get(upper);
      return managed(upper) && (!prior || prior.key !== entry.key || prior.value !== entry.value);
    })
    .map(([, entry]) => entry)
    .sort((left, right) => left.key.localeCompare(right.key));
  const requiresAcknowledgement = launch.spec.warnings.length > 0 || launch.spec.requiresConfirmation;
  const confirmationCommand = [
    process.execPath,
    fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./confirm-launch-cli.ts', import.meta.url)),
    JSON.stringify(launch.spec.warnings),
  ].map(shellQuote).join(' ');
  const statements = [
    `cd -- ${shellQuote(launch.spec.cwd.replaceAll('\\', '/'))} || exit 1`,
    ...(unset.length > 0 ? [`unset -v ${unset.map(shellQuote).join(' ')}`] : []),
    ...assign.map(({ key, value }) => `export ${key}=${shellQuote(value)}`),
    ...(requiresAcknowledgement ? [`${confirmationCommand} || exit $?`] : []),
    `exec ${[launch.spec.executable, ...launch.spec.args].map(shellQuote).join(' ')}`,
  ];
  return statements.join('; ');
}

/**
 * Pure Orca 729491 terminal-create recipe. It always names the workspace
 * explicitly and creates a terminal only; it is not Run/worker restoration.
 */
export function buildOrcaPiResurrectionRecipe(
  prepared: PreparedResumeLaunch,
  options: { ambientEnv?: NodeJS.ProcessEnv; orcaExecutable?: string } = {},
): OrcaTerminalCreateRecipe {
  if (options.orcaExecutable !== undefined && options.orcaExecutable !== 'orca') {
    throw new Error('The pinned Orca recipe requires the supported orca CLI executable');
  }
  const launch = adaptPreparedPiResurrection(prepared);
  const workspace = `path:${launch.spec.cwd.replaceAll('\\', '/')}`;
  const title = `${launch.plan.account === 'work' ? 'WORK' : 'PERSONAL'} · Pi`;
  const command = buildPreparedLaunchCommand(launch, options.ambientEnv);
  return {
    executable: 'orca',
    argv: [
      'terminal', 'create',
      '--worktree', workspace,
      '--title', title,
      '--command', command,
      '--json',
    ],
    workspace,
    title,
    command,
    launch,
  };
}
