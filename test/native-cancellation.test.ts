import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  type AgentSession as InstalledAgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionAPI,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

type AgentStreamFunction = InstalledAgentSession['agent']['streamFunction'];

const installedPackageRoot = resolve(
  dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  '..',
);

interface CancellationFixture {
  readonly session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  readonly observations: string[];
  readonly extensionErrors: string[];
  readonly publishChildResult: () => void;
  readonly getProviderRequests: () => number;
  readonly getHostAbortRequests: () => number;
  readonly waitForStreamStart: (requestNumber?: number) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

function assistantMessage(model: { readonly api: string; readonly provider: string; readonly id: string }, stopReason: 'stop' | 'aborted') {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: stopReason }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function createCancellationFixture(rejectAsyncHandler = false): Promise<CancellationFixture> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-cancellation-'));
  const cwd = join(root, 'project');
  const account = join(root, 'account');
  const observations: string[] = [];
  const extensionErrors: string[] = [];
  let recoveryArmed = true;
  let providerRequests = 0;
  let hostAbortRequests = 0;
  const streamStartWaiters = new Map<number, () => void>();
  const eventBus = createEventBus();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(account, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(account, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('native-cancellation-fixture', {
    api: 'openai-completions',
    apiKey: 'fixture-only',
    baseUrl: 'http://127.0.0.1:1',
    models: [{
      id: 'offline',
      name: 'Offline cancellation fixture',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1000,
    }],
  });
  const model = modelRuntime.getModel('native-cancellation-fixture', 'offline');
  assert.ok(model);

  const extension = (pi: ExtensionAPI) => {
    pi.on('session_abort', (_event, ctx) => {
      observations.push('session-abort');
      recoveryArmed = false;
      ctx.abort();
    });
    pi.on('session_abort', () => {
      throw new Error('fixture handler failure');
    });
    pi.on('session_abort', () => {
      observations.push('later-handler');
    });
    if (rejectAsyncHandler) {
      pi.on('session_abort', async () => {
        observations.push('async-handler-called');
        throw new Error('fixture async handler failure');
      });
    }
    pi.events.on('fixture-child-result', () => {
      observations.push(recoveryArmed ? 'child-result-armed' : 'child-result-disarmed');
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: account,
    settingsManager,
    eventBus,
    extensionFactories: [{ name: 'native-cancellation-fixture', factory: extension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const { session } = await createAgentSession({
    cwd,
    agentDir: account,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
  });
  const streamFunction: AgentStreamFunction = (streamModel, _context, options) => {
    providerRequests += 1;
    streamStartWaiters.get(providerRequests)?.();
    streamStartWaiters.delete(providerRequests);
    const stream = createAssistantMessageEventStream();
    const finish = () => {
      observations.push('native-signal');
      stream.push({ type: 'done', reason: 'stop', message: assistantMessage(streamModel, 'aborted') });
    };
    if (options?.signal?.aborted) finish();
    else options?.signal?.addEventListener('abort', finish, { once: true });
    return stream;
  };
  session.agent.streamFunction = streamFunction;
  await session.bindExtensions({
    abortHandler: () => { hostAbortRequests += 1; },
    onError: (error) => {
      extensionErrors.push(error.error);
      throw new Error('fixture diagnostic listener failure');
    },
  });

  return {
    session,
    observations,
    extensionErrors,
    publishChildResult: () => eventBus.emit('fixture-child-result', undefined),
    getProviderRequests: () => providerRequests,
    getHostAbortRequests: () => hostAbortRequests,
    waitForStreamStart: (requestNumber = 1) => providerRequests >= requestNumber
      ? Promise.resolve()
      : new Promise<void>((resolve) => { streamStartWaiters.set(requestNumber, resolve); }),
    dispose: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('idle public abort synchronously disarms recovery before a later child result', async () => {
  const fixture = await createCancellationFixture();
  try {
    const abort = fixture.session.abort();
    fixture.publishChildResult();
    assert.deepEqual(fixture.observations, ['session-abort', 'later-handler', 'child-result-disarmed']);
    await abort;
    assert.equal(fixture.getProviderRequests(), 0);
  } finally {
    await fixture.dispose();
  }
});

test('active public abort notifies extensions before native cancellation', async () => {
  const fixture = await createCancellationFixture();
  try {
    const prompt = fixture.session.prompt('start active cancellation');
    await fixture.waitForStreamStart();
    await fixture.session.abort();
    await prompt;
    assert.deepEqual(fixture.observations.slice(0, 3), ['session-abort', 'later-handler', 'native-signal']);
  } finally {
    await fixture.dispose();
  }
});

test('a second abort cancels a new run while the first abort waits for idle', async () => {
  const fixture = await createCancellationFixture();
  const originalWaitForIdle = fixture.session.waitForIdle.bind(fixture.session);
  let releaseFirstWait: () => void = () => undefined;
  const firstWaitGate = new Promise<void>((resolve) => { releaseFirstWait = resolve; });
  let waitCalls = 0;
  fixture.session.waitForIdle = async () => {
    await originalWaitForIdle();
    if (++waitCalls === 1) await firstWaitGate;
  };
  try {
    const firstPrompt = fixture.session.prompt('first run');
    await fixture.waitForStreamStart();
    const firstAbort = fixture.session.abort();
    await firstPrompt;
    const followUp = fixture.session.prompt('follow-up after cancellation');
    await fixture.waitForStreamStart(2);
    try {
      const secondAbort = fixture.session.abort();
      assert.equal(fixture.observations.filter((item) => item === 'session-abort').length, 2);
      assert.equal(fixture.observations.filter((item) => item === 'native-signal').length, 2);
      releaseFirstWait();
      await secondAbort;
      await firstAbort;
      await followUp;
    } finally {
      fixture.session.agent.abort();
      releaseFirstWait();
    }
  } finally {
    fixture.session.waitForIdle = originalWaitForIdle;
    await fixture.dispose();
  }
});

test('idle manual compaction retains native abort cleanup without notifying cancellation', async () => {
  const fixture = await createCancellationFixture();
  try {
    let nativeAbortCalls = 0;
    const originalAbort = fixture.session.agent.abort.bind(fixture.session.agent);
    fixture.session.agent.abort = () => { nativeAbortCalls += 1; originalAbort(); };
    await assert.rejects(fixture.session.compact(), /Nothing to compact/);
    assert.equal(nativeAbortCalls, 1);
    assert.equal(fixture.observations.includes('session-abort'), false);
  } finally {
    await fixture.dispose();
  }
});

test('manual compaction of an active run notifies cancellation and aborts the stream', async () => {
  const fixture = await createCancellationFixture();
  try {
    const prompt = fixture.session.prompt('active before manual compaction');
    await fixture.waitForStreamStart();
    await assert.rejects(fixture.session.compact(), /Nothing to compact/);
    await prompt;
    assert.deepEqual(fixture.observations.slice(0, 3), ['session-abort', 'later-handler', 'native-signal']);
  } finally {
    await fixture.dispose();
  }
});

test('reentrant handlers and throwing diagnostics neither duplicate nor prevent cancellation', async () => {
  const fixture = await createCancellationFixture();
  try {
    const prompt = fixture.session.prompt('start guarded cancellation');
    await fixture.waitForStreamStart();
    await fixture.session.abort();
    await prompt;
    assert.equal(fixture.observations.filter((item) => item === 'session-abort').length, 1);
    assert.equal(fixture.observations.filter((item) => item === 'native-signal').length, 1);
    assert.equal(fixture.getHostAbortRequests(), 0);
    assert.deepEqual(fixture.extensionErrors, ['fixture handler failure']);
  } finally {
    await fixture.dispose();
  }
});

test('rejected notification handlers are reported without blocking native cancellation', async () => {
  const fixture = await createCancellationFixture(true);
  try {
    const prompt = fixture.session.prompt('start asynchronous handler cancellation');
    await fixture.waitForStreamStart();
    await fixture.session.abort();
    await prompt;
    assert.deepEqual(fixture.observations.slice(0, 4), [
      'session-abort', 'later-handler', 'async-handler-called', 'native-signal',
    ]);
    assert.deepEqual(fixture.extensionErrors, ['fixture handler failure', 'fixture async handler failure']);
  } finally {
    await fixture.dispose();
  }
});

test('normal lifecycle completion does not emit cancellation intent', async () => {
  const fixture = await createCancellationFixture();
  try {
    const streamFunction: AgentStreamFunction = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistantMessage(model, 'stop') }));
      return stream;
    };
    fixture.session.agent.streamFunction = streamFunction;
    await fixture.session.prompt('complete normally');
    assert.equal(fixture.observations.includes('session-abort'), false);
  } finally {
    await fixture.dispose();
  }
});

test('an unclaimed idle Escape routes through public session abort', () => {
  const mode = Object.create(InteractiveMode.prototype) as {
    defaultEditor: { onEscape?: () => void; onAction: (name: string, handler: () => void) => void };
    ui: { onDebug?: () => void };
    editor: { getText: () => string; setText: (text: string) => void };
    runtimeHost: { session: {
      isStreaming: boolean;
      isBashRunning: boolean;
      abort: () => Promise<void>;
      abortBash: () => void;
      settingsManager: { getDoubleEscapeAction: () => 'none' };
    } };
    isBashMode: boolean;
    setupKeyHandlers: () => void;
  };
  let abortCount = 0;
  mode.defaultEditor = { onAction: () => undefined };
  mode.ui = {};
  mode.editor = { getText: () => '', setText: () => undefined };
  mode.runtimeHost = {
    session: {
      isStreaming: false,
      isBashRunning: false,
      abort: async () => { abortCount += 1; },
      abortBash: () => undefined,
      settingsManager: { getDoubleEscapeAction: () => 'none' },
    },
  };
  mode.isBashMode = false;

  mode.setupKeyHandlers();
  mode.defaultEditor.onEscape?.();

  assert.equal(abortCount, 1);
});

test('bundled CLI RPC abort notifies once while idle compaction stays silent', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-bundled-cancellation-'));
  const extension = join(root, 'cancellation.mjs');
  await writeFile(extension, `export default function (pi) {
    pi.on('session_abort', (_event, ctx) => {
      ctx.ui.notify('session-abort', 'info');
      ctx.abort();
    });
  }\n`);
  const child = spawn(process.execPath, [
    join(installedPackageRoot, 'dist', 'bundle', 'cli.js'), '--mode', 'rpc', '--no-session',
    '--no-extensions', '--extension', extension, '--no-skills', '--no-prompt-templates',
  ], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, 'account'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  let stdout = '';
  let stderr = '';
  let nextId = 0;
  const notifications: string[] = [];
  const pending = new Map<string, { resolve: (response: { success: boolean; error?: string }) => void; reject: (error: Error) => void }>();
  const deadline = setTimeout(() => {
    for (const request of pending.values()) request.reject(new Error(`Bundled RPC timed out: ${stderr}`));
    pending.clear();
    child.kill();
  }, 20_000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      const event = JSON.parse(line);
      if (event.type === 'extension_ui_request' && event.method === 'notify') notifications.push(event.message);
      if (event.type === 'response' && typeof event.id === 'string') {
        pending.get(event.id)?.resolve(event);
        pending.delete(event.id);
      }
      newline = stdout.indexOf('\n');
    }
  });
  child.on('error', (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  child.on('exit', (code) => {
    for (const request of pending.values()) request.reject(new Error(`Bundled RPC exited ${code}: ${stderr}`));
    pending.clear();
  });
  const command = (type: string) => {
    const id = String(++nextId);
    return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      if (child.exitCode !== null || child.killed) { reject(new Error(`Bundled RPC unavailable: ${stderr}`)); return; }
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, type }) + '\n', (error) => {
        if (error) { pending.delete(id); reject(error); }
      });
    });
  };
  try {
    assert.deepEqual(await command('abort'), { id: '1', type: 'response', command: 'abort', success: true });
    assert.deepEqual(notifications, ['session-abort']);
    const compact = await command('compact');
    assert.equal(compact.success, false);
    assert.match(compact.error ?? '', /Nothing to compact|No model/i);
    assert.deepEqual(notifications, ['session-abort']);
    assert.equal((await command('abort')).success, true);
    assert.deepEqual(notifications, ['session-abort', 'session-abort']);
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
