import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { planResume, readPiSession } from '../../src/resume.js';

const options = JSON.parse(process.argv[2]!) as { cwd: string; account: string; sessionDir: string };
globalThis.fetch = async () => { throw new Error('Unexpected network request in native-resume fixture'); };
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
settings.setProjectTrusted(true);
settings.setDefaultModelAndProvider('native-fixture', 'model-a');
settings.setDefaultThinkingLevel('low');
const loader = new DefaultResourceLoader({
  cwd: options.cwd, agentDir: options.account, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await ModelRuntime.create({
  authPath: join(options.account, 'auth.json'), modelsPath: null,
  modelsStorePath: join(options.account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
});
const modelSpec = (id: string, name: string) => ({
  id, name, reasoning: true, input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
});
runtime.registerProvider('native-fixture', {
  api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
  models: [modelSpec('model-a', 'Model A'), modelSpec('model-b', 'Model B')],
});
const modelA = runtime.getModel('native-fixture', 'model-a')!;
const modelB = runtime.getModel('native-fixture', 'model-b')!;
type Captured = { messages: unknown[] };
const installStream = (session: Awaited<ReturnType<typeof createAgentSession>>['session'], captured: Captured[]) => {
  session.agent.streamFunction = ((model, context) => {
    captured.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: {
      role: 'assistant', content: [{ type: 'text', text: `reply-${model.id}` }], api: model.api,
      provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    } });
    return stream;
  }) as typeof session.agent.streamFunction;
};
const nativeSessionManager = SessionManager.create(options.cwd, options.sessionDir);
const firstResult = await createAgentSession({
  cwd: options.cwd, agentDir: options.account, modelRuntime: runtime, model: modelA, thinkingLevel: 'low',
  sessionManager: nativeSessionManager, settingsManager: settings, resourceLoader: loader, tools: [],
});
const firstCaptured: Captured[] = [];
installStream(firstResult.session, firstCaptured);
await firstResult.session.prompt('owned-user-model-a');
await firstResult.session.setModel(modelB);
firstResult.session.setThinkingLevel('medium');
await firstResult.session.prompt('owned-user-model-b');
const file = firstResult.session.sessionFile!;
const id = firstResult.session.sessionId;
assert.equal(resolve(dirname(file)), resolve(options.sessionDir));
firstResult.session.dispose();

const before = await readFile(file);
const read = await readPiSession(file, 'personal', options.account);
assert.deepEqual({ id: read.session.id, cwd: read.session.cwd, provider: read.session.provider,
  model: read.session.model, thinking: read.session.thinking },
{ id, cwd: options.cwd, provider: 'native-fixture', model: 'model-b', thinking: 'medium' });
assert.deepEqual(read.warnings, []);
const plan = await planResume(read.session);
assert.deepEqual(plan.args, ['--session', resolve(file)]);
assert.deepEqual(await readFile(file), before, 'readPiSession and planResume must be byte-read-only');

const reopenedManager = SessionManager.open(file, options.sessionDir);
const nativeHistory = reopenedManager.buildSessionContext().messages;
const resumedResult = await createAgentSession({
  cwd: options.cwd, agentDir: options.account, modelRuntime: runtime,
  sessionManager: reopenedManager, settingsManager: settings, resourceLoader: loader, tools: [],
});
const resumed = resumedResult.session;
assert.equal(resumedResult.modelFallbackMessage, undefined);
assert.deepEqual({ provider: resumed.model?.provider, model: resumed.model?.id, thinking: resumed.thinkingLevel },
  { provider: read.session.provider, model: read.session.model, thinking: read.session.thinking });
const historyShape = (messages: readonly any[]) => messages.filter(message => message.role === 'user' || message.role === 'assistant')
  .map(message => message.role === 'user'
    ? { role: message.role, content: message.content }
    : { role: message.role, provider: message.provider, model: message.model, content: message.content });
assert.deepEqual(historyShape(resumed.messages), historyShape(nativeHistory));
const resumedCaptured: Captured[] = [];
installStream(resumed, resumedCaptured);
await resumed.prompt('owned-user-after-resume');
const sent = resumedCaptured[0]!.messages as any[];
const userTexts = sent.filter(message => message.role === 'user').map(message =>
  typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join(''));
const assistantModels = sent.filter(message => message.role === 'assistant').map(message => message.model);
assert.deepEqual(userTexts, ['owned-user-model-a', 'owned-user-model-b', 'owned-user-after-resume']);
assert.deepEqual(assistantModels, ['model-a', 'model-b']);
console.log(JSON.stringify({ nativeSdk: true, sessionIdMatched: true, restored: {
  provider: resumed.model?.provider, model: resumed.model?.id, thinking: resumed.thinkingLevel,
}, historyMessages: nativeHistory.length, modelRequests: 0, bytesUnchanged: true }));
resumed.dispose();
