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

async function checkedExecute(
  execute: Execute,
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const result = await execute(command, args, { cwd, signal, timeout: 120_000 });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed) {
    throw new Error(
      `${command} failed${result.killed ? ' or timed out' : ` (${result.code})`}:\n${(result.stderr || result.stdout).slice(-12_000)}`,
    );
  }
  return result.stdout.trim();
}

export async function prepareWorktree(
  request: WorktreeRequest,
  cwd: string,
  execute: Execute,
  signal: AbortSignal,
): Promise<string> {
  validateRequest(request);
  const git = (args: string[], directory = cwd) =>
    checkedExecute(execute, 'git', args, directory, signal);
  const sourceRoot = await realpath(await git(['rev-parse', '--show-toplevel']));
  const sourceCommonDirectory = await realpath(
    await git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  let target: string;
  if (request.action === 'create') {
    await git(['check-ref-format', '--branch', request.name!]);
    try {
      const output = await checkedExecute(
        execute,
        'mpx',
        [
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
      throw new Error(
        `MPX workspace Hub is unavailable or creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  if (sourceRoot === targetRoot) {
    throw new Error('Pi is already in that worktree.');
  }
  signal.throwIfAborted();
  return targetRoot;
}
