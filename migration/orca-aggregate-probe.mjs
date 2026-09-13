// Native Pi + unchanged upstream manager + patched Orca hook, all in disposable data.
// Only model streaming, nudge-clock delay, and HTTP delivery are controlled fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { withSourceIntegrity } from './source-integrity.mjs';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, createEventBus } from '@earendil-works/pi-coding-agent';
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Pass the absolute installed Orca Pi hook source path.');
const orcaSource = process.argv[3];
if (!orcaSource || !path.isAbsolute(orcaSource)) throw new Error('Pass the absolute read-only Orca source checkout as second argument.');
let normalizePiCompatibleEvent;
let receiverState;
const normalized = [];
const original = await readFile(source);
const root = path.resolve(import.meta.dirname, '..');
let temporary;
const realTimeout = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
const held = new Map();
let holdNudges = true;
let session;
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const childEntered = defer(); const releaseChild = defer(); const childCompleted = defer(); const cancelEntered = defer();
const secondChildEntered = defer(); const releaseSecondChild = defer(); const resultWaitEntered = defer();
let consumedChildId;
const delay = milliseconds => new Promise(resolve => realTimeout(resolve, milliseconds));
async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = realTimeout(() => reject(new Error(`Deadline: ${label}`)), milliseconds); })]); }
  finally { realClear(timer); }
}
const posts = [];
const activities = [];
let expectedEnds = 0;
let pendingEnd;
function nextEnd() { expectedEnds++; pendingEnd = defer(); return pendingEnd.promise; }
const evidence = await withSourceIntegrity({ repositories: [orcaSource], files: [source] }, async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'mpx-orca-aggregate-'));
try {
  const home = path.join(temporary, 'home'), account = path.join(temporary, 'account'), cwd = path.join(temporary, 'project');
  await Promise.all([home, account, cwd].map(p => mkdir(p)));
  for (const key of Object.keys(process.env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|COOKIE|AUTH)/i.test(key)
      || /^(MPX|ORCA|WSL|OPENAI|ANTHROPIC|AZURE|AWS|GOOGLE|GEMINI|CODEX|GITHUB|GH|MCP)_/i.test(key)
      || /^PI_(MODEL|PROVIDER|REASONING_LEVEL|SESSION|CODING_AGENT|AUTH|ROUT)/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', MPX_ACCOUNT: 'personal', MPX_ACTIVE_CONTENT_ROOT: root, ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_TOKEN: 'fixture-only', ORCA_PANE_KEY: 'fixture-pane' });
  execFileSync('git', ['init', '--quiet'], { cwd });
  const candidate = path.join(temporary, 'orca-agent-status.ts');
  await copyFile(source, candidate);
  execFileSync('git', ['init', '--quiet'], { cwd: temporary });
  execFileSync('git', ['apply', '--check', path.join(root, 'patches/orca-pi-aggregate.patch')], { cwd: temporary });
  execFileSync('git', ['apply', path.join(root, 'patches/orca-pi-aggregate.patch')], { cwd: temporary });
  net.Socket.prototype.connect = () => { throw new Error('Unexpected fixture socket connection'); };
  globalThis.fetch = async (url, request) => {
    assert.equal(String(url), 'http://127.0.0.1:1/hook/pi');
    assert.equal(request.headers['X-Orca-Agent-Hook-Token'], 'fixture-only');
    const payload = JSON.parse(request.body).payload;
    posts.push(payload);
    normalized.push(normalizePiCompatibleEvent(receiverState, 'pi', payload.hook_event_name, String(payload.prompt ?? ''), 'fixture-pane', payload));
    if (posts.filter(p => p.hook_event_name === 'agent_end').length >= expectedEnds) pendingEnd?.resolve(payload);
    return new Response('', { status: 200 });
  };
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (holdNudges && milliseconds === 200) {
      const handle = realTimeout(() => {}, 30000); handle.unref?.();
      held.set(handle, () => callback(...args)); return handle;
    }
    return realTimeout(callback, milliseconds, ...args);
  };
  globalThis.clearTimeout = handle => { held.delete(handle); realClear(handle); };
  ({ normalizePiCompatibleEvent } = await import(pathToFileURL(path.join(orcaSource, 'src/shared/agent-hook-listener/providers/pi-family-events.ts')).href));
  const { createHookListenerState } = await import(pathToFileURL(path.join(orcaSource, 'src/shared/agent-hook-listener/listener-state.ts')).href);
  receiverState = createHookListenerState();
  const events = createEventBus();
  events.on('mpx2:pi-ui:activity', value => activities.push(value));
  events.on('subagents:completed', value => childCompleted.resolve(value));
  const driver = path.join(temporary, 'driver.ts');
  await writeFile(driver, `export default function(pi) {
    let spawned = false;
    pi.on('agent_start', () => {
      if (spawned) return; spawned = true;
      pi.events.emit('subagents:rpc:spawn', {requestId:'fixture-child', type:'general-purpose', prompt:'CHILD_HOLD', options:{isBackground:true,description:'Held native child',model:'mpx-fixture/model',thinkingLevel:'high',isolated:true}});
    });
  }`);
  let rpcReply;
  events.on('subagents:rpc:spawn:reply:fixture-child', reply => { rpcReply = reply; });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } }); settings.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir: account, settingsManager: settings, eventBus: events, noExtensions: true, additionalExtensionPaths: [path.join(root, 'extensions/pi-runtime.ts'), candidate, driver], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: path.join(account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('mpx-fixture', { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'model', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }] });
  const execution = [];
  runtime.streamSimple = (model, context, options) => {
    assert.equal(model.provider, 'mpx-fixture');
    const text = context.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(p => p.type === 'text').map(p => p.text).join(' ')).join(' ');
    const isSecondChild = text.includes('CHILD_WAIT');
    const isChild = text.includes('CHILD_HOLD') || isSecondChild;
    const consume = text.includes('CONSUME_CHILD') && !context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'consume-fixture');
    const isCancel = text.includes('CANCEL_ROOT');
    execution.push({ child: isChild, provider: model.provider, model: model.id, reasoning: options?.reasoning });
    const stream = createAssistantMessageEventStream(); let finished = false;
    const finish = (aborted = false) => {
      if (finished) return; finished = true;
      const message = { role: 'assistant', content: consume && !aborted ? [{ type: 'toolCall', id: 'consume-fixture', name: 'get_subagent_result', arguments: { agent_id: consumedChildId, wait: true } }] : [{ type: 'text', text: isChild ? 'Native child completed' : 'Native parent completed' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: aborted ? 'aborted' : consume ? 'toolUse' : 'stop', timestamp: Date.now() };
      stream.push(aborted ? { type: 'error', reason: 'aborted', error: message } : { type: 'done', reason: consume ? 'toolUse' : 'stop', message });
    };
    if (options?.signal?.aborted) finish(true);
    else options?.signal?.addEventListener('abort', () => finish(true), { once: true });
    if (isSecondChild) { secondChildEntered.resolve(); void releaseSecondChild.promise.then(() => finish()); }
    else if (isChild) { childEntered.resolve(); void releaseChild.promise.then(() => finish()); }
    else if (isCancel) cancelEntered.resolve();
    else finish();
    return stream;
  };
  ({ session } = await createAgentSession({ cwd, agentDir: account, modelRuntime: runtime, model: runtime.getModel('mpx-fixture', 'model'), thinkingLevel: 'high', settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader, tools: ['get_subagent_result'] }));
  await session.bindExtensions({ onError: error => { throw new Error(error.message); } });
  assert.deepEqual(session.getActiveToolNames(), ['get_subagent_result']);
  const firstEnd = nextEnd();
  await bounded(session.prompt('Parent starts native background child'), 'parent prompt');
  await bounded(childEntered.promise, 'native child startup');
  await delay(150); // Let the real upstream batch debounce settle before its child finishes.
  assert.equal(posts.filter(p => p.hook_event_name === 'agent_end').length, 0);
  assert.equal(activities.at(-1).activeChildren, 1);
  releaseChild.resolve();
  const finishedChild = await bounded(childCompleted.promise, 'native child completion');
  await delay(700); // Exceeds MPX's UI settle delay, while actual upstream nudge is still held.
  const childRecord = globalThis[Symbol.for('pi-subagents:manager')]?.getRecord(finishedChild.id);
  assert.ok(held.size > 0, JSON.stringify({ message: 'actual upstream notification timer was not intercepted', activity: activities.at(-1), events: posts.map(p => p.hook_event_name), record: { status: childRecord?.status, consumed: childRecord?.resultConsumed, background: childRecord?.isBackground } }));
  assert.equal(posts.filter(p => p.hook_event_name === 'agent_end').length, 0);
  assert.equal(activities.at(-1).pendingFollowUps, 1);
  holdNudges = false;
  for (const [handle, callback] of [...held]) { held.delete(handle); realClear(handle); callback(); }
  await bounded(firstEnd, 'aggregate completion after actual native follow-up');
  assert.equal(posts.filter(p => p.hook_event_name === 'agent_end').length, 1);
  assert.equal(activities.at(-1).state, 'done');
  assert.equal(activities.at(-1).pendingFollowUps, 0);
  assert.equal(rpcReply?.success, true);
  assert.ok(execution.some(e => e.child));
  assert.ok(execution.every(e => e.reasoning === 'high'), JSON.stringify(execution));
  assert.ok(execution.filter(e => !e.child).length >= 2, 'native follow-up invoked parent model');

  // A real native get_subagent_result wait consumes the result; no nudge turn is owed.
  holdNudges = true;
  const secondReply = defer();
  events.on('subagents:rpc:spawn:reply:consume-child', reply => secondReply.resolve(reply));
  events.emit('subagents:rpc:spawn', { requestId: 'consume-child', type: 'general-purpose', prompt: 'CHILD_WAIT', options: { isBackground: true, description: 'Consumed native child', model: 'mpx-fixture/model', thinkingLevel: 'high', isolated: true } });
  const reply = await bounded(secondReply.promise, 'second child RPC');
  assert.equal(reply.success, true); consumedChildId = reply.data.id;
  await bounded(secondChildEntered.promise, 'second child stream');
  const unsubscribeWait = session.subscribe(event => { if (event.type === 'tool_execution_start' && event.toolName === 'get_subagent_result') resultWaitEntered.resolve(); });
  const consumedEnd = nextEnd();
  const consumePrompt = session.prompt('CONSUME_CHILD');
  await bounded(resultWaitEntered.promise, 'native result wait');
  releaseSecondChild.resolve();
  await bounded(consumePrompt, 'native consumed result prompt');
  try { await bounded(consumedEnd, 'consumed-result aggregate completion'); }
  catch (error) {
    const r = globalThis[Symbol.for('pi-subagents:manager')]?.getRecord(consumedChildId);
    console.error(JSON.stringify({ activity: activities.at(-1), child: { id: consumedChildId, status: r?.status, consumed: r?.resultConsumed }, tools: session.getActiveToolNames(), results: session.state.messages.filter(m => m.role === 'toolResult').map(m => ({ name: m.toolName, error: m.isError, content: JSON.stringify(m.content).slice(0, 500) })) }));
    throw error;
  }
  unsubscribeWait();
  assert.equal(globalThis[Symbol.for('pi-subagents:manager')].getRecord(consumedChildId).resultConsumed, true);
  assert.equal(activities.at(-1).pendingFollowUps, 0);
  holdNudges = false;
  for (const [handle, callback] of [...held]) { held.delete(handle); realClear(handle); callback(); }
  await delay(100);
  assert.equal(posts.filter(p => p.hook_event_name === 'agent_end').length, 2, 'consumed result cannot generate an extra completion');

  const secondEnd = nextEnd();
  events.emit('mpx2:pi-ui:background', { id: 'fixture-background', active: true });
  events.emit('rpiv:ask-user:blocked', { active: true });
  await delay(25);
  assert.equal(posts.at(-1).ui_prompt_active, true);
  assert.equal(normalized.at(-1).state, 'waiting');
  events.emit('rpiv:ask-user:blocked', { active: false });
  await delay(25);
  assert.equal(posts.at(-1).is_idle, false);
  assert.equal(normalized.at(-1).state, 'working');
  events.emit('mpx2:pi-ui:background', { id: 'fixture-background', active: false });
  await bounded(secondEnd, 'tracked background completion');

  const cancelledEnd = nextEnd();
  const cancelledPrompt = session.prompt('CANCEL_ROOT');
  await bounded(cancelEntered.promise, 'cancel stream startup');
  await bounded(session.abort(), 'native abort');
  await bounded(cancelledPrompt, 'aborted prompt unwind');
  const cancelled = await bounded(cancelledEnd, 'cancelled aggregate payload');
  assert.equal(cancelled.interrupted, true);
  const receivedCancellation = normalizePiCompatibleEvent(createHookListenerState(), 'pi', 'agent_end', '', 'fixture-pane', cancelled);
  assert.equal(receivedCancellation.state, 'done');
  assert.equal(receivedCancellation.interrupted, undefined, 'confirmed current receiver gap, NOT cancellation acceptance');
  assert.equal(activities.at(-1).state, 'cancelled');

  const old = activities.at(-1);
  await bounded(session.reload(), 'native extension reload');
  assert.notEqual(activities.at(-1).activityId, old.activityId);
  const beforeStale = posts.length;
  events.emit('mpx2:pi-ui:activity', { ...old, state: 'done', revision: old.revision + 1000 });
  await delay(50);
  assert.equal(posts.length, beforeStale, 'old activation cannot publish completion after reload');
  const reloadedEnd = nextEnd();
  events.emit('mpx2:pi-ui:background', { id: 'after-reload', active: true });
  await delay(50);
  assert.equal(normalized.at(-1).state, 'working', 'replacement hook listener remains active');
  events.emit('mpx2:pi-ui:background', { id: 'after-reload', active: false });
  await bounded(reloadedEnd, 'replacement hook aggregate completion');
  assert.deepEqual(await readFile(source), original);
  const piVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent')), 'utf8')).version;
  return { sourceSha256: createHash('sha256').update(original).digest('hex'), nativePi: piVersion, nativeChildAndFollowUp: true, heldNudgeMs: 700, noPrematureDone: true, execution, rootCompletions: 4, nativeResultConsumption: true, cancellationPayload: 'interrupted:true; current Orca receiver drops it, companion approval required', humanNeeded: 'public package-event fixture, not physical UI', reloadStaleEventRejected: true, replacementListenerWorks: true, networkRequests: 0, installedChanges: 0 };
} finally {
  releaseChild.resolve(); releaseSecondChild.resolve();
  for (const handle of held.keys()) realClear(handle);
  held.clear(); globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear;
  session?.dispose();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
});
console.log(JSON.stringify({ ...evidence, externalGitVisibleSourcesUnchanged: true }, null, 2));
