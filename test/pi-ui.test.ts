import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiUiExtension } from '../extensions/pi-ui.js';
import type { UserConfig } from '../src/contracts.js';
import {
  PI_ACTIVITY_EVENT,
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

function extensionHarness() {
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
      getProvider: () => ({ streamSimple(_model: unknown, _context: unknown, options: unknown) {
        completedCalls.push(options);
        return { result: async () => ({ content: [{ type: 'text', text: 'Build Pi Activity UI.' }] }) };
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
