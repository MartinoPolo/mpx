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

interface WorktreeDependencies {
  environment?: NodeJS.ProcessEnv;
  prepare?: typeof prepareWorktree;
  forkSession?: typeof forkWorktreeSession;
}

const MANAGED_LAUNCH_MARKERS = [
  'MPX_RUNTIME',
  'MPX_RUNTIME_EXECUTOR',
  'MPX_RUNTIME_CONTEXT',
  'MPX_RUNTIME_CONTEXT_FILE',
  'MPX_RUNTIME_PROJECTION_REFERENCE',
  'MPX_SESSION_LIFECYCLE_BINDING_ID',
  'MPX_SESSION_LIFECYCLE_EVENT_DIR',
  'MPX_SESSION_LIFECYCLE_SEQUENCE',
  'MPX_SESSION_LIFECYCLE_START_FINGERPRINT',
] as const;

function hasManagedLaunchMarker(environment: NodeJS.ProcessEnv): boolean {
  return MANAGED_LAUNCH_MARKERS.some((name) => environment[name] !== undefined);
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

export default function (pi: ExtensionAPI, dependencies: WorktreeDependencies = {}): void {
  const environment = dependencies.environment ?? process.env;
  const prepare = dependencies.prepare ?? prepareWorktree;
  const forkSession = dependencies.forkSession ?? forkWorktreeSession;
  const managedLaunch = hasManagedLaunchMarker(environment);
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
    let continuation: string | undefined;
    try {
      ctx.ui.setStatus('worktree', 'Preparing worktree…');
      const outcome = await prepare(
        request,
        ctx.cwd,
        (command, args, options) => pi.exec(command, args, options),
        controller.signal,
      );
      target = outcome.path;
      controller.signal.throwIfAborted();
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        throw new Error('Pi became busy; retry with /worktree --enter and the created path.');
      }
      if (outcome.warning !== undefined) {
        ctx.ui.notify(outcome.warning, 'warning');
      }
      if (outcome.alreadyCurrent) {
        ctx.ui.notify(`Already in ${target}; continuing in this session.`, 'info');
        continuation = request.task;
      } else {
        if (managedLaunch) {
          throw new Error(
            `Managed MPX worktree handoff cannot safely switch to preserved destination ${target}. Start a fresh managed Pi launch in that destination; the source session remains active.`,
          );
        }
        destinationFile = forkSession(ctx, target);
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
    if (continuation !== undefined && !disposed && !controller.signal.aborted) {
      pi.sendUserMessage(continuation);
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
      'From a native-origin launch, switches this conversation into a new session there and continues the task after the current run settles. From a managed-origin launch, a cross-destination handoff is refused, preserving the source session and prepared checkout; start a fresh managed launch in the destination. If already in the requested checkout, continues in place. ' +
      'Call alone, never alongside other tools. Session replacement stops session-owned background agents and servers; collect their results first. ' +
      'Does not move uncommitted changes, commit, or delete worktrees. Main TUI/RPC sessions only.',
    promptSnippet:
      'Create or enter a worktree. Native-origin handoffs switch and continue automatically; managed-origin cross-destination handoffs require a fresh managed launch.',
    promptGuidelines: [
      'For main-session worktree isolation, use worktree before implementation rather than invoking workspace setup in bash. Supply the continuation task.',
      'Call worktree alone in its tool batch, then stop. Native-origin handoffs switch sessions and resume automatically; already-current requests continue in place. Managed-origin cross-destination handoffs are refused while preserving the source and prepared checkout, so start a fresh managed launch there. Do not keep editing the old checkout after a native switch.',
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
