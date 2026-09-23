import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectContent } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillsRoot = path.join(root, 'content', 'skills');
const names = [
  'batch-execute', 'bug-report', 'check-fix', 'commit', 'commit-push',
  'continue', 'decompose', 'epic-create', 'execute', 'issue-create', 'pr',
  'review', 'ship', 'sync-base', 'to-issues', 'board-to-issues', 'design-init', 'design-brief',
  'mockup', 'design-refine', 'grill',
] as const;
const exposures: Record<(typeof names)[number], 'normal' | 'name-only' | 'explicit-only'> = {
  'batch-execute': 'explicit-only',
  'bug-report': 'name-only',
  'check-fix': 'name-only',
  commit: 'name-only',
  'commit-push': 'name-only',
  continue: 'explicit-only',
  decompose: 'name-only',
  'epic-create': 'explicit-only',
  execute: 'normal',
  'issue-create': 'name-only',
  pr: 'name-only',
  review: 'normal',
  ship: 'name-only',
  'sync-base': 'name-only',
  'to-issues': 'explicit-only',
  'board-to-issues': 'explicit-only',
  'design-init': 'name-only',
  'design-brief': 'name-only',
  mockup: 'explicit-only',
  'design-refine': 'name-only',
  grill: 'name-only',
};

function frontmatter(source: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, 'expected YAML frontmatter');
  return parse(match[1]!) as Record<string, any>;
}

async function filesBelow(directory: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(directory, child));
    else found.push(child);
  }
  return found.sort();
}

async function allBatchText(): Promise<string> {
  const files = (await Promise.all(names.map(async name =>
    (await filesBelow(path.join(skillsRoot, name)))
      .filter(file => /\.(?:md|m?js)$/.test(file))
      .map(file => path.join(skillsRoot, name, file)),
  ))).flat();
  return (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
}

test('inactive skills retain their sources without any build projections', async () => {
  const projections = await projectContent(root);
  for (const [category, name] of [
    ['archived', 'architecture-review'],
    ['archived', 'epic-review'],
    ['archived', 'vocabulary'],
    ['unfinished', 'harvest-decisions'],
    ['unfinished', 'grill-voice'],
  ] as const) {
    const source = await readFile(path.join(skillsRoot, category, name, 'SKILL.md'), 'utf8');
    assert.equal(frontmatter(source).name, name);
    assert.ok(!projections.some(item => item.path.includes(`/skills/mpx-${name}/`)), name);
  }
});

test('bounded core batch has exact canonical exposure metadata', async () => {
  for (const name of names) {
    const data = frontmatter(await readFile(path.join(skillsRoot, name, 'SKILL.md'), 'utf8'));
    assert.equal(data.name, name);
    assert.deepEqual(data.metadata?.mpx, {
      schemaVersion: 1,
      skillPacks: ['development'],
      defaultExposure: exposures[name],
    });
  }
});

test('private support closure is copied into every consuming skill', async () => {
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'execute')), [
    'DEV_SERVER.md', 'SKILL.md', 'mocking.md', 'tests.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'board-to-issues')), ['ISSUE_TEMPLATE.md', 'SKILL.md']);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'review')), ['SKILL.md', 'scripts/detect-base-branch.js']);

  assert.equal(
    await readFile(path.join(skillsRoot, 'review', 'scripts', 'detect-base-branch.js'), 'utf8'),
    await readFile(path.join(skillsRoot, 'sync-base', 'scripts', 'detect-base-branch.js'), 'utf8'),
  );
});

test('core skills retain compiler placeholders without retired dependency identifiers', async () => {
  const source = await allBatchText();
  for (const retiredDependency of [
    '/mpx:', '../shared/', 'MPX_ACTIVE_CONTENT_ROOT', 'dev_server', 'SessionManager',
  ]) assert.ok(!source.includes(retiredDependency), `retired dependency: ${retiredDependency}`);
  assert.doesNotMatch(source, /\]\(\.\.\/(?:check-fix|issue-create|to-issues|grill|sync-base)\//);
  assert.match(source, /\{\{MPX_SHARED_INSTRUCTIONS\}\}/);
  assert.match(source, /\{\{MPX_HARNESS\}\}/);
  assert.match(source, /\{\{MPX_SKILL_COMMAND\}\}/);
  assert.match(source, /\{\{MPX_SKILL_PREFIX\}\}/);
});

test('compiled execute support links resolve in both harnesses', async () => {
  const projections = await projectContent(root);
  for (const harness of ['pi', 'claude']) {
    const skillDirectory = harness === 'pi'
      ? 'dist/packs/development/pi/skills/mpx-execute'
      : 'dist/packs/development/claude/.claude/skills/mpx-execute';
    const skillPath = `${skillDirectory}/SKILL.md`;
    const skill = projections.find(item => item.path === skillPath);
    assert.ok(skill, `missing projection: ${skillPath}`);
    const supportLink = /\[[^\]]*\]\((DEV_SERVER\.md)\)/.exec(skill.content.toString('utf8'));
    assert.ok(supportLink, `${harness}: DEV_SERVER.md link`);
    const destination = path.posix.join(skillDirectory, supportLink[1]!);
    assert.ok(projections.some(item => item.path === destination), destination);
  }
});

test('retired visual support files are excluded from projections and links', async () => {
  const projections = await projectContent(root);
  for (const projection of projections) {
    assert.doesNotMatch(projection.path, /PLAYWRIGHT_TESTING\.md|mpx-chrome-devtools-tester\.md/);
    if (projection.path.endsWith('.md')) {
      assert.doesNotMatch(projection.content.toString('utf8'), /PLAYWRIGHT_TESTING\.md|mpx-chrome-devtools-tester/);
    }
  }
});

test('compiler closure resolves skill prefixes without a placeholder fallback', async () => {
  const projected = new Map((await projectContent(root)).map(item => [item.path, item.content.toString('utf8')]));
  for (const [projectionPath, content] of projected) {
    assert.ok(!projectionPath.includes('/skills/mp-'), projectionPath);
    assert.doesNotMatch(content, /\/skill:mp-(?!x)|\/mp-(?!x)/, projectionPath);
  }
  assert.match(projected.get('dist/packs/development/pi/skills/mpx-mockup/SKILL.md')!, /\/skill:mpx-design-refine/);
  assert.match(projected.get('dist/packs/development/claude/.claude/skills/mpx-mockup/SKILL.md')!, /\/mpx-design-refine/);
  assert.match(projected.get('dist/packs/development/pi/skills/mpx-design-init/SKILL.md')!, /mpx-design-brief/);
  assert.ok([...projected.keys()].some(item => item.endsWith('/skills/mpx-board-to-issues/ISSUE_TEMPLATE.md')));
  assert.ok(![...projected.keys()].some(item => item.includes('/skills/mpx-grill-voice/')));
});
