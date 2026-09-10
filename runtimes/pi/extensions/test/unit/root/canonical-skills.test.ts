import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CombinedAutocompleteProvider,
  Editor,
  TuiMainScreen,
  type EditorTheme,
  type Terminal,
} from '@earendil-works/pi-tui';
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

function harness(nativeCommands: unknown[] = []) {
  const commands = new Map<string, CommandRegistration>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const sent: Array<{ content: string; options?: unknown }> = [];
  const autocompleteFactories: Array<(current: any) => any> = [];
  const api = {
    registerCommand: (name: string, command: CommandRegistration) => {
      assert.equal(commands.has(name), false, `duplicate command ${name}`);
      commands.set(name, command);
    },
    on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    getCommands: () => nativeCommands,
    sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
  } as unknown as ExtensionAPI;
  const sessionContext = {
    ui: {
      addAutocompleteProvider: (factory: (current: any) => any) => {
        autocompleteFactories.push(factory);
      },
    },
  };
  return {
    api,
    commands,
    events,
    sent,
    sessionContext,
    autocompleteFactories,
    autocomplete: (current: any) => autocompleteFactories.at(-1)?.(current),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  compiler.classifyCompiledSkillSource.mockImplementation((entry: SkillEntry) =>
    entry.sourcePath?.startsWith('project:') || entry.sourcePath?.startsWith('.agents/')
      ? 'project'
      : 'canonical',
  );
});

test('non-MPX Pi sessions retain native skills without extension registrations', async () => {
  const state = harness();

  await canonicalSkills(state.api, { ...env, MPX_RUNTIME: undefined });

  assert.equal(state.commands.size, 0);
  assert.equal(state.events.size, 0);
  assert.equal(compiler.loadActiveContentProjection.mock.calls.length, 0);
});

test('pasted prose with an empty line in a code fence continues without skill expansion', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(active([]));
  const state = harness();
  await canonicalSkills(state.api, env);

  const text = 'The plan is settled.\n\n```text\n✓ Ready\n\nSave available sessions.\n```';
  const result = await state.events.get('input')?.({ text, source: 'interactive' }, {});

  assert.deepEqual(result, { action: 'continue' });
  assert.equal(compiler.readActiveSkill.mock.calls.length, 0);
  assert.deepEqual(state.sent, []);
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

test('autocomplete offers active canonical and accepted project skill names without descriptions or body reads', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'review',
        exposure: 'full',
        canonicalDescription: 'Secret',
        effectiveDescription: 'Secret',
        generatedPath: 'skills/review/SKILL.md',
      },
      {
        identity: 'manual',
        exposure: 'explicit-only',
        canonicalDescription: 'Manual secret',
        effectiveDescription: 'Manual secret',
        generatedPath: 'skills/manual/SKILL.md',
      },
      {
        identity: 'skill:diagnose',
        exposure: 'explicit-only',
        canonicalDescription: 'Project secret',
        effectiveDescription: 'Project secret',
        sourcePath: '.agents/skills/diagnose/SKILL.md',
        generatedPath: 'project-skills/skills/diagnose/SKILL.md',
      },
    ]),
  );
  const state = harness([
    {
      name: 'skill:deploy',
      description: 'Deploy secret',
      source: 'skill',
      sourceInfo: {
        path: 'C:/repo/.agents/skills/deploy/SKILL.md',
        source: 'project',
        scope: 'project',
        origin: 'top-level',
        baseDir: 'C:/repo',
      },
    },
  ]);
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  const delegated = {
    getSuggestions: vi.fn(),
    applyCompletion: vi.fn(),
    shouldTriggerFileCompletion: vi.fn(),
  };
  const provider = state.autocomplete(delegated);

  const canonical = await provider.getSuggestions(['Please /mpx:'], 0, 12, {});
  const project = await provider.getSuggestions(['/skill:d'], 0, 8, {});

  assert.deepEqual(canonical, {
    prefix: '/mpx:',
    items: [
      { value: '/mpx:manual', label: '/mpx:manual' },
      { value: '/mpx:review', label: '/mpx:review' },
    ],
  });
  assert.deepEqual(project, {
    prefix: '/skill:d',
    items: [
      { value: '/skill:deploy', label: '/skill:deploy' },
      { value: '/skill:diagnose', label: '/skill:diagnose' },
    ],
  });
  assert.equal(compiler.readActiveSkill.mock.calls.length, 0);
});

test('autocomplete replaces the whole reference at the cursor without corrupting trailing prose', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'review',
        exposure: 'full',
        canonicalDescription: 'Review',
        effectiveDescription: 'Review',
        generatedPath: 'skills/review/SKILL.md',
      },
    ]),
  );
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  const current = {
    getSuggestions: vi.fn(),
    applyCompletion: vi.fn().mockReturnValue({ lines: ['wrong'], cursorLine: 0, cursorCol: 5 }),
  };
  const provider = state.autocomplete(current);
  const suggestions = await provider.getSuggestions(['Use /mpx:review later'], 0, 14, {});

  const applied = provider.applyCompletion(
    ['Use /mpx:review later'],
    0,
    14,
    suggestions.items[0],
    suggestions.prefix,
  );

  assert.deepEqual(applied, {
    lines: ['Use /mpx:review later'],
    cursorLine: 0,
    cursorCol: 15,
  });
});

test('autocomplete delegates unrelated slash and path completion', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(active([]));
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  const expected = { prefix: './', items: [] };
  const current = {
    getSuggestions: vi.fn().mockResolvedValue(expected),
    applyCompletion: vi.fn(),
    shouldTriggerFileCompletion: vi.fn().mockReturnValue(false),
  };
  const provider = state.autocomplete(current);

  assert.equal(await provider.getSuggestions(['open ./'], 0, 7, {}), expected);
  assert.equal(provider.shouldTriggerFileCompletion(['open ./'], 0, 7), false);
});

test('same-name canonical and managed project skills register distinct qualified commands', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'review',
        exposure: 'full',
        canonicalDescription: 'Canonical review',
        effectiveDescription: 'Canonical review',
        generatedPath: 'skills/review/SKILL.md',
      },
      {
        identity: 'skill:review',
        exposure: 'name-only',
        canonicalDescription: 'Project secret',
        effectiveDescription: 'Project review',
        sourcePath: '.agents/skills/review/SKILL.md',
        generatedPath: 'project-skills/skills/review/SKILL.md',
      },
    ]),
  );
  compiler.readActiveSkill.mockResolvedValue({
    body: 'Body',
    filePath: 'C:/active/skill/SKILL.md',
    baseDirectory: 'C:/active/skill',
  });
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

  await state.commands.get('mpx:review')!.handler('', { isIdle: () => true });
  await state.commands.get('skill:review')!.handler('', { isIdle: () => true });

  assert.deepEqual([...state.commands.keys()], ['mpx:review', 'skill:review']);
  assert.deepEqual(
    compiler.readActiveSkill.mock.calls.map((call) => call.slice(1)),
    [
      ['review', 'canonical'],
      ['review', 'project'],
    ],
  );
});

test('factory initialization does not query session-bound commands before session_start', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'skill:deploy',
        exposure: 'full',
        canonicalDescription: 'Deploy',
        effectiveDescription: 'Deploy',
        sourcePath: '.agents/skills/deploy/SKILL.md',
        generatedPath: 'project-skills/skills/deploy/SKILL.md',
      },
    ]),
  );
  const state = harness();
  let sessionStarted = false;
  (state.api as unknown as { getCommands(): unknown[] }).getCommands = () => {
    if (!sessionStarted) {
      throw new Error('Extension runtime not initialized');
    }
    return [];
  };

  await canonicalSkills(state.api, env);
  sessionStarted = true;
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

  assert.equal(state.commands.has('skill:deploy'), true);
});

test('managed project commands defer to a conflicting native projected skill command', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'skill:deploy',
        exposure: 'full',
        canonicalDescription: 'Deploy',
        effectiveDescription: 'Deploy',
        sourcePath: '.agents/skills/deploy/SKILL.md',
        generatedPath: 'project-skills/skills/deploy/SKILL.md',
      },
    ]),
  );
  const state = harness([
    {
      name: 'skill:deploy',
      source: 'skill',
      sourceInfo: { source: 'cli', scope: 'explicit', path: 'C:/active/deploy/SKILL.md' },
    },
  ]);

  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

  assert.equal(state.commands.has('skill:deploy'), false);
});

test('project skill discovery accepts Pi project scope regardless of the SDK source label', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(active([]));
  const state = harness([
    {
      name: 'skill:deploy',
      source: 'skill',
      sourceInfo: {
        path: 'C:/repo/.agents/skills/deploy/SKILL.md',
        source: 'local',
        scope: 'project',
        origin: 'top-level',
        baseDir: 'C:/repo',
      },
    },
  ]);
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  const provider = state.autocomplete({
    getSuggestions: vi.fn(),
    applyCompletion: vi.fn(),
  });

  const result = await provider.getSuggestions(['/skill:d'], 0, 8, {});

  assert.deepEqual(result.items, [{ value: '/skill:deploy', label: '/skill:deploy' }]);
});

test('repeated session_start refreshes one autocomplete layer with the current inventory', async () => {
  compiler.loadActiveContentProjection
    .mockResolvedValueOnce(
      active([
        {
          identity: 'old',
          exposure: 'full',
          canonicalDescription: 'Old',
          effectiveDescription: 'Old',
          generatedPath: 'skills/old/SKILL.md',
        },
      ]),
    )
    .mockResolvedValueOnce(active([]))
    .mockResolvedValue(
      active([
        {
          identity: 'current',
          exposure: 'full',
          canonicalDescription: 'Current',
          effectiveDescription: 'Current',
          generatedPath: 'skills/current/SKILL.md',
        },
      ]),
    );
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  await state.events.get('session_start')?.({ reason: 'resume' }, state.sessionContext);
  const delegated = {
    getSuggestions: vi.fn().mockResolvedValue({ prefix: './', items: [] }),
    applyCompletion: vi.fn(),
  };
  const provider = state.autocomplete(delegated);

  const managed = await provider.getSuggestions(['/mpx:'], 0, 5, {});
  await provider.getSuggestions(['open ./'], 0, 7, {});

  assert.equal(state.autocompleteFactories.length, 1);
  assert.deepEqual(managed.items, [{ value: '/mpx:current', label: '/mpx:current' }]);
  assert.equal(delegated.getSuggestions.mock.calls.length, 1);
});

test('failed validation clears cached completion names before any later suggestion', async () => {
  const trusted = active([
    {
      identity: 'trusted',
      exposure: 'full',
      canonicalDescription: 'Trusted',
      effectiveDescription: 'Trusted',
      generatedPath: 'skills/trusted/SKILL.md',
    },
  ]);
  compiler.loadActiveContentProjection
    .mockResolvedValueOnce(trusted)
    .mockResolvedValueOnce(trusted)
    .mockRejectedValue(new Error('ACTIVE_CONTENT_TAMPERED'));
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);
  await assert.rejects(
    Promise.resolve(state.events.get('before_agent_start')?.({ systemPrompt: 'base' })),
    /TAMPERED/,
  );
  const provider = state.autocomplete({ getSuggestions: vi.fn(), applyCompletion: vi.fn() });

  const result = await provider.getSuggestions(['/mpx:t'], 0, 6, {});

  assert.deepEqual(result.items, []);
  assert.equal(compiler.readActiveSkill.mock.calls.length, 0);
});

test('submitting both managed namespaces loads each qualified identity once and preserves every reference', async () => {
  compiler.loadActiveContentProjection.mockResolvedValue(
    active([
      {
        identity: 'review',
        exposure: 'full',
        canonicalDescription: 'Canonical',
        effectiveDescription: 'Canonical',
        generatedPath: 'skills/review/SKILL.md',
      },
      {
        identity: 'skill:review',
        exposure: 'full',
        canonicalDescription: 'Project',
        effectiveDescription: 'Project',
        sourcePath: '.agents/skills/review/SKILL.md',
        generatedPath: 'project-skills/skills/review/SKILL.md',
      },
    ]),
  );
  compiler.readActiveSkill.mockImplementation(async (_active, _identity, source) => ({
    body: `${source} body`,
    filePath: `C:/active/${source}/SKILL.md`,
    baseDirectory: `C:/active/${source}`,
  }));
  const state = harness();
  await canonicalSkills(state.api, env);
  await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

  const result = (await state.events.get('input')?.(
    {
      text: 'First /mpx:review, then /skill:review and /mpx:review.',
      source: 'interactive',
      streamingBehavior: 'followUp',
    },
    {},
  )) as { text: string };

  assert.equal(compiler.readActiveSkill.mock.calls.length, 2);
  assert.deepEqual(
    compiler.readActiveSkill.mock.calls.map((call) => call.slice(1)),
    [
      ['review', 'canonical'],
      ['review', 'project'],
    ],
  );
  assert.match(result.text, /^First <skill name="mpx:review"/);
  assert.match(result.text, /then <skill name="skill:review"/);
  assert.match(result.text, /and <skill name="mpx:review"[\s\S]*\.$/);
});

test('submitting an exact inline canonical reference lazily inserts its verified body while preserving prose', async () => {
  const entry = {
    identity: 'review',
    exposure: 'full' as const,
    canonicalDescription: 'Review',
    effectiveDescription: 'Review',
    generatedPath: 'skills/review/SKILL.md',
  };
  compiler.loadActiveContentProjection.mockResolvedValue(active([entry]));
  compiler.readActiveSkill.mockResolvedValue({
    entry,
    body: 'Review body',
    filePath: 'C:/active/skills/review/SKILL.md',
    baseDirectory: 'C:/active/skills/review',
  });
  const state = harness();
  await canonicalSkills(state.api, env);

  const result = await state.events.get('input')?.(
    { text: 'Please /mpx:review this change', source: 'interactive' },
    {},
  );

  assert.match(
    (result as { text: string }).text,
    /^Please <skill name="mpx:review"[\s\S]*Review body[\s\S]*<\/skill> this change$/,
  );
  assert.equal(compiler.readActiveSkill.mock.calls.length, 1);
});

async function realProjectionFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-pi-canonical-skills-'));
  const canonicalPath = 'skills/deploy/SKILL.md';
  const projectPath = 'project-skills/skills/deploy/SKILL.md';
  const canonicalBytes = Buffer.from('canonical projected body\n');
  const projectBytes = Buffer.from('managed projected body\n');
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.join(root, 'skills', 'deploy'), { recursive: true });
  await mkdir(path.join(root, 'project-skills', 'skills', 'deploy'), { recursive: true });
  await writeFile(path.join(root, ...canonicalPath.split('/')), canonicalBytes);
  await writeFile(path.join(root, ...projectPath.split('/')), projectBytes);
  const manifest = {
    schemaVersion: 2,
    compilerVersion: '2.0.0',
    runtime: 'pi',
    profileSchemaVersion: 1,
    binding: {
      projectId: 'project',
      repositoryId: 'repo',
      identity: 'test',
      selection: {
        location: { name: 'test', canonicalRoot: root },
        packs: ['development'],
        source: 'project',
      },
    },
    manifestKey: 'manifest-key',
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills: [
      {
        identity: 'deploy',
        exposure: 'full',
        canonicalDescription: 'Canonical deploy.',
        effectiveDescription: 'Canonical deploy.',
        sourcePath: 'content/skills/deploy/SKILL.md',
        generatedPath: canonicalPath,
        generatedSha256: sha256(canonicalBytes),
        bodyByteOffset: 0,
        omittedOptionalFeatures: [],
      },
      {
        identity: 'skill:deploy',
        exposure: 'full',
        canonicalDescription: 'Managed deploy.',
        effectiveDescription: 'Managed deploy.',
        sourcePath: '.agents/skills/deploy/SKILL.md',
        generatedPath: projectPath,
        generatedSha256: sha256(projectBytes),
        bodyByteOffset: 0,
        omittedOptionalFeatures: [],
      },
    ],
    agents: [],
    files: [
      {
        relativePath: projectPath,
        sha256: sha256(projectBytes),
        byteCount: projectBytes.byteLength,
      },
      {
        relativePath: canonicalPath,
        sha256: sha256(canonicalBytes),
        byteCount: canonicalBytes.byteLength,
      },
    ],
  };
  const manifestPath = path.join(root, 'active-content.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  return {
    root,
    projectFile: path.join(root, ...projectPath.split('/')),
    environment: {
      MPX_RUNTIME: 'pi',
      MPX_ACTIVE_CONTENT_ROOT: root,
      MPX_ACTIVE_CONTENT_MANIFEST: manifestPath,
      MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: JSON.stringify({
        sha256: sha256(manifestBytes),
        byteCount: manifestBytes.byteLength,
      }),
    },
  };
}

async function loadCanonicalSkillsWithRealProjection() {
  vi.doUnmock('@mpx/content-compiler/active');
  vi.resetModules();
  return (await import('../../../canonical-skills.js')).default;
}

test('real projection rejects different-path native authority while canonical identity remains independent', async () => {
  const fixture = await realProjectionFixture();
  try {
    const realCanonicalSkills = await loadCanonicalSkillsWithRealProjection();
    const state = harness([
      {
        name: 'skill:deploy',
        source: 'skill',
        sourceInfo: {
          path: path.join(fixture.root, 'different', 'SKILL.md'),
          source: 'local',
          scope: 'project',
          origin: 'top-level',
        },
      },
    ]);
    await realCanonicalSkills(state.api, fixture.environment);
    await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

    const result = (await state.events.get('input')?.(
      { text: 'Use /skill:deploy and /mpx:deploy', source: 'interactive' },
      {},
    )) as { text: string };

    assert.match(result.text, /^Use \/skill:deploy and <skill name="mpx:deploy"/);
    assert.doesNotMatch(result.text, /managed projected body/);
    assert.match(result.text, /canonical projected body/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('real projected native path completes an inline managed reference through the real editor on Tab', async () => {
  const fixture = await realProjectionFixture();
  try {
    const realCanonicalSkills = await loadCanonicalSkillsWithRealProjection();
    const state = harness([
      {
        name: 'skill:deploy',
        source: 'skill',
        sourceInfo: {
          path: fixture.projectFile,
          source: 'local',
          scope: 'project',
          origin: 'top-level',
        },
      },
    ]);
    await realCanonicalSkills(state.api, fixture.environment);
    await state.events.get('session_start')?.({ reason: 'startup' }, state.sessionContext);

    const terminal = {
      columns: 120,
      rows: 40,
      kittyProtocolActive: false,
      start: vi.fn(),
      stop: vi.fn(),
      drainInput: vi.fn(async () => {}),
      write: vi.fn(),
      moveBy: vi.fn(),
      hideCursor: vi.fn(),
      showCursor: vi.fn(),
      clearLine: vi.fn(),
      clearFromCursor: vi.fn(),
      clearScreen: vi.fn(),
      setTitle: vi.fn(),
      setProgress: vi.fn(),
    } satisfies Terminal;
    const tui = new TuiMainScreen(terminal);
    const plain = (text: string) => text;
    const theme: EditorTheme = {
      borderColor: plain,
      selectList: {
        selectedPrefix: plain,
        selectedText: plain,
        description: plain,
        scrollInfo: plain,
        noMatch: plain,
      },
    };
    const editor = new Editor(tui, theme);
    tui.addChild(editor);
    tui.setFocus(editor);
    editor.setAutocompleteProvider(
      state.autocomplete(new CombinedAutocompleteProvider(undefined, fixture.root, null)),
    );

    editor.handleInput('Please use /mpx:dep');
    editor.handleInput('\t');

    await vi.waitFor(() => assert.equal(editor.getText(), 'Please use /mpx:deploy'), {
      timeout: 500,
      interval: 5,
    });
    assert.deepEqual(editor.getCursor(), { line: 0, col: 22 });
    assert.equal(state.commands.has('skill:deploy'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
