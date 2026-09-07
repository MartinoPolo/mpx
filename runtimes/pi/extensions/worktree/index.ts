import { randomUUID } from 'node:crypto';

import { StringEnum, Type } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  COMMAND_USAGE,
  parseCommand,
  prepareWorktree,
  validateRequest,
  type WorktreeRequest,
} from './operations.js';
import { forkWorktreeSession } from './session.js';

interface PendingHandoff {
  id: string;
  sessionId: string;
  request: WorktreeRequest;
  signal?: AbortSignal;
}

function requireSession(ctx: ExtensionContext): void {
  if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') {
    throw new Error(
      'Worktree handoff is for interactive or RPC main sessions. Use Agent isolation for subagents.',
    );
  }
  if (!ctx.sessionManager.getSessionFile()) {
    throw new Error('Worktree handoff requires a saved session; --no-session is not supported.');
  }
}

export default function (pi: ExtensionAPI): void {
  let pending: PendingHandoff | undefined;
  let dispatch: ReturnType<typeof setImmediate> | undefined;
  let preparation: AbortController | undefined;
  let busy = false;
  let disposed = false;

  function cancel(): void {
    pending = undefined;
    if (dispatch !== undefined) {
      clearImmediate(dispatch);
    }
    dispatch = undefined;
    preparation?.abort();
  }

  async function handoff(request: WorktreeRequest, ctx: ExtensionCommandContext): Promise<void> {
    requireSession(ctx);
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      throw new Error('Wait for Pi to finish, or stop it before using /worktree.');
    }
    if (busy) {
      throw new Error('A worktree handoff is already running. Use /worktree cancel to cancel it.');
    }
    busy = true;
    const controller = new AbortController();
    preparation = controller;
    let target: string | undefined;
    let destinationFile: string | undefined;
    try {
      ctx.ui.setStatus('worktree', 'Preparing worktree…');
      target = await prepareWorktree(
        request,
        ctx.cwd,
        (command, args, options) => pi.exec(command, args, options),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        throw new Error('Pi became busy; retry with /worktree --enter and the created path.');
      }
      destinationFile = forkWorktreeSession(ctx, target);
      const task = request.task;
      ctx.ui.notify(`Entering ${target}`, 'info');
      const result = await ctx.switchSession(destinationFile, {
        withSession: async (replacement) => {
          if (task !== undefined) {
            await replacement.sendUserMessage(task);
          }
        },
      });
      if (result.cancelled) {
        ctx.ui.notify(
          `Session switch cancelled. Worktree preserved at ${target}. Resume with /worktree --enter "${target}".`,
          'warning',
        );
      }
    } catch (error) {
      const reason =
        controller.signal.aborted && !disposed
          ? 'Worktree handoff cancelled.'
          : error instanceof Error
            ? error.message
            : String(error);
      const recovery =
        target === undefined
          ? 'If creation partially succeeded, inspect git worktree list and use /worktree --enter <path>; no worktrees or branches were removed.'
          : `Worktree preserved at ${target}.${destinationFile ? ` Replacement session: ${destinationFile}.` : ''}`;
      if (disposed) {
        throw error;
      }
      pi.sendMessage({
        customType: 'worktree-error',
        content: `${reason}\n${recovery}`,
        display: true,
      });
    } finally {
      busy = false;
      preparation = undefined;
      if (!disposed) {
        ctx.ui.setStatus('worktree', undefined);
      }
    }
  }

  pi.registerCommand('worktree', {
    description:
      'Create and enter a Worktree Hub checkout, or enter an existing worktree, preserving conversation history',
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text === 'cancel') {
        cancel();
        ctx.ui.setStatus('worktree', undefined);
        ctx.ui.notify('Worktree handoff cancelled; any created worktree is preserved.', 'info');
        return;
      }
      if (!text || text === '--help') {
        ctx.ui.notify(
          `Current working directory: ${ctx.cwd}\n${COMMAND_USAGE}\n/worktree cancel`,
          'info',
        );
        return;
      }
      if (text.startsWith('--handoff ')) {
        const request = pending;
        if (
          !request ||
          request.id !== text.slice('--handoff '.length) ||
          request.sessionId !== ctx.sessionManager.getSessionId()
        ) {
          throw new Error('This worktree handoff is no longer pending.');
        }
        pending = undefined;
        if (request.signal?.aborted) {
          ctx.ui.setStatus('worktree', undefined);
          return;
        }
        await handoff(request.request, ctx);
        return;
      }
      if (pending) {
        throw new Error('A worktree handoff is already pending. Use /worktree cancel first.');
      }
      await handoff(parseCommand(text), ctx);
    },
  });

  pi.registerTool({
    name: 'worktree',
    label: 'Worktree handoff',
    description:
      'Create a checkout through the MPX workspace Hub (default base: current HEAD), or enter an existing worktree of this repository. ' +
      'Forks this conversation into a new session in that checkout and automatically continues task after the current run settles. ' +
      'Call alone, never alongside other tools. Session replacement stops session-owned background agents and servers; collect their results first. ' +
      'Does not move uncommitted changes, commit, or delete worktrees. Main TUI/RPC sessions only.',
    promptSnippet: 'Create or enter a worktree and continue this conversation there automatically.',
    promptGuidelines: [
      'For main-session worktree isolation, use worktree before implementation rather than invoking workspace setup in bash. Supply the continuation task.',
      'Call worktree alone in its tool batch, then stop: the extension switches sessions and resumes task automatically. Do not keep editing the old checkout.',
      'Use Agent isolation for subagents; worktree changes the main session, not a child agent.',
    ],
    parameters: Type.Object(
      {
        action: StringEnum(['create', 'enter'], {
          description: 'Create a new worktree or enter an existing one.',
        }),
        name: Type.Optional(
          Type.String({
            description: 'New Git branch name for create; Worktree Hub chooses the directory.',
          }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              'Existing worktree root for enter; relative to the current session directory or absolute.',
          }),
        ),
        base: Type.Optional(
          Type.String({
            description:
              'Base ref for create. Defaults to HEAD, preserving the branch you started from.',
          }),
        ),
        task: Type.String({
          minLength: 1,
          description:
            'Task to execute automatically after the session moves. Include relevant constraints and next steps.',
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      requireSession(ctx);
      signal?.throwIfAborted();
      if (pending || busy) {
        throw new Error('A worktree handoff is already pending or running.');
      }
      const request = validateRequest(params as WorktreeRequest);
      pending = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), request, signal };
      ctx.ui.setStatus('worktree', 'Worktree handoff pending…');
      return {
        content: [
          {
            type: 'text',
            text: 'Worktree handoff requested. Stop here; Pi will create/validate the checkout, switch sessions, and continue the supplied task after this run settles.',
          },
        ],
        details: { request },
        terminate: true,
      };
    },
  });

  pi.on('tool_call', (_event, ctx) => {
    const assistant = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    if (assistant?.type === 'message' && assistant.message.role === 'assistant') {
      const calls = assistant.message.content.filter((block) => block.type === 'toolCall');
      if (calls.length > 1 && calls.some((call) => call.name === 'worktree')) {
        return {
          block: true,
          reason:
            "Call worktree alone, not in a parallel tool batch. None of this batch's tools may run; retry worktree by itself.",
        };
      }
    }
    if (pending || busy) {
      return {
        block: true,
        terminate: true,
        reason: 'Worktree handoff pending. Do not execute tools in the old checkout.',
      };
    }
  });

  pi.on('input', (event, ctx) => {
    if (busy) {
      ctx.ui.notify(
        'Worktree setup is running. Wait for the switch, or use /worktree cancel.',
        'warning',
      );
      return { action: 'handled' };
    }
    if (pending && event.source !== 'extension') {
      cancel();
      ctx.ui.setStatus('worktree', undefined);
      ctx.ui.notify('Pending worktree handoff cancelled by your new message.', 'info');
    }
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!pending || dispatch !== undefined) {
      return;
    }
    // Command dispatch is immediate even with deliverAs: followUp; leave the event drain before replacing its runtime.
    dispatch = setImmediate(() => {
      dispatch = undefined;
      if (disposed || !pending || !ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }
      if (pending.signal?.aborted) {
        pending = undefined;
        ctx.ui.setStatus('worktree', undefined);
        return;
      }
      pi.sendUserMessage(`/worktree --handoff ${pending.id}`, { expandPromptTemplates: true });
    });
  });

  pi.on('session_shutdown', () => {
    disposed = true;
    cancel();
  });
}
