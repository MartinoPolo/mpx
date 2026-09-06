import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, test, vi } from 'vitest';

vi.mock('../../../subagents/settings.js', () => ({
  applyAndEmitLoaded: vi.fn(),
  saveAndEmitChanged: vi.fn(),
}));

import subagents from '../../../subagents/index.js';
import { AgentManager } from '../../../subagents/agent-manager.js';
import { registerAgents, setDefaultsDisabled } from '../../../subagents/agent-types.js';
import * as outputFiles from '../../../subagents/output-file.js';
import { SubagentScheduler } from '../../../subagents/schedule.js';
import type { AgentRecord } from '../../../subagents/types.js';

interface ToolResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
  details?: { subagentType: string; description: string; modelName?: string };
}

type AgentTool = {
  execute(
    id: string,
    parameters: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    context: ExtensionContext,
  ): Promise<ToolResult>;
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mpx-agent-invocation-'));
  vi.useFakeTimers();
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'global'));
  vi.stubEnv('MPX_COMPILED_AGENTS_DIR', join(root, 'compiled'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  setDefaultsDisabled(true);
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDefaultsDisabled(false);
  registerAgents(new Map());
  Reflect.deleteProperty(globalThis, Symbol.for('pi-subagents:manager'));
  await rm(root, { recursive: true, force: true });
});

function record(type = 'Specialist'): AgentRecord {
  return {
    id: 'agent-1',
    type,
    description: 'Stored task',
    status: 'completed',
    result: 'Finished',
    startedAt: 1,
    completedAt: 2,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    session: {} as NonNullable<AgentRecord['session']>,
    invocation: { modelName: 'stored/model' },
  };
}

function harness() {
  const tools = new Map<string, AgentTool>();
  const commands = new Map<
    string,
    { handler(input: string, context: ExtensionCommandContext): Promise<void> }
  >();
  const emit = vi.fn();
  const api = {
    registerTool: (tool: AgentTool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      command: { handler(input: string, context: ExtensionCommandContext): Promise<void> },
    ) => commands.set(name, command),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    events: { emit, on: () => () => undefined },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = {
    cwd: root,
    model: { provider: 'test', id: 'model' },
    modelRegistry: {},
    sessionManager: { getSessionId: () => 'session-1' },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      custom: vi.fn(),
      editor: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
    },
  };
  const spawn = vi.spyOn(AgentManager.prototype, 'spawn').mockReturnValue('agent-1');
  const spawnAndWait = vi
    .spyOn(AgentManager.prototype, 'spawnAndWait')
    .mockResolvedValue({ id: 'agent-1', record: record() });
  const resume = vi.spyOn(AgentManager.prototype, 'resume').mockResolvedValue(record());
  const schedule = vi.spyOn(SubagentScheduler.prototype, 'addJob');
  vi.spyOn(SubagentScheduler.prototype, 'isActive').mockReturnValue(true);
  const transcriptPath = vi
    .spyOn(outputFiles, 'createOutputFilePath')
    .mockReturnValue(join(root, 'transcript'));
  const transcriptWrite = vi
    .spyOn(outputFiles, 'writeInitialEntry')
    .mockImplementation(() => undefined);
  subagents(api);
  emit.mockClear();
  const execute = (parameters: Record<string, unknown>) =>
    tools.get('Agent')!.execute(
      'call',
      {
        description: 'Requested task',
        prompt: 'Do the work',
        ...parameters,
      },
      undefined,
      undefined,
      context as unknown as ExtensionContext,
    );
  return {
    execute,
    commands,
    context,
    spawn,
    spawnAndWait,
    resume,
    schedule,
    transcriptPath,
    transcriptWrite,
    emit,
  };
}

function assertNoExecutionSideEffects(execution: ReturnType<typeof harness>) {
  for (const operation of [
    execution.spawn,
    execution.spawnAndWait,
    execution.resume,
    execution.schedule,
    execution.transcriptPath,
    execution.transcriptWrite,
    execution.emit,
  ]) {
    assert.equal(operation.mock.calls.length, 0);
  }
}

async function defineAgent(name: string, frontmatter = '') {
  const directory = join(root, 'global', 'agents');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.md`),
    `---\ndescription: Specialist\n${frontmatter}---\nUse the specialist role.\n`,
  );
}

for (const mode of [{}, { run_in_background: true }, { schedule: 'in 1 hour' }]) {
  for (const disabled of [false, true]) {
    test(`${disabled ? 'disabled' : 'missing'} specialist is an error with no execution side effects: ${JSON.stringify(mode)}`, async () => {
      if (disabled) {
        await defineAgent('Specialist', 'enabled: false\n');
      }
      const execution = harness();
      await assert.rejects(
        execution.execute({ subagent_type: 'specialist', ...mode }),
        disabled ? /disabled/ : /Unknown agent type/,
      );
      assertNoExecutionSideEffects(execution);
    });
  }
}

test('linked-root specialist names resolve case-insensitively without changing the role', async () => {
  await defineAgent('Specialist');
  const target = join(root, 'target');
  const alias = join(root, 'global', 'agents');
  await rename(alias, target);
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const execution = harness();
  const result = await execution.execute({ subagent_type: 'sPeCiAlIsT' });
  assert.notEqual(result.isError, true);
  assert.equal(execution.spawnAndWait.mock.calls[0][2], 'Specialist');
  assert.equal(result.details?.subagentType, 'Specialist');
});

test('explicit general-purpose remains available with defaults disabled', async () => {
  const execution = harness();
  const result = await execution.execute({ subagent_type: 'GENERAL-PURPOSE' });
  assert.notEqual(result.isError, true);
  assert.equal(execution.spawnAndWait.mock.calls[0][2], 'general-purpose');
  assert.doesNotMatch(result.content[0].text!, /Unknown agent type/);
});

test('an explicitly disabled general-purpose does not bypass validation', async () => {
  await defineAgent('general-purpose', 'enabled: false\n');
  const execution = harness();
  await assert.rejects(
    execution.execute({ subagent_type: 'GENERAL-PURPOSE' }),
    /Agent type "GENERAL-PURPOSE" is disabled\./,
  );
  assertNoExecutionSideEffects(execution);
});

for (const invalidResume of ['missing', 'nested', 'inactive'] as const) {
  test(`invalid ${invalidResume} resume rejects without execution side effects`, async () => {
    const execution = harness();
    const existing = record();
    if (invalidResume === 'nested') {
      existing.parentAgentId = 'parent-agent';
    }
    if (invalidResume === 'inactive') {
      existing.session = undefined;
    }
    vi.spyOn(AgentManager.prototype, 'getRecord').mockReturnValue(
      invalidResume === 'missing' ? undefined : existing,
    );
    await assert.rejects(
      execution.execute({ subagent_type: 'Missing', resume: 'agent-1' }),
      invalidResume === 'inactive' ? /has no active session to resume/ : /Agent not found/,
    );
    assertNoExecutionSideEffects(execution);
  });
}

test('failed resume rejects instead of returning a successful tool result', async () => {
  const execution = harness();
  vi.spyOn(AgentManager.prototype, 'getRecord').mockReturnValue(record());
  execution.resume.mockResolvedValue(undefined);
  await assert.rejects(
    execution.execute({ subagent_type: 'Missing', resume: 'agent-1' }),
    /Failed to resume agent "agent-1"\./,
  );
  assert.equal(execution.resume.mock.calls.length, 1);
  execution.resume.mockClear();
  assertNoExecutionSideEffects(execution);
});

test('resume uses stored identity even when the requested type is unknown or disabled', async () => {
  await defineAgent('Disabled', 'enabled: false\n');
  const execution = harness();
  vi.spyOn(AgentManager.prototype, 'getRecord').mockReturnValue(record('StoredSpecialist'));
  execution.resume.mockResolvedValue(record('StoredSpecialist'));
  for (const requested of ['Missing', 'Disabled']) {
    const result = await execution.execute({
      subagent_type: requested,
      resume: 'agent-1',
      model: 'invalid/model',
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.details?.subagentType, 'StoredSpecialist');
    assert.equal(result.details?.description, 'Stored task');
    assert.equal(result.details?.modelName, 'stored/model');
  }
  assert.equal(execution.resume.mock.calls.length, 2);
  assert.equal(
    execution.spawn.mock.calls.length +
      execution.spawnAndWait.mock.calls.length +
      execution.schedule.mock.calls.length +
      execution.transcriptWrite.mock.calls.length,
    0,
  );
});

test('linked-root management is visibly read-only and cannot edit a lower-precedence file', async () => {
  const target = join(root, 'target');
  const projectDirectory = join(root, '.pi', 'agents');
  await mkdir(target);
  await mkdir(join(root, '.pi'));
  await writeFile(join(target, 'Specialist.md'), '---\ndescription: Linked\n---\nLinked role');
  await symlink(target, projectDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await defineAgent('Specialist');
  const execution = harness();
  execution.context.ui.custom.mockResolvedValueOnce('Specialist').mockResolvedValue(undefined);
  execution.context.ui.select.mockResolvedValueOnce('Agent types (1)');
  await execution.commands
    .get('agents')!
    .handler('', execution.context as unknown as ExtensionCommandContext);
  assert.ok(
    execution.context.ui.select.mock.calls.some(
      ([title, options]) =>
        title === 'Specialist (read-only)' && JSON.stringify(options) === '["Back"]',
    ),
  );
  assert.equal(execution.context.ui.editor.mock.calls.length, 0);
  assert.match(await readFile(join(target, 'Specialist.md'), 'utf8'), /Linked role/);
  assert.match(
    await readFile(join(root, 'global', 'agents', 'Specialist.md'), 'utf8'),
    /specialist role/,
  );
});
