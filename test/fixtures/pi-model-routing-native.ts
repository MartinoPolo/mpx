import assert from 'node:assert/strict';
import { join } from 'node:path';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';

const options = JSON.parse(process.argv[2]!) as { cwd: string; account: string; extension: string; probe: string; cancellation?: boolean };
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
settings.setProjectTrusted(true);
const loader = new DefaultResourceLoader({
  cwd: options.cwd, agentDir: options.account, settingsManager: settings, noExtensions: true,
  additionalExtensionPaths: [options.extension, options.probe], noSkills: true, noContextFiles: true,
  noPromptTemplates: true, noThemes: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(options.account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
});
const modelDefinition = (id: string) => ({ id, name: id, reasoning: true, input: ['text'] as Array<'text' | 'image'>, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 });
runtime.registerProvider('openai-codex', {
  api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
  models: [modelDefinition('gpt-5.10-luna'),
    { ...modelDefinition('gpt-6-luna'), ...(options.cancellation ? { thinkingLevelMap: { high: null } } : {}) },
    modelDefinition('gpt-6-astra')],
});
const parentModel = runtime.getModel('openai-codex', options.cancellation ? 'gpt-6-luna' : 'gpt-6-astra');
assert.ok(parentModel);
const { session, extensionsResult } = await createAgentSession({
  cwd: options.cwd, agentDir: options.account, modelRuntime: runtime, model: parentModel,
  thinkingLevel: 'low', sessionManager: SessionManager.inMemory(options.cwd), settingsManager: settings, resourceLoader: loader,
});
assert.deepEqual(extensionsResult.errors, []);
if (options.cancellation) {
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = async () => {
    dispatched++;
    throw new Error('Unexpected provider network dispatch');
  };
  try {
    (globalThis as Record<string, unknown>).__mpxGetNativeSignal = () => session.agent.signal;
    await session.bindExtensions({ onError: error => { throw error; } });
    await session.prompt('cancel unsupported Luna request');
    assert.equal((globalThis as Record<string, unknown>).__mpxSameNativeSignal, true,
      'provider context must carry the native agent request signal');
    const providerSignal = (globalThis as Record<string, unknown>).__mpxProviderSignal;
    assert.ok(providerSignal instanceof AbortSignal, 'native provider hook did not run');
    assert.equal((globalThis as Record<string, unknown>).__mpxSignalAbortedInHook, true,
      'native request signal must be aborted inside the provider hook');
    assert.equal(providerSignal.aborted, true);
    assert.equal(dispatched, 0, 'provider request must be cancelled before network dispatch');
    console.log(JSON.stringify({ aborted: true, dispatched }));
  } finally {
    globalThis.fetch = originalFetch;
    session.dispose();
  }
  process.exit(0);
}
let request = 0;
const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
  role: 'assistant', content, api: parentModel.api, provider: parentModel.provider, model: parentModel.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now(),
});
session.agent.streamFunction = (() => {
  const response = request++ === 0
    ? message([{ type: 'toolCall', id: 'route', name: 'Agent', arguments: { subagent_type: 'project-worker', description: 'routing probe', prompt: 'probe' } }], 'toolUse')
    : message([{ type: 'text', text: 'done' }], 'stop');
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: response.stopReason as 'toolUse' | 'stop', message: response });
  return stream;
}) as typeof session.agent.streamFunction;
await session.bindExtensions({ onError: error => { throw error; } });
await session.prompt('route project agent');
console.log(JSON.stringify((globalThis as Record<string, unknown>).__mpxRoutingProbe));
session.dispose();
