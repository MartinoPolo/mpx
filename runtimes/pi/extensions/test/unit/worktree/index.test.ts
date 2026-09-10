import assert from 'node:assert/strict';
import path from 'node:path';
import { setImmediate as nextImmediate } from 'node:timers/promises';

import { test } from 'vitest';

import registerWorktree from '../../../worktree/index.js';

class FakePi {
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  handlers = new Map<string, any[]>();
  sentUserMessages: Array<{ message: string; options: unknown }> = [];
  sentMessages: unknown[] = [];
  registerCommand(name: string, definition: unknown) {
    this.commands.set(name, definition);
  }
  registerTool(definition: any) {
    this.tools.set(definition.name, definition);
  }
  on(event: string, handler: unknown) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  sendUserMessage(message: string, options: unknown) {
    this.sentUserMessages.push({ message, options });
  }
  sendMessage(message: unknown) {
    this.sentMessages.push(message);
  }
  execImplementation: (...args: any[]) => any = () => {
    throw new Error('not configured');
  };
  exec(...args: any[]) {
    return this.execImplementation(...args);
  }
}

function register(pi: FakePi, dependencies: Record<string, unknown> = {}) {
  registerWorktree(pi as never, { environment: {}, ...dependencies });
}

function context(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    cwd: process.cwd(),
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => path.resolve('saved-session.jsonl'),
      getSessionId: () => 'session-id',
      getBranch: () => [],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notifications,
      setStatus() {},
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    ...overrides,
  } as any;
}

test('extension registers one worktree command and tool with lifecycle handoff gates', () => {
  const pi = new FakePi();
  register(pi);

  assert.deepEqual([...pi.commands.keys()], ['worktree']);
  assert.deepEqual([...pi.tools.keys()], ['worktree']);
  assert.equal(JSON.stringify(pi.tools.get('worktree').parameters).includes('color'), false);
  assert.deepEqual([...pi.handlers.keys()].sort(), [
    'agent_settled',
    'input',
    'session_shutdown',
    'tool_call',
  ]);
});

test('tool handoff terminates the run and dispatches only after the agent settles', async () => {
  const pi = new FakePi();
  register(pi);
  const ctx = context();
  const result = await pi.tools
    .get('worktree')
    .execute(
      'call',
      { action: 'create', name: 'feature', task: 'continue' },
      new AbortController().signal,
      undefined,
      ctx,
    );

  assert.equal(result.terminate, true);
  assert.deepEqual(pi.handlers.get('tool_call')![0]({}, ctx), {
    block: true,
    terminate: true,
    reason: 'Worktree handoff pending. Do not execute tools in the old checkout.',
  });
  assert.equal(pi.sentUserMessages.length, 0);
  pi.handlers.get('agent_settled')![0]({}, ctx);
  await nextImmediate();
  assert.match(pi.sentUserMessages[0]!.message, /^\/worktree --handoff /u);
});

test('command already in the checkout resumes exactly once after releasing gates', async () => {
  const pi = new FakePi();
  register(pi);
  const cwd = process.cwd();
  let status: string | undefined;
  const ctx = context({
    cwd,
    switchSession: () => {
      throw new Error('must not switch');
    },
  });
  ctx.ui.setStatus = (_key: string, value: string | undefined) => {
    status = value;
  };
  pi.execImplementation = async (_command, args) => ({
    stdout: args.includes('--show-toplevel') ? cwd : path.join(cwd, '.git'),
    stderr: '',
    code: 0,
    killed: false,
  });
  const observations: Array<{ message: string; status: string | undefined; gate: unknown }> = [];
  pi.sendUserMessage = (message: string, options: unknown) => {
    observations.push({ message, status, gate: pi.handlers.get('tool_call')![0]({}, ctx) });
    pi.sentUserMessages.push({ message, options });
  };

  await pi.commands.get('worktree').handler('--enter . -- continue exactly', ctx);

  assert.deepEqual(observations, [
    { message: 'continue exactly', status: undefined, gate: undefined },
  ]);
  assert.match(ctx.ui.notifications.at(-1)!.message, /continuing in this session/u);
});

test('deferred tool no-op resumes once while no-task command only notifies', async () => {
  const pi = new FakePi();
  register(pi);
  const cwd = process.cwd();
  const ctx = context({ cwd, switchSession: () => assert.fail('must not switch') });
  pi.execImplementation = async (_command, args) => ({
    stdout: args.includes('--show-toplevel') ? cwd : path.join(cwd, '.git'),
    stderr: '',
    code: 0,
    killed: false,
  });
  await pi.tools
    .get('worktree')
    .execute(
      'call',
      { action: 'enter', path: '.', task: 'deferred continuation' },
      undefined,
      undefined,
      ctx,
    );
  pi.handlers.get('agent_settled')![0]({}, ctx);
  await nextImmediate();
  const handoff = pi.sentUserMessages[0]!.message;
  await pi.commands.get('worktree').handler(handoff.slice('/worktree '.length), ctx);
  assert.deepEqual(
    pi.sentUserMessages.map(({ message }) => message),
    [handoff, 'deferred continuation'],
  );

  await pi.commands.get('worktree').handler('--enter .', ctx);
  assert.equal(pi.sentUserMessages.length, 2);
});

test.each(['cancel', 'shutdown', 'pending-message'])(
  '%s during preparation never resumes the task',
  async (interruption) => {
    const pi = new FakePi();
    register(pi);
    const ctx = context();
    pi.execImplementation = async (_command, args) => {
      if (interruption === 'cancel') {
        await pi.commands.get('worktree').handler('cancel', ctx);
      } else if (interruption === 'shutdown') {
        pi.handlers.get('session_shutdown')![0]();
      } else {
        ctx.hasPendingMessages = () => true;
      }
      return {
        stdout: args.includes('--show-toplevel') ? ctx.cwd : path.join(ctx.cwd, '.git'),
        stderr: '',
        code: 0,
        killed: false,
      };
    };

    const handoff = pi.commands.get('worktree').handler('--enter . -- must not run', ctx);
    if (interruption === 'shutdown') {
      await assert.rejects(handoff);
    } else {
      await handoff;
    }
    assert.equal(pi.sentUserMessages.length, 0);
    assert.equal(pi.handlers.get('tool_call')![0]({}, ctx), undefined);
  },
);

test('a genuine preparation failure reports an error and never runs the task in place', async () => {
  const pi = new FakePi();
  register(pi);
  const ctx = context();
  pi.execImplementation = async () => ({
    stdout: '',
    stderr: 'not a repository',
    code: 128,
    killed: false,
  });

  await pi.commands.get('worktree').handler('--enter . -- must not run', ctx);

  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.match(JSON.stringify(pi.sentMessages[0]), /Execution failed/u);
});

test.each([
  ['valid managed launch', { MPX_RUNTIME: 'pi', MPX_RUNTIME_CONTEXT: '{}' }],
  ['partial malformed managed launch', { MPX_RUNTIME_CONTEXT: '{' }],
])('%s refuses a cross-root switch without forking or continuing', async (_name, environment) => {
  const pi = new FakePi();
  const target = path.resolve('prepared-worktree');
  let forkCalls = 0;
  let switchCalls = 0;
  registerWorktree(pi as never, {
    environment,
    prepare: async () => ({ path: target, alreadyCurrent: false }),
    forkSession: () => {
      forkCalls += 1;
      return path.resolve('replacement.jsonl');
    },
  });
  const ctx = context({
    switchSession: async () => {
      switchCalls += 1;
      return { cancelled: false };
    },
  });

  await pi.commands.get('worktree').handler('--enter prepared-worktree -- must not run', ctx);

  assert.equal(forkCalls, 0);
  assert.equal(switchCalls, 0);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(JSON.stringify(pi.sentMessages), /fresh managed Pi launch/u);
  assert.equal(JSON.stringify(pi.sentMessages).includes(JSON.stringify(target).slice(1, -1)), true);
  assert.equal(pi.handlers.get('tool_call')![0]({}, ctx), undefined);
});

test('native-origin cross-root handoff keeps native fork, switch, and task path', async () => {
  const pi = new FakePi();
  const target = path.resolve('native-worktree');
  let forkTarget: string | undefined;
  let replacementTask: string | undefined;
  register(pi, {
    prepare: async () => ({ path: target, alreadyCurrent: false }),
    forkSession: (_ctx: unknown, destination: string) => {
      forkTarget = destination;
      return path.resolve('replacement.jsonl');
    },
  });
  const ctx = context({
    switchSession: async (_file: string, options: any) => {
      await options.withSession({
        sendUserMessage: async (task: string) => {
          replacementTask = task;
        },
      });
      return { cancelled: false };
    },
  });

  await pi.commands.get('worktree').handler('--enter native-worktree -- continue natively', ctx);

  assert.equal(forkTarget, target);
  assert.equal(replacementTask, 'continue natively');
  assert.equal(pi.sentMessages.length, 0);
});

test('new user input cancels pending worktree use instead of auto-creating', async () => {
  const pi = new FakePi();
  register(pi);
  const ctx = context();
  await pi.tools
    .get('worktree')
    .execute(
      'call',
      { action: 'create', name: 'feature', task: 'continue' },
      undefined,
      undefined,
      ctx,
    );
  pi.handlers.get('agent_settled')![0]({}, ctx);
  const outcome = pi.handlers.get('input')![0]({ source: 'interactive' }, ctx);
  await nextImmediate();

  assert.equal(outcome, undefined);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.match(ctx.ui.notifications.at(-1)!.message, /cancelled by your new message/u);
});

test('worktree is unavailable outside a saved main TUI or RPC session', async () => {
  const pi = new FakePi();
  register(pi);
  await assert.rejects(
    pi.tools
      .get('worktree')
      .execute(
        'call',
        { action: 'enter', path: '.', task: 'continue' },
        undefined,
        undefined,
        context({ mode: 'print' }),
      ),
    /main sessions/u,
  );
});
