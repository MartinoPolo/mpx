import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineRootContext, STYLE_REINFORCEMENT } from './context.js';
import { evaluateTool, editedPaths } from './safeguards/tools.js';
import { repositoryRoot } from './safeguards/fallow.js';
import { formatEditedFile } from './safeguards/format.js';

export interface ClaudeHookInput { hook_event_name: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> }
export interface ClaudeHookResult { code: number; stdout: string; stderr: string }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Claude native context/tool transport. PreCompact stdout is not an instruction channel. */
export async function handleClaudeHook(event: ClaudeHookInput, contentRoot = root, env = process.env): Promise<ClaudeHookResult> {
  const result: ClaudeHookResult = { code: 0, stdout: '', stderr: '' };
  const cwd = event.cwd ?? process.cwd();
  const currentRoot = await repositoryRoot(cwd);
  const isTrusted = (candidate: string) => currentRoot !== undefined && path.resolve(candidate) === path.resolve(currentRoot);
  if (event.hook_event_name === 'UserPromptSubmit') {
    result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: STYLE_REINFORCEMENT } });

  } else if (event.hook_event_name === 'SessionStart') {
    const roots = machineRootContext(env);
    try { result.stdout = await readFile(path.join(contentRoot, 'dist/claude/instructions/shared/AGENTS.md'), 'utf8'); }
    catch { result.stderr = 'MPX canonical instructions unavailable; native context retained.\n'; }
    try {
      const compact = await readFile(path.join(contentRoot, 'dist/claude/instructions/shared/COMPACT.md'), 'utf8');
      result.stdout += `\n\n## Conversation compaction only\nWhen native manual or automatic compaction occurs, apply the following guidance. User-supplied compaction instructions take precedence; preserve native summary behavior. These instructions do not request a summary during ordinary work.\n\n${compact}`;
    } catch { result.stderr += 'MPX compaction guidance unavailable; continuing with native compaction.\n'; }
    if (roots) result.stdout += `\n\n${roots}`;
  } else if (event.hook_event_name === 'PreToolUse') {
    const policy = await evaluateTool({ name: event.tool_name ?? '', input: event.tool_input ?? {}, cwd }, { isTrusted });
    if (policy.decision === 'block') {
      result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: policy.diagnostics.join('\n') } });
    } else if (policy.diagnostics.length) {
      result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: policy.diagnostics.join('\n') } });
      result.stderr = policy.diagnostics.join('\n');
    }
  } else if (event.hook_event_name === 'PostToolUse') {
    const files = editedPaths({ name: event.tool_name ?? '', input: event.tool_input ?? {}, cwd });
    const deadline = Date.now() + 4500;
    const diagnostics: string[] = [];
    for (const file of files) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { diagnostics.push('Formatting budget exhausted; remaining files require the explicit project command.'); break; }
      diagnostics.push(...(await formatEditedFile(file, cwd, { isTrusted, timeoutMs: remaining })).diagnostics);
    }
    if (diagnostics.length) result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: diagnostics.join('\n') } });
  }
  return result;
}

async function main(): Promise<void> {
  let input = ''; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) throw new Error('hook input exceeds limit');
    input += chunk;
  }
  const event = JSON.parse(input) as ClaudeHookInput;
  if (!event || typeof event !== 'object' || event.hook_event_name !== process.argv[2]) throw new Error('Hook event mismatch');
  const result = await handleClaudeHook(event);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Native event supplied separately by the owned registration, so malformed shell input fails closed.
    if (process.argv[2] === 'PreToolUse') { process.stderr.write('MPX safeguard infrastructure failed; affected tool invocation blocked.\n'); process.exitCode = 2; }
    else { process.stderr.write('MPX hook unavailable; native operation continues.\n'); process.exitCode = 0; }
  });
}
