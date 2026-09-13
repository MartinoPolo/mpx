#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSourceIntegrity } from './source-integrity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const legacyRoot = resolve(projectRoot, '../mpx-pi');
const footerSource = join(legacyRoot, 'extensions/footer.ts');
const helperSource = join(legacyRoot, 'extensions/dev-server/footer-format.ts');
const subagentsSource = join(legacyRoot, 'extensions/subagents/index.ts');
const settingsSource = join(legacyRoot, 'settings.json');
const patchPath = join(projectRoot, 'patches/legacy-footer-native-account.patch');
const RESULT_PREFIX = 'LEGACY_COMPAT_PROBE_RESULT=';
const tsxImportSpecifier = import.meta.resolve('tsx');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileHash(path) {
  return sha256(await readFile(path));
}

function isolatedEnv(fixture, accountDir) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|COOKIE|AUTH)/i.test(name)
      || /^(MPX|ORCA)_/i.test(name)
      || /^(OPENAI|ANTHROPIC|AZURE|AWS|GOOGLE|GEMINI|CODEX|GITHUB|GH|MCP)_/i.test(name)
      || /^PI_(MODEL|PROVIDER|REASONING_LEVEL|SESSION|CODING_AGENT|AUTH|ROUT)/i.test(name)) delete env[name];
  }
  const home = join(fixture, 'home');
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(fixture, 'appdata'),
    LOCALAPPDATA: join(fixture, 'localappdata'),
    XDG_CONFIG_HOME: join(fixture, 'xdg'),
    TEMP: join(fixture, 'tmp'),
    TMP: join(fixture, 'tmp'),
    PI_CODING_AGENT_DIR: accountDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  return env;
}

async function resolveDisplayEntry() {
  const configured = JSON.parse(await readFile(settingsSource, 'utf8'));
  const source = configured.packages?.find(value => typeof value === 'string' && isAbsolute(value) && /pi-tool-display/i.test(value));
  if (!source) throw new Error('Exact configured local pi-tool-display source was not found.');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'pi-tool-display' || !Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length !== 1) {
    throw new Error('Configured pi-tool-display manifest has an unexpected native entry contract.');
  }
  return { source: resolve(source), entry: resolve(source, manifest.pi.extensions[0]), version: manifest.version };
}

async function prepareFixture(display) {
  // Keeping this beneath the checkout lets the copied footer resolve the checkout's
  // Pi 0.85.1 dependencies. The directory is deleted after the bounded child exits.
  const fixture = await mkdtemp(join(projectRoot, '.legacy-compat-fixture-'));
  try {
  const accountDir = join(fixture, 'account');
  const cwd = join(fixture, 'project');
  const home = join(fixture, 'home');
  const copiedFooter = join(fixture, 'extensions/footer.ts');
  await Promise.all([
    mkdir(join(fixture, 'extensions'), { recursive: true }), mkdir(accountDir, { recursive: true }),
    mkdir(cwd, { recursive: true }), mkdir(join(home, '.pi/agent'), { recursive: true }),
    mkdir(join(fixture, 'appdata'), { recursive: true }), mkdir(join(fixture, 'localappdata'), { recursive: true }),
    mkdir(join(fixture, 'xdg'), { recursive: true }), mkdir(join(fixture, 'tmp'), { recursive: true }),
  ]);
  execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  await Promise.all([
    writeFile(join(accountDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'low', compaction: { enabled: false } }), 'utf8'),
    writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultThinkingLevel: 'high', compaction: { enabled: true } }), 'utf8'),
    writeFile(join(accountDir, 'subagents.json'), JSON.stringify({ schedulingEnabled: false }), 'utf8'),
    copyFile(footerSource, copiedFooter),
  ]);

  const fixtureRelative = relative(projectRoot, fixture).replaceAll('\\', '/');
  execFileSync('git', ['apply', `--directory=${fixtureRelative}`, patchPath], { cwd: projectRoot, stdio: 'pipe' });
  const candidateHash = await fileHash(copiedFooter);

  // footer-format.ts is a pure relative helper, not a manager entrypoint. For this
  // copied-only probe, point that single import at its read-only original rather
  // than copying the retired dev-server tree.
  const originalText = await readFile(copiedFooter, 'utf8');
  const helperSpecifier = helperSource.replaceAll('\\', '/');
  const relocated = originalText.replace('"./dev-server/footer-format.ts"', JSON.stringify(helperSpecifier));
  if (relocated === originalText) throw new Error('Footer helper import relocation did not match exactly once.');
  await writeFile(copiedFooter, relocated, 'utf8');
  return { fixture, accountDir, cwd, copiedFooter, candidateHash, display };
  } catch (error) {
    await rm(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    throw error;
  }
}

async function childMain(encoded) {
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const [{ createRequire, syncBuiltinESMExports }, fs, { default: net }, { default: tls }] = await Promise.all([
    import('node:module'), import('node:fs'), import('node:net'), import('node:tls'),
  ]);
  const require = createRequire(import.meta.url);
  const mutableFs = require('node:fs');
  const mutableNet = require('node:net');
  const mutableTls = require('node:tls');
  const originalRead = mutableFs.readFileSync;
  const selectedSettings = resolve(data.accountDir, 'settings.json').toLowerCase();
  const decoySettings = resolve(data.fixture, 'home/.pi/agent/settings.json').toLowerCase();
  const footerMarker = resolve(data.copiedFooter).replaceAll('\\', '/').toLowerCase();
  let selectedFooterRead = false;
  let decoyFooterRead = false;
  let socketAttempts = 0;
  let fetchAttempts = 0;
  mutableFs.readFileSync = function instrumentedRead(path, ...args) {
    const resolvedPath = typeof path === 'string' ? resolve(path).toLowerCase() : '';
    if (resolvedPath === selectedSettings || resolvedPath === decoySettings) {
      const stack = String(new Error().stack).replaceAll('\\', '/').toLowerCase();
      if (stack.includes(footerMarker)) {
        if (resolvedPath === selectedSettings) selectedFooterRead = true;
        if (resolvedPath === decoySettings) decoyFooterRead = true;
      }
    }
    return originalRead.call(this, path, ...args);
  };
  const rejectSocket = () => { socketAttempts++; throw new Error('Network sockets are disabled in legacy compatibility probe.'); };
  mutableNet.connect = rejectSocket;
  mutableNet.createConnection = rejectSocket;
  mutableNet.Socket.prototype.connect = rejectSocket;
  mutableTls.connect = rejectSocket;
  syncBuiltinESMExports();
  globalThis.fetch = async () => { fetchAttempts++; throw new Error('Fetch is disabled in legacy compatibility probe.'); };
  await globalThis.fetch('http://127.0.0.1:1').then(
    () => { throw new Error('Fetch rejection self-test unexpectedly succeeded.'); },
    error => { if (!/disabled/.test(String(error))) throw error; },
  );
  try {
    net.connect({ host: '127.0.0.1', port: 1 });
    throw new Error('Socket rejection self-test unexpectedly succeeded.');
  } catch (error) {
    if (!/disabled/.test(String(error))) throw error;
  }

  const [{ DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, createEventBus }, { InMemoryCredentialStore }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'), import('@earendil-works/pi-ai'),
  ]);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  settingsManager.setProjectTrusted(true);
  const eventBus = createEventBus();
  let subagentsReady = false;
  eventBus.on('subagents:ready', () => { subagentsReady = true; });
  const explicitPaths = [data.copiedFooter, data.subagentsSource, data.display.entry];
  const loader = new DefaultResourceLoader({
    cwd: data.cwd,
    agentDir: data.accountDir,
    settingsManager,
    eventBus,
    noExtensions: true,
    additionalExtensionPaths: explicitPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length || loaded.extensions.length !== explicitPaths.length) throw new Error(`Native loader errors: ${JSON.stringify(loaded.errors)}`);
  const resolvedLoaded = loaded.extensions.map(extension => resolve(extension.resolvedPath));
  for (const target of explicitPaths) if (!resolvedLoaded.includes(resolve(target))) throw new Error(`Explicit target not loaded: ${target}`);
  if (resolvedLoaded.some(path => /[\\/](dev-server|worktree|terminal-progress)[\\/]|[\\/]guard-hooks\.ts$/i.test(path))) {
    throw new Error('A retired manager/alert entrypoint was loaded.');
  }

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(data.accountDir, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('legacy-probe-fixture', {
    api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'non-codex', name: 'Non-Codex Fixture', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
  });
  const model = modelRuntime.getModel('legacy-probe-fixture', 'non-codex');
  if (!model) throw new Error('In-memory non-Codex model was not registered.');
  const created = await createAgentSession({
    cwd: data.cwd,
    agentDir: data.accountDir,
    modelRuntime,
    model,
    thinkingLevel: 'low',
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(data.cwd),
    noTools: 'builtin',
  });
  const extensionErrors = [];
  await created.session.bindExtensions({ mode: 'print', onError: error => extensionErrors.push(String(error)) });
  if (extensionErrors.length) throw new Error(`Extension bind errors: ${extensionErrors.join('; ')}`);
  if (!selectedFooterRead || decoyFooterRead) throw new Error('Footer did not exclusively read the selected disposable account settings path.');
  if (!subagentsReady) throw new Error('Retained subagents lifecycle did not bind.');
  const tools = created.session.getAllTools().map(tool => tool.name);
  for (const name of ['Agent', 'get_subagent_result', 'steer_subagent']) {
    if (tools.filter(candidate => candidate === name).length !== 1) throw new Error(`${name} was not registered exactly once.`);
  }
  if (fetchAttempts !== 1 || socketAttempts !== 1) throw new Error('Unexpected network attempt beyond rejection self-tests.');
  const piManifest = JSON.parse(await readFile(join(dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))), 'package.json'), 'utf8'));
  const result = {
    ok: true,
    piVersion: piManifest.version,
    model: `${created.session.model?.provider}/${created.session.model?.id}`,
    thinking: created.session.thinkingLevel,
    loaderTargets: { footer: true, subagents: true, configuredToolDisplay: true },
    registrations: ['Agent', 'get_subagent_result', 'steer_subagent'],
    selectedAccountSettingsReadByFooter: true,
    decoyHomeSettingsReadByFooter: false,
    retiredEntrypointsLoaded: false,
    networkPolicy: { fetchAttempts, socketAttempts, allRejected: true, socketHooksInstalled: net.connect === rejectSocket && tls.connect === rejectSocket },
  };
  created.session.dispose();
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

async function parentMain() {
  const display = await resolveDisplayEntry();
  const evidence = await withSourceIntegrity({ repositories: [legacyRoot, resolve(projectRoot, '../mpx-claude-code'), display.source] }, async () => {
  const provenance = {
    footerSource: await fileHash(footerSource),
    footerHelper: await fileHash(helperSource),
    subagentsEntry: await fileHash(subagentsSource),
    configuredToolDisplayEntry: await fileHash(display.entry),
    legacySettings: await fileHash(settingsSource),
    patch: await fileHash(patchPath),
  };
  const fixture = await prepareFixture(display);
  try {
    const encoded = Buffer.from(JSON.stringify({ ...fixture, subagentsSource })).toString('base64url');
    const child = spawnSync(process.execPath, ['--import', tsxImportSpecifier, fileURLToPath(import.meta.url), '--child', encoded], {
      cwd: fixture.cwd,
      env: isolatedEnv(fixture.fixture, fixture.accountDir),
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const marker = child.stdout?.split(/\r?\n/).find(line => line.startsWith(RESULT_PREFIX));
    if (child.status !== 0 || !marker) {
      const diagnostic = String(child.stderr || child.stdout || `exit ${child.status}`).slice(-3000);
      throw new Error(`bounded child failed: ${diagnostic}`);
    }
    const result = JSON.parse(marker.slice(RESULT_PREFIX.length));
    const after = {
      footerSource: await fileHash(footerSource), helperSource: await fileHash(helperSource),
      subagentsSource: await fileHash(subagentsSource), configuredToolDisplayEntry: await fileHash(display.entry),
      legacySettings: await fileHash(settingsSource),
    };
    if (after.footerSource !== provenance.footerSource || after.helperSource !== provenance.footerHelper
      || after.subagentsSource !== provenance.subagentsEntry || after.configuredToolDisplayEntry !== provenance.configuredToolDisplayEntry
      || after.legacySettings !== provenance.legacySettings) {
      throw new Error('A read-only legacy source changed during the probe.');
    }
    return {
      ...result,
      sourceProvenance: {
        footer: { path: footerSource, sha256: provenance.footerSource },
        helper: { path: helperSource, sha256: provenance.footerHelper },
        subagents: { path: subagentsSource, sha256: provenance.subagentsEntry },
        toolDisplay: { path: display.entry, version: display.version, sha256: provenance.configuredToolDisplayEntry },
        settings: { path: settingsSource, sha256: provenance.legacySettings },
        patch: { path: patchPath, sha256: provenance.patch, patchedFooterSha256: fixture.candidateHash },
      },
      fixtureOnlyHelperImportRelocation: true,
      sourceEntriesUnchanged: true,
      limitations: [
        'Loader/account-root evidence only: no physical TUI, provider authentication, live subagent execution, or full legacy acceptance.',
        'AgentResurrect was intentionally not loaded; its separate pilot evidence is outside this probe.',
        'The pure footer-format helper import was relocated to its original absolute read-only path only in the disposable copied footer.',
      ],
    };
  } finally {
    await rm(fixture.fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
  });
  console.log(JSON.stringify({ ...evidence, externalGitVisibleSourcesUnchanged: true }, null, 2));
}

try {
  if (process.argv[2] === '--child') await childMain(process.argv[3]);
  else await parentMain();
} catch (error) {
  console.error(`legacy-compat-probe: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
