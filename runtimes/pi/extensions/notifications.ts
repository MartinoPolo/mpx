import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export function registerNotifications(
  pi: ExtensionAPI,
  notify: (context: ExtensionContext) => Promise<void>,
): void {
  let armed = false;
  let running = false;
  let aborted = false;
  let pending: ReturnType<typeof setImmediate> | undefined;

  const isMainUI = (context: ExtensionContext) =>
    context.hasUI && (context.mode === 'tui' || context.mode === 'rpc');

  const cancelPending = () => {
    if (pending) {
      clearImmediate(pending);
    }
    pending = undefined;
  };

  const reset = () => {
    cancelPending();
    armed = false;
    running = false;
    aborted = false;
  };

  pi.on('session_start', reset);
  pi.on('session_shutdown', reset);
  pi.on('input', (event, context) => {
    if (isMainUI(context) && event.source !== 'extension') {
      cancelPending();
      armed = true;
    }
  });
  pi.on('agent_start', () => {
    cancelPending();
    running = true;
    aborted = false;
  });
  pi.on('message_end', (event) => {
    if (event.message.role === 'assistant') {
      aborted = event.message.stopReason === 'aborted';
    }
  });
  pi.on('ui_prompt_start', (_event, context) => {
    if (isMainUI(context) && running) {
      void notify(context);
    }
  });
  pi.on('agent_settled', (_event, context) => {
    running = false;
    cancelPending();
    if (!isMainUI(context) || !armed) {
      return;
    }
    // Later settled handlers can enqueue a subagent-result continuation.
    pending = setImmediate(() => {
      pending = undefined;
      if (!context.isIdle() || context.hasPendingMessages()) {
        return;
      }
      armed = false;
      if (!aborted) {
        void notify(context);
      }
    });
  });
}
