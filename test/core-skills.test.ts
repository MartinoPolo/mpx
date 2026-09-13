import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectContent } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillsRoot = path.join(root, 'content', 'skills');
const names = [
  'batch-execute', 'bug-report', 'check-fix', 'commit', 'commit-push', 'commit-push-pr',
  'continue', 'decompose', 'epic-create', 'epic-review', 'execute', 'issue-create', 'pr',
  'review', 'ship', 'sync-base', 'to-issues', 'board-to-issues', 'design-init', 'design-brief',
  'mockup', 'design-refine', 'grill', 'grill-voice', 'harvest-decisions',
] as const;
const exposures: Record<(typeof names)[number], 'normal' | 'name-only' | 'explicit-only'> = {
  'batch-execute': 'explicit-only',
  'bug-report': 'name-only',
  'check-fix': 'name-only',
  commit: 'name-only',
  'commit-push': 'name-only',
  'commit-push-pr': 'name-only',
  continue: 'explicit-only',
  decompose: 'name-only',
  'epic-create': 'explicit-only',
  'epic-review': 'explicit-only',
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
  'grill-voice': 'explicit-only',
  'harvest-decisions': 'explicit-only',
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
    'CLOSE_OUT.md', 'SKILL.md', 'detect-check-scripts.mjs', 'mocking.md', 'tests.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'epic-review')), [
    'ANALYSIS_BRANCHES.md', 'EXECUTION.md', 'ISSUE_TEMPLATE.md', 'PHASE_END_TEMPLATE.md', 'SKILL.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'board-to-issues')), ['ISSUE_TEMPLATE.md', 'SKILL.md']);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'review')), ['SKILL.md', 'scripts/detect-base-branch.js']);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'grill-voice')), [
    'CONTRACT.md', 'GRILL_WORKFLOW.md', 'SKILL.md', 'scripts/grill-voice.js',
  ]);

  assert.equal(
    await readFile(path.join(skillsRoot, 'board-to-issues', 'ISSUE_TEMPLATE.md'), 'utf8'),
    await readFile(path.join(skillsRoot, 'issue-create', 'references', 'ISSUE_TEMPLATE.md'), 'utf8'),
  );
  assert.equal(
    await readFile(path.join(skillsRoot, 'epic-review', 'ISSUE_TEMPLATE.md'), 'utf8'),
    await readFile(path.join(skillsRoot, 'to-issues', 'ISSUE_TEMPLATE.md'), 'utf8'),
  );
  assert.equal(
    await readFile(path.join(skillsRoot, 'review', 'scripts', 'detect-base-branch.js'), 'utf8'),
    await readFile(path.join(skillsRoot, 'sync-base', 'scripts', 'detect-base-branch.js'), 'utf8'),
  );
  assert.equal(
    await readFile(path.join(skillsRoot, 'grill-voice', 'GRILL_WORKFLOW.md'), 'utf8'),
    await readFile(path.join(skillsRoot, 'grill', 'SKILL.md'), 'utf8'),
  );
});

test('core workflows are native-first without retired services or cross-skill file discovery', async () => {
  const source = await allBatchText();
  for (const banned of [
    '/mpx:', '../shared/', 'MPX_ACTIVE_CONTENT_ROOT', 'runtime worktree operation',
    'dev_server', 'launch-bound session discovery contract', 'SessionManager',
    'Local Markdown uses', 'glab issue',
  ]) assert.ok(!source.includes(banned), `retired dependency: ${banned}`);
  assert.doesNotMatch(source, /\]\(\.\.\/(?:check-fix|issue-create|to-issues|grill|sync-base)\//);
  assert.match(source, /\{\{MPX_SHARED_INSTRUCTIONS\}\}/);
  assert.match(source, /\{\{MPX_HARNESS\}\}/);
  assert.match(source, /\{\{MPX_SKILL_COMMAND\}\}/);
  assert.match(source, /\{\{MPX_SKILL_PREFIX\}\}/);
  assert.match(source, /user-created Orca checkout/);
  assert.match(source, /does not manage development-server processes or port state/);
  assert.match(source, /explicitly approved project test-auth context/);
});

test('repository and Issue provider roles remain independent', async () => {
  const source = await allBatchText();
  assert.match(source, /repository providers are GitHub, GitLab, or Gerrit/);
  assert.match(source, /Issue\s+providers are GitHub or KanbanFlow/);
  assert.match(source, /independently resolve `issues\.provider` and `repository\.provider`/);
  assert.match(source, /Native status\/login diagnostics may inspect the active account/);
  assert.doesNotMatch(source, /Issue provider[^\n]*(?:GitLab|Gerrit)/i);
});

test('compiler closure is valid, with MPX_SKILL_PREFIX owned by parent integration', async () => {
  try {
    const projected = new Map((await projectContent(root)).map(item => [item.path, item.content.toString('utf8')]));
    assert.match(projected.get('dist/packs/development/pi/skills/mp-mockup/SKILL.md')!, /\/skill:mp-design-refine/);
    assert.match(projected.get('dist/packs/development/claude/.claude/skills/mp-mockup/SKILL.md')!, /\/mp-design-refine/);
    assert.match(projected.get('dist/packs/development/pi/skills/mp-design-init/SKILL.md')!, /mp-design-brief/);
    return;
  } catch (error) {
    assert.match(String(error), /unknown placeholder \{\{MPX_SKILL_PREFIX\}\}/);
  }

  // Validate the rest of the current compiler contract without weakening the source placeholder.
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-core-skills-'));
  try {
    await cp(path.join(root, 'content'), path.join(temporary, 'content'), { recursive: true });
    for (const name of names) {
      for (const relative of await filesBelow(path.join(temporary, 'content', 'skills', name))) {
        if (!/\.md$/.test(relative)) continue;
        const file = path.join(temporary, 'content', 'skills', name, relative);
        const source = await readFile(file, 'utf8');
        await writeFile(file, source.replaceAll('{{MPX_SKILL_PREFIX}}', ''));
      }
    }
    const projected = await projectContent(temporary);
    assert.ok(projected.some(item => item.path.endsWith('/skills/mp-execute/detect-check-scripts.mjs')));
    assert.ok(projected.some(item => item.path.endsWith('/skills/mp-board-to-issues/ISSUE_TEMPLATE.md')));
    assert.ok(projected.some(item => item.path.endsWith('/skills/mp-grill-voice/GRILL_WORKFLOW.md')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
