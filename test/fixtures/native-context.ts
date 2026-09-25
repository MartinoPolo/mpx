import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { MACHINE_ROOT_CUSTOM_TYPE, NO_MACHINE_ROOTS_CONTEXT, STYLE_REINFORCEMENT } from '../../src/context.js';

const options = JSON.parse(process.argv[2]!) as { cwd: string; account: string; extension: string };
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
settings.setProjectTrusted(true);
const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.account, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [options.extension], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await ModelRuntime.create({ authPath: join(options.account, 'auth.json'), modelsPath: null, modelsStorePath: join(options.account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider('mpx-fixture', {
  api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
});
const model = runtime.getModel('mpx-fixture', 'fixture')!;
const manager = SessionManager.inMemory(options.cwd);
const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.account, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [] });
const captured: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
// Mock ONLY the model stream boundary. Native session, loader, context and lifecycle run normally.
session.agent.streamFunction = ((_model, context) => {
  captured.push(structuredClone({ systemPrompt: getCurrentSystemPrompt(context.messages), messages: context.messages }));
  const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'fixture reply' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message });
  return stream;
}) as typeof session.agent.streamFunction;
globalThis.fetch = async () => { throw new Error('Unexpected network request in native-context fixture'); };
await session.bindExtensions({});
const roots = () => manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === MACHINE_ROOT_CUSTOM_TYPE);
assert.equal(roots().length, 1, 'native startup must persist one root message');
await session.prompt('first');
await session.prompt('second');
assert.equal(roots().length, 1, 'ordinary prompts must not duplicate root messages');
process.env.MPX_PROJECTS = 'C:/fixture-B';
await session.prompt('changed roots');
process.env.MPX_PROJECTS = 'C:/fixture-A';
await session.prompt('restored roots');
assert.equal(roots().length, 3);
for (const key of ['MPX_PROJECTS', 'MPX_WORK', 'MPX_CLONED', 'MPX_APPS', 'MPX_ONEDRIVE', 'MPX_AI_GENERATED', 'MPX_OBSIDIAN_VAULT']) delete process.env[key];
await session.prompt('unset roots');
await session.prompt('still unset');
assert.equal(roots().length, 4);
assert.equal(roots().at(-1)!.type, 'custom_message');
assert.ok(JSON.stringify(roots().at(-1)).includes(NO_MACHINE_ROOTS_CONTEXT));
assert.ok(captured.every(context => context.systemPrompt?.includes(STYLE_REINFORCEMENT)));
assert.ok(captured.every(context => !JSON.stringify(context).includes('never-inject-this')));
const capturedRoots = (index: number) => captured[index]!.messages.map(message => JSON.stringify(message)).filter(text => text.includes('Machine roots'));
assert.ok(capturedRoots(0).at(-1)!.includes('MPX_PROJECTS = C:/fixture-A'));
assert.ok(capturedRoots(1).at(-1)!.includes('MPX_PROJECTS = C:/fixture-A'));
assert.ok(capturedRoots(2).at(-1)!.includes('MPX_PROJECTS = C:/fixture-B'));
assert.ok(capturedRoots(3).at(-1)!.includes('MPX_PROJECTS = C:/fixture-A'));
assert.ok(capturedRoots(4).at(-1)!.includes(NO_MACHINE_ROOTS_CONTEXT));
assert.ok(capturedRoots(5).at(-1)!.includes(NO_MACHINE_ROOTS_CONTEXT));
process.env.MPX_PROJECTS = 'C:/fixture-A';
const kept = manager.getBranch().at(-1)!;
const compactionId = manager.appendCompaction('Synthetic compaction boundary; summary quality is not tested.', kept.id, 100);
const compaction = manager.getEntry(compactionId)!;
assert.equal(compaction.type, 'compaction');
// Apply the synthetic boundary through native context rebuilding, not a handwritten message filter.
session.agent.state.messages = manager.buildSessionContext().messages;
await session.extensionRunner.emit({ type: 'session_compact', compactionEntry: compaction as Extract<typeof compaction, { type: 'compaction' }>, fromExtension: false, reason: 'manual', willRetry: false });
assert.equal(manager.buildContextEntries().filter(entry => entry.type === 'custom_message' && entry.customType === MACHINE_ROOT_CUSTOM_TYPE).length, 1);
await session.prompt('after synthetic compaction');
assert.equal(capturedRoots(6).length, 1);
assert.ok(capturedRoots(6)[0]!.includes('MPX_PROJECTS = C:/fixture-A'));
assert.ok(captured[6]!.systemPrompt?.includes(STYLE_REINFORCEMENT));
console.log(JSON.stringify({ prompts: captured.length, rootMessages: roots().length, nativeLoader: true, modelRequests: 0, syntheticCompactionBoundary: true }));
session.dispose();
