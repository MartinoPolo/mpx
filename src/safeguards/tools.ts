import type { PolicyResult } from './contracts.js';
import { evaluateDangerousCommand, isWindowsNulFileTarget } from './dangerous.js';
import { evaluatePackageManager } from './package-manager.js';
import { scanStagedSecrets } from './staged-secrets.js';
import { evaluateFallow, type FallowOptions } from './fallow.js';
import { gitInvocations } from './git-command.js';

export interface ToolInput { name: string; input: Record<string, unknown>; cwd: string }
const INDEX_MUTATIONS = new Set(['add', 'rm', 'mv', 'reset', 'restore', 'checkout', 'switch', 'update-index', 'read-tree', 'apply', 'stash', 'merge', 'cherry-pick', 'rebase']);
export function mutatesIndex(command: string, cwd: string): boolean {
  return gitInvocations(command, cwd).invocations.some(call => INDEX_MUTATIONS.has(call.operation)) || /(?:\.git[\\/]index|GIT_INDEX_FILE)\s*(?:=|[<>])/i.test(command);
}
export function editedPaths(tool: ToolInput): string[] {
  if (['write', 'edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
    const value = tool.input.path ?? tool.input.file_path ?? tool.input.notebook_path;
    return typeof value === 'string' ? [value.replace(/^@/, '')] : [];
  }
  if (['apply_patch', 'ApplyPatch'].includes(tool.name)) {
    const patch = tool.input.patch ?? tool.input.input;
    return typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)].map(match => match[1]!) : [];
  }
  return [];
}
export async function evaluateTool(tool: ToolInput, options: FallowOptions & { siblingCommands?: string[] }): Promise<PolicyResult> {
  for (const file of editedPaths(tool)) if (isWindowsNulFileTarget(file)) return { decision: 'block', diagnostics: ['Blocked literal Windows NUL file creation. Use a real filename or the shell-native null device.'] };
  if (!['bash', 'Bash', 'powershell', 'PowerShell'].includes(tool.name)) return { decision: 'allow', diagnostics: [] };
  const command = tool.input.command;
  if (typeof command !== 'string') return { decision: 'block', diagnostics: ['Dangerous-command inspection failed: shell command is missing.'] };
  const inspectedCommand = /powershell/i.test(tool.name) ? `powershell -Command ${JSON.stringify(command)}` : command;
  let danger: PolicyResult;
  try { danger = await evaluateDangerousCommand(inspectedCommand, tool.cwd); }
  catch { return { decision: 'block', diagnostics: ['Dangerous-command inspection failed; this shell invocation is blocked.'] }; }
  if (danger.decision === 'block') return danger;
  const results = [danger, await evaluatePackageManager(inspectedCommand, tool.cwd)];
  for (const commit of gitInvocations(command, tool.cwd).invocations.filter(call => call.operation === 'commit')) {
    if (mutatesIndex(command, tool.cwd) || options.siblingCommands?.some(sibling => mutatesIndex(sibling, tool.cwd)) || commit.args.some(arg => arg === '--all' || /^-[^-]*a/.test(arg) || ['--include', '--only', '-i', '-o'].includes(arg)) || commit.args.includes('--')) {
      results.push({ decision: 'block', diagnostics: ['Finish staging/index mutations in a separate completed tool call before git commit; commit the inspected index without -a/--include/--only.'] });
    } else if (!commit.cwd) results.push({ decision: 'warn', diagnostics: ['Staged-secret scan incomplete: commit directory is unresolved. Use a literal directory and retry the standalone scan; no clean verdict is claimed.'] });
    else results.push(await scanStagedSecrets(commit.cwd));
  }
  if (!results.some(result => result.decision === 'block')) results.push(await evaluateFallow(command, tool.cwd, options));
  return { decision: results.some(r => r.decision === 'block') ? 'block' : results.some(r => r.decision === 'warn') ? 'warn' : 'allow', diagnostics: [...new Set(results.flatMap(r => r.diagnostics))] };
}
