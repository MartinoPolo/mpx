// Isolated native-session event reproduction. Never connects to the installed Orca receiver.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Pass the absolute installed Orca Pi status extension path.');
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-orca-activity-'));
let session;
try {
  const account = path.join(temporary, 'account');
  const cwd = path.join(temporary, 'project');
  const home = path.join(temporary, 'home');
  await Promise.all([account, cwd, home].map(directory => mkdir(directory)));
  execFileSync('git', ['init', '--quiet'], { cwd });
  for (const key of Object.keys(process.env)) if (/^(?:ORCA_|ANTHROPIC_|OPENAI_)/i.test(key) || /API_KEY|AUTH_TOKEN/i.test(key)) delete process.env[key];
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', MPX_ACCOUNT: 'personal', MPX_ACTIVE_CONTENT_ROOT: root, ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_TOKEN: 'fixture-only', ORCA_PANE_KEY: 'fixture-pane' });
  const posts = [];
  globalThis.fetch = async (url, request) => {
    assert.equal(String(url), 'http://127.0.0.1:1/hook/pi');
    posts.push(JSON.parse(request.body).payload);
    return new Response('', { status: 200 });
  };
  const driver = path.join(temporary, 'driver.ts');
  await writeFile(driver, `export default function(pi) {
    pi.events.on('mpx2:pi-ui:activity', state => { globalThis.__activity = state; });
    pi.on('agent_start', () => { pi.events.emit('subagents:started', {id:'held-child',type:'fixture'}); });
  }`);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  settings.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir: account, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [path.join(root, 'extensions/pi-runtime.ts'), source, driver], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: path.join(account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'model', name: 'Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }] });
  const model = runtime.getModel('fixture', 'model');
  ({ session } = await createAgentSession({ cwd, agentDir: account, modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings, resourceLoader: loader, tools: [] }));
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'Parent waiting for held child' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } });
    return stream;
  };
  await session.bindExtensions({ onError: error => { throw new Error(error.message); } });
  await session.prompt('Disposable parent/held-child event fixture');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(posts.some(post => post.hook_event_name === 'agent_end'));
  assert.equal(globalThis.__activity.state, 'working');
  console.log(JSON.stringify({ prematureDoneReproduced: true, nativeParentSession: true, childLifecycle: 'held public-event fixture; not provider execution', aggregate: globalThis.__activity, orcaPosts: posts.map(post => post.hook_event_name), networkRequests: 0, installedChanges: 0 }, null, 2));
} finally { session?.dispose(); await rm(temporary, { recursive: true, force: true }); }
