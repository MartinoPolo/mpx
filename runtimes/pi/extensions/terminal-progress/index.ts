import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TerminalProgressController, type TerminalProgressDependencies } from './state.js';

const BLOCKED_EVENT = 'rpiv:ask-user:blocked';
const QUESTION_TOOLS = new Set(['ask_user_question', 'question', 'questionnaire']);

export function registerTerminalProgress(
  pi: ExtensionAPI,
  dependencies: TerminalProgressDependencies,
): void {
  let controller: TerminalProgressController | undefined;
  let unsubscribeBlocked: (() => void) | undefined;

  const dispose = () => {
    unsubscribeBlocked?.();
    unsubscribeBlocked = undefined;
    controller?.dispose();
    controller = undefined;
  };

  pi.on('session_start', (_event, ctx) => {
    dispose();
    if (ctx.mode !== 'tui') {
      return;
    }
    controller = new TerminalProgressController(dependencies);
    unsubscribeBlocked = pi.events.on(BLOCKED_EVENT, (payload) => {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'active' in payload &&
        typeof payload.active === 'boolean'
      ) {
        controller?.onBlocked(payload.active);
      }
    });
  });

  pi.on('agent_start', () => controller?.onAgentStart());
  pi.on('agent_settled', () => controller?.onAgentSettled());
  pi.on('tool_execution_start', (event) => {
    if (QUESTION_TOOLS.has(event.toolName)) {
      controller?.onQuestionStart(event.toolCallId);
    }
  });
  pi.on('tool_execution_end', (event) => controller?.onQuestionEnd(event.toolCallId));
  pi.on('session_shutdown', dispose);
}

export default function terminalProgressExtension(pi: ExtensionAPI): void {
  registerTerminalProgress(pi, {
    write: (sequence) => process.stdout.write(sequence),
  });
}
