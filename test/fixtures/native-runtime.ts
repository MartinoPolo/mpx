import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { STYLE_REINFORCEMENT } from '../../src/context.js';

const options = JSON.parse(process.argv[2]!) as { cwd: string; account: string; extension: string; profile: string };
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
settings.setProjectTrusted(true);
const loader = new DefaultResourceLoader({
  cwd: options.cwd,
  agentDir: options.account,
  settingsManager: settings,
  noExtensions: true,
  additionalExtensionPaths: [options.extension],
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(options.account, 'models-store.json'),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
runtime.registerProvider('mpx-fixture', {
  api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
});
const model = runtime.getModel('mpx-fixture', 'fixture');
assert.ok(model, 'checkout dependency must include a built-in model for the stream-boundary fixture');
const manager = SessionManager.inMemory(options.cwd);
const { session, extensionsResult } = await createAgentSession({
  cwd: options.cwd,
  agentDir: options.account,
  modelRuntime: runtime,
  model,
  thinkingLevel: 'low',
  sessionManager: manager,
  settingsManager: settings,
  resourceLoader: loader,
});
assert.deepEqual(extensionsResult.errors, []);

const calls = [
  { id: 'clean', name: 'bash', arguments: { command: 'git clean -fd' } },
  { id: 'nul', name: 'write', arguments: { path: 'NUL', content: 'must not be written' } },
  { id: 'write', name: 'write', arguments: { path: 'safe.txt', content: 'before' } },
  { id: 'edit', name: 'edit', arguments: { path: 'safe.txt', edits: [{ oldText: 'before', newText: 'after' }] } },
] as const;
const captured: Context[] = [];
let request = 0;
const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
  role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: Date.now(),
});
session.agent.streamFunction = ((_model, context) => {
  captured.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
  const planned = calls[request++];
  const response = planned
    ? message([{ type: 'toolCall', ...planned }], 'toolUse')
    : message([{ type: 'text', text: 'fixture complete' }], 'stop');
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: response.stopReason as 'toolUse' | 'stop', message: response });
  return stream;
}) as typeof session.agent.streamFunction;

globalThis.fetch = async () => { throw new Error('Unexpected network request in native-runtime fixture'); };
const extensionErrors: unknown[] = [];
const executions: Array<{ phase: 'start' | 'end'; name: string; result?: unknown }> = [];
session.subscribe(event => {
  if (event.type === 'tool_execution_start') executions.push({ phase: 'start', name: event.toolName });
  if (event.type === 'tool_execution_end') executions.push({ phase: 'end', name: event.toolName, result: event.result });
});
await session.bindExtensions({ onError: error => extensionErrors.push(error) });
assert.deepEqual(extensionErrors, []);

const allToolNames = session.getAllTools().map(tool => tool.name);
for (const name of ['Agent', 'get_subagent_result', 'steer_subagent']) {
  assert.equal(allToolNames.filter(candidate => candidate === name).length, 1, `${name} must be registered exactly once`);
  assert.equal(session.getActiveToolNames().filter(candidate => candidate === name).length, 1, `${name} must be active exactly once`);
}
for (const name of ['write', 'edit']) assert.equal(allToolNames.filter(candidate => candidate === name).length, 1, `${name} override must compose once`);

await session.prompt(`exercise ${options.profile} composition`);
assert.deepEqual(extensionErrors, []);
assert.equal(request, calls.length + 1, JSON.stringify(session.messages.slice(-1)));
assert.deepEqual(executions.filter(event => event.phase === 'start').map(event => event.name), ['bash', 'write', 'write', 'edit']);
assert.deepEqual(executions.filter(event => event.phase === 'end').map(event => event.name), ['bash', 'write', 'write', 'edit']);
assert.equal(await readFile('safe.txt', 'utf8'), 'after');
await access('clean-marker.txt');
const transcript = JSON.stringify(captured);
assert.match(transcript, /mutating git clean/i);
assert.match(transcript, /Blocked literal Windows NUL/i);
assert.ok(captured.every(context => context.systemPrompt?.includes(STYLE_REINFORCEMENT)));
assert.ok(captured.every(context => context.systemPrompt?.includes('# Working principles')));
assert.ok(captured.every(context => context.systemPrompt?.includes('Your `bash` tool runs **Git Bash**')));
const rootVariable = options.profile === 'personal' ? 'MPX_PROJECTS' : 'MPX_WORK';
assert.ok(captured.every(context => JSON.stringify(context.messages).includes(`${rootVariable} =`)));
assert.deepEqual(extensionErrors, []);
console.log(JSON.stringify({ profile: options.profile, nativeLoader: true, nativeToolCalls: calls.length, modelRequests: 0, tools: ['Agent', 'get_subagent_result', 'steer_subagent'], markerPreserved: true, safeBytes: 'after' }));
session.dispose();
