import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  readonly waitForStreamStart: () => Promise<void>;
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

async function createCancellationFixture(): Promise<CancellationFixture> {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-native-cancellation-'));
  const cwd = join(root, 'project');
  const account = join(root, 'account');
  const observations: string[] = [];
  const extensionErrors: string[] = [];
  let recoveryArmed = true;
  let providerRequests = 0;
  let hostAbortRequests = 0;
  let streamStartedResolve: (() => void) | undefined;
  const streamStarted = new Promise<void>((resolve) => { streamStartedResolve = resolve; });
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
    streamStartedResolve?.();
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
    waitForStreamStart: () => streamStarted,
    dispose: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('idle public abort synchronously disarms recovery before a later child result', async () => {
  const fixture = await createCancellationFixture();
  try {
    await fixture.session.abort();
    fixture.publishChildResult();
    assert.deepEqual(fixture.observations, ['session-abort', 'later-handler', 'child-result-disarmed']);
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

test('the RPC abort command delegates to the same public session abort route', async () => {
  const rpcSource = await readFile(join(installedPackageRoot, 'dist', 'modes', 'rpc', 'rpc-mode.js'), 'utf8');
  assert.match(rpcSource, /case "abort": \{\s*await session\.abort\(\);\s*return success\(id, "abort"\);/);
});
