import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(
  new URL('../../node_modules/@tintinweb/pi-subagents/src/', import.meta.url),
).replaceAll('\\', '/');
const trackerSymbol = Symbol.for('mpx2.subagent-policy.fixture');

export interface SubagentPolicyEvidence {
  explicit: {
    modelInput?: string;
    modelFromParams: boolean;
    thinking?: string;
    overridden?: unknown;
  };
  tighterMaxTurns?: number;
  cappedMaxTurns?: number;
  grants: {
    globalDefault: unknown;
    explicitRuntimeDenial: unknown;
    omitted: unknown;
    explicitFalse: unknown;
    none: unknown;
    empty: unknown;
    emptyList: unknown;
    all: unknown;
    selected: unknown;
  };
}

const controllerExtension = (): string => `
import { parseAllowedSubagents } from ${JSON.stringify(`${sourceRoot}custom-agents.js`)};
import { resolveAgentInvocationConfig } from ${JSON.stringify(`${sourceRoot}invocation-config.js`)};
import { resolveNestedSubagentGrant } from ${JSON.stringify(`${sourceRoot}agent-runner.js`)};

const profile = (overrides = {}) => ({
  name: 'policy-fixture', description: 'Disposable policy fixture', extensions: true,
  skills: true, systemPrompt: 'fixture', promptMode: 'replace', ...overrides,
});
const explicit = resolveAgentInvocationConfig(
  profile({ model: 'fixture/profile', thinking: 'low' }),
  { model: 'fixture/requested', thinking: 'high' },
);
globalThis[Symbol.for('mpx2.subagent-policy.fixture')] = {
  explicit: {
    modelInput: explicit.modelInput,
    modelFromParams: explicit.modelFromParams,
    thinking: explicit.thinking,
    overridden: explicit.overridden,
  },
  tighterMaxTurns: resolveAgentInvocationConfig(profile({ maxTurns: 12 }), { max_turns: 5 }).maxTurns,
  cappedMaxTurns: resolveAgentInvocationConfig(profile({ maxTurns: 12 }), { max_turns: 20 }).maxTurns,
  grants: {
    globalDefault: resolveNestedSubagentGrant(undefined),
    explicitRuntimeDenial: resolveNestedSubagentGrant([]),
    omitted: parseAllowedSubagents(undefined),
    explicitFalse: parseAllowedSubagents(false),
    none: parseAllowedSubagents('none'),
    empty: parseAllowedSubagents(''),
    emptyList: parseAllowedSubagents([]),
    all: parseAllowedSubagents(true),
    selected: parseAllowedSubagents('Explore, Plan'),
  },
};
export default function() {}
`;

export async function runSubagentPolicyFixture(): Promise<SubagentPolicyEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-subagent-policy-'));
  const account = join(root, 'account');
  const project = join(root, 'project');
  const extensionPath = join(account, 'extensions', 'policy-controller.ts');
  const previous = Reflect.get(globalThis, trackerSymbol);
  try {
    await mkdir(dirname(extensionPath), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(extensionPath, controllerExtension());
    const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir: account,
      settingsManager: SettingsManager.inMemory(),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const evidence = Reflect.get(globalThis, trackerSymbol);
    if (!evidence) throw new Error(`Policy fixture did not load: ${JSON.stringify(loader.getExtensions().errors)}`);
    return evidence as SubagentPolicyEvidence;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, trackerSymbol);
    else Reflect.set(globalThis, trackerSymbol, previous);
    await rm(root, { recursive: true, force: true });
  }
}
