import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineRootContext, STYLE_REINFORCEMENT } from './context.js';
import { evaluateTool, editedPaths } from './safeguards/tools.js';
import { repositoryRoot } from './safeguards/fallow.js';
import { formatEditedFile } from './safeguards/format.js';
import { checkClaudeStop, claudeLedgerContext, HITL_LEDGER_DIRECTORY, type ClaudeRunEvent } from './hitl-ledger.js';
import { CLAUDE_UNFINISHED_PROMPT, saveUnfinished } from './unfinished-command.js';
import { missingClaudePackWarning } from './claude-pack-presence.js';

export interface ClaudeHookInput extends ClaudeRunEvent { hook_event_name: string; source?: string; cwd?: string; transcript_path?: string; tool_name?: string; tool_input?: Record<string, unknown> }
export interface ClaudeHookResult { code: number; stdout: string; stderr: string }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Counters the native post-summary footer that says to continue without asking, which would skip open questions.
export const POST_COMPACTION_RESTART = 'Context was just compacted. Before continuing, re-read the plan, state, and critical files the summary names, and check in-flight work by its IDs. If the summary lists open questions or pending approvals, wait for the user instead of continuing past them.';
/** Claude native context/tool transport. Claude appends PreCompact stdout to the summarizer instructions, after any `/compact` arguments. */
export async function handleClaudeHook(event: ClaudeHookInput, contentRoot = root, env = process.env, ledgerDirectory = HITL_LEDGER_DIRECTORY): Promise<ClaudeHookResult> {
  const result: ClaudeHookResult = { code: 0, stdout: '', stderr: '' };
  if (event.hook_event_name === 'Stop') {
    const reason = await checkClaudeStop(event, ledgerDirectory);
    if (reason) result.stdout = JSON.stringify({ decision: 'block', reason });
    return result;
  }
  const cwd = event.cwd ?? process.cwd();
  const unfinished = event.hook_event_name === 'UserPromptSubmit' && event.session_id ? event.prompt?.trim().match(CLAUDE_UNFINISHED_PROMPT) : null;
  if (unfinished && event.session_id) {
    // Blocking the prompt shows the reason to the user and spends no model turn.
    const reason = await saveUnfinished({ sessionId: event.session_id, cwd, argument: unfinished[1] ?? '', transcriptPath: event.transcript_path, env });
    result.stdout = JSON.stringify({ decision: 'block', reason });
    return result;
  }
  const currentRoot = await repositoryRoot(cwd);
  const isTrusted = (candidate: string) => currentRoot !== undefined && path.resolve(candidate) === path.resolve(currentRoot);
  if (event.hook_event_name === 'UserPromptSubmit') {
    const ledgerContext = await claudeLedgerContext(event, ledgerDirectory);
    result.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ledgerContext ? `${STYLE_REINFORCEMENT}\n\n${ledgerContext}` : STYLE_REINFORCEMENT } });

  } else if (event.hook_event_name === 'PreCompact') {
    try {
      result.stdout = (await readFile(path.join(contentRoot, 'dist/claude/instructions/shared/COMPACT.md'), 'utf8')).trim();
    } catch { result.stderr = 'MPX compaction guidance unavailable; continuing with native compaction.\n'; }
  } else if (event.hook_event_name === 'SessionStart') {
    const restart = event.source === 'compact' ? POST_COMPACTION_RESTART : undefined;
    const packWarning = await missingClaudePackWarning({ root: contentRoot, cwd, env, transcriptPath: event.transcript_path })
      .catch(() => { result.stderr = 'MPX pack check failed; MPX skills may be missing from this session.\n'; return undefined; });
    const context = [packWarning, restart, machineRootContext(env)].filter(Boolean).join('\n\n');
    // Plain stdout reaches only the model; systemMessage also shows the warning to the user.
    result.stdout = packWarning ? JSON.stringify({ systemMessage: packWarning, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) : context;
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
