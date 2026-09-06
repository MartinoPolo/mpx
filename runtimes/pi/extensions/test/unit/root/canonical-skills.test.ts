import assert from 'node:assert/strict';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, test, vi } from 'vitest';

const compiler = vi.hoisted(() => ({
  loadActiveContentProjection: vi.fn(),
  classifyCompiledSkillSource: vi.fn(),
  readActiveSkill: vi.fn(),
}));

vi.mock('@mpx/content-compiler/active', () => compiler);

import canonicalSkills from '../../../canonical-skills.js';

interface SkillEntry {
  identity: string;
  exposure: 'full' | 'name-only' | 'explicit-only';
  canonicalDescription: string;
  effectiveDescription: string;
  generatedPath: string;
  sourcePath?: string;
}

interface CommandRegistration {
  description?: string;
  handler: (args: string, ctx: { isIdle(): boolean }) => Promise<void>;
}

const integrity = { sha256: 'a'.repeat(64), byteCount: 321 };
const env = {
  MPX_RUNTIME: 'pi',
  MPX_ACTIVE_CONTENT_ROOT: 'C:/active',
  MPX_ACTIVE_CONTENT_MANIFEST: 'C:/active/active-content.json',
  MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: JSON.stringify(integrity),
};

function active(skills: SkillEntry[]) {
  return { root: 'C:/active', manifestPath: env.MPX_ACTIVE_CONTENT_MANIFEST, manifest: { skills } };
}

function harness() {
  const commands = new Map<string, CommandRegistration>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const sent: Array<{ content: string; options?: unknown }> = [];
  const api = {
    registerCommand: (name: string, command: CommandRegistration) => {
      assert.equal(commands.has(name), false, `duplicate command ${name}`);
      commands.set(name, command);
    },
    on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
  } as unknown as ExtensionAPI;
  return { api, commands, events, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  compiler.classifyCompiledSkillSource.mockImplementation((entry: SkillEntry) =>
    entry.sourcePath?.startsWith('project:') ? 'project' : 'canonical',
  );
});

test('non-MPX Pi sessions retain native skills without extension registrations', async () => {
  const state = harness();

  await canonicalSkills(state.api, { ...env, MPX_RUNTIME: undefined });

  assert.equal(state.commands.size, 0);
  assert.equal(state.events.size, 0);
  assert.equal(compiler.loadActiveContentProjection.mock.calls.length, 0);
});

test('activation registers each canonical identity once under only the mpx namespace', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'alpha',
        exposure: 'full',
        canonicalDescription: 'Alpha',
        effectiveDescription: 'Alpha',
        generatedPath: 'skills/alpha/SKILL.md',
      },
      {
        identity: 'hidden',
        exposure: 'explicit-only',
        canonicalDescription: 'Hidden',
        effectiveDescription: 'Hidden',
        generatedPath: 'skills/hidden/SKILL.md',
      },
      {
        identity: 'local',
        exposure: 'full',
        canonicalDescription: 'Local',
        effectiveDescription: 'Local',
        generatedPath: 'skills/local/SKILL.md',
        sourcePath: 'project:local',
      },
    ]),
  );
  const state = harness();

  await canonicalSkills(state.api, env);

  assert.deepEqual([...state.commands.keys()], ['mpx:alpha', 'mpx:hidden']);
  assert.equal(state.commands.get('mpx:alpha')?.description, 'Alpha');
  assert.equal(state.commands.get('mpx:hidden')?.description, 'Hidden');
});

test('name-only commands use the compiler-owned effective description', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'named',
        exposure: 'name-only',
        canonicalDescription: 'Sensitive canonical description',
        effectiveDescription:
          'MPX skill named. Load only when the user explicitly mentions named by name.',
        generatedPath: 'skills/named/SKILL.md',
      },
    ]),
  );
  const state = harness();

  await canonicalSkills(state.api, env);

  assert.equal(
    state.commands.get('mpx:named')?.description,
    'MPX skill named. Load only when the user explicitly mentions named by name.',
  );
  assert.notEqual(state.commands.get('mpx:named')?.description, 'Sensitive canonical description');
});

test('activation requires runtime-pinned manifest integrity and passes it to the shared loader', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(active([]));
  const state = harness();

  await canonicalSkills(state.api, env);

  assert.deepEqual(compiler.loadActiveContentProjection.mock.calls[0]?.[0], {
    root: env.MPX_ACTIVE_CONTENT_ROOT,
    manifestPath: env.MPX_ACTIVE_CONTENT_MANIFEST,
    expected: { runtime: 'pi', manifestFile: integrity },
  });
  await assert.rejects(
    canonicalSkills(state.api, {
      ...env,
      MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: '{"sha256":"bad","byteCount":1}',
    }),
    /integrity/i,
  );
});

test('manifest integrity mismatch fails closed before per-turn metadata is used', async () => {
  compiler.loadActiveContentProjection
    .mockResolvedValueOnce(active([]))
    .mockRejectedValueOnce(new Error('ACTIVE_CONTENT_TAMPERED'));
  const state = harness();
  await canonicalSkills(state.api, env);

  await assert.rejects(
    Promise.resolve(state.events.get('before_agent_start')?.({ systemPrompt: 'base' })),
    /TAMPERED/,
  );
});

test('startup and metadata registration do not read canonical skill bodies', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'alpha',
        exposure: 'full',
        canonicalDescription: 'Alpha',
        effectiveDescription: 'Alpha',
        generatedPath: 'skills/alpha/SKILL.md',
      },
    ]),
  );
  const state = harness();

  await canonicalSkills(state.api, env);
  await state.events.get('before_agent_start')?.({ systemPrompt: 'base' });

  assert.equal(compiler.readActiveSkill.mock.calls.length, 0);
});

test('per-turn metadata exposes full and name-only canonical skills, but not explicit-only or project skills', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'a&b',
        exposure: 'full',
        canonicalDescription: 'Use <carefully>.',
        effectiveDescription: 'Use <carefully>.',
        generatedPath: 'skills/a/SKILL.md',
      },
      {
        identity: 'names',
        exposure: 'name-only',
        canonicalDescription: 'Secret description',
        effectiveDescription:
          'MPX skill names. Load only when the user explicitly mentions names by name.',
        generatedPath: 'skills/names/SKILL.md',
      },
      {
        identity: 'manual',
        exposure: 'explicit-only',
        canonicalDescription: 'Manual',
        effectiveDescription: 'Manual',
        generatedPath: 'skills/manual/SKILL.md',
      },
      {
        identity: 'local',
        exposure: 'full',
        canonicalDescription: 'Local',
        effectiveDescription: 'Local',
        generatedPath: 'skills/local/SKILL.md',
        sourcePath: 'project:local',
      },
    ]),
  );
  const state = harness();
  await canonicalSkills(state.api, env);

  const result = (await state.events.get('before_agent_start')?.({
    systemPrompt: 'base prompt',
  })) as { systemPrompt: string };

  assert.match(result.systemPrompt, /<name>\/mpx:a&amp;b<\/name>/);
  assert.match(result.systemPrompt, /<description>Use &lt;carefully&gt;\.<\/description>/);
  assert.match(result.systemPrompt, /<name>\/mpx:names<\/name>/);
  assert.doesNotMatch(result.systemPrompt, /Secret description|manual|local/);
  assert.match(result.systemPrompt, /<location>C:\/active\/skills\/a\/SKILL\.md<\/location>/);
  assert.match(result.systemPrompt, /Use the read tool.*absolute path/s);
});

test('metadata is rebuilt from each turn event prompt without accumulating prior copies', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'alpha',
        exposure: 'full',
        canonicalDescription: 'Alpha',
        effectiveDescription: 'Alpha',
        generatedPath: 'skills/alpha/SKILL.md',
      },
    ]),
  );
  const state = harness();
  await canonicalSkills(state.api, env);
  const handler = state.events.get('before_agent_start')!;

  const first = (await handler({ systemPrompt: 'turn one' })) as { systemPrompt: string };
  const second = (await handler({ systemPrompt: 'turn two' })) as { systemPrompt: string };

  assert.match(first.systemPrompt, /^turn one/);
  assert.match(second.systemPrompt, /^turn two/);
  assert.equal(second.systemPrompt.split('<available_mpx_skills>').length, 2);
});

test('command invocation lazily reads a revalidated skill and sends native-compatible content with args', async () => {
  const entry = {
    identity: 'a&b',
    exposure: 'full' as const,
    canonicalDescription: 'Alpha',
    effectiveDescription: 'Alpha',
    generatedPath: 'skills/alpha/SKILL.md',
  };
  compiler.loadActiveContentProjection.mockResolvedValue(active([entry]));
  compiler.readActiveSkill.mockResolvedValue({
    entry,
    body: 'Body text',
    filePath: 'C:/active/skills/alpha/SKILL.md',
    baseDirectory: 'C:/active/skills/alpha',
  });
  const state = harness();
  await canonicalSkills(state.api, env);

  await state.commands.get('mpx:a&b')!.handler('focus here', { isIdle: () => true });

  assert.equal(compiler.loadActiveContentProjection.mock.calls.length, 2);
  assert.equal(compiler.readActiveSkill.mock.calls[0]?.[1], 'a&b');
  assert.equal(
    state.sent[0]?.content,
    '<skill name="mpx:a&amp;b" location="C:/active/skills/alpha/SKILL.md">\nReferences are relative to C:/active/skills/alpha.\n\nBody text\n</skill>\n\nfocus here',
  );
  assert.equal(state.sent[0]?.options, undefined);
});

test('command invocation uses supported follow-up delivery while the agent is streaming', async () => {
  const entry = {
    identity: 'alpha',
    exposure: 'full' as const,
    canonicalDescription: 'Alpha',
    effectiveDescription: 'Alpha',
    generatedPath: 'skills/alpha/SKILL.md',
  };
  compiler.loadActiveContentProjection.mockResolvedValue(active([entry]));
  compiler.readActiveSkill.mockResolvedValue({
    entry,
    body: 'Body',
    filePath: 'C:/skill/SKILL.md',
    baseDirectory: 'C:/skill',
  });
  const state = harness();
  await canonicalSkills(state.api, env);

  await state.commands.get('mpx:alpha')!.handler('', { isIdle: () => false });

  assert.deepEqual(state.sent[0]?.options, { deliverAs: 'followUp' });
});
