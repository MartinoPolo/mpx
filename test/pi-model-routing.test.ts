import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerPiModelRouting } from '../extensions/pi-model-routing.js';
import { enforceLunaThinking, piFamilyReference, resolvePiModelReference } from '../src/pi-model-routing.js';

const profiles = {
  mechanical: 'openai-codex/gpt-6-luna', exploration: 'openai-codex/gpt-6-luna', standard: 'openai-codex/gpt-6-luna',
  reviewer: 'openai-codex/gpt-6-sol', advanced: 'openai-codex/gpt-6-sol', frontier: 'openai-codex/astra',
};
const model = (provider: string, id: string, thinkingLevelMap?: Record<string, string | null>) => ({
  provider, id, name: id, api: 'openai-codex-responses' as const, baseUrl: 'http://fixture', reasoning: true,
  thinkingLevelMap, input: ['text'] as Array<'text' | 'image'>,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000,
});

test('family resolution compares numeric version components and excludes variants', () => {
  const available = [
    model('openai-codex', 'gpt-5.9-luna'), model('openai-codex', 'gpt-5.10-luna'),
    model('openai-codex', 'gpt-6-luna'), model('openai-codex', 'gpt-10-luna'),
    model('openai-codex', 'gpt-99-luna-preview'), model('openai-codex', 'gpt-100-luna-20260101'),
    model('other', 'gpt-999-luna'),
  ];
  assert.deepEqual(resolvePiModelReference('openai-codex/luna', profiles, available), {
    kind: 'resolved', family: 'luna', model: 'openai-codex/gpt-10-luna',
  });
  assert.deepEqual(resolvePiModelReference('mechanical', profiles, available), {
    kind: 'resolved', family: 'luna', model: 'openai-codex/gpt-6-luna',
  });
  assert.deepEqual(resolvePiModelReference('luna', profiles, available), {
    kind: 'resolved', family: 'luna', model: 'openai-codex/gpt-10-luna',
  });
});

test('exact family pins are preserved only when available from their provider', () => {
  const available = [model('openai-codex', 'gpt-5.10-sol'), model('other', 'gpt-5.10-sol')];
  assert.deepEqual(resolvePiModelReference('openai-codex/gpt-5.10-sol', profiles, available), {
    kind: 'resolved', family: 'sol', model: 'openai-codex/gpt-5.10-sol',
  });
  assert.equal(resolvePiModelReference('missing/gpt-5.10-sol', profiles, available).kind, 'error');
  assert.equal(resolvePiModelReference('openai-codex/sol', profiles, [model('other', 'gpt-10-sol')]).kind, 'error');
  assert.deepEqual(resolvePiModelReference('anthropic/sonnet', profiles, available), { kind: 'unrelated' });
});

test('recognized bare families fail when their provider is absent or ambiguous', () => {
  assert.equal(resolvePiModelReference('terra', profiles, []).kind, 'error');
  const ambiguous = { first: 'one/terra', second: 'two/terra' };
  assert.equal(resolvePiModelReference('terra', ambiguous, []).kind, 'error');
});

test('profile lookup ignores inherited prototype properties', () => {
  const inherited = Object.create({ mechanical: 'hostile/luna' }) as Record<string, string>;
  assert.equal(piFamilyReference('mechanical', inherited), undefined);
  assert.deepEqual(resolvePiModelReference('mechanical', inherited, [model('hostile', 'gpt-6-luna')]), { kind: 'unrelated' });
});

test('Luna thinking keeps supported levels and raises lower or omitted values', () => {
  assert.equal(enforceLunaThinking(undefined), 'high');
  assert.equal(enforceLunaThinking('low'), 'high');
  assert.equal(enforceLunaThinking('high'), 'high');
  assert.equal(enforceLunaThinking('xhigh'), 'xhigh');
  assert.equal(enforceLunaThinking('max'), 'max');
});

function extensionHarness(
  agents: Map<string, { model?: string; thinking?: string }> = new Map(),
  canRaiseThinking = true,
  parentModel = model('openai-codex', 'gpt-6-astra'),
) {
  const handlers = new Map<string, (event: any, context: ExtensionContext) => unknown>();
  let thinking = 'low';
  const pi = {
    on(name: string, handler: (event: any, context: ExtensionContext) => unknown) { handlers.set(name, handler); },
    getThinkingLevel() { return thinking; },
    setThinkingLevel(level: string) { if (canRaiseThinking) thinking = level; },
  } as unknown as ExtensionAPI;
  const available = [
    model('openai-codex', 'gpt-6-luna'), model('openai-codex', 'gpt-6-sol'),
    model('openai-codex', 'gpt-6-astra'), model('gateway', 'gpt-7-luna'),
  ];
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find(item => item.provider === provider && item.id === id),
  };
  registerPiModelRouting(pi, {
    profiles,
    loadCustomAgents: () => agents,
    resolveEnabledTypeIn: (registry, requested) => typeof requested === 'string' && registry.has(requested) ? requested : undefined,
    resolveModel: (input, registry) => {
      const tokens = input.toLowerCase().split(/[\s\-/]+/).filter(Boolean);
      return registry.getAvailable().find(item => tokens.every(token => item.id.toLowerCase().includes(token)
        || item.name.toLowerCase().includes(token) || item.provider.toLowerCase().includes(token))) ?? 'not found';
    },
  });
  let aborts = 0;
  const providerAbort = new AbortController();
  const notifications: string[] = [];
  const context = {
    cwd: 'C:/fixture', modelRegistry, model: parentModel, signal: providerAbort.signal,
    abort: () => { aborts++; providerAbort.abort(); },
    ui: { notify: (message: string) => { notifications.push(message); } },
  } as unknown as ExtensionContext;
  const call = (toolName: string, input: Record<string, unknown>) => handlers.get('tool_call')!({ toolName, input }, context);
  return { handlers, context, call, getThinking: () => thinking, getAborts: () => aborts, providerSignal: providerAbort.signal, notifications };
}

test('Agent hook resolves native config, honors explicit overrides, and applies Luna floor', () => {
  const agents = new Map([['worker', { model: 'mechanical', thinking: 'low' }]]);
  const harness = extensionHarness(agents);
  const declared: Record<string, unknown> = { subagent_type: 'worker', prompt: 'work' };
  assert.equal(harness.call('Agent', declared), undefined);
  assert.equal(declared.model, 'openai-codex/gpt-6-luna');
  assert.equal(declared.thinking, 'high');

  const explicit = { subagent_type: 'worker', prompt: 'work', model: 'reviewer', thinking: 'max' };
  harness.call('Agent', explicit);
  assert.equal(explicit.model, 'openai-codex/gpt-6-sol');
  assert.equal(explicit.thinking, 'max');
});

test('inherited and natively fuzzy Luna models receive the floor without rewriting unrelated model input', () => {
  const inherited = extensionHarness(new Map(), true, model('gateway', 'gpt-7-luna'));
  const noModel: Record<string, unknown> = { subagent_type: 'general-purpose', thinking: 'low' };
  inherited.call('Agent', noModel);
  assert.deepEqual(noModel, { subagent_type: 'general-purpose', thinking: 'high' });

  const fuzzy = extensionHarness();
  const fuzzyLuna: Record<string, unknown> = { subagent_type: 'general-purpose', model: 'GPT 6 Luna', thinking: 'low' };
  fuzzy.call('Agent', fuzzyLuna);
  assert.deepEqual(fuzzyLuna, { subagent_type: 'general-purpose', model: 'GPT 6 Luna', thinking: 'high' });
  const unrelated: Record<string, unknown> = { subagent_type: 'general-purpose', model: 'GPT 6 Sol', thinking: 'low' };
  fuzzy.call('Agent', unrelated);
  assert.deepEqual(unrelated, { subagent_type: 'general-purpose', model: 'GPT 6 Sol', thinking: 'low' });
});

test('project config is authoritative and names do not imply MPX routing', () => {
  const harness = extensionHarness(new Map([
    ['mpx-worker', { model: 'reviewer', thinking: 'medium' }],
    ['mpx-no-profile', {}],
  ]));
  const overridden: Record<string, unknown> = { subagent_type: 'mpx-worker' };
  harness.call('Agent', overridden);
  assert.equal(overridden.model, 'openai-codex/gpt-6-sol');
  assert.equal(overridden.thinking, undefined);
  const noProfile = { subagent_type: 'mpx-no-profile' };
  harness.call('Agent', noProfile);
  assert.deepEqual(noProfile, { subagent_type: 'mpx-no-profile' });
});

test('unavailable families block while unrelated tools and true resumes remain untouched', () => {
  const harness = extensionHarness(new Map([['worker', { model: 'openai-codex/terra' }], ['other', { model: 'anthropic/sonnet' }]]));
  const unavailable = { subagent_type: 'worker' };
  assert.deepEqual(harness.call('Agent', unavailable), { block: true, reason: 'No available openai-codex/terra model was found' });
  const unrelatedModel = { subagent_type: 'other' };
  assert.equal(harness.call('Agent', unrelatedModel), undefined);
  assert.deepEqual(unrelatedModel, { subagent_type: 'other' });
  const resumed = { subagent_type: 'worker', resume: 'stored-session' };
  harness.call('Agent', resumed);
  assert.deepEqual(resumed, { subagent_type: 'worker', resume: 'stored-session' });
  const emptyResume: Record<string, unknown> = { subagent_type: 'worker', resume: '' };
  assert.deepEqual(harness.call('Agent', emptyResume), { block: true, reason: 'No available openai-codex/terra model was found' });
  const read = { path: 'README.md' };
  harness.call('read', read);
  assert.deepEqual(read, { path: 'README.md' });
});

test('active Luna lifecycle applies across providers and guards the final provider payload', () => {
  const harness = extensionHarness();
  const lunaContext = { ...harness.context, model: model('gateway', 'gpt-7-luna') } as ExtensionContext;
  harness.handlers.get('session_start')!({ reason: 'resume' }, lunaContext);
  assert.equal(harness.getThinking(), 'high');
  const guarded = harness.handlers.get('before_provider_request')!({ payload: { reasoning: { effort: 'low', summary: 'auto' } } }, lunaContext);
  assert.deepEqual(guarded, { reasoning: { effort: 'high', summary: 'auto' } });
});

test('unsupported Luna high effort cancels the active provider signal without replacing its payload', () => {
  const incapableModel = model('gateway', 'gpt-7-luna', { high: null });
  const harness = extensionHarness(new Map(), false, incapableModel);
  assert.doesNotThrow(() => harness.handlers.get('before_agent_start')!({}, harness.context));
  const result = harness.handlers.get('before_provider_request')!({ payload: { reasoning: { effort: 'low' } } }, harness.context);
  assert.equal(result, undefined);
  assert.equal(harness.getAborts(), 1);
  assert.equal(harness.providerSignal.aborted, true);
  assert.deepEqual(harness.notifications, ['MPX blocked Luna below thinking level high']);
});
