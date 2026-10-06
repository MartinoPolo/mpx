import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleClaudeHook, type ClaudeHookInput, type ClaudeHookResult } from './claude-hooks.js';
import { machineRootContext } from './context.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Codex uses command for patches and cmd/workdir for raw unified-exec arguments. */
export function normalizeCodexHook(event: ClaudeHookInput): ClaudeHookInput {
  const input = { ...(event.tool_input ?? {}) };
  let name = event.tool_name;
  if (['exec_command', 'shell_command'].includes(name ?? '')) name = 'Bash';
  if (['apply_patch', 'ApplyPatch'].includes(name ?? '')) {
    input.patch ??= input.command ?? input.input;
  } else if (['Bash', 'bash', 'PowerShell', 'powershell'].includes(name ?? '')) {
    input.command ??= input.cmd;
  }
  const directory = input.workdir ?? input.cwd;
  return { ...event, tool_name: name, tool_input: input, cwd: typeof directory === 'string' ? path.resolve(event.cwd ?? process.cwd(), directory) : event.cwd };
}

export async function handleCodexHook(event: ClaudeHookInput, contentRoot = root, env = process.env): Promise<ClaudeHookResult> {
  if (event.hook_event_name !== 'SessionStart') return handleClaudeHook(normalizeCodexHook(event), contentRoot, env);
  const result: ClaudeHookResult = { code: 0, stdout: '', stderr: '' };
  const context: string[] = [];
  try {
    const compact = await readFile(path.join(contentRoot, 'content/instructions/shared/COMPACT.md'), 'utf8');
    context.push(`Conversation compaction only: apply this guidance during native manual or automatic compaction. User-supplied compaction instructions take precedence; preserve native summary behavior. These instructions do not request a summary during ordinary work.\n\n${compact}`);
  } catch { result.stderr = 'MPX compaction guidance unavailable; continuing with native compaction.\n'; }
  const roots = machineRootContext(env);
  if (roots) context.push(roots);
  if (context.length) result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n\n') } });
  return result;
}
