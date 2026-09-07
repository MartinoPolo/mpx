/**
 * Guard hooks run package-local scripts with the hook-compatible stdin contract.
 * Pre-tool scripts use exit 2 to block and post-tool scripts may emit additional context.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { registerNotifications } from './notifications.js';

/** @public */
export function resolveGuardsDirectory(): string {
  return fileURLToPath(new URL('./guards/', import.meta.url));
}

const GUARDS_DIRECTORY = resolveGuardsDirectory();
const NOTIFY_FLASH_BEEP_SCRIPT = join(GUARDS_DIRECTORY, 'notify-flash-beep.ps1');

/** Exit code Claude Code reserves for "block this tool call, stderr holds the reason". */
const BLOCKING_EXIT_CODE = 2;

/** Keeps a runaway script's stderr from eating the model's context window. */
const MAXIMUM_REASON_LENGTH = 4000;

export interface HookScriptOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the script was killed at its timeout — its verdict is unknown, not "allow". */
  timedOut: boolean;
  /** Set when the process could not be started or crashed before reporting an exit code. */
  spawnErrorMessage: string | null;
}

export type HookScriptRunner = (
  scriptPath: string,
  stdinPayload: unknown,
  timeoutMilliseconds: number,
  workingDirectory: string,
) => Promise<HookScriptOutcome>;

interface BashGuardScript {
  fileName: string;
  timeoutMilliseconds: number;
  /**
   * What to do when the script itself fails (missing, crashed, timed out) rather than
   * returning a verdict. Fail-open matches Claude Code, which never blocks on hook
   * infrastructure errors.
   */
  blockOnInfrastructureFailure: boolean;
  /**
   * Whether stderr from a successful script is relevant in pi. `enforce-pkg-mgr.mjs` uses
   * successful stderr only for Claude Code's Grep/Glob/Read preferences. Pi cannot return a
   * soft advisory to the model during a tool call, so surfacing those messages only adds TUI
   * noise; exit-2 package-manager verdicts remain blocking.
   */
  surfaceSuccessfulStderr: boolean;
}

/**
 * The PreToolUse(Bash) quartet, in Claude Code's configured order. First block verdict wins.
 *
 * `dangerous-command-guard.mjs` is the one fail-closed member: it is pure regex over the command
 * string with no I/O, so the only way it fails is a broken harness — and an unvetted destructive
 * command is worse than a false block, which the user can always run by hand with `!`.
 */
const BASH_GUARD_SCRIPTS: readonly BashGuardScript[] = [
  {
    fileName: 'enforce-pkg-mgr.mjs',
    timeoutMilliseconds: 5000,
    blockOnInfrastructureFailure: false,
    surfaceSuccessfulStderr: false,
  },
  {
    fileName: 'pre-commit-gate.mjs',
    timeoutMilliseconds: 130000,
    blockOnInfrastructureFailure: false,
    surfaceSuccessfulStderr: true,
  },
  {
    fileName: 'dangerous-command-guard.mjs',
    timeoutMilliseconds: 5000,
    blockOnInfrastructureFailure: true,
    surfaceSuccessfulStderr: true,
  },
  {
    fileName: 'fallow-gate.mjs',
    timeoutMilliseconds: 30000,
    blockOnInfrastructureFailure: false,
    surfaceSuccessfulStderr: true,
  },
];

const FORMAT_LINT_TIMEOUT_MILLISECONDS = 50000;
export const UNTRUSTED_FORMAT_LINT_RESULT =
  'Formatting and linting skipped: project is not trusted.';
const POST_BASH_CONTEXT_TIMEOUT_MILLISECONDS = 10000;
const SESSION_CONTEXT_TIMEOUT_MILLISECONDS = 5000;
const NOTIFY_TIMEOUT_MILLISECONDS = 10000;

const TRUSTED_PROJECT_GUARD_SCRIPTS = new Set([
  'fallow-gate.mjs',
  'format-lint-file.mjs',
  'post-bash-context.mjs',
  'pre-commit-gate.mjs',
]);

/**
 * Spawn a process, optionally feeding it a JSON payload on stdin, and never reject.
 *
 * `process.execPath` is used for the Node scripts because pi runs under an fnm shim whose `node`
 * is not reliably on PATH for child processes.
 */
function runProcess(
  command: string,
  commandArguments: readonly string[],
  stdinPayload: unknown,
  timeoutMilliseconds: number,
  workingDirectory: string,
): Promise<HookScriptOutcome> {
  return new Promise((resolveOutcome) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: HookScriptOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolveOutcome(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...commandArguments], {
        cwd: workingDirectory,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      return resolveOutcome({
        exitCode: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnErrorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMilliseconds);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({ exitCode: -1, stdout, stderr, timedOut, spawnErrorMessage: error.message });
    });
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut, spawnErrorMessage: null });
    });

    // A closed stdin is what makes the scripts' `readStdin()` resolve.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinPayload === undefined ? '' : JSON.stringify(stdinPayload));
  });
}

const runHookScript: HookScriptRunner = (
  scriptPath,
  stdinPayload,
  timeoutMilliseconds,
  workingDirectory,
) => {
  if (!existsSync(scriptPath)) {
    return Promise.resolve({
      exitCode: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnErrorMessage: `hook script not found: ${scriptPath}`,
    });
  }
  return runProcess(
    process.execPath,
    [scriptPath],
    stdinPayload,
    timeoutMilliseconds,
    workingDirectory,
  );
};

function dispatchGuardScript(
  fileName: string,
  trusted: boolean,
  stdinPayload: unknown,
  timeoutMilliseconds: number,
  workingDirectory: string,
  runScript: HookScriptRunner,
  hooksDirectory: string,
): Promise<HookScriptOutcome | null> {
  if (!trusted && TRUSTED_PROJECT_GUARD_SCRIPTS.has(fileName)) {
    return Promise.resolve(null);
  }
  return runScript(
    join(hooksDirectory, fileName),
    stdinPayload,
    timeoutMilliseconds,
    workingDirectory,
  );
}

function truncateReason(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAXIMUM_REASON_LENGTH
    ? trimmed
    : `…${trimmed.slice(-MAXIMUM_REASON_LENGTH)}`;
}

function describeInfrastructureFailure(fileName: string, outcome: HookScriptOutcome): string {
  if (outcome.timedOut) {
    return `${fileName} timed out`;
  }
  if (outcome.spawnErrorMessage) {
    return `${fileName} could not run (${outcome.spawnErrorMessage})`;
  }
  return `${fileName} exited ${outcome.exitCode}`;
}

export type BashGuardVerdict =
  { blocked: true; reason: string } | { blocked: false; advisories: string[] };

/**
 * Run the guard quartet against one bash command and return the first block verdict.
 *
 * Pi-relevant advisories are returned separately from the blocking reason. Claude-only native-tool
 * preferences are suppressed by the per-script compatibility policy above.
 */
export async function evaluateBashGuards(
  command: string,
  workingDirectory: string,
  trusted: boolean,
  runScript: HookScriptRunner = runHookScript,
  hooksDirectory: string = GUARDS_DIRECTORY,
): Promise<BashGuardVerdict> {
  const advisories: string[] = [];
  const payload = { tool_input: { command }, cwd: workingDirectory };

  for (const guard of BASH_GUARD_SCRIPTS) {
    const outcome = await dispatchGuardScript(
      guard.fileName,
      trusted,
      payload,
      guard.timeoutMilliseconds,
      workingDirectory,
      runScript,
      hooksDirectory,
    );
    if (!outcome) {
      continue;
    }

    if (outcome.exitCode === BLOCKING_EXIT_CODE) {
      return {
        blocked: true,
        reason: truncateReason(outcome.stderr) || `Blocked by ${guard.fileName}.`,
      };
    }

    if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnErrorMessage) {
      const failure = describeInfrastructureFailure(guard.fileName, outcome);
      if (guard.blockOnInfrastructureFailure) {
        return {
          blocked: true,
          reason: `Guard hook ${failure}, so this command was never vetted. Fix the hook, or run it yourself with a leading '!'.`,
        };
      }
      advisories.push(failure);
      continue;
    }

    const advisory = outcome.stderr.trim();
    if (guard.surfaceSuccessfulStderr && advisory) {
      advisories.push(advisory);
    }
  }

  return { blocked: false, advisories };
}

/**
 * Recover the bash exit code pi does not expose directly.
 *
 * pi's bash tool merges stdout and stderr into one stream and, on a non-zero exit, throws
 * `<output>\n\nCommand exited with code N` — which becomes the error result's text content
 * (`dist/core/tools/bash.js:343-344`).
 */
function deriveBashExitCode(outputText: string, isError: boolean): number {
  if (!isError) {
    return 0;
  }
  const match = outputText.match(/Command exited with code (\d+)/);
  return match ? Number(match[1]) : 1;
}

/** Pull `hookSpecificOutput.additionalContext` out of a PostToolUse script's stdout. */
function extractAdditionalContext(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const context = parsed.hookSpecificOutput?.additionalContext;
    return typeof context === 'string' && context.trim() ? context.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Run `post-bash-context.mjs` over a finished bash call and return the context it wants appended.
 *
 * pi merges the command's stdout and stderr, so the merged text is fed as both — the script reads
 * `stdout` for a PR URL and `stderr` for vulnerability warnings, and either can appear anywhere in
 * the merged stream.
 */
export async function collectPostBashContext(
  command: string,
  workingDirectory: string,
  outputText: string,
  exitCode: number,
  trusted: boolean,
  runScript: HookScriptRunner = runHookScript,
  hooksDirectory: string = GUARDS_DIRECTORY,
): Promise<string | null> {
  const outcome = await dispatchGuardScript(
    'post-bash-context.mjs',
    trusted,
    {
      tool_input: { command },
      tool_response: { stdout: outputText, stderr: outputText, exit_code: exitCode },
      cwd: workingDirectory,
    },
    POST_BASH_CONTEXT_TIMEOUT_MILLISECONDS,
    workingDirectory,
    runScript,
    hooksDirectory,
  );
  return outcome ? extractAdditionalContext(outcome.stdout) : null;
}

function joinTextContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(`guard-hooks: ${message}`, 'warning');
  }
}

export async function runFormatLintHook(
  trusted: boolean,
  filePath: string,
  workingDirectory: string,
  runScript: HookScriptRunner = runHookScript,
  hooksDirectory: string = GUARDS_DIRECTORY,
): Promise<string> {
  const outcome = await dispatchGuardScript(
    'format-lint-file.mjs',
    trusted,
    { tool_input: { file_path: filePath }, cwd: workingDirectory },
    FORMAT_LINT_TIMEOUT_MILLISECONDS,
    workingDirectory,
    runScript,
    hooksDirectory,
  );
  return outcome ? 'Formatting and linting completed.' : UNTRUSTED_FORMAT_LINT_RESULT;
}

/** Run a context-producing session script and queue its stdout for the next user prompt. */
async function injectSessionContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  scriptPath: string,
  customType: string,
): Promise<void> {
  if (!existsSync(scriptPath)) {
    return;
  }
  const outcome = await runHookScript(
    scriptPath,
    { cwd: ctx.cwd },
    SESSION_CONTEXT_TIMEOUT_MILLISECONDS,
    ctx.cwd,
  );
  const context = outcome.stdout.trim();
  if (!context) {
    if (outcome.spawnErrorMessage || outcome.timedOut) {
      warn(ctx, describeInfrastructureFailure(scriptPath, outcome));
    }
    return;
  }
  pi.sendMessage({ customType, content: context, display: false }, { deliverAs: 'nextTurn' });
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    if (event.toolName !== 'bash') {
      return undefined;
    }

    const command = typeof event.input.command === 'string' ? event.input.command : '';
    if (!command.trim()) {
      return undefined;
    }

    const verdict = await evaluateBashGuards(command, ctx.cwd, ctx.isProjectTrusted());
    if (verdict.blocked) {
      return { block: true, reason: verdict.reason };
    }
    for (const advisory of verdict.advisories) {
      warn(ctx, advisory);
    }
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'edit' || event.toolName === 'write') {
      const rawPath = typeof event.input.path === 'string' ? event.input.path : '';
      if (!rawPath || event.isError) {
        return undefined;
      }
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
      // Fire-and-forget: formatting must not delay the tool result the model is waiting on.
      void runFormatLintHook(ctx.isProjectTrusted(), filePath, ctx.cwd);
      return undefined;
    }

    if (event.toolName !== 'bash') {
      return undefined;
    }

    const command = typeof event.input.command === 'string' ? event.input.command : '';
    if (!command.trim()) {
      return undefined;
    }

    const outputText = joinTextContent(event.content);
    const context = await collectPostBashContext(
      command,
      ctx.cwd,
      outputText,
      deriveBashExitCode(outputText, event.isError),
      ctx.isProjectTrusted(),
    );
    if (!context) {
      return undefined;
    }
    return { content: [...event.content, { type: 'text' as const, text: context }] };
  });

  pi.on('session_start', async (_event, ctx) => {
    await injectSessionContext(
      pi,
      ctx,
      join(GUARDS_DIRECTORY, 'machine-paths.mjs'),
      'guard-hooks-machine-paths',
    );
  });
}

export function canonicalNotifications(pi: ExtensionAPI): void {
  registerNotifications(pi, async (ctx) => {
    if (process.platform !== 'win32') {
      return;
    }
    const outcome = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NOTIFY_FLASH_BEEP_SCRIPT],
      undefined,
      NOTIFY_TIMEOUT_MILLISECONDS,
      ctx.cwd,
    );
    if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnErrorMessage) {
      warn(
        ctx,
        `${describeInfrastructureFailure('notification', outcome)}: ${truncateReason(outcome.stderr)}`,
      );
    }
  });
}
