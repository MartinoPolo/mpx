import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export async function runCoordinatorFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-coordinator-'));
  const account = join(root, 'account');
  const project = join(root, 'project');
  const source = resolve(process.env.MPX_SUBAGENTS_TEST_SOURCE ?? 'node_modules/@tintinweb/pi-subagents/src').replaceAll('\\', '/');
  const symbol = Symbol.for('mpx.coordinator.fixture');
  const tracker: any = { tools: new Map(), children: [], gates: new Map(), gateReady: new Map(), requests: [], delivered: [] };
  Reflect.set(globalThis, symbol, tracker);
  const environment = ['HOME', 'USERPROFILE', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_TELEMETRY', 'MPX_ACTIVE_CONTENT_ROOT'];
  const previous = new Map(environment.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const previousDirectory = process.cwd();
  let session: AgentSession | undefined;
  try {
    for (const path of [account, project, join(project, '.pi', 'agents')]) await mkdir(path, { recursive: true });
    process.chdir(project);
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.PI_CODING_AGENT_DIR = account;
    process.env.PI_OFFLINE = '1';
    process.env.PI_TELEMETRY = '0';
    process.env.MPX_ACTIVE_CONTENT_ROOT = join(root, 'empty-content');
    globalThis.fetch = async () => { throw new Error('No network allowed'); };
    await writeFile(join(account, 'subagents.json'), JSON.stringify({ workflowsEnabled: false, schedulingEnabled: false, worktreeIsolation: false, rememberAgents: true, maxSubagentDepth: 2, defaultJoinMode: 'group' }));
    await writeFile(join(project, '.pi', 'agents', 'reader.md'), '---\nname: reader\ndescription: Fixture reader\ntools: read\nmodel: fixture/default\n---\nREQUESTED_READER_CONFIG\n');
    await writeFile(join(project, '.pi', 'agents', 'writer.md'), '---\nname: writer\ndescription: Fixture writer\ntools: read, write, edit\n---\nREQUESTED_WRITER_CONFIG\n');
    const extension = join(root, 'controller.ts');
    await writeFile(extension, `
import extension from ${JSON.stringify(source + '/index.js')};
import { AgentManager } from ${JSON.stringify(source + '/agent-manager.js')};
import { QuietDelivery, validateChildReference } from ${JSON.stringify(source + '/quiet-delivery.js')};
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
const tracker = globalThis[Symbol.for('mpx.coordinator.fixture')];
const original = AgentManager.prototype.spawn;
const originalObserver = AgentManager.prototype.setRecordObserver;
if (!tracker.cleanup) AgentManager.prototype.setRecordObserver = function(observer) {
  tracker.manager = this;
  return originalObserver.call(this, observer);
};
if (!tracker.cleanup) AgentManager.prototype.spawn = function(pi, ctx, type, prompt, options) {
  tracker.manager ??= this;
  return original.call(this, pi, ctx, type, prompt, { ...options, onSessionCreated(session) {
    tracker.children.push(session);
    tracker.maximumNested = Math.max(tracker.maximumNested ?? 0, tracker.manager.listAgents().filter(record => record.depth === 2 && record.status === 'running').length);
    let delegated = false;
    const stream = (model, context) => {
      const result = createAssistantMessageEventStream();
      const finish = () => {
        const nested = prompt === 'nested-parent' && !delegated;
        delegated = true;
        const content = nested ? ['nested-leaf', 'nested-leaf-second'].map(name => ({ type: 'toolCall', id: name, name: 'Agent', arguments: {
          subagent_type: 'writer', prompt: name, description: name, run_in_background: false, model: 'fixture/override'
        } })) : [{ type: 'text', text: 'RESULT:' + prompt }];
        result.push({ type: 'done', reason: nested ? 'toolUse' : 'stop', message: { role: 'assistant', content,
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: nested ? 'toolUse' : 'stop', timestamp: Date.now() } });
      };
      if (prompt.startsWith('held')) { tracker.gates.set(prompt, finish); tracker.gateReady.get(prompt)?.(); } else finish();
      return result;
    };
    session.agent.streamFunction = stream;
    options.onSessionCreated?.(session);
  } });
};
tracker.cleanup ??= () => { AgentManager.prototype.spawn = original; AgentManager.prototype.setRecordObserver = originalObserver; };
tracker.QuietDelivery = QuietDelivery;
tracker.AgentManager = AgentManager;
tracker.validateChildReference = validateChildReference;
export default function(pi) {
  if (tracker.pi) return;
  tracker.pi = pi;
  const register = pi.registerTool.bind(pi);
  extension({ ...pi, registerTool(tool) { tracker.tools.set(tool.name, tool); register(tool); } });
  pi.on('session_start', (_event, ctx) => { tracker.ctx = ctx; });
  pi.on('agent_settled', (_event, ctx) => { if (ctx.isIdle()) tracker.idle?.(); });
  pi.events.on('subagents:result-delivered', value => tracker.delivered.push(value));
  pi.registerTool({ name: 'fixture_rpc_result', label: 'RPC result fixture', description: 'Offline RPC receipt test',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, parameters) {
      const record = await tracker.manager.waitForResult(parameters.id);
      pi.events.emit('subagents:rpc:consume', { requestId: 'fixture-rpc', agentId: record.id });
      return { content: [{ type: 'text', text: record.id + '\\n' + record.result }], details: {} };
    }
  });
}
`);
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(account, 'auth.json'), modelsPath: null, modelsStorePath: join(account, 'store.json'), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1', models: ['default', 'override'].map(id => ({ id, name: id, reasoning: false, input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })) });
    const settings = SettingsManager.create(project, account);
    settings.setProjectTrusted(true);
    settings.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir: account, settingsManager: settings, additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (await createAgentSession({ cwd: project, agentDir: account, modelRuntime: runtime, model: runtime.getModel('fixture', 'default')!, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(project, join(root, 'sessions')) })).session;
    await session.bindExtensions({});
    assert.equal(tracker.tools.has('SubagentWorkflow'), false);
    const agentParameters = tracker.tools.get('Agent').parameters.properties;
    assert.equal('schedule' in agentParameters, false);
    assert.equal('isolation' in agentParameters, false);
    let action: { name: string; arguments: object } | undefined;
    const installParentStream = (parent: AgentSession) => { parent.agent.streamFunction = ((model) => {
      tracker.requests.push(model.id);
      const stream = createAssistantMessageEventStream();
      const next = action; action = undefined;
      stream.push({ type: 'done', reason: next ? 'toolUse' : 'stop', message: {
        role: 'assistant', content: next ? [{ type: 'toolCall', id: `call-${tracker.requests.length}`, name: next.name, arguments: next.arguments }] : [{ type: 'text', text: 'parent-complete' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: next ? 'toolUse' : 'stop', timestamp: Date.now(),
      } });
      return stream;
    }); };
    installParentStream(session);
    const invoke = async (name: string, parameters: object) => {
      action = { name, arguments: parameters };
      await session!.prompt('Run fixture action');
      if (!tracker.ctx.isIdle()) await new Promise<void>(resolve => { tracker.idle = resolve; });
      const messages = session!.messages.filter(message => message.role === 'toolResult');
      const result = messages.at(-1);
      assert.ok(result && result.role === 'toolResult');
      assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    };
    const spawn = async (prompt: string, background = true) => invoke('Agent', { subagent_type: 'reader', prompt, description: prompt, run_in_background: background, model: 'fixture/override' });
    const gate = async (prompt: string) => {
      if (!tracker.gates.has(prompt)) await new Promise<void>(resolve => tracker.gateReady.set(prompt, resolve));
      return tracker.gates.get(prompt);
    };
    await spawn('foreground', false);
    let manager = tracker.manager;
    assert.ok(manager);
    const foreground = manager.listAgents()[0];
    assert.ok(foreground.resultConsumed, 'foreground receipt persisted');
    assert.equal(foreground.invocation.modelId, 'fixture/override');
    assert.equal(foreground.session.model.id, 'override');
    assert.ok(foreground.session.agent.state.systemPrompt.includes('REQUESTED_READER_CONFIG'));
    assert.equal(session.messages.filter(message => message.role === 'custom').length, 0);

    await invoke('Agent', { subagent_type: 'writer', prompt: 'ceiling-resume', description: 'ceiling-resume', run_in_background: false });
    const narrowed = manager.listAgents().find((record: any) => record.description === 'ceiling-resume');
    assert.ok(narrowed.session.getActiveToolNames().includes('write'));
    await manager.resume(narrowed.id, 'continue with fewer tools', undefined, { toolCeiling: ['read'] });
    assert.equal(narrowed.session.getActiveToolNames().includes('write'), false, 'turn-end refresh cannot restore tools denied by resume');
    assert.equal(narrowed.session.getActiveToolNames().includes('edit'), false);
    await invoke('get_subagent_result', { agent_id: narrowed.id, wait: true });

    manager.setMaxConcurrent(1);
    manager.setMaxConcurrentForeground(1);
    await spawn('nested-parent', false);
    const nestedParent = manager.listAgents().find((record: any) => record.description === 'nested-parent');
    const grandchildren = manager.listAgents().filter((record: any) => record.parentAgentId === nestedParent.id);
    assert.equal(grandchildren.length, 2);
    assert.equal(tracker.maximumNested, 1, 'the per-depth pool bounds parallel grandchildren without blocking their parent');
    const grandchild = grandchildren.find((record: any) => record.description === 'nested-leaf');
    assert.ok(grandchild, JSON.stringify(nestedParent.session.messages));
    assert.equal(grandchild.depth, 2);
    assert.equal(grandchild.result, 'RESULT:nested-leaf');
    assert.ok(grandchild.session.agent.state.systemPrompt.includes('REQUESTED_WRITER_CONFIG'));
    assert.equal(grandchild.session.model.id, 'override');
    assert.equal(grandchild.session.getActiveToolNames().includes('write'), false);
    assert.equal(grandchild.session.getActiveToolNames().includes('edit'), false);
    assert.equal(grandchild.session.getActiveToolNames().includes('Agent'), false, 'next depth is deprived of delegation');
    assert.equal(session.messages.filter(message => message.role === 'custom').length, 0, 'grandchildren do not wake root');

    await spawn('held-idle');
    const idle = manager.listAgents().find((record: any) => record.description === 'held-idle');
    (await gate('held-idle'))();
    await manager.waitForResult(idle.id);
    await session.agent.waitForIdle();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.messages.filter(message => message.role === 'custom' && message.customType === 'subagents:results').length, 1);
    assert.equal(idle.resultConsumed, true);
    const count = tracker.requests.length;
    await invoke('get_subagent_result', { agent_id: idle.id, wait: true });
    assert.equal(tracker.requests.length, count + 2, 'reread creates no extra recovery turn');

    await spawn('held-retrieval');
    const retrieved = manager.listAgents().find((record: any) => record.description === 'held-retrieval');
    const releaseRetrieved = await gate('held-retrieval');
    const beforeRetrieval = session.messages.filter(message => message.role === 'custom').length;
    const retrieving = invoke('get_subagent_result', { agent_id: retrieved.id, wait: true });
    releaseRetrieved();
    const fetched = await retrieving;
    assert.ok(JSON.stringify(fetched.content).includes('RESULT:held-retrieval'));
    assert.equal(retrieved.resultConsumed, true);
    assert.equal(session.messages.filter(message => message.role === 'custom').length, beforeRetrieval);
    await spawn('held-rpc');
    const rpcRecord = manager.listAgents().find((record: any) => record.description === 'held-rpc');
    const releaseRpc = await gate('held-rpc');
    const rpcRead = invoke('fixture_rpc_result', { id: rpcRecord.id });
    releaseRpc();
    const rpcResult = await rpcRead;
    assert.equal(rpcResult.details.subagentReceipts.length, 1);
    assert.equal(rpcRecord.resultConsumed, true, 'RPC consumption is reconciled from actual persisted tool output');
    const joined = await invoke('get_subagent_result', { agent_ids: [retrieved.id, idle.id], wait_for: 'any' });
    assert.equal(joined.details.subagentReceipts.length, 2, 'wait-any returns all currently settled selections');
    const oldSnapshot = await manager.waitForResult(foreground.id);
    await invoke('Agent', { subagent_type: 'reader', resume: foreground.id, prompt: 'another turn', description: 'resume', run_in_background: false });
    assert.equal(oldSnapshot.runRevision, 0, 'settled snapshot is immutable across resume');
    assert.equal(manager.getRecord(foreground.id).runRevision, 1);
    assert.equal(manager.getRecord(foreground.id).resultConsumed, true);

    await spawn('held-abort');
    const aborted = manager.listAgents().find((record: any) => record.description === 'held-abort');
    await session.abort();
    const before = tracker.requests.length;
    (await gate('held-abort'))();
    await manager.waitForResult(aborted.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracker.requests.length, before, 'late settlement after idle abort never wakes');

    manager.setMaxConcurrent(1);
    await spawn('held-slot');
    await spawn('held-queued');
    const queued = manager.listAgents().find((record: any) => record.description === 'held-queued');
    assert.equal(queued.status, 'queued');
    const waiting = manager.waitForResult(queued.id);
    manager.abort(queued.id);
    assert.equal((await waiting).status, 'stopped');
    await session.abort();
    const slot = manager.listAgents().find((record: any) => record.description === 'held-slot');
    await gate('held-slot');
    manager.abort(slot.id);
    let settled = false;
    const partial = manager.waitForResult(slot.id).then((value: any) => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false, 'provisional stopped must not settle before final partial output');
    tracker.gates.get('held-slot')();
    await partial;

    const branch = tracker.ctx.sessionManager.getBranch();
    assert.ok(branch.some((entry: any) => entry.type === 'custom' && entry.customType === 'subagents:record' && entry.data.sessionFile));
    const parentSessionFile = session.sessionFile!;
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' });
    session.dispose();
    tracker.cleanup();
    tracker.cleanup = undefined;
    tracker.pi = undefined;
    tracker.manager = undefined;
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (await createAgentSession({ cwd: project, agentDir: account, modelRuntime: runtime,
      model: runtime.getModel('fixture', 'default')!, settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.open(parentSessionFile) })).session;
    await session.bindExtensions({});
    installParentStream(session);
    manager = tracker.manager;
    const restored = manager.getRecord(foreground.id);
    assert.equal(restored.result, 'RESULT:foreground');
    assert.equal(restored.resultConsumed, true);
    assert.equal(restored.session, undefined, 'restore is metadata only');
    assert.equal(tracker.validateChildReference(restored, session.sessionFile), restored.sessionFile);
    assert.throws(() => tracker.validateChildReference(restored, join(root, 'wrong-parent')), /ENOENT|match/);
    const queried = await invoke('get_subagent_result', { agent_id: restored.handle, wait: true });
    assert.ok(JSON.stringify(queried.content).includes('RESULT:foreground'));
    const reopenedResult = await invoke('Agent', { subagent_type: restored.type, resume: restored.id, prompt: 'reopened', description: 'reopened', run_in_background: false });
    const reopened = manager.getRecord(reopenedResult.details.agentId);
    assert.notEqual(reopened.id, restored.id, 'reopen returns its new run identity explicitly');
    assert.ok(reopened.session.messages.some((message: any) => message.role === 'assistant' && message.content.some((block: any) => block.text === 'RESULT:foreground')), 'explicit reopen retains saved context');
    assert.equal(reopened.result, 'RESULT:reopened');
    const branchAnchor = session.sessionManager.getLeafId()!;
    await spawn('held-abandoned');
    const abandoned = manager.listAgents().find((record: any) => record.description === 'held-abandoned');
    const releaseAbandoned = await gate('held-abandoned');
    const abandonedRun = abandoned.promise;
    await session.navigateTree(branchAnchor);
    assert.equal(manager.getRecord(abandoned.id), undefined, 'confirmed branch navigation restores only its entries');
    const branchRequestCount = tracker.requests.length;
    releaseAbandoned();
    await abandonedRun;
    assert.equal(tracker.requests.length, branchRequestCount);
    assert.equal(session.sessionManager.getBranch().some((entry: any) => entry.type === 'custom' && entry.customType === 'subagents:record' && entry.data.id === abandoned.id), false, 'old callback cannot append through current branch');
    assert.equal(session.messages.filter(message => message.role === 'custom' && message.customType === 'subagent-notification').length, 0, 'group previews never dispatch');
    const failureManager = new tracker.AgentManager();
    const failureSession = SessionManager.inMemory(project);
    let failedDispatches = 0;
    const failureOwner = new tracker.QuietDelivery({ ...tracker.pi,
      appendEntry: (type: string, data: unknown) => failureSession.appendCustomEntry(type, data),
      sendMessage: () => { failedDispatches++; throw new Error('fixture dispatch rejected'); },
    }, failureManager);
    failureOwner.activate({ ...tracker.ctx, sessionManager: failureSession, isIdle: () => true });
    const failureRecord = { ...restored, id: 'dispatch-failure', parentSessionId: failureSession.getSessionId(), resultConsumed: false, blocking: false };
    failureManager.restore(failureRecord);
    failureOwner.track(failureRecord);
    failureOwner.rearm();
    failureOwner.recover();
    failureOwner.reconcile();
    failureOwner.recover();
    assert.equal(failedDispatches, 1, 'failed dispatch does not retry in a loop');
    assert.equal(failureRecord.resultConsumed, false);
    assert.equal(failureOwner.reserve([failureRecord]).length, 1, 'failed unrecorded reservation is available to retrieval');
    failureOwner.shutdown();
    await failureManager.dispose();
    const disposalManager = new tracker.AgentManager(undefined, 1);
    const liveId = disposalManager.spawn(tracker.pi, tracker.ctx, 'reader', 'held-dispose-live', { description: 'dispose-live', isBackground: true });
    const queuedId = disposalManager.spawn(tracker.pi, tracker.ctx, 'reader', 'held-dispose-queued', { description: 'dispose-queued', isBackground: true });
    const liveWait = disposalManager.waitForResult(liveId);
    const queuedWait = disposalManager.waitForResult(queuedId);
    const releaseDisposed = await gate('held-dispose-live');
    await disposalManager.dispose();
    assert.equal((await liveWait).status, 'stopped');
    assert.equal((await queuedWait).status, 'stopped');
    releaseDisposed();
    await manager.dispose();
  } finally {
    for (const finish of tracker.gates.values()) finish();
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
    await tracker.manager?.dispose();
    tracker.cleanup?.();
    session?.dispose();
    for (const child of tracker.children) child.dispose();
    globalThis.fetch = previousFetch;
    process.chdir(previousDirectory);
    Reflect.deleteProperty(globalThis, symbol);
    for (const name of environment) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
