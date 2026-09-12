import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { build, checkOutput, projectContent } from '../src/compiler.js';

const CLASSES = ['mechanical', 'exploration', 'standard', 'advanced', 'frontier'] as const;
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
  const piSkillPath = 'dist/packs/development/pi/skills/mp-review/SKILL.md';
  const claudeSkillPath = 'dist/packs/development/claude/.claude/skills/mp-review/SKILL.md';
  const piSkill = byPath.get(piSkillPath)!;
  const claudeSkill = byPath.get(claudeSkillPath)!;
  assert.ok(piSkill && claudeSkill);
  assert.deepEqual(frontmatter(piSkill), {
    description: 'Loads the mp-review skill when explicitly referenced.',
    license: 'private',
    metadata: { owner: 'mpx' },
    name: 'mp-review',
  });
  assert.deepEqual(frontmatter(byPath.get('dist/packs/personal/pi/skills/mp-personal-note/SKILL.md')!), {
    description: 'Personal notes.',
    'disable-model-invocation': true,
    name: 'mp-personal-note',
  });
  assert.match(piSkill.toString(), /Use \/skill:mp-review and mpx-explorer\./);
  assert.match(claudeSkill.toString(), /Use \/mp-review and mpx-explorer\./);
  assert.match(piSkill.toString(), /\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/pi\/instructions\/shared\/base\.md/);
  assert.ok(piSkill.toString().endsWith('agent reference]: ../../../../../pi/agents/references/roles.md\r\n'));

  assert.deepEqual(markdownBody(piSkill), Buffer.from(`# Review 🧪\r\n\r\nUse /skill:mp-review and mpx-explorer.\r\nSee [guide](references/guide.md), ![pixel](assets/pixel.bin), and [shared](../../../../../pi/instructions/shared/base.md).\r\n[agent reference]: ../../../../../pi/agents/references/roles.md\r\n`));
  assert.deepEqual(byPath.get('dist/packs/development/pi/skills/mp-review/assets/pixel.bin'), Buffer.from([0, 255, 1, 2, 3]));
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
      const name = 'a'.repeat(62);
      await put(root, `content/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: too long after prefix\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`);
    }, /mp-.*64 characters/],
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

test('accepts the longest skill name whose mp- projection is 64 characters', async () => {
  const root = await fixture();
  const name = 'a'.repeat(61);
  await put(root, `content/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: boundary\nmetadata: { mpx: { schemaVersion: 1, skillPacks: [development] } }\n---\nbody\n`);
  const projected = await projectContent(root);
  assert.ok(projected.some(({ path }) => path === `dist/packs/development/pi/skills/mp-${name}/SKILL.md`));
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
