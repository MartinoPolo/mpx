import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

export interface WorktreeRequest {
  action: 'create' | 'enter';
  name?: string;
  path?: string;
  base?: string;
  task?: string;
}

export type Execute = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface WorkspaceHubInvocation {
  command: string;
  argumentPrefix: string[];
}

export interface WorktreePreparation {
  path: string;
  alreadyCurrent: boolean;
  warning?: string;
}

export function resolveWorkspaceHubInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable: string = process.execPath,
): WorkspaceHubInvocation {
  if (platform !== 'win32') {
    return { command: 'mpx', argumentPrefix: [] };
  }
  const applicationsRoot = environment.MPX_APPS?.trim();
  const driveQualified = applicationsRoot ? /^[A-Za-z]:[\\/]/u.test(applicationsRoot) : false;
  const uncQualified = applicationsRoot
    ? /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(applicationsRoot)
    : false;
  if (!applicationsRoot || (!driveQualified && !uncQualified)) {
    throw new Error(
      'MPX_APPS must identify a drive-qualified or UNC MPX applications root on Windows.',
    );
  }
  return {
    command: nodeExecutable,
    argumentPrefix: [path.win32.join(applicationsRoot, 'mpx', 'bin', 'mpx-node.mjs')],
  };
}

export const COMMAND_USAGE =
  '/worktree <name> [--base <ref>] [-- <task>] or /worktree --enter <path> [-- <task>]';

export function validateRequest(request: WorktreeRequest): WorktreeRequest {
  for (const value of Object.values(request)) {
    if (typeof value === 'string' && /[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) {
      throw new Error('Worktree arguments must not contain control characters.');
    }
  }
  if (request.action === 'create') {
    if (
      !request.name ||
      /[\s\\:]/u.test(request.name) ||
      request.name.startsWith('-') ||
      request.name.includes('@{')
    ) {
      throw new Error('Supply a literal Git branch name for the new worktree.');
    }
    if (request.path !== undefined) {
      throw new Error('Use action enter for an existing worktree path.');
    }
    if (
      request.base !== undefined &&
      (!request.base.trim() || request.base.startsWith('-') || /[\r\n]/u.test(request.base))
    ) {
      throw new Error('Supply a valid base ref, not an option.');
    }
  } else if (request.action === 'enter') {
    if (!request.path?.trim() || /[\r\n]/u.test(request.path)) {
      throw new Error('Supply the existing worktree path.');
    }
    if (request.name !== undefined || request.base !== undefined) {
      throw new Error('name and base apply only when creating a worktree.');
    }
  } else {
    throw new Error('Worktree action must be create or enter.');
  }
  if (request.task !== undefined && !request.task.trim()) {
    throw new Error('The continuation task must not be empty.');
  }
  return request;
}

export function parseCommand(argumentsText: string): WorktreeRequest {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let task: string | undefined;
  for (let index = 0; index <= argumentsText.length; index += 1) {
    const character = argumentsText[index];
    if (quote) {
      if (character === undefined) {
        throw new Error('Unclosed quote in worktree command.');
      }
      if (character === quote) {
        quote = '';
      } else {
        token += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === undefined || /\s/u.test(character)) {
      if (token === '--') {
        task = argumentsText.slice(index).trim();
        break;
      }
      if (token) {
        tokens.push(token);
      }
      token = '';
    } else {
      token += character;
    }
  }
  const request: WorktreeRequest = { action: 'create', task };
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]!;
    if (['--enter', '--base'].includes(current)) {
      const value = tokens[++index];
      if (!value || value.startsWith('--')) {
        throw new Error(`${current} needs a value. ${COMMAND_USAGE}`);
      }
      if (current === '--enter') {
        request.action = 'enter';
        request.path = value;
      } else {
        request.base = value;
      }
    } else if (!request.name && !current.startsWith('-')) {
      request.name = current;
    } else {
      throw new Error(`Unexpected argument: ${current}. ${COMMAND_USAGE}`);
    }
  }
  return validateRequest(request);
}

export function parseWorkspaceCreateResult(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Worktree Hub did not return a valid workspace create result.');
  }
  const envelope = parsed as {
    ok?: unknown;
    data?: { kind?: unknown; operation?: unknown; path?: unknown };
  };
  if (
    envelope.ok !== true ||
    envelope.data?.kind !== 'workspace-mutation' ||
    envelope.data.operation !== 'create' ||
    typeof envelope.data.path !== 'string'
  ) {
    throw new Error('Worktree Hub did not return a valid workspace create result.');
  }
  if (!path.isAbsolute(envelope.data.path)) {
    throw new Error('Worktree Hub returned a non-absolute worktree path.');
  }
  return envelope.data.path;
}

export function findWorktreeForBranch(output: string, branch: string): string | undefined {
  const expectedReference = `refs/heads/${branch}`;
  const matches: string[] = [];
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;
  let prunable = false;
  const publish = () => {
    if (worktreeBranch === expectedReference && worktreePath !== undefined && !prunable) {
      matches.push(worktreePath);
    }
    worktreePath = undefined;
    worktreeBranch = undefined;
    prunable = false;
  };

  for (const field of output.split('\0')) {
    if (field === '') {
      publish();
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      worktreePath = value;
    } else if (key === 'branch') {
      worktreeBranch = value;
    } else if (key === 'prunable') {
      prunable = true;
    }
  }
  publish();

  if (matches.length > 1) {
    throw new Error(`Git reported multiple worktrees for branch ${JSON.stringify(branch)}.`);
  }
  const match = matches[0];
  if (match !== undefined && !path.isAbsolute(match)) {
    throw new Error('Git reported a non-absolute worktree path.');
  }
  return match;
}

const EXECUTION_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_CHARACTERS = 12_000;

interface ExecutionDiagnosticResult {
  stdout?: string;
  stderr?: string;
  code?: unknown;
  killed?: unknown;
}

function boundedJson(value: unknown, maximumCharacters: number): string {
  const serialized = JSON.stringify(value) ?? 'undefined';
  if (serialized.length <= maximumCharacters) {
    return serialized;
  }
  let tailLength = maximumCharacters;
  let bounded = '';
  do {
    bounded = JSON.stringify({ truncated: true, jsonTail: serialized.slice(-tailLength) });
    tailLength = Math.max(0, tailLength - Math.max(1, bounded.length - maximumCharacters));
  } while (bounded.length > maximumCharacters && tailLength > 0);
  return bounded.slice(0, maximumCharacters);
}

function boundedTail(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) {
    return value;
  }
  const marker = `[truncated output; ${value.length} total characters]\n`;
  if (marker.length >= maximumCharacters) {
    return marker.slice(0, maximumCharacters);
  }
  return `${marker}${value.slice(-(maximumCharacters - marker.length))}`;
}

function diagnosticPrimitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

function executionFailureDetails(
  error: unknown,
): ExecutionDiagnosticResult & { description: string } {
  const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (typeof error !== 'object' || error === null) {
    return { description };
  }
  const failure = error as Record<string, unknown>;
  return {
    description,
    stdout: typeof failure.stdout === 'string' ? failure.stdout : undefined,
    stderr: typeof failure.stderr === 'string' ? failure.stderr : undefined,
    code: diagnosticPrimitive(failure.code),
    killed: diagnosticPrimitive(failure.killed),
  };
}

function formatExecutionDiagnostic(
  command: string,
  args: string[],
  cwd: string,
  result?: ExecutionDiagnosticResult,
  executionError?: string,
): string {
  const metadata = [
    `Command: ${boundedJson(command, 512)}`,
    `Arguments: ${boundedJson(args, 2_048)}`,
    `Cwd: ${boundedJson(cwd, 1_024)}`,
    `Exit code: ${result?.code === undefined ? '<unavailable>' : boundedJson(result.code, 128)}`,
    `Killed/timeout: ${result?.killed === undefined ? '<unavailable>' : boundedJson(result.killed, 128)}`,
    ...(executionError === undefined
      ? []
      : [`Execution error: ${boundedTail(executionError, 1_024)}`]),
  ].join('\n');
  const stdout = result?.stdout === undefined ? '<unavailable>' : result.stdout || '<empty>';
  const stderr = result?.stderr === undefined ? '<unavailable>' : result.stderr || '<empty>';
  const sectionCharacters = '\nstdout:\n\nstderr:\n'.length;
  const outputBudget = Math.max(0, MAX_DIAGNOSTIC_CHARACTERS - metadata.length - sectionCharacters);
  const stdoutBudget = Math.floor(outputBudget / 2);
  const stderrBudget = outputBudget - stdoutBudget;

  return `${metadata}\nstdout:\n${boundedTail(stdout, stdoutBudget)}\nstderr:\n${boundedTail(stderr, stderrBudget)}`;
}

async function checkedExecute(
  execute: Execute,
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let result: ExecResult;
  try {
    result = await execute(command, args, { cwd, signal, timeout: EXECUTION_TIMEOUT_MS });
  } catch (error) {
    signal.throwIfAborted();
    const failure = executionFailureDetails(error);
    throw new Error(
      `Execution failed:\n${formatExecutionDiagnostic(
        command,
        args,
        cwd,
        failure,
        failure.description,
      )}`,
    );
  }
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed) {
    throw new Error(`Execution failed:\n${formatExecutionDiagnostic(command, args, cwd, result)}`);
  }
  return result.stdout.trim();
}

export async function prepareWorktree(
  request: WorktreeRequest,
  cwd: string,
  execute: Execute,
  signal: AbortSignal,
): Promise<WorktreePreparation> {
  validateRequest(request);
  const git = (args: string[], directory = cwd) =>
    checkedExecute(execute, 'git', args, directory, signal);
  const currentDirectory = await realpath(cwd);
  const sourceRoot = await realpath(await git(['rev-parse', '--show-toplevel']));
  const sourceCommonDirectory = await realpath(
    await git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  let target: string;
  let warning: string | undefined;
  if (request.action === 'create') {
    await git(['check-ref-format', '--branch', request.name!]);
    const existingTarget = findWorktreeForBranch(
      await git(['worktree', 'list', '--porcelain', '-z'], sourceRoot),
      request.name!,
    );
    const canonicalExistingTarget =
      existingTarget === undefined ? undefined : await realpath(existingTarget);
    if (request.base === undefined && canonicalExistingTarget === sourceRoot) {
      target = canonicalExistingTarget;
    } else {
      try {
        const hub = resolveWorkspaceHubInvocation();
        const output = await checkedExecute(
          execute,
          hub.command,
          [
            ...hub.argumentPrefix,
            '--cwd',
            sourceRoot,
            '--json',
            'workspace',
            'create',
            request.name!,
            '--base',
            request.base ?? 'HEAD',
          ],
          sourceRoot,
          signal,
        );
        target = parseWorkspaceCreateResult(output);
      } catch (error) {
        signal.throwIfAborted();
        const hubFailure = error instanceof Error ? error.message : String(error);
        let recoveredTarget: string | undefined;
        try {
          const inventory = await git(['worktree', 'list', '--porcelain', '-z'], sourceRoot);
          recoveredTarget = findWorktreeForBranch(inventory, request.name!);
        } catch (recoveryError) {
          signal.throwIfAborted();
          throw new Error(
            `MPX workspace Hub is unavailable or creation failed: ${hubFailure}\nGit could not resolve a partially created worktree: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
        if (recoveredTarget === undefined || existingTarget !== undefined) {
          const manualRecovery =
            existingTarget === undefined
              ? 'No matching worktree was reported by Git. As a manual fallback, create the requested branch and worktree with Git, then use /worktree --enter <path>.'
              : 'The matching worktree existed before this request, so it was not entered automatically. Inspect git worktree list and use /worktree --enter <path> if it is the intended checkout.';
          throw new Error(
            `MPX workspace Hub is unavailable or creation failed: ${hubFailure}\n${manualRecovery}`,
          );
        }
        target = recoveredTarget;
        warning = `MPX workspace Hub reported a failure, but Git reported the newly created worktree. Continuing with the validated checkout.\n${hubFailure}`;
      }
    }
  } else {
    target = path.resolve(cwd, request.path!);
  }
  const targetRoot = await realpath(target);
  const targetGitRoot = await realpath(await git(['rev-parse', '--show-toplevel'], targetRoot));
  const targetCommonDirectory = await realpath(
    await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], targetRoot),
  );
  if (targetRoot !== targetGitRoot) {
    throw new Error('Enter the worktree root, not one of its subdirectories.');
  }
  if (sourceCommonDirectory !== targetCommonDirectory) {
    throw new Error('The destination belongs to a different Git repository.');
  }
  signal.throwIfAborted();
  return {
    path: targetRoot,
    alreadyCurrent: currentDirectory === targetRoot,
    ...(warning === undefined ? {} : { warning }),
  };
}
