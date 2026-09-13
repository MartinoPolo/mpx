import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { evaluateTool } from '../src/safeguards/tools.js';
import { repositoryRoot } from '../src/safeguards/fallow.js';

/** Thin native interception; project trust is never granted by MPX configuration. */
export default function piSafeguards(pi: ExtensionAPI): void {
  const warnings = new Map<string, string[]>();
  pi.on('session_start', () => { warnings.clear(); });
  pi.on('tool_call', async (event, ctx) => {
    const currentRoot = await repositoryRoot(ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    const last = branch.at(-1);
    const siblingCommands: string[] = [];
    if (last?.type === 'message' && last.message.role === 'assistant') {
      for (const part of last.message.content) if (part.type === 'toolCall' && part.id !== event.toolCallId && ['bash', 'powershell'].includes(part.name) && typeof part.arguments.command === 'string') siblingCommands.push(part.arguments.command);
    }
    const result = await evaluateTool({ name: event.toolName, input: event.input, cwd: ctx.cwd }, {
      siblingCommands,
      isTrusted: root => ctx.isProjectTrusted() && currentRoot !== undefined && path.resolve(root) === path.resolve(currentRoot),
    });
    if (result.decision === 'block') return { block: true, reason: result.diagnostics.join('\n') };
    if (result.diagnostics.length) {
      warnings.set(event.toolCallId, result.diagnostics);
      if (ctx.hasUI) ctx.ui.notify(result.diagnostics.join('\n'), 'warning');
      else process.stderr.write(`${result.diagnostics.join('\n')}\n`);
    }
    return undefined;
  });
  pi.on('tool_result', event => {
    const diagnostics = warnings.get(event.toolCallId); warnings.delete(event.toolCallId);
    if (diagnostics) return { content: [...event.content, { type: 'text' as const, text: diagnostics.join('\n') }] };
    return undefined;
  });
}
