#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNativePackages } from '../src/native-packages.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const RESULT_PREFIX = 'NATIVE_PACKAGE_PROBE_RESULT=';
const tsxImportSpecifier = import.meta.resolve('tsx');
const EXPECTED_VERSIONS = {
  personal: { 'pi-web-access': '0.28.0', 'pi-mcp-adapter': '2.32.1', '@juicesharp/rpiv-ask-user-question': '2.9.0' },
  work: { 'pi-web-access': '0.27.0', 'pi-mcp-adapter': '2.32.1', '@juicesharp/rpiv-ask-user-question': '2.9.0' },
};

function usage() {
  return 'Usage: node --import tsx migration/native-packages-probe.mjs --personal-root <absolute-agent-dir> --work-root <absolute-agent-dir>';
}

function parseRoots(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--personal-root' && flag !== '--work-root') || !value) throw new Error(usage());
    const account = flag === '--personal-root' ? 'personal' : 'work';
    if (values[account]) throw new Error(`Duplicate ${flag}.`);
    if (!isAbsolute(value)) throw new Error(`${flag} must be absolute.`);
    values[account] = resolve(value);
  }
  if (!values.personal || !values.work) throw new Error(usage());
  return values;
}

function textOf(result) {
  return (result?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function contractFor(extension) {
  return [...extension.tools.values()].map(({ definition }) => ({
    name: definition.name,
    properties: Object.keys(definition.parameters?.properties ?? {}).sort(),
    required: [...(definition.parameters?.required ?? [])].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function createTheme() {
  const passText = (_name, text) => String(text ?? '');
  return new Proxy({ fg: passText, bg: passText, bold: String, italic: String, strikethrough: String }, {
    get(target, property) { return property in target ? target[property] : String; },
  });
}

function createUi(state) {
  return {
    theme: createTheme(),
    select: async (_title, options) => state.select?.(options),
    confirm: async () => false,
    input: async () => state.input?.(),
    editor: async () => undefined,
    custom: async () => undefined,
    notify() {}, onTerminalInput() { return () => {}; }, setStatus() {}, setWorkingMessage() {},
    setWorkingVisible() {}, setWorkingIndicator() {}, setHiddenThinkingLabel() {}, setWidget() {},
    setFooter() {}, setHeader() {}, setTitle() {}, pasteToEditor() {}, setEditorText() {},
    getEditorText() { return ''; }, addAutocompleteProvider() {}, setEditorComponent() {},
    getEditorComponent() { return undefined; }, getAllThemes() { return []; }, getTheme() { return undefined; },
    setTheme() { return { success: true }; }, getToolsExpanded() { return false; }, setToolsExpanded() {},
  };
}

async function makeRuntime(data, eventBus, ui, mode) {
  const [{ DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession }, { InMemoryCredentialStore }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: data.cwd,
    agentDir: data.agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: [data.packagePath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length || loaded.extensions.length !== 1) {
    throw new Error(`Native loader failed: ${JSON.stringify(loaded.errors)}`);
  }
  if (resolve(loaded.extensions[0].resolvedPath) !== resolve(data.loadTarget)) {
    throw new Error(`Native resolver target mismatch: ${loaded.extensions[0].resolvedPath}`);
  }
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(data.agentDir, 'models-store.json'),
    refreshOnCreate: false,
  });
  const created = await createAgentSession({
    cwd: data.cwd,
    agentDir: data.agentDir,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(data.cwd),
    noTools: 'builtin',
  });
  if (ui) await created.session.bindExtensions({ uiContext: ui, mode });
  else await created.session.bindExtensions({ mode });
  return { ...created, extension: loaded.extensions[0] };
}

async function shutdownRuntime(runtime) {
  for (const extension of runtime.extensionsResult.extensions) {
    for (const handler of extension.handlers.get('session_shutdown') ?? []) {
      await handler({ type: 'session_shutdown', reason: 'quit' }, {});
    }
  }
  runtime.session.dispose();
}

async function exerciseWeb(data) {
  const { createEventBus } = await import('@earendil-works/pi-coding-agent');
  const runtime = await makeRuntime(data, createEventBus(), undefined, 'print');
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('native package probe');
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const tool = runtime.session.agent.state.tools.find(candidate => candidate.name === 'fetch_content');
    if (!tool) throw new Error('fetch_content was not active');
    const result = await tool.execute('web-loopback', { url: `http://localhost:${port}/probe`, mode: 'raw' }, undefined);
    const text = textOf(result);
    return {
      loaderTarget: runtime.extension.resolvedPath,
      tools: runtime.session.getAllTools().map(toolInfo => toolInfo.name).sort(),
      contract: contractFor(runtime.extension),
      loopback: { attempted: true, blockedBySsrf: /Blocked internal hostname|blocked internal/i.test(text), serverHits: hits, result: text.slice(0, 500) },
    };
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await shutdownRuntime(runtime);
  }
}

async function exerciseMcp(data) {
  const { createEventBus } = await import('@earendil-works/pi-coding-agent');
  const eventBus = createEventBus();
  let status;
  eventBus.on('pi-mcp-adapter/status/v1', snapshot => { status = snapshot; });
  const runtime = await makeRuntime(data, eventBus, undefined, 'print');
  try {
    const tool = runtime.session.agent.state.tools.find(candidate => candidate.name === 'mcp');
    if (!tool) throw new Error('mcp was not active');
    const result = await tool.execute('mcp-stdio', { tool: 'echo', server: 'dummy', args: { text: 'hello' } }, undefined);
    const text = textOf(result);
    return {
      loaderTarget: runtime.extension.resolvedPath,
      tools: runtime.session.getAllTools().map(toolInfo => toolInfo.name).sort(),
      contract: contractFor(runtime.extension),
      stdio: { called: true, echoed: text.includes('probe:hello'), result: text.slice(0, 500), status },
    };
  } finally {
    await shutdownRuntime(runtime);
  }
}

async function exerciseQuestion(data) {
  const { createEventBus } = await import('@earendil-works/pi-coding-agent');
  const state = {};
  const ui = createUi(state);
  const runtime = await makeRuntime(data, createEventBus(), ui, 'rpc');
  const params = { questions: [{ question: 'Choose a mode?', header: 'Mode', options: [
    { label: 'Alpha', description: 'Use alpha.' },
    { label: 'Beta', description: 'Use beta.' },
  ] }] };
  try {
    const tool = runtime.session.agent.state.tools.find(candidate => candidate.name === 'ask_user_question');
    if (!tool) throw new Error('ask_user_question was not active');
    state.select = options => options[0];
    state.input = () => undefined;
    const selected = await tool.execute('question-select', params, undefined);
    state.select = options => options.at(-1);
    state.input = () => 'A custom answer';
    const custom = await tool.execute('question-custom', params, undefined);
    state.select = () => undefined;
    const cancelled = await tool.execute('question-cancel', params, undefined);
    const raw = runtime.extension.tools.get('ask_user_question').definition;
    const headless = await raw.execute('question-headless', params, undefined, undefined, { hasUI: false });
    return {
      loaderTarget: runtime.extension.resolvedPath,
      tools: runtime.session.getAllTools().map(toolInfo => toolInfo.name).sort(),
      contract: contractFor(runtime.extension),
      callbacks: {
        select: { accepted: /Alpha/.test(textOf(selected)), result: textOf(selected).slice(0, 500) },
        custom: { accepted: /A custom answer/.test(textOf(custom)), result: textOf(custom).slice(0, 500) },
        cancel: { cancelled: /DECLINE|cancel/i.test(textOf(cancelled)), result: textOf(cancelled).slice(0, 500) },
        headless: { rejected: /UI not available/.test(textOf(headless)), result: textOf(headless).slice(0, 500) },
      },
    };
  } finally {
    await shutdownRuntime(runtime);
  }
}

async function childMain(encoded) {
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const kind = data.packageName === 'pi-web-access' ? 'web' : data.packageName === 'pi-mcp-adapter' ? 'mcp' : 'question';
  const exercise = kind === 'web' ? exerciseWeb : kind === 'mcp' ? exerciseMcp : exerciseQuestion;
  const result = await exercise(data);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ok: true, ...result })}\n`);
}

function isolatedEnv(fixture, agentDir) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|COOKIE|AUTH)/i.test(name)) delete env[name];
  }
  Object.assign(env, {
    HOME: fixture,
    USERPROFILE: fixture,
    APPDATA: join(fixture, 'appdata'),
    LOCALAPPDATA: join(fixture, 'localappdata'),
    XDG_CONFIG_HOME: join(fixture, 'xdg'),
    TEMP: join(fixture, 'tmp'),
    TMP: join(fixture, 'tmp'),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_MCP_ADAPTER_TEST_AUTH_STORE: 'memory',
    PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: '1',
    MCP_DIRECT_TOOLS: '__none__',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  return env;
}

async function resolveConfiguredPathsWithNativeManager(inspection, roots) {
  const { DefaultPackageManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const fixture = await mkdtemp(join(tmpdir(), 'mpx2-native-path-resolution-'));
  try {
    const cwd = join(fixture, 'repo');
    await mkdir(cwd, { recursive: true });
    const resolutions = [];
    for (const account of ['personal', 'work']) {
      const inspected = inspection.packages.filter(entry => entry.account === account);
      const sources = inspected.map(entry => entry.source);
      if (sources.some(source => typeof source !== 'string')) throw new Error(`${account}: configured source missing`);
      const packageManager = new DefaultPackageManager({
        cwd,
        agentDir: roots[account],
        settingsManager: SettingsManager.inMemory({ packages: sources }),
      });
      // This public method only parses configured sources and checks installed paths;
      // unlike resolve(), it has no missing-package installation path.
      const configured = packageManager.listConfiguredPackages();
      for (const entry of inspected) {
        const native = configured.find(candidate => candidate.source === entry.source);
        const nativePath = native?.installedPath;
        if (!nativePath || resolve(nativePath) !== resolve(entry.packagePath)) {
          throw new Error(`${account}/${entry.packageName}: native installed-path mismatch (${nativePath ?? 'missing'})`);
        }
        resolutions.push({
          account,
          packageName: entry.packageName,
          source: entry.source,
          nativeInstalledPath: nativePath,
          matchesInspectedPath: true,
        });
      }
    }
    return resolutions;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function writeDummyMcpServer(path) {
  await writeFile(path, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function handle(message) {
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'mpx2-probe', version: '1.0.0' } });
  if (message.method === 'tools/list') return send(message.id, { tools: [{ name: 'echo', description: 'Echo probe text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] });
  if (message.method === 'resources/list') return send(message.id, { resources: [] });
  if (message.method === 'prompts/list') return send(message.id, { prompts: [] });
  if (message.method === 'tools/call') return send(message.id, { content: [{ type: 'text', text: 'probe:' + String(message.params?.arguments?.text ?? '') }] });
  if (message.method === 'ping') return send(message.id, {});
  send(message.id, {});
}
`, 'utf8');
}

async function prepareFixture(entry) {
  const fixture = await mkdtemp(join(tmpdir(), `mpx2-native-${entry.account}-`));
  const cwd = join(fixture, 'repo');
  const agentDir = join(fixture, 'agent');
  await Promise.all([
    mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(join(fixture, 'appdata'), { recursive: true }),
    mkdir(join(fixture, 'localappdata'), { recursive: true }), mkdir(join(fixture, 'xdg'), { recursive: true }), mkdir(join(fixture, 'tmp'), { recursive: true }),
  ]);
  execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  await writeFile(join(agentDir, 'settings.json'), '{}\n', 'utf8');
  if (entry.packageName === 'pi-web-access') {
    await writeFile(join(agentDir, 'web-search.json'), JSON.stringify({
      fetchRouting: { providers: ['http'], allowRemoteHostedProviders: false },
      workflow: 'none', autoOpenBrowser: false,
    }), 'utf8');
  }
  if (entry.packageName === 'pi-mcp-adapter') {
    const serverPath = join(fixture, 'dummy-mcp-server.mjs');
    await writeDummyMcpServer(serverPath);
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({
      settings: { scriptMode: false, mcpFooterStatus: 'off', hostConfigDiscovery: 'off', outputGuard: true },
      mcpServers: { dummy: { command: process.execPath, args: [serverPath], lifecycle: 'lazy', requestTimeoutMs: 5000 } },
    }), 'utf8');
  }
  return { fixture, cwd, agentDir };
}

function assertExercise(entry, result) {
  const names = result.tools;
  if (entry.packageName === 'pi-web-access') {
    for (const name of ['web_search', 'source_check', 'fetch_content', 'get_search_content']) if (!names.includes(name)) throw new Error(`${entry.account}: missing ${name}`);
    if (!result.loopback?.blockedBySsrf || result.loopback.serverHits !== 0) throw new Error(`${entry.account}: loopback SSRF boundary was not preserved`);
  } else if (entry.packageName === 'pi-mcp-adapter') {
    if (!names.includes('mcp') || !result.stdio?.echoed) throw new Error(`${entry.account}: MCP stdio echo failed`);
  } else {
    if (!names.includes('ask_user_question')) throw new Error(`${entry.account}: question tool missing`);
    if (!Object.values(result.callbacks ?? {}).every(value => value.accepted === true || value.cancelled === true || value.rejected === true)) {
      throw new Error(`${entry.account}: question callback contract failed`);
    }
  }
}

async function parentMain(argv) {
  const roots = parseRoots(argv);
  const inspection = await inspectNativePackages([
    { account: 'personal', root: roots.personal },
    { account: 'work', root: roots.work },
  ]);
  if (!inspection.ok) throw new Error(`Missing retained artifacts: ${JSON.stringify(inspection.packages.filter(entry => entry.status !== 'ready'))}`);
  for (const entry of inspection.packages) {
    const expected = EXPECTED_VERSIONS[entry.account]?.[entry.packageName];
    if (entry.version !== expected) throw new Error(`${entry.account}/${entry.packageName}: expected ${expected}, found ${entry.version ?? 'missing'}`);
  }
  const nativePathResolutions = await resolveConfiguredPathsWithNativeManager(inspection, roots);

  const exercises = [];
  for (const entry of inspection.packages) {
    const fixture = await prepareFixture(entry);
    try {
      const data = { account: entry.account, packageName: entry.packageName, packagePath: entry.packagePath, loadTarget: entry.loadTargets[0], cwd: fixture.cwd, agentDir: fixture.agentDir };
      const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
      const child = spawnSync(process.execPath, ['--import', tsxImportSpecifier, fileURLToPath(import.meta.url), '--child', encoded], {
        cwd: fixture.cwd,
        env: isolatedEnv(fixture.fixture, fixture.agentDir),
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const marker = child.stdout?.split(/\r?\n/).find(line => line.startsWith(RESULT_PREFIX));
      if (child.status !== 0 || !marker) {
        const diagnostic = String(child.stderr || child.stdout || `exit ${child.status}`).slice(-2000);
        throw new Error(`${entry.account}/${entry.packageName} child failed: ${diagnostic}`);
      }
      const result = JSON.parse(marker.slice(RESULT_PREFIX.length));
      assertExercise(entry, result);
      exercises.push({ account: entry.account, packageName: entry.packageName, version: entry.version, packagePath: entry.packagePath, ...result });
    } finally {
      await rm(fixture.fixture, { recursive: true, force: true });
    }
  }

  const contractComparisons = [];
  for (const packageName of Object.keys(EXPECTED_VERSIONS.personal)) {
    const matching = exercises.filter(entry => entry.packageName === packageName);
    contractComparisons.push({ packageName, sameContractShape: JSON.stringify(matching[0]?.contract) === JSON.stringify(matching[1]?.contract) });
  }
  console.log(JSON.stringify({ piVersion: '0.85.1', inspection, nativePathResolutions, exercises, contractComparisons, limitations: [
    'No external provider, authenticated service, real credential store, or live terminal UI was exercised.',
    'Question UI results come from deterministic RPC/native-dialog callbacks, not human TUI acceptance.',
    'Loopback web fetch is intentionally rejected by pi-web-access SSRF policy; the local server received no request.',
  ] }, null, 2));
}

try {
  if (process.argv[2] === '--child') await childMain(process.argv[3]);
  else await parentMain(process.argv.slice(2));
} catch (error) {
  console.error(`native-packages-probe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
