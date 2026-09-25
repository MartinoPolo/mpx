import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

const runnerSource = fileURLToPath(
  new URL('../../node_modules/@tintinweb/pi-subagents/src/agent-runner.js', import.meta.url),
).replaceAll('\\', '/');
const agentTypesSource = fileURLToPath(
  new URL('../../node_modules/@tintinweb/pi-subagents/src/agent-types.js', import.meta.url),
).replaceAll('\\', '/');
const parentOnlyExtensions = [
  'orca-agent-status',
  'orca-titlebar-spinner',
  'orca-prefill',
] as const;
const retainedExtensions = ['authorized-test-mcp', 'authorized-safeguard'] as const;
const parentOnlyExtensionNames = new Set<string>(parentOnlyExtensions);
const allFixtureExtensions = [...parentOnlyExtensions, ...retainedExtensions] as const;
const trackerSymbol = Symbol.for('mpx.subagent-isolation.fixture');
const processProbeEvent = 'mpx:subagent-isolation:process-probe';

interface ActivationEvidence {
  name: string;
  run: 'parent' | 'isolation-baseline' | 'isolation-excluded';
  eventBusEvents: number;
  processEvents: number;
  settledEvents: number;
}

interface FixtureTracker {
  activations: ActivationEvidence[];
  eventBusTriggers: Array<() => void>;
  cleanup: Array<() => void>;
  result?: Pick<SubagentIsolationEvidence, 'baselineChild' | 'excludedChild'>;
  error?: string;
  loadingRun?: 'isolation-baseline' | 'isolation-excluded';
}

interface ChildEvidence {
  activations: ActivationEvidence[];
  allToolNames: string[];
  activeToolNames: string[];
  authorizedSkillLoaded: boolean;
  requestedConfigMarkerLoaded: boolean;
  responseText: string;
}

export interface SubagentIsolationEvidence {
  parent: {
    activations: ActivationEvidence[];
    allToolNames: string[];
    activeToolNames: string[];
    authorizedSkillLoaded: boolean;
  };
  baselineChild: ChildEvidence;
  excludedChild: ChildEvidence;
  providerRequests: number;
}

const put = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const fixtureExtension = (name: string): string => `
import { Type } from 'typebox';

const tracker = globalThis[Symbol.for('mpx.subagent-isolation.fixture')];
export default function(pi) {
  const activation = {
    name: ${JSON.stringify(name)},
    run: tracker.loadingRun ?? 'parent',
    eventBusEvents: 0,
    processEvents: 0,
    settledEvents: 0,
  };
  tracker.activations.push(activation);

  const busEvent = ${JSON.stringify(`mpx:subagent-isolation:bus:${name}`)};
  pi.events.on(busEvent, () => { activation.eventBusEvents += 1; });
  tracker.eventBusTriggers.push(() => pi.events.emit(busEvent, undefined));

  const processListener = () => { activation.processEvents += 1; };
  process.on(${JSON.stringify(processProbeEvent)}, processListener);
  tracker.cleanup.push(() => process.off(${JSON.stringify(processProbeEvent)}, processListener));

  pi.on('agent_settled', () => { activation.settledEvents += 1; });
  pi.registerTool({
    name: ${JSON.stringify(`${name}-tool`)},
    label: ${JSON.stringify(name)},
    description: 'Disposable isolation probe tool.',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'fixture-only' }], details: {} }; },
  });
}
`;

const controllerExtension = (explicitParentOnlyExtension: string): string => `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runAgent } from ${JSON.stringify(runnerSource)};
import { registerAgents } from ${JSON.stringify(agentTypesSource)};

const base = {
  description: 'Disposable child extension isolation probe',
  builtinToolNames: ['read', 'bash'],
  extensions: ['*', ${JSON.stringify(explicitParentOnlyExtension)}],
  skills: true,
  promptMode: 'replace',
};
registerAgents(new Map([
  ['isolation-baseline', {
    ...base,
    name: 'isolation-baseline',
    systemPrompt: 'REQUESTED_CONFIG:isolation-baseline',
  }],
  ['isolation-excluded', {
    ...base,
    name: 'isolation-excluded',
    systemPrompt: 'REQUESTED_CONFIG:isolation-excluded',
    excludeExtensions: ${JSON.stringify(parentOnlyExtensions)},
  }],
]));

const installFixtureStream = (session) => {
  session.agent.streamFunction = ((model) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: {
      role: 'assistant', content: [{ type: 'text', text: 'fixture-child-complete' }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    }});
    return stream;
  });
};

export default function(pi) {
  pi.registerCommand('subagent-isolation-probe', {
    description: 'Run disposable same-process child sessions',
    handler: async (_args, ctx) => {
      const tracker = globalThis[Symbol.for('mpx.subagent-isolation.fixture')];
      try {
      const run = async (type) => {
        const firstActivation = tracker.activations.length;
        const firstEventBusTrigger = tracker.eventBusTriggers.length;
        let sessionEvidence;
        tracker.loadingRun = type;
        let result;
        try {
          result = await runAgent(ctx, type, 'Complete the offline fixture.', {
            pi,
            toolCeiling: [
              'read',
              ${retainedExtensions.map(name => JSON.stringify(`${name}-tool`)).join(',\n              ')},
            ],
            onSessionCreated(session) {
              installFixtureStream(session);
              sessionEvidence = {
                allToolNames: session.getAllTools().map((tool) => tool.name).sort(),
                activeToolNames: session.getActiveToolNames().slice().sort(),
                authorizedSkillLoaded: session.systemPrompt.includes('<name>authorized-skill</name>'),
                requestedConfigMarkerLoaded: session.systemPrompt.includes('REQUESTED_CONFIG:' + type),
              };
            },
          });
        } finally {
          tracker.loadingRun = undefined;
        }
        try {
          for (const trigger of tracker.eventBusTriggers.slice(firstEventBusTrigger)) trigger();
          process.emit(${JSON.stringify(processProbeEvent)});
          return {
            activations: tracker.activations.slice(firstActivation).map((activation) => ({ ...activation })),
            ...sessionEvidence,
            responseText: result.responseText,
          };
        } finally {
          result.session.dispose();
        }
      };

      const baselineChild = await run('isolation-baseline');
      const excludedChild = await run('isolation-excluded');
      tracker.result = { baselineChild, excludedChild };
      pi.events.emit('mpx:subagent-isolation:result', tracker.result);
      } catch (error) {
        tracker.error = error instanceof Error ? error.stack ?? error.message : String(error);
        throw error;
      }
    },
  });
}
`;

export async function runSubagentIsolationFixture(): Promise<SubagentIsolationEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-subagent-isolation-'));
  const home = join(root, 'home');
  const account = join(root, 'account');
  const project = join(root, 'project');
  const environmentKeys = [
    'HOME',
    'USERPROFILE',
    'PI_CODING_AGENT_DIR',
    'PI_OFFLINE',
    'PI_TELEMETRY',
    'MPX_ACTIVE_CONTENT_ROOT',
    'MPX_ACCOUNT',
  ] as const;
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const tracker: FixtureTracker = { activations: [], eventBusTriggers: [], cleanup: [] };
  const previousMaximumListeners = process.getMaxListeners();
  process.setMaxListeners(previousMaximumListeners + allFixtureExtensions.length * 3);
  Reflect.set(globalThis, trackerSymbol, tracker);
  const previousFetch = globalThis.fetch;
  let fetchReplaced = false;
  let providerRequests = 0;
  let parentSession: AgentSession | undefined;

  try {
    globalThis.fetch = async () => {
      providerRequests += 1;
      throw new Error('The disposable isolation fixture forbids provider and network requests.');
    };
    fetchReplaced = true;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_CODING_AGENT_DIR = account;
    process.env.PI_OFFLINE = '1';
    process.env.PI_TELEMETRY = '0';
    process.env.MPX_ACTIVE_CONTENT_ROOT = join(root, 'content-root');
    process.env.MPX_ACCOUNT = 'personal';

    await mkdir(project, { recursive: true });
    for (const name of allFixtureExtensions) {
      await put(join(account, 'extensions', `${name}.ts`), fixtureExtension(name));
    }
    const explicitParentOnlyExtension = join(root, 'explicit', 'orca-agent-status.ts');
    await put(explicitParentOnlyExtension, fixtureExtension('orca-agent-status'));
    await put(
      join(account, 'extensions', 'isolation-controller.ts'),
      controllerExtension(explicitParentOnlyExtension),
    );
    await put(
      join(account, 'skills', 'authorized-skill', 'SKILL.md'),
      '---\nname: authorized-skill\ndescription: Disposable isolation probe skill\n---\nAUTHORIZED_SKILL_BODY\n',
    );
    await put(join(account, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }));

    const {
      createAgentSession,
      createEventBus,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import('@earendil-works/pi-coding-agent');
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');

    const modelRuntime = await ModelRuntime.create({
      authPath: join(account, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(account, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider('isolation-fixture', {
      api: 'openai-completions',
      apiKey: 'fixture-only',
      baseUrl: 'http://127.0.0.1:1',
      models: [{
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1_000,
      }],
    });
    const model = modelRuntime.getModel('isolation-fixture', 'fixture');
    assert.ok(model);

    const events = createEventBus();
    const settings = SettingsManager.create(project, account);
    settings.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir: account,
      settingsManager: settings,
      eventBus: events,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const created = await createAgentSession({
      cwd: project,
      agentDir: account,
      modelRuntime,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(project),
    });
    parentSession = created.session;
    await parentSession.bindExtensions({});
    parentSession.agent.streamFunction = ((streamModel) => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'fixture-parent-complete' }],
          api: streamModel.api,
          provider: streamModel.provider,
          model: streamModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      });
      return stream;
    });

    await parentSession.prompt('Complete the parent lifecycle fixture.');
    for (const trigger of tracker.eventBusTriggers) trigger();
    EventEmitter.prototype.emit.call(process, processProbeEvent);
    const parent = {
      activations: tracker.activations
        .filter((activation) => activation.run === 'parent')
        .map((activation) => ({ ...activation })),
      allToolNames: parentSession.getAllTools().map((tool) => tool.name).sort(),
      activeToolNames: parentSession.getActiveToolNames().slice().sort(),
      authorizedSkillLoaded: parentSession.agent.state.systemPrompt.includes('<name>authorized-skill</name>'),
    };
    await parentSession.prompt('/subagent-isolation-probe');
    assert.ok(
      tracker.result,
      `child isolation command failed: ${tracker.error ?? JSON.stringify(parentSession.messages)}`,
    );

    return { parent, ...tracker.result, providerRequests };
  } finally {
    if (fetchReplaced) globalThis.fetch = previousFetch;
    parentSession?.dispose();
    for (const cleanup of tracker.cleanup) cleanup();
    process.setMaxListeners(previousMaximumListeners);
    Reflect.deleteProperty(globalThis, trackerSymbol);
    for (const key of environmentKeys) {
      const previous = previousEnvironment.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

export interface NativeExtensionFilterEvidence {
  postLoadOverride: {
    factoryActivations: string[];
    loadedExtensions: string[];
  };
  settingsPatterns: {
    factoryActivations: string[];
    loadedExtensions: string[];
  };
}

export async function runNativeExtensionFilterFeasibilityFixture(): Promise<NativeExtensionFilterEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-extension-filter-'));
  const extensionNames = [...allFixtureExtensions];

  const runCase = async (
    name: string,
    configure: (
      account: string,
      marker: string,
    ) => Promise<NativeExtensionFilterEvidence['postLoadOverride']>,
  ): Promise<NativeExtensionFilterEvidence['postLoadOverride']> => {
    const account = join(root, name, 'account');
    const marker = join(root, name, 'factory-activations.txt');
    for (const extensionName of extensionNames) {
      await put(
        join(account, 'extensions', `${extensionName}.ts`),
        `import { appendFileSync } from 'node:fs';\n`
          + `export default function() { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${extensionName}\n`)}); }\n`,
      );
    }
    return configure(account, marker);
  };

  const readActivations = async (marker: string): Promise<string[]> => {
    try {
      return (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean).sort();
    } catch {
      return [];
    }
  };
  const extensionName = (path: string): string => basename(path).replace(/\.(ts|js)$/, '');

  try {
    const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const postLoadOverride = await runCase('post-load-override', async (account, marker) => {
      const settings = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd: join(root, 'post-load-override', 'project'),
        agentDir: account,
        settingsManager: settings,
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter(
            (extension) => !parentOnlyExtensionNames.has(extensionName(extension.path)),
          ),
        }),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      return {
        factoryActivations: await readActivations(marker),
        loadedExtensions: loader.getExtensions().extensions.map((extension) => extensionName(extension.path)).sort(),
      };
    });

    const settingsPatterns = await runCase('settings-patterns', async (account, marker) => {
      const settings = SettingsManager.inMemory({
        extensions: [
          '-extensions/orca-agent-status.ts',
          '!extensions/orca-titlebar-spinner.ts',
          '-extensions/orca-prefill.ts',
        ],
      });
      const loader = new DefaultResourceLoader({
        cwd: join(root, 'settings-patterns', 'project'),
        agentDir: account,
        settingsManager: settings,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      return {
        factoryActivations: await readActivations(marker),
        loadedExtensions: loader.getExtensions().extensions.map((extension) => extensionName(extension.path)).sort(),
      };
    });

    return { postLoadOverride, settingsPatterns };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
