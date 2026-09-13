import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiUiExtension } from '../extensions/pi-ui.js';
import type { UserConfig } from '../src/contracts.js';
import {
  PI_ACTIVITY_EVENT,
  PI_ACTIVITY_REQUEST_EVENT,
  PiActivityAggregate,
  applyThreeLineFullscreenWheel,
  fallbackTitle,
  finishedAgentFromLifecycle,
  formatFinishedAgent,
  mergeFinishedAgentToolResult,
  registerPiUi,
  shouldUseThreeLineWheel,
  type ActivityTiming,
  type PiActivitySnapshot,
} from '../src/pi-ui.js';

class FakeTiming implements ActivityTiming {
  pending: Array<{ active: boolean; callback: () => void }> = [];

  delay(callback: () => void): { cancel(): void } {
    const item = { active: true, callback };
    this.pending.push(item);
    return { cancel: () => { item.active = false; } };
  }

  flush(): void {
    for (const item of this.pending.splice(0)) if (item.active) item.callback();
  }
}

test('activity aggregate waits for main, children, background work, and follow-ups', () => {
  const timing = new FakeTiming();
  const states: PiActivitySnapshot[] = [];
  const aggregate = new PiActivityAggregate((state) => states.push({ ...state }), 500, timing);

  aggregate.startMain();
  aggregate.startChild('child-a');
  aggregate.setBackground('build', true);
  aggregate.setFollowUp('queued-review', true);
  aggregate.settleMain();
  aggregate.finishChild('child-a');
  aggregate.setBackground('build', false);

  assert.equal(states.at(-1)?.state, 'working');
  assert.equal(states.at(-1)?.pendingFollowUps, 1, 'explicit follow-up remains authoritative');
  assert.equal(states.some((state) => state.state === 'done'), false);

  aggregate.setFollowUp('queued-review', false);
  timing.flush();
  assert.equal(states.at(-1)?.state, 'done');
});

test('human-needed wins while work remains and child completion never emits a child done', () => {
  const timing = new FakeTiming();
  const states: PiActivitySnapshot[] = [];
  const aggregate = new PiActivityAggregate((state) => states.push({ ...state }), 500, timing);

  aggregate.startMain();
  aggregate.startChild('one');
  aggregate.startChild('two');
  aggregate.startHumanPrompt();
  assert.equal(states.at(-1)?.state, 'human-needed');

  aggregate.finishChild('one');
  assert.equal(states.at(-1)?.state, 'human-needed');
  aggregate.endHumanPrompt();
  assert.equal(states.at(-1)?.state, 'working');
  aggregate.finishChild('two');
  aggregate.settleMain();
  assert.equal(states.at(-1)?.settling, true);
  assert.equal(states.filter((state) => state.state === 'done').length, 0);

  // The upstream completion follow-up starts within the settle window.
  aggregate.startMain();
  timing.flush();
  assert.equal(states.at(-1)?.state, 'working');
  assert.equal(states.filter((state) => state.state === 'done').length, 0);
});

test('idempotent aggregate updates cannot restart settling or publish duplicate completion', () => {
  const timing = new FakeTiming();
  const states: PiActivitySnapshot[] = [];
  const aggregate = new PiActivityAggregate((state) => states.push({ ...state }), 500, timing);

  aggregate.startMain();
  aggregate.settleMain();
  timing.flush();
  const doneCount = states.filter(state => state.state === 'done').length;
  assert.equal(doneCount, 1);

  aggregate.settleMain();
  aggregate.finishChild('absent');
  aggregate.setFollowUp('absent', false);
  aggregate.setBackground('absent', false);
  aggregate.setExternallyBlocked(false);
  timing.flush();
  assert.equal(states.filter(state => state.state === 'done').length, doneCount);
  assert.equal(timing.pending.length, 0);

  aggregate.setBackground('build', true);
  const revision = aggregate.snapshot().revision;
  aggregate.setBackground('build', true);
  assert.equal(aggregate.snapshot().revision, revision);
  aggregate.setBackground('build', false);
  timing.flush();
  assert.equal(states.filter(state => state.state === 'done').length, doneCount + 1);
});

test('cancellation and reload reset do not masquerade as completion', () => {
  const timing = new FakeTiming();
  const states: PiActivitySnapshot[] = [];
  const aggregate = new PiActivityAggregate((state) => states.push({ ...state }), 500, timing);

  aggregate.startMain();
  aggregate.cancelMain();
  assert.equal(states.at(-1)?.state, 'cancelled');
  timing.flush();
  assert.equal(states.at(-1)?.state, 'cancelled');

  aggregate.reset();
  assert.equal(states.at(-1)?.state, 'idle');
  assert.equal(states.filter((state) => state.state === 'done').length, 0);
});

test('finished-agent lifecycle data stays unknown when upstream omits it', () => {
  const lifecycle = finishedAgentFromLifecycle({
    id: 'a1',
    type: 'Explore',
    status: 'completed',
    durationMs: 1_250,
    tokens: { input: 100, output: 20, total: 120 },
  });
  assert.deepEqual(lifecycle, {
    id: 'a1',
    type: 'Explore',
    status: 'completed',
    elapsedMs: 1_250,
    tokens: 120,
  });
  assert.match(formatFinishedAgent(lifecycle!), /model unknown · effort unknown/);
  assert.doesNotMatch(formatFinishedAgent(lifecycle!), /model .*gpt|tokens 0/);
});

test('public tool_result details enrich model and effective effort without replacing actual usage', () => {
  const merged = mergeFinishedAgentToolResult(
    {
      id: 'a1',
      type: 'Explore',
      status: 'completed',
      elapsedMs: 1_250,
      tokens: 120,
    },
    {
      agentId: 'a1',
      subagentType: 'Explore',
      status: 'completed',
      modelName: 'luna 5.6',
      tags: ['thinking: low', 'background'],
      durationMs: 1_300,
      tokens: '0 token',
    },
  );
  assert.deepEqual(merged, {
    id: 'a1',
    type: 'Explore',
    status: 'completed',
    model: 'luna 5.6',
    effort: 'low',
    elapsedMs: 1_300,
    tokens: 120,
  });
});

test('wheel override is Windows Terminal marker-only, with positive Orca precedence', () => {
  assert.equal(shouldUseThreeLineWheel({ WT_SESSION: 'wt' }), true);
  assert.equal(shouldUseThreeLineWheel({ WT_SESSION: 'wt', ORCA_PANE_KEY: 'tab:leaf' }), false);
  assert.equal(shouldUseThreeLineWheel({ TERM_PROGRAM: 'unknown' }), false);

  const fullscreen = { mode: 'fullscreen', wheelScrollLines: 1 };
  assert.equal(applyThreeLineFullscreenWheel(fullscreen), true);
  assert.equal(fullscreen.wheelScrollLines, 3);
  assert.equal(applyThreeLineFullscreenWheel({ mode: 'default', wheelScrollLines: 1 }), false);
});

test('prompt title fallback is bounded and deterministic', () => {
  assert.equal(fallbackTitle('  Implement **the** pi-ui footer, please!  '), 'Implement the pi-ui footer, please');
  assert.ok(fallbackTitle('word '.repeat(100)).length <= 80);
});

type Handler = (event: any, context: any) => unknown;

function extensionHarness(options: { titleResult?: () => Promise<string> } = {}) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  let sessionName: string | undefined;
  let footerFactory: any;
  const completedCalls: any[] = [];
  const model = { provider: 'openai-codex', id: 'gpt-5.6-luna', contextWindow: 272_000, reasoning: true };

  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    events: {
      on(name: string, handler: (payload: unknown) => void) {
        const listeners = bus.get(name) ?? new Set();
        listeners.add(handler);
        bus.set(name, listeners);
        return () => listeners.delete(handler);
      },
      emit(name: string, payload: unknown) {
        emitted.push({ name, payload });
        for (const listener of bus.get(name) ?? []) listener(payload);
      },
    },
    getSessionName: () => sessionName,
    setSessionName(name: string) {
      sessionName = name;
      void call('session_info_changed', { name });
    },
  } as unknown as ExtensionAPI;

  const entries: any[] = [];
  const ctx = {
    mode: 'tui',
    cwd: 'C:/repo/project',
    model,
    thinkingLevel: 'high',
    sessionManager: {
      getSessionId: () => 'session-12345678',
      getBranch: () => entries,
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getProvider: () => ({ streamSimple(_model: unknown, _context: unknown, streamOptions: unknown) {
        completedCalls.push(streamOptions);
        return { result: async () => ({
          content: [{
            type: 'text',
            text: options.titleResult ? await options.titleResult() : 'Build Pi Activity UI.',
          }],
        }) };
      } }),
    },
    getContextUsage: () => ({ tokens: 12_345, percent: 25, contextWindow: 50_000 }),
    ui: {
      setWidget() {},
      setFooter(factory: unknown) { footerFactory = factory; },
    },
  };

  async function call(name: string, event: unknown = {}, context: unknown = ctx): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  }

  return {
    pi,
    ctx,
    entries,
    emitted,
    completedCalls,
    call,
    emitBus(name: string, payload: unknown) { (pi as any).events.emit(name, payload); },
    footerFactory: () => footerFactory,
    sessionName: () => sessionName,
  };
}

const SUBAGENT_MANAGER_FIXTURE = Symbol.for('pi-subagents:manager');

type RegistryFixtureRecord = { status: string; resultConsumed?: boolean };

function installNativeRegistryFixture(records: Map<string, RegistryFixtureRecord>): () => void {
  // Fixture only: this stubs the documented in-process registry; no provider or child process runs.
  const global = globalThis as typeof globalThis & { [SUBAGENT_MANAGER_FIXTURE]?: unknown };
  const previous = global[SUBAGENT_MANAGER_FIXTURE];
  global[SUBAGENT_MANAGER_FIXTURE] = { getRecord: (id: string) => records.get(id) };
  return () => {
    if (previous === undefined) delete global[SUBAGENT_MANAGER_FIXTURE];
    else global[SUBAGENT_MANAGER_FIXTURE] = previous;
  };
}

function activityEvents(harness: ReturnType<typeof extensionHarness>): any[] {
  return harness.emitted
    .filter((event) => event.name === PI_ACTIVITY_EVENT)
    .map((event) => event.payload);
}

const pause = (milliseconds = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

test('extension uses the explicitly configured title model and effort, then preserves the name', async () => {
  const harness = extensionHarness();
  const configuredTitle: NonNullable<UserConfig['piTitle']> = {
    provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'low',
  };
  createPiUiExtension({
    title: configuredTitle,
    settleDelayMs: 0,
    environment: {},
  })(harness.pi);
  await harness.call('session_start');
  await harness.call('input', { source: 'interactive', text: 'Implement Pi UI', streamingBehavior: undefined });
  await harness.call('agent_start');
  await harness.call('agent_settled');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sessionName(), 'Build Pi Activity UI');
  assert.equal(harness.completedCalls.length, 1);
  assert.deepEqual(
    {
      reasoning: harness.completedCalls[0].reasoning,
      maxTokens: harness.completedCalls[0].maxTokens,
      maxRetries: harness.completedCalls[0].maxRetries,
      timeoutMs: harness.completedCalls[0].timeoutMs,
    },
    { reasoning: 'low', maxTokens: 96, maxRetries: 0, timeoutMs: 15_000 },
  );

  await harness.call('session_shutdown', { reason: 'quit' });
});

test('manual naming prevents automatic generation and an absent title config uses no fallback model', async () => {
  const manual = extensionHarness();
  registerPiUi(manual.pi, {
    title: { provider: 'openai-codex', model: 'gpt-5.6-luna', effort: 'low' },
    environment: {},
  });
  await manual.call('session_start');
  await manual.call('input', { source: 'interactive', text: 'Do not rename this', streamingBehavior: undefined });
  await manual.call('session_info_changed', { name: 'My manual title' });
  await manual.call('agent_settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manual.completedCalls.length, 0);
  await manual.call('session_shutdown', { reason: 'quit' });

  const fallback = extensionHarness();
  registerPiUi(fallback.pi, { environment: {} });
  await fallback.call('session_start');
  await fallback.call('input', { source: 'interactive', text: 'Fallback title from prompt', streamingBehavior: undefined });
  await fallback.call('agent_settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fallback.completedCalls.length, 0);
  assert.equal(fallback.sessionName(), 'Fallback title from prompt');
  await fallback.call('session_shutdown', { reason: 'quit' });

  const unavailable = extensionHarness();
  createPiUiExtension({
    title: { provider: 'openai-codex', model: 'unavailable-alias', thinking: 'low' },
    environment: {},
  })(unavailable.pi);
  await unavailable.call('session_start');
  await unavailable.call('input', { source: 'interactive', text: 'Missing model uses prompt', streamingBehavior: undefined });
  await unavailable.call('agent_settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unavailable.completedCalls.length, 0, 'an unavailable alias is not substituted');
  assert.equal(unavailable.sessionName(), 'Missing model uses prompt');
  await unavailable.call('session_shutdown', { reason: 'quit' });
});

test('a child-bound extension instance emits no aggregate activity or child alert', async () => {
  const root = extensionHarness();
  const child = extensionHarness();
  registerPiUi(root.pi, { environment: {} });
  registerPiUi(child.pi, { environment: {} });
  await root.call('session_start');
  await child.call('session_start');
  child.emitBus('subagents:started', { id: 'nested-child' });
  child.emitBus('subagents:completed', { id: 'nested-child', status: 'completed' });
  assert.equal(child.emitted.some((event) => event.name === PI_ACTIVITY_EVENT), false);
  await child.call('session_shutdown', { reason: 'quit' });
  await root.call('session_shutdown', { reason: 'quit' });
});

test('footer keeps native context/compaction visibility and finished rows, not running duplicates or help/ports', async () => {
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  harness.entries.push({ type: 'compaction', id: 'compact-1' });
  await harness.call('session_start');

  harness.emitBus('subagents:started', { id: 'agent-1', type: 'Explore' });
  const tui = { requestRender() {} };
  const footerData = {
    getGitBranch: () => 'feature/ui',
    onBranchChange: () => () => {},
  };
  const component = harness.footerFactory()(tui, {}, footerData);
  assert.equal(component.render(180).length, 1, 'running agents stay in the upstream live panel');

  harness.emitBus('subagents:completed', {
    id: 'agent-1', type: 'Explore', status: 'completed', durationMs: 2_000, tokens: { total: 321 },
  });
  await harness.call('tool_result', {
    toolName: 'get_subagent_result',
    details: {
      agentId: 'agent-1', subagentType: 'Explore', status: 'completed', modelName: 'luna 5.6',
      tags: ['thinking: low'], durationMs: 2_000,
    },
  });
  const rendered = component.render(180).join('\n');
  assert.match(rendered, /context 12\.3k \(25%\)/);
  assert.match(rendered, /compact 1/);
  assert.match(rendered, /Explore · model luna 5\.6 · effort low · elapsed 2\.0s · tokens 321/);
  assert.doesNotMatch(rendered, /port|Ctrl\+|Alt\+/i);

  assert.ok(harness.emitted.some((event) => event.name === PI_ACTIVITY_EVENT));
  await harness.call('session_shutdown', { reason: 'quit' });
});

test('native registry fixture holds an unconsumed result beyond settling and releases on result tool consumption', async () => {
  const records = new Map<string, RegistryFixtureRecord>([
    ['held', { status: 'running', resultConsumed: false }],
  ]);
  const restore = installNativeRegistryFixture(records);
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 5, environment: {} });
  try {
    await harness.call('session_start');
    harness.emitBus('subagents:started', { id: 'held' });
    records.set('held', { status: 'completed', resultConsumed: false });
    harness.emitBus('subagents:completed', { id: 'held', status: 'completed' });
    await pause(30);

    assert.equal(activityEvents(harness).at(-1)?.state, 'working');
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 1);
    assert.equal(activityEvents(harness).some(event => event.state === 'done'), false);

    records.get('held')!.resultConsumed = true;
    await harness.call('tool_result', {
      toolName: 'get_subagent_result',
      content: [{ type: 'text', text: 'native text result has no structured details' }],
      details: undefined,
    });
    await pause(10);
    assert.equal(activityEvents(harness).at(-1)?.state, 'done');
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0);
  } finally {
    await harness.call('session_shutdown', { reason: 'quit' });
    restore();
  }
});

test('native registry fixture handles pre-consumption and synchronous consume RPC refresh', async () => {
  const records = new Map<string, RegistryFixtureRecord>([
    ['pre', { status: 'completed', resultConsumed: true }],
    ['rpc', { status: 'running', resultConsumed: false }],
  ]);
  const restore = installNativeRegistryFixture(records);
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  (harness.pi as any).events.on('subagents:rpc:consume', (payload: unknown) => {
    const id = (payload as { agentId?: string }).agentId;
    if (id && records.has(id)) records.get(id)!.resultConsumed = true;
  });
  try {
    await harness.call('session_start');
    harness.emitBus('subagents:completed', { id: 'pre', status: 'completed' });
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0, 'consumed before completion is not reserved');

    harness.emitBus('subagents:started', { id: 'rpc' });
    records.set('rpc', { status: 'completed', resultConsumed: false });
    harness.emitBus('subagents:completed', { id: 'rpc', status: 'completed' });
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 1);
    harness.emitBus('subagents:rpc:consume', { agentId: 'rpc', requestId: 'fixture-request' });
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0);
  } finally {
    await harness.call('session_shutdown', { reason: 'quit' });
    restore();
  }
});

test('individual and grouped native notification message starts release only event-known results', async () => {
  const records = new Map<string, RegistryFixtureRecord>([
    ['one', { status: 'completed', resultConsumed: false }],
    ['two', { status: 'completed', resultConsumed: false }],
    ['three', { status: 'completed', resultConsumed: false }],
  ]);
  const restore = installNativeRegistryFixture(records);
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  try {
    await harness.call('session_start');
    for (const id of records.keys()) harness.emitBus('subagents:completed', { id, status: 'completed' });
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 3);

    await harness.call('message_start', {
      message: { role: 'custom', customType: 'subagent-notification', details: { id: 'one' } },
    });
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 2);
    await harness.call('message_start', {
      message: {
        role: 'custom', customType: 'subagent-notification',
        details: { id: 'two', others: [{ id: 'three' }, { id: 'not-event-known' }] },
      },
    });
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0);
  } finally {
    await harness.call('session_shutdown', { reason: 'quit' });
    restore();
  }
});

test('queued creation counts immediately, fast terminal creation does not resurrect, and restart clears reservation', async () => {
  const records = new Map<string, RegistryFixtureRecord>([
    ['race', { status: 'queued', resultConsumed: false }],
  ]);
  const restore = installNativeRegistryFixture(records);
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  try {
    await harness.call('session_start');
    harness.emitBus('subagents:created', { id: 'race' });
    assert.equal(activityEvents(harness).at(-1)?.activeChildren, 1);

    harness.emitBus('subagents:started', { id: 'race' });
    records.set('race', { status: 'completed', resultConsumed: false });
    harness.emitBus('subagents:completed', { id: 'race', status: 'completed' });
    harness.emitBus('subagents:created', { id: 'race' });
    assert.equal(activityEvents(harness).at(-1)?.activeChildren, 0, 'late created event is stale');
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 1);

    records.set('race', { status: 'running', resultConsumed: false });
    harness.emitBus('subagents:created', { id: 'race' });
    assert.equal(activityEvents(harness).at(-1)?.activeChildren, 1);
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0, 'new run drops old result reservation');
  } finally {
    await harness.call('session_shutdown', { reason: 'quit' });
    restore();
  }
});

test('cancellation survives held child delivery and automatic continuation until a fresh user turn', async () => {
  const records = new Map<string, RegistryFixtureRecord>([
    ['after-cancel', { status: 'running', resultConsumed: false }],
  ]);
  const restore = installNativeRegistryFixture(records);
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  try {
    await harness.call('session_start');
    await harness.call('before_agent_start', { prompt: 'first user turn' });
    await harness.call('agent_start');
    harness.emitBus('subagents:started', { id: 'after-cancel' });
    await harness.call('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    records.set('after-cancel', { status: 'completed', resultConsumed: false });
    harness.emitBus('subagents:completed', { id: 'after-cancel', status: 'completed' });
    assert.equal(activityEvents(harness).at(-1)?.state, 'working');
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 1);

    await harness.call('message_start', {
      message: { role: 'custom', customType: 'subagent-notification', details: { id: 'after-cancel' } },
    });
    assert.equal(activityEvents(harness).at(-1)?.state, 'cancelled');
    await harness.call('agent_start');
    await harness.call('agent_settled');
    assert.equal(activityEvents(harness).at(-1)?.state, 'cancelled', 'automatic follow-up cannot clear cancellation');

    await harness.call('before_agent_start', { prompt: 'new explicit user turn' });
    await harness.call('agent_start');
    await harness.call('agent_settled');
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.state, 'done');
  } finally {
    await harness.call('session_shutdown', { reason: 'quit' });
    restore();
  }
});

test('native settled clears queued input follow-ups processed inside the same agent loop', async () => {
  const harness = extensionHarness();
  harness.pi.setSessionName('Native queue fixture');
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  try {
    await harness.call('session_start');
    await harness.call('before_agent_start', { prompt: 'first' });
    assert.equal(activityEvents(harness).at(-1)?.mainActive, true, 'preparation already counts as work');
    await harness.call('agent_start');
    await harness.call('input', { source: 'interactive', text: 'queued input', streamingBehavior: 'followUp' });
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 1);
    await harness.call('agent_settled');
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0);
    assert.equal(activityEvents(harness).at(-1)?.state, 'done');
  } finally { await harness.call('session_shutdown'); }
});

test('duplicate terminal events cannot reserve an already delivered child again', async () => {
  const restore = installNativeRegistryFixture(new Map([['duplicate', { status: 'completed', resultConsumed: false }]]));
  const harness = extensionHarness();
  registerPiUi(harness.pi, { settleDelayMs: 0, environment: {} });
  try {
    await harness.call('session_start');
    harness.emitBus('subagents:completed', { id: 'duplicate', status: 'completed' });
    await harness.call('message_start', { message: { role: 'custom', customType: 'subagent-notification', details: { id: 'duplicate' } } });
    await pause();
    const count = activityEvents(harness).filter(s => s.state === 'done').length;
    harness.emitBus('subagents:completed', { id: 'duplicate', status: 'completed' });
    await pause();
    assert.equal(activityEvents(harness).at(-1)?.pendingFollowUps, 0);
    assert.equal(activityEvents(harness).filter(s => s.state === 'done').length, count);
  } finally { await harness.call('session_shutdown'); restore(); }
});

test('cancelled first turn does not start a fresh automatic title request', async () => {
  let requests = 0;
  const harness = extensionHarness({ titleResult: async () => { requests++; return 'Title'; } });
  registerPiUi(harness.pi, { title: { provider: 'openai-codex', model: 'gpt-5.6-luna', effort: 'low' }, environment: {} });
  try {
    await harness.call('session_start');
    await harness.call('input', { source: 'interactive', text: 'cancel before title' });
    await harness.call('before_agent_start', { prompt: 'cancel before title' });
    await harness.call('agent_start');
    await harness.call('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    await harness.call('agent_settled');
    await pause();
    assert.equal(requests, 0);
    assert.equal(activityEvents(harness).at(-1)?.state, 'cancelled');
  } finally { await harness.call('session_shutdown'); }
});

test('activity handshake carries native and ephemeral identities and stops answering after shutdown', async () => {
  const harness = extensionHarness();
  registerPiUi(harness.pi, { environment: {} });
  await harness.call('session_start');
  const initial = activityEvents(harness).at(-1);
  assert.equal(initial.sessionId, 'session-12345678');
  assert.match(initial.activityId, /^[0-9a-f-]{36}$/);

  const before = activityEvents(harness).length;
  harness.emitBus(PI_ACTIVITY_REQUEST_EVENT, { sessionId: 'ignored-request-hint' });
  const response = activityEvents(harness).at(-1);
  assert.equal(activityEvents(harness).length, before + 1);
  assert.deepEqual(response, initial);

  await harness.call('session_shutdown', { reason: 'quit' });
  const afterShutdown = activityEvents(harness).length;
  harness.emitBus(PI_ACTIVITY_REQUEST_EVENT, {});
  assert.equal(activityEvents(harness).length, afterShutdown);
});

test('same-session reload gives a new activity identity and stale title cleanup cannot clear the new slot', async () => {
  const resolvers: Array<(title: string) => void> = [];
  const harness = extensionHarness({
    titleResult: () => new Promise<string>(resolve => resolvers.push(resolve)),
  });
  registerPiUi(harness.pi, {
    title: { provider: 'openai-codex', model: 'gpt-5.6-luna', effort: 'low' },
    settleDelayMs: 0,
    environment: {},
  });
  await harness.call('session_start');
  const firstActivityId = activityEvents(harness).at(-1)?.activityId;
  await harness.call('input', { source: 'interactive', text: 'old title prompt' });
  await harness.call('agent_settled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 1);

  await harness.call('session_start');
  const secondActivityId = activityEvents(harness).at(-1)?.activityId;
  assert.notEqual(secondActivityId, firstActivityId);
  await harness.call('input', { source: 'interactive', text: 'new title prompt' });
  await harness.call('agent_settled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  assert.equal(activityEvents(harness).at(-1)?.backgroundWork, 1);

  resolvers[0]!('Stale Old Title');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activityEvents(harness).at(-1)?.backgroundWork, 1, 'old finally leaves the new aggregate alone');
  resolvers[1]!('Current New Title');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activityEvents(harness).at(-1)?.backgroundWork, 0);
  assert.equal(harness.sessionName(), 'Current New Title');
  await harness.call('session_shutdown', { reason: 'quit' });
});
