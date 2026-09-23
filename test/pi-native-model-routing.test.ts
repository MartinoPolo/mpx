import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(root, 'node_modules/.pnpm/node_modules/jiti'));
const native = createJiti(import.meta.url);
const packageSource = path.join(root, 'node_modules/@tintinweb/pi-subagents/src');
const { resolveModel } = native(path.join(packageSource, 'model-resolver.ts'));
const { resolveDefaultModel, resumeAgent } = native(path.join(packageSource, 'agent-runner.ts'));
const { SubagentScheduler } = native(path.join(packageSource, 'schedule.ts'));

const models = [
  { provider: 'openai-codex', id: 'gpt-5.9-luna', name: 'GPT Luna', reasoning: true },
  { provider: 'openai-codex', id: 'gpt-5.10-luna', name: 'GPT Luna', reasoning: true },
  { provider: 'openai-codex', id: 'gpt-6-luna-preview', name: 'GPT Luna preview', reasoning: true },
  { provider: 'other', id: 'gpt-6-luna', name: 'GPT Luna', reasoning: true },
  { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT Sol', reasoning: true },
];
const registry = {
  find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
  getAvailable: () => models,
  getAll: () => models,
};

test('native resolution chooses numeric latest within the requested provider and strict family', () => {
  assert.equal(resolveModel('openai-codex/luna', registry), models[1]);
  assert.equal(resolveDefaultModel(models[4], registry, 'openai-codex/luna'), models[1]);
  assert.equal(resolveModel('openai-codex/sol', registry), models[4]);
  assert.match(resolveModel('openai-codex/terra', registry), /unavailable|not found/i);
  assert.throws(() => resolveDefaultModel(models[4], registry, 'openai-codex/terra'), /unavailable|not found/i);
});

test('provider-qualified family pins cannot cross providers or fuzzily match a different version', () => {
  assert.match(resolveModel('openai-codex/gpt-6-luna', registry), /unavailable|not found/i);
  assert.match(resolveModel('missing/gpt-6-luna', registry), /unavailable|not found/i);
  assert.throws(() => resolveDefaultModel(models[4], registry, 'openai-codex/gpt-6-luna'), /unavailable|not found/i);
  assert.equal(resolveDefaultModel(models[4], registry, 'unrelated/missing'), models[4]);
});

test('scheduled unavailable family reports an error instead of spawning a default model', () => {
  const events: Array<{ type: string; error?: string }> = [];
  let spawnCount = 0;
  const job: { id: string; name: string; enabled: boolean; model: string; subagent_type: string;
    prompt: string; scheduleType: string; intervalMs: number; lastStatus?: string } = {
    id: 'scheduled-luna', name: 'scheduled-luna', enabled: true, model: 'openai-codex/terra',
    subagent_type: 'Explore', prompt: 'probe', scheduleType: 'interval', intervalMs: 60_000 };
  const store = {
    list: () => [],
    get: () => job,
    update: (_id: string, patch: Record<string, unknown>) => Object.assign(job, patch),
  };
  const scheduler = new SubagentScheduler();
  scheduler.start({ events: { emit: (_name: string, event: { type: string; error?: string }) => events.push(event) } },
    { modelRegistry: registry }, { spawn: () => { spawnCount++; return 'unexpected'; }, awaitStartup: async () => {} }, store);
  try {
    scheduler.executeJob(job.id);
    assert.equal(spawnCount, 0);
    assert.equal(job.lastStatus, 'error');
    assert.equal(events[0]?.type, 'error');
    assert.match(events[0]?.error ?? '', /unavailable|not found/i);
  } finally {
    scheduler.stop();
  }
});

test('native resume floors Luna before the first request without changing the stored model', async () => {
  const storedModel = { ...models[1], thinkingLevelMap: { high: 'high' } };
  const session = {
    model: storedModel,
    thinkingLevel: 'low',
    messages: [],
    getAvailableThinkingLevels: () => ['low', 'high'],
    setThinkingLevel(level: string) { this.thinkingLevel = level; },
    subscribe: () => () => {},
    async prompt() {
      assert.equal(this.model, storedModel);
      assert.equal(this.thinkingLevel, 'high');
    },
  };
  await resumeAgent(session, 'continue');
  assert.equal(session.thinkingLevel, 'high');
  session.thinkingLevel = 'low';
  session.getAvailableThinkingLevels = () => ['low'];
  await assert.rejects(resumeAgent(session, 'continue'), /high thinking minimum/);
});
