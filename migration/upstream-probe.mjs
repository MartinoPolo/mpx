// Disposable native-loading prototype. No real account, auth, model request or installed mutation.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'mpx2-upstream-probe-'));
const cwd = join(root, 'repo');
const account = join(root, 'account');
const selected = join(root, 'selected');
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = account;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const skill = (name, body) => `---\nname: ${name}\ndescription: Probe ${name}\n---\n${body}\n`;
let session;
try {
  await mkdir(join(cwd, '.pi', 'skills', 'native-project'), { recursive: true });
  // Bound ancestor .agents discovery to this disposable project, not the user's home.
  execFileSync('git', ['init', '--quiet'], { cwd });
  await mkdir(join(selected, 'mp-selected'), { recursive: true });
  await mkdir(account, { recursive: true });
  await writeFile(join(cwd, '.pi', 'skills', 'native-project', 'SKILL.md'), skill('native-project', 'NATIVE_BODY'));
  await writeFile(join(selected, 'mp-selected', 'SKILL.md'), skill('mp-selected', 'SELECTED_BODY'));
  const upstreamSource = fileURLToPath(new URL('../node_modules/@tintinweb/pi-subagents/src/skill-loader.ts', import.meta.url)).replaceAll('\\', '/');
  const extension = join(root, 'probe.ts');
  await writeFile(extension, `import { preloadSkills } from ${JSON.stringify(upstreamSource)};\nexport default function(pi) {\n pi.on('session_start', () => pi.events.emit('mpx2:probe', {named:preloadSkills(['mp-selected'], ${JSON.stringify(cwd)})}));\n pi.on('resources_discover', () => ({skillPaths:[${JSON.stringify(selected)}]}));\n}\n`);
  const { DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, createAgentSession, createEventBus } = await import('@earendil-works/pi-coding-agent');
  const settings = SettingsManager.inMemory();
  settings.setProjectTrusted(true);
  const events = createEventBus();
  let named;
  events.on('mpx2:probe', result => { named = result.named; });
  const loader = new DefaultResourceLoader({ cwd, agentDir: account, settingsManager: settings, eventBus: events, noExtensions: true, additionalExtensionPaths: [extension], noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const modelRuntime = await ModelRuntime.create({ authPath: join(account, 'auth.json'), modelsPath: join(account, 'models.json'), modelsStorePath: join(account, 'models-store.json'), allowModelNetwork: false });
  // Metadata only. No prompt() is called and no provider request is made.
  const model = modelRuntime.getModel('openai', 'gpt-4o');
  if (!model) throw new Error('Fixture model metadata unavailable; no fallback selected.');
  const beforeBind = loader.getSkills().skills.map(item => item.name);
  ({ session } = await createAgentSession({ cwd, agentDir: account, model, modelRuntime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd) }));
  await session.bindExtensions({});
  const afterBind = loader.getSkills().skills.map(item => item.name);
  const expectedGap = beforeBind.length === 1 && beforeBind[0] === 'native-project' && afterBind.length === 2 && afterBind.includes('mp-selected') && afterBind.includes('native-project') && named?.[0]?.content.includes('not found');
  console.log(JSON.stringify({ beforeBind, afterBind, named, expectedGap, modelRequests: 0 }, null, 2));
  if (!expectedGap) process.exitCode = 1;
} finally {
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
