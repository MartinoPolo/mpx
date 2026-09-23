import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { build, checkOutput, projectContent } from '../src/compiler.js';

const CLASSES = ['mechanical', 'exploration', 'standard', 'reviewer', 'advanced', 'frontier'] as const;
const CAPABILITIES = ['read', 'search', 'shell', 'write', 'browser', 'context', 'web'] as const;
const temporaryRoots: string[] = [];
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
test.after(async () => { for (const root of temporaryRoots) await rm(root, { recursive: true, force: true }); });

async function put(root: string, relative: string, content: string | Buffer): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function frontmatter(source: Buffer): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---(?:\r?\n|$)/.exec(source.toString('utf8'));
  assert.ok(match, 'expected YAML frontmatter');
  return parse(match[1]!) as Record<string, unknown>;
}

function markdownBody(source: Buffer): Buffer {
  const text = source.toString('utf8');
  const match = /^---\n[\s\S]*?\n---\n/.exec(text);
  assert.ok(match, 'expected YAML frontmatter');
  return source.subarray(Buffer.byteLength(match[0], 'utf8'));
}

async function fixture(): Promise<string> {
  const root = await temporaryRoot('mpx-compiler-');
  const models = Object.fromEntries(CLASSES.map((name) => [name, `pi/${name}`]));
  const claudeModels = Object.fromEntries(CLASSES.map((name) => [name, `claude/${name}`]));
  const tools = Object.fromEntries(CAPABILITIES.map((name) => [name, [`${name}-tool`]]));
  await put(root, 'content/runtime-profiles.json', `${JSON.stringify({
    schemaVersion: 1,
    models: { pi: models, claude: claudeModels },
    tools: { pi: tools, claude: tools },
  }, null, 2)}\n`);
  await put(root, 'content/skills/review/SKILL.md', `---
name: review
description: Réview changes carefully 🔍.
license: private
metadata:
  owner: mpx
  mpx:
    schemaVersion: 1
    skillPacks: [development, personal]
    defaultExposure: name-only
---
# Review 🧪\r
\r
Use {{MPX_SKILL_COMMAND}}review and {{MPX_AGENT_PREFIX}}explorer.\r
See [guide](references/guide.md), ![pixel](assets/pixel.bin), and [shared]({{MPX_SHARED_INSTRUCTIONS}}/base.md).\r
[agent reference]: {{MPX_AGENT_REFERENCES}}/roles.md\r
`);
  await put(root, 'content/skills/review/references/guide.md', '# Guide\n\n[roles][agent reference]\n\n[agent reference]: {{MPX_AGENT_REFERENCES}}/roles.md\n');
  await put(root, 'content/skills/review/assets/pixel.bin', Buffer.from([0, 255, 1, 2, 3]));
  await put(root, 'content/skills/personal-note/SKILL.md', `---
name: personal-note
description: Personal notes.
metadata:
  mpx:
    schemaVersion: 1
    skillPacks: [personal]
---
Private body.\n`);
  await put(root, 'content/agents/explorer.md', `---
name: explorer
description: Explore the repository 🔍.
model: stale/model
tools: stale-tool
thinking: low
effort: max
metadata:
  owner: mpx
  mpx:
    schemaVersion: 1
    modelClass: exploration
    thinking: high
    capabilities: [read, search, read]
---
Remain an exploration-class agent. See [roles](references/roles.md). Delegate to {{MPX_AGENT_PREFIX}}reviewer.\n`);
  await put(root, 'content/agents/references/roles.md', '# Roles\n');
  await put(root, 'content/instructions/shared/base.md', '# Shared\n');
  await put(root, 'content/instructions/pi/native.md', 'Pi {{MPX_SKILL_COMMAND}}review\n');
  await put(root, 'content/instructions/claude/native.md', 'Claude {{MPX_SKILL_COMMAND}}review\n');
  await put(root, 'content/rules/rule.md', 'Keep bytes.\r\n');
  await put(root, 'content/hooks/helper.bin', Buffer.from([8, 0, 9, 10]));
  await put(root, 'content/output-styles/concise.md', 'Concise.\n');
  return root;
}

test('balanced Markdown/HTML references and skill-prefix placeholders resolve without rewriting support bodies', async () => {
  const root = await fixture();
  const file = path.join(root, 'content/skills/review/SKILL.md');
  const body = await readFile(file, 'utf8');
  await put(root, 'content/skills/review/references/nested(a).md', 'Guide');
  await put(root, 'content/skills/review/references/guide # (one).md', 'Special');
  await writeFile(file, `${body}\n[balanced](references/nested(a).md)\n<a href="references/nested(a).md">HTML</a>\n[encoded](references/guide%20%23%20%28one%29.md?raw=1#part)\n[escaped](references/guide\\ \\#\\ \\(one\\).md#part)\n[angle](<references/guide%20%23%20(one).md#part>)\n[special]: <references/guide%20%23%20(one).md?raw=1#part>\n[other](../{{MPX_SKILL_PREFIX}}personal-note/SKILL.md)\n`);
  // Both fixture skills need matching packs for a sibling reference.
  const other = path.join(root, 'content/skills/personal-note/SKILL.md');
  await writeFile(other, (await readFile(other, 'utf8')).replace('skillPacks: [personal]', 'skillPacks: [development, personal]'));
  const projected = new Map((await projectContent(root)).map(({ path: outputPath, content }) => [outputPath, content.toString()]));
  const output = projected.get('dist/packs/development/pi/skills/mpx-review/SKILL.md')!;
  assert.match(output, /references\/guide%20%23%20%28one%29\.md\?raw=1#part/);
  assert.match(output, /\[escaped\]\(references\/guide%20%23%20%28one%29\.md#part\)/);
  assert.match(output, /\[angle\]\(<references\/guide%20%23%20%28one%29\.md#part>\)/);
  assert.match(output, /\[special\]: <references\/guide%20%23%20%28one%29\.md\?raw=1#part>/);
  await build(root);
  await writeFile(file, `${body}\n<img src="missing-image.png">\n`);
  await assert.rejects(projectContent(root), /missing-image/);
});

async function filesBelow(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(root, child));
    else found.push(child);
  }
  return found.sort();
}

test('projects deterministic native metadata while preserving bodies and support bytes', async () => {
  const root = await fixture();
  const first = await projectContent(root);
  const second = await projectContent(root);
  assert.deepEqual(first.map(({ path, content }) => [path, content]), second.map(({ path, content }) => [path, content]));
  assert.deepEqual(first.map((item) => item.path), [...first.map((item) => item.path)].sort());

  const byPath = new Map(first.map((item) => [item.path, item.content]));
  assert.ok(first.every((item) => !item.path.includes('/skills/mp-')), 'legacy skill aliases must not be projected');
  const piSkillPath = 'dist/packs/development/pi/skills/mpx-review/SKILL.md';
  const claudeSkillPath = 'dist/packs/development/claude/.claude/skills/mpx-review/SKILL.md';
  const piSkill = byPath.get(piSkillPath)!;
  const claudeSkill = byPath.get(claudeSkillPath)!;
  assert.ok(piSkill && claudeSkill);
  assert.deepEqual(frontmatter(piSkill), {
    description: 'Loads the mpx-review skill when explicitly referenced.',
    license: 'private',
    metadata: { owner: 'mpx' },
    name: 'mpx-review',
  });
  assert.deepEqual(frontmatter(byPath.get('dist/packs/personal/pi/skills/mpx-personal-note/SKILL.md')!), {
    description: 'Personal notes.',
    'disable-model-invocation': true,
    name: 'mpx-personal-note',
  });
  assert.match(piSkill.toString(), /Use \/skill:mpx-review and mpx-explorer\./);
  assert.match(claudeSkill.toString(), /Use \/mpx-review and mpx-explorer\./);
  assert.match(piSkill.toString(), /references\/instructions\/shared\/base\.md/);
  assert.ok(piSkill.toString().endsWith('agent reference]: references/agents/references/roles.md\r\n'));

  assert.deepEqual(markdownBody(piSkill), Buffer.from(`# Review 🧪\r\n\r\nUse /skill:mpx-review and mpx-explorer.\r\nSee [guide](references/guide.md), ![pixel](assets/pixel.bin), and [shared](references/instructions/shared/base.md).\r\n[agent reference]: references/agents/references/roles.md\r\n`));
  assert.equal(byPath.get('dist/packs/development/pi/skills/mpx-review/references/instructions/shared/base.md')?.toString(), '# Shared\n');
  assert.deepEqual(byPath.get('dist/packs/development/pi/skills/mpx-review/assets/pixel.bin'), Buffer.from([0, 255, 1, 2, 3]));
  assert.deepEqual(byPath.get('dist/claude/hooks/helper.bin'), Buffer.from([8, 0, 9, 10]));
  assert.equal(byPath.has('dist/pi/instructions/claude/native.md'), false);
  assert.equal(byPath.has('dist/claude/instructions/pi/native.md'), false);

  const piAgent = byPath.get('dist/pi/agents/mpx-explorer.md')!;
  assert.deepEqual(frontmatter(piAgent), {
    description: 'Explore the repository 🔍.',
    metadata: { owner: 'mpx' },
    model: 'pi/exploration',
    name: 'mpx-explorer',
    thinking: 'high',
    tools: 'read-tool, search-tool',
  });
  assert.match(piAgent.toString(), /exploration-class agent/);
  assert.match(piAgent.toString(), /mpx-reviewer/);
  const claudeAgent = frontmatter(byPath.get('dist/claude/agents/mpx-explorer.md')!);
  assert.deepEqual(claudeAgent, {
    description: 'Explore the repository 🔍.',
    effort: 'high',
    metadata: { owner: 'mpx' },
    model: 'claude/exploration',
    name: 'mpx-explorer',
    tools: 'read-tool, search-tool',
  });
});

test('projects harness-specific thinking overrides before the shared default', async () => {
  const root = await fixture();
  const profiles = path.join(root, 'content/runtime-profiles.json');
  await writeFile(profiles, (await readFile(profiles, 'utf8')).replace('pi/exploration', 'openai-codex/gpt-6-luna'));
  const agent = path.join(root, 'content/agents/explorer.md');
  await writeFile(agent, (await readFile(agent, 'utf8')).replace(
    'thinking: high\n    capabilities:',
    'thinking: medium\n    thinkingOverrides: { pi: max }\n    capabilities:',
  ));
  const projected = new Map((await projectContent(root))
    .filter(item => item.path.endsWith('/agents/mpx-explorer.md'))
    .map(item => [item.path, frontmatter(item.content)]));
  assert.equal(projected.get('dist/pi/agents/mpx-explorer.md')?.thinking, 'max');
  assert.equal(projected.get('dist/claude/agents/mpx-explorer.md')?.effort, 'medium');
});

test('rejects invalid thinking overrides and Pi Luna effort below high', async (t) => {
  for (const [name, override, expected] of [
    ['unknown harness', '{ codex: high }', /thinkingOverrides.*unknown field.*codex/],
    ['unknown level', '{ pi: extreme }', /thinkingOverrides\.pi is unknown/],
  ] as const) await t.test(name, async () => {
    const root = await fixture();
    const agent = path.join(root, 'content/agents/explorer.md');
    await writeFile(agent, (await readFile(agent, 'utf8')).replace(
      'thinking: high\n    capabilities:',
      `thinking: high\n    thinkingOverrides: ${override}\n    capabilities:`,
    ));
    await assert.rejects(projectContent(root), expected);
  });

  await t.test('Luna floor uses effective Pi override', async () => {
    const root = await fixture();
    const profiles = path.join(root, 'content/runtime-profiles.json');
    await writeFile(profiles, (await readFile(profiles, 'utf8')).replace('pi/exploration', 'openai-codex/gpt-6-luna'));
    const agent = path.join(root, 'content/agents/explorer.md');
    await writeFile(agent, (await readFile(agent, 'utf8')).replace(
      'thinking: high\n    capabilities:',
      'thinking: high\n    thinkingOverrides: { pi: medium }\n    capabilities:',
    ));
    await assert.rejects(projectContent(root), /Pi Luna.*high, xhigh, or max/);
  });
});

test('preserves framework template examples while resolving only named uppercase placeholders', async () => {
  const root = await fixture();
  const examples = 'Vue `{{ variable }}`\nReact `<MemoizedComponent style={{ color: "red" }} />`\n';
  await put(root, 'content/agents/references/framework-examples.md', examples);
  await put(root, 'content/instructions/shared/harness.md', 'Use dist/{{MPX_HARNESS}}/agents for this harness.\n');
  const projections = new Map((await projectContent(root)).map(item => [item.path, item.content.toString()]));
  for (const harness of ['pi', 'claude']) {
    assert.equal(projections.get(`dist/${harness}/agents/references/framework-examples.md`), examples);
    assert.equal(projections.get(`dist/${harness}/instructions/shared/harness.md`), `Use dist/${harness}/agents for this harness.\n`);
  }
});

test('build converges inside generated roots and checkOutput reports drift without mutation', async () => {
  const root = await fixture();
  await put(root, 'dist/packs/obsolete.txt', 'old');
  await put(root, 'dist/pi/obsolete.txt', 'old');
  await put(root, 'dist/claude/obsolete.txt', 'old');
  await put(root, 'dist/unowned.txt', 'leave');

  const result = await build(root);
  assert.ok(result.changed.includes('dist/packs/obsolete.txt'));
  assert.ok(result.changed.includes('dist/pi/obsolete.txt'));
  assert.ok(result.changed.includes('dist/claude/obsolete.txt'));
  assert.equal((await readFile(path.join(root, 'dist/unowned.txt'), 'utf8')), 'leave');
  assert.deepEqual(await checkOutput(root), []);
  assert.deepEqual((await build(root)).changed, []);

  const changed = result.files[0];
  const missing = result.files[1];
  assert.ok(changed && missing);
  await writeFile(path.join(root, changed), 'drift');
  await writeFile(path.join(root, 'dist/pi/extra.txt'), 'extra');
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(root, missing));
  const before = await filesBelow(path.join(root, 'dist'));
  assert.deepEqual(await checkOutput(root), [changed, missing, 'dist/pi/extra.txt'].sort());
  assert.deepEqual(await filesBelow(path.join(root, 'dist')), before, 'checkOutput must be read-only');
});

test('excludes archived and unfinished skill trees and removes their stale outputs', async () => {
  const root = await fixture();
  const expected = await projectContent(root);
  for (const category of ['archived', 'unfinished']) {
    await put(root, `content/skills/${category}/draft/SKILL.md`, 'Incomplete {{UNKNOWN}} [missing](missing.md)\n');
    await put(root, `content/skills/${category}/draft/scripts/helper.js`, 'unfinished support\n');
    await put(root, `content/skills/${category}/notes.md`, 'category notes\n');
  }
  assert.deepEqual(await projectContent(root), expected);
  for (const directory of ['dist/packs/development/pi/skills', 'dist/packs/development/claude/.claude/skills']) {
    await put(root, `${directory}/mp-draft/SKILL.md`, 'stale legacy skill\n');
    await put(root, `${directory}/mp-draft/scripts/helper.js`, 'stale legacy support\n');
  }
  await build(root);
  assert.deepEqual(await checkOutput(root), []);
  assert.ok(!(await filesBelow(path.join(root, 'dist'))).some(file => file.includes('mp-draft')));
});

test('archiving an agent removes both harness outputs without validating archived content', async () => {
  const root = await fixture();
  const agentPath = path.join(root, 'content/agents/explorer.md');
  await writeFile(agentPath, `${await readFile(agentPath, 'utf8')}{{include:../instructions/shared/base.md}}`);
  await build(root);
  const unaffectedPath = path.join(root, 'dist/packs/development/pi/skills/mpx-review/SKILL.md');
  const unaffectedContent = await readFile(unaffectedPath);
  const archivedPath = path.join(root, 'content/agents/archived/explorer.md');
  const authoredContent = await readFile(agentPath);
  await mkdir(path.dirname(archivedPath), { recursive: true });
  await rename(agentPath, archivedPath);
  assert.deepEqual(await readFile(archivedPath), authoredContent);

  const result = await build(root);
  const generatedAgents = ['dist/claude/agents/mpx-explorer.md', 'dist/pi/agents/mpx-explorer.md'];
  assert.deepEqual(result.changed, generatedAgents);
  for (const generatedAgent of generatedAgents) {
    await assert.rejects(stat(path.join(root, generatedAgent)), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(unaffectedPath), unaffectedContent);
  assert.deepEqual(await checkOutput(root), []);
});

test('rejects malformed metadata, unknown placeholders, duplicate outputs, and broken local Markdown references', async (t) => {
  const cases: Array<[string, (root: string) => Promise<void>, RegExp]> = [
    ['unsafe skill name', async (root) => put(root, 'content/skills/review/SKILL.md', `---\nname: ../review\ndescription: bad\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`), /safe lowercase bare name/],
    ['unknown model class', async (root) => put(root, 'content/agents/explorer.md', `---\nname: explorer\ndescription: bad\nmetadata: { mpx: { schemaVersion: 1, modelClass: turbo, thinking: high, capabilities: [read] } }\n---\nbody\n`), /modelClass/],
    ['unknown capability', async (root) => put(root, 'content/agents/explorer.md', `---\nname: explorer\ndescription: bad\nmetadata: { mpx: { schemaVersion: 1, modelClass: standard, thinking: high, capabilities: [telepathy] } }\n---\nbody\n`), /capabilit/],
    ['unknown placeholder', async (root) => put(root, 'content/rules/rule.md', '{{NOT_DECLARED}}\n'), /unknown placeholder/],
    ['malformed reserved placeholder', async (root) => put(root, 'content/rules/rule.md', '{{MPX_HARNESS\n'), /placeholder/],
    ['placeholder in metadata', async (root) => put(root, 'content/skills/review/SKILL.md', `---\nname: review\ndescription: "{{MPX_AGENT_PREFIX}} review"\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`), /only allowed in bodies/],
    ['broken inline image', async (root) => put(root, 'content/rules/rule.md', '![missing](missing.png)\n'), /broken local Markdown reference/],
    ['broken reference-style link', async (root) => put(root, 'content/rules/rule.md', '[guide][g]\n\n[g]: missing.md\n'), /broken local Markdown reference/],
    ['duplicate output pack', async (root) => put(root, 'content/skills/review/SKILL.md', `---\nname: review\ndescription: bad\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development, development] } }\n---\nbody\n`), /duplicate output/],
    ['orphan skill support', async (root) => put(root, 'content/skills/orphan/references.md', 'orphaned\n'), /missing SKILL\.md/],
    ['projected skill name over 64 characters', async (root) => {
      const name = 'a'.repeat(61);
      await put(root, `content/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: too long after prefix\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`);
    }, /mpx-.*64 characters/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const root = await fixture();
      await mutate(root);
      await assert.rejects(projectContent(root), expected);
    });
  }

  const root = await fixture();
  await put(root, 'content/rules/examples.md', `A URL [site](https://example.com/nope), [anchor](#part), and inline code \`[sample](missing.ts)\`.\n\n\`\`\`ts\nimport './missing.js';\n[example](also-missing.md)\n\`\`\`\n\n    [indented example](not-real.md)\n`);
  await projectContent(root);
});

test('expands explicit includes transitively for both harnesses and rejects invalid include graphs', async (t) => {
  await t.test('transitive shared-root include', async () => {
    const root = await fixture();
    await put(root, 'content/instructions/shared/guides/guide # (one).md', 'Leaf guide.\n');
    await put(root, 'content/instructions/shared/leaf.md', 'Exact wording. [leaf](guides/guide%20%23%20(one).md)\n');
    await put(root, 'content/instructions/shared/middle.md', 'Before\n{{include:leaf.md}}After\n');
    const agent = path.join(root, 'content/agents/explorer.md');
    await writeFile(agent, (await readFile(agent, 'utf8')).replace('Remain an exploration-class agent.', '{{include:{{MPX_SHARED_INSTRUCTIONS}}/middle.md}}') + '\n`{{include:{{MPX_SHARED_INSTRUCTIONS}}/leaf.md}}`\n```text\n{{include:{{MPX_SHARED_INSTRUCTIONS}}/leaf.md}}\n```\n');
    const projected = new Map((await projectContent(root)).map(({ path: outputPath, content }) => [outputPath, content.toString()]));
    for (const harness of ['pi', 'claude']) {
      const output = projected.get(`dist/${harness}/agents/mpx-explorer.md`)!;
      assert.match(output, /Before\nExact wording\.\n? \[leaf\]\(\.\.\/instructions\/shared\/guides\/guide%20%23%20%28one%29\.md\)\nAfter/);
      assert.equal((output.match(/\{\{include:\{\{MPX_SHARED_INSTRUCTIONS\}\}\/leaf\.md\}\}/g) ?? []).length, 2);
    }
  });

  const cases: Array<[string, (root: string) => Promise<void>, RegExp]> = [
    ['missing', async (root) => put(root, 'content/instructions/shared/base.md', '{{include:missing.md}}'), /missing include/],
    ['cycle', async (root) => {
      await put(root, 'content/instructions/shared/base.md', '{{include:other.md}}');
      await put(root, 'content/instructions/shared/other.md', '{{include:base.md}}');
    }, /include cycle/],
    ['escape', async (root) => put(root, 'content/instructions/shared/base.md', '{{include:../../../outside.md}}'), /escapes content/],
    ['malformed body directive', async (root) => put(root, 'content/instructions/shared/base.md', '{{include:missing.md'), /malformed include/],
    ['frontmatter directive', async (root) => put(root, 'content/agents/explorer.md', '---\nname: explorer\ndescription: "{{include:description.md}}"\n---\nBody\n'), /only allowed in bodies/],
    ['unknown placeholder in literal include', async (root) => put(root, 'content/instructions/shared/base.md', '`{{include:{{UNKNOWN}}/example.md}}`\n'), /unknown placeholder/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, async () => {
    const root = await fixture();
    await mutate(root);
    await assert.rejects(projectContent(root), expected);
  });
});

test('bundles cross-skill bodies and their transitive closure without nested discoverable skills', async () => {
  const root = await fixture();
  const skill = path.join(root, 'content/skills/review/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\n[external](../personal-note/SKILL.md#section)\n[tools]({{MPX_SHARED_INSTRUCTIONS}}/tooling)\n`);
  const dependencySkill = path.join(root, 'content/skills/personal-note/SKILL.md');
  await writeFile(dependencySkill, `${await readFile(dependencySkill, 'utf8')}\n[binary](media/pixel.bin#raw)\n[back](../review/SKILL.md)\n`);
  await put(root, 'content/skills/personal-note/media/pixel.bin', Buffer.from([9, 0, 8]));
  await put(root, 'content/instructions/shared/tooling/run.sh', '#!/bin/sh\n');
  const first = await projectContent(root);
  const second = await projectContent(root);
  assert.deepEqual(first, second);
  const files = new Map(first.map(({ path: outputPath, content }) => [outputPath, content]));
  const prefix = 'dist/packs/development/pi/skills/mpx-review/';
  assert.match(files.get(`${prefix}SKILL.md`)!.toString(), /references\/skills\/personal-note\/REFERENCE\.md#section/);
  const reference = files.get(`${prefix}references/skills/personal-note/REFERENCE.md`)!.toString();
  assert.ok(!reference.startsWith('---'));
  assert.match(reference, /media\/pixel\.bin#raw/);
  assert.match(reference, /\.\.\/\.\.\/\.\.\/SKILL\.md/);
  assert.deepEqual(files.get(`${prefix}references/skills/personal-note/media/pixel.bin`), Buffer.from([9, 0, 8]));
  assert.equal(files.has(`${prefix}references/skills/personal-note/SKILL.md`), false);
  assert.equal(files.get(`${prefix}references/instructions/shared/tooling/run.sh`)?.toString(), '#!/bin/sh\n');
});

test('rewrites only Markdown target spans and resolves canonical cross-skill prefixes', async () => {
  const root = await fixture();
  const skill = path.join(root, 'content/skills/review/SKILL.md');
  const original = await readFile(skill, 'utf8');
  await writeFile(skill, `${original}\nLiteral {{MPX_SHARED_INSTRUCTIONS}}/base.md\n\`{{MPX_SHARED_INSTRUCTIONS}}/base.md\`\n\`\`\`text\n[code]({{MPX_SHARED_INSTRUCTIONS}}/base.md)\n\`\`\`\n[cross](../{{MPX_SKILL_PREFIX}}personal-note/SKILL.md)\n`);
  const other = path.join(root, 'content/skills/personal-note/SKILL.md');
  await writeFile(other, (await readFile(other, 'utf8')).replace('skillPacks: [personal]', 'skillPacks: [development, personal]'));
  const output = new Map((await projectContent(root)).map(({ path: outputPath, content }) => [outputPath, content.toString()]))
    .get('dist/packs/development/pi/skills/mpx-review/SKILL.md')!;
  assert.match(output, /Literal \.\.\/\.\.\/\.\.\/\.\.\/\.\.\/pi\/instructions\/shared\/base\.md/);
  assert.match(output, /`\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/pi\/instructions\/shared\/base\.md`/);
  assert.match(output, /\[code\]\(\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/pi\/instructions\/shared\/base\.md\)/);
  assert.match(output, /\[cross\]\(references\/skills\/personal-note\/REFERENCE\.md\)/);
  assert.equal((output.match(/references\/instructions\/shared\/base\.md/g) ?? []).length, 1);
});

test('rejects case-insensitive skill bundle destination collisions', async () => {
  const root = await fixture();
  const skill = path.join(root, 'content/skills/review/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\n[shared]({{MPX_SHARED_INSTRUCTIONS}}/base.md)\n`);
  await put(root, 'content/skills/review/references/instructions/shared/base.md', 'local collision\n');
  await assert.rejects(projectContent(root), /skill bundle collision/);
});

test('accepts the longest skill name whose mpx- projection is 64 characters', async () => {
  const root = await fixture();
  const name = 'a'.repeat(60);
  await put(root, `content/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: boundary\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`);
  const projected = await projectContent(root);
  assert.ok(projected.some(({ path }) => path === `dist/packs/development/pi/skills/mpx-${name}/SKILL.md`));
});

test('refuses escaping source links and linked generated directories', async (t) => {
  await t.test('source link', async () => {
    const root = await fixture();
    const outside = await temporaryRoot('mpx-outside-');
    await put(outside, 'secret.md', 'outside\n');
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'content/rules/linked.md'));
    await assert.rejects(projectContent(root), /symlink.*escapes.*content/i);
  });

  await t.test('output directory link', async () => {
    const root = await fixture();
    const outside = await temporaryRoot('mpx-output-');
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await symlink(outside, path.join(root, 'dist/pi'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(build(root), /linked output directory|symlink/i);
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});
