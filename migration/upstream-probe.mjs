// Disposable native-session proof for the checkout-local pi-subagents patch.
// No real account, auth, provider request, installed bootstrap, or account file is touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'mpx2-subagent-packs-'));
const home = join(root, 'home');
const account = join(root, 'account');
const contentRoot = join(root, 'content-root');
const main = join(root, 'main');
const linked = join(root, 'linked');
const extension = join(root, 'probe-extension.ts');
const put = async (file, text) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
};
const skill = (name, marker) => `---\nname: ${name}\ndescription: Probe ${name}\n---\n${marker}\n`;
const runGit = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const selectedPath = (pack) => join(contentRoot, 'dist', 'packs', pack, 'pi', 'skills');
let sessions = [];

try {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = account;
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  process.env.MPX_ACTIVE_CONTENT_ROOT = contentRoot;
  process.env.MPX_ACCOUNT = 'personal';

  await mkdir(main, { recursive: true });
  runGit(['init', '--quiet'], main);
  runGit(['config', 'user.email', 'probe@example.invalid'], main);
  runGit(['config', 'user.name', 'MPX Probe'], main);
  await put(join(main, 'mpxconfig.json'), JSON.stringify({ projectId: 'probe', skillPacks: ['alpha'] }));
  await put(join(main, '.pi', 'skills', 'pi-project', 'SKILL.md'), skill('pi-project', 'PI_PROJECT_BODY'));
  await put(join(main, '.agents', 'skills', 'linked-project', 'SKILL.md'), skill('linked-project', 'LINKED_PROJECT_BODY'));
  runGit(['add', '.'], main);
  runGit(['commit', '--quiet', '-m', 'probe fixture'], main);
  runGit(['worktree', 'add', '--quiet', '-b', 'probe-linked', linked], main);

  await put(join(selectedPath('alpha'), 'mp-alpha', 'SKILL.md'), skill('mp-alpha', 'ALPHA_NAMED_BODY'));
  await put(join(selectedPath('beta'), 'mp-beta', 'SKILL.md'), skill('mp-beta', 'BETA_NAMED_BODY'));
  await put(join(account, 'skills', 'account-native', 'SKILL.md'), skill('account-native', 'ACCOUNT_BODY'));
  await put(join(home, '.agents', 'skills', 'shared-native', 'SKILL.md'), skill('shared-native', 'SHARED_BODY'));
  const unrelated = join(root, 'unrelated-package');
  await put(join(unrelated, 'package.json'), JSON.stringify({ name: 'unrelated-probe', pi: { skills: ['./skills'] } }));
  await put(join(unrelated, 'skills', 'packaged-native', 'SKILL.md'), skill('packaged-native', 'PACKAGED_BODY'));
  await put(join(account, 'settings.json'), JSON.stringify({ packages: [unrelated], defaultProjectTrust: 'always' }));

  const runnerSource = fileURLToPath(new URL('../node_modules/@tintinweb/pi-subagents/src/agent-runner.ts', import.meta.url)).replaceAll('\\', '/');
  const typesSource = fileURLToPath(new URL('../node_modules/@tintinweb/pi-subagents/src/agent-types.js', import.meta.url)).replaceAll('\\', '/');
  await writeFile(extension, `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runAgent, getSelectedMpxSkillPaths } from ${JSON.stringify(runnerSource)};
import { registerAgents } from ${JSON.stringify(typesSource)};
const base = { description: 'Probe', builtinToolNames: ['read'], extensions: false, systemPrompt: '', promptMode: 'replace' };
registerAgents(new Map([
  ['probe-discovery', { ...base, name: 'probe-discovery', skills: true }],
  ['probe-alpha', { ...base, name: 'probe-alpha', skills: ['mp-alpha'] }],
  ['probe-beta', { ...base, name: 'probe-beta', skills: ['mp-beta'] }],
]));
const inspect = (systemPrompt) => ({
  catalogAlpha: systemPrompt.includes('<name>mp-alpha</name>'),
  catalogBeta: systemPrompt.includes('<name>mp-beta</name>'),
  linkedProject: systemPrompt.includes('<name>linked-project</name>'),
  piProject: systemPrompt.includes('<name>pi-project</name>'),
  accountNative: systemPrompt.includes('<name>account-native</name>'),
  sharedNative: systemPrompt.includes('<name>shared-native</name>'),
  packagedNative: systemPrompt.includes('<name>packaged-native</name>'),
  alphaBody: systemPrompt.includes('ALPHA_NAMED_BODY'),
  betaBody: systemPrompt.includes('BETA_NAMED_BODY'),
  namedNotFound: systemPrompt.includes('not found in .pi/skills/')
});
const installFixtureStream = (session) => {
  session.agent.streamFunction = ((model, context) => {
    const text = JSON.stringify(inspect(context.systemPrompt ?? ''));
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: {
      role: 'assistant', content: [{ type: 'text', text }], api: model.api,
      provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now()
    }});
    return stream;
  });
};
export default function(pi) {
  pi.registerCommand('mpx-pack-probe', {
    description: 'Run disposable child loaders',
    handler: async (args, ctx) => {
      const [id, namedType] = args.trim().split(':');
      const inheritedPaths = getSelectedMpxSkillPaths(pi);
      const run = async (type) => {
        const result = await runAgent(ctx, type, 'Inspect native resource context.', {
          pi, onSessionCreated: installFixtureStream
        });
        try { return JSON.parse(result.responseText); }
        finally { result.session.dispose(); }
      };
      const discovery = await run('probe-discovery');
      const named = await run(namedType);
      pi.events.emit('mpx2:pack-probe', { id, inheritedPaths, discovery, named });
    }
  });
}
`);

  const {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
    createEventBus,
  } = await import('@earendil-works/pi-coding-agent');
  const modelRuntime = await ModelRuntime.create({
    authPath: join(account, 'auth.json'), modelsPath: null,
    modelsStorePath: join(account, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerProvider('mpx-probe', {
    api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
  });
  const model = modelRuntime.getModel('mpx-probe', 'fixture');
  assert.ok(model);

  const runCase = async ({ id, paths, namedType }) => {
    const events = createEventBus();
    let emitted;
    events.on('mpx2:pack-probe', (value) => { emitted = value; });
    const settings = SettingsManager.create(linked, account);
    settings.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: linked, agentDir: account, settingsManager: settings, eventBus: events,
      noExtensions: true, additionalExtensionPaths: [extension], additionalSkillPaths: paths,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: linked, agentDir: account, modelRuntime, model, resourceLoader: loader,
      settingsManager: settings, sessionManager: SessionManager.inMemory(linked), tools: [],
    });
    sessions.push(session);
    await session.bindExtensions({});
    await session.prompt(`/mpx-pack-probe ${id}:${namedType}`);
    assert.ok(emitted, `probe event missing for ${id}`);
    return emitted;
  };

  // The three parent native loaders run at the same time in one process. Their
  // selected roots come from each loader's command provenance, never shared state.
  const [alpha, beta, empty] = await Promise.all([
    runCase({ id: 'alpha', paths: [selectedPath('alpha')], namedType: 'probe-alpha' }),
    runCase({ id: 'beta', paths: [selectedPath('beta')], namedType: 'probe-beta' }),
    runCase({ id: 'empty', paths: [], namedType: 'probe-alpha' }),
  ]);

  assert.deepEqual(alpha.inheritedPaths, [selectedPath('alpha')]);
  assert.deepEqual(beta.inheritedPaths, [selectedPath('beta')]);
  assert.deepEqual(empty.inheritedPaths, []);
  assert.deepEqual(alpha.discovery, {
    catalogAlpha: true, catalogBeta: false, linkedProject: true, piProject: true,
    accountNative: true, sharedNative: true, packagedNative: true,
    alphaBody: false, betaBody: false, namedNotFound: false,
  });
  assert.deepEqual(beta.discovery, {
    catalogAlpha: false, catalogBeta: true, linkedProject: true, piProject: true,
    accountNative: true, sharedNative: true, packagedNative: true,
    alphaBody: false, betaBody: false, namedNotFound: false,
  });
  for (const selected of [alpha.named, beta.named]) {
    assert.equal(selected.namedNotFound, false);
  }
  assert.equal(alpha.named.alphaBody, true);
  assert.equal(alpha.named.betaBody, false);
  assert.equal(beta.named.alphaBody, false);
  assert.equal(beta.named.betaBody, true);
  assert.equal(empty.discovery.catalogAlpha, false);
  assert.equal(empty.discovery.catalogBeta, false);
  assert.equal(empty.discovery.linkedProject, true);
  assert.equal(empty.discovery.packagedNative, true);
  assert.equal(empty.named.alphaBody, false);
  assert.equal(empty.named.namedNotFound, true);

  const commonDir = runGit(['rev-parse', '--git-common-dir'], linked).toString().trim();
  const linkedConfig = JSON.parse(await readFile(join(linked, 'mpxconfig.json'), 'utf8'));
  const output = {
    version: '0.19.0',
    linkedWorktree: !commonDir.startsWith(join(linked, '.git')) && linkedConfig.skillPacks[0] === 'alpha',
    concurrentSelections: { alpha: alpha.inheritedPaths, beta: beta.inheritedPaths, empty: empty.inheritedPaths },
    alpha: { discovery: alpha.discovery, named: alpha.named },
    beta: { discovery: beta.discovery, named: beta.named },
    empty: { discovery: empty.discovery, named: empty.named },
    providerRequests: 0,
  };
  assert.equal(output.linkedWorktree, true);
  console.log(JSON.stringify(output, null, 2));
} finally {
  for (const session of sessions) session.dispose();
  await rm(root, { recursive: true, force: true });
}
