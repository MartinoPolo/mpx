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
  'commit-push-pr': 'name-only',
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
    ['unfinished', 'harvest-decisions'],
    ['unfinished', 'grill-voice'],
  ] as const) {
    const source = await readFile(path.join(skillsRoot, category, name, 'SKILL.md'), 'utf8');
    assert.equal(frontmatter(source).name, name);
    assert.ok(!projections.some(item => item.path.includes(`/skills/mp-${name}/`)), name);
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
    'CLOSE_OUT.md', 'DEV_SERVER.md', 'SKILL.md', 'detect-check-scripts.mjs', 'mocking.md', 'tests.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'board-to-issues')), ['ISSUE_TEMPLATE.md', 'SKILL.md']);
  assert.deepEqual(await filesBelow(path.join(skillsRoot, 'review')), ['SKILL.md', 'scripts/detect-base-branch.js']);

  assert.equal(
    await readFile(path.join(skillsRoot, 'board-to-issues', 'ISSUE_TEMPLATE.md'), 'utf8'),
    await readFile(path.join(skillsRoot, 'issue-create', 'references', 'ISSUE_TEMPLATE.md'), 'utf8'),
  );
  const boardToIssues = await readFile(path.join(skillsRoot, 'board-to-issues', 'SKILL.md'), 'utf8');
  const boardConvention = await readFile(path.join(root, 'content', 'instructions', 'shared', 'BOARD_CONVENTION.md'), 'utf8');
  assert.match(boardToIssues, /append the canonical ` → issue:<id>`/);
  assert.match(boardConvention, /Use `issue:<id>` as the canonical annotation/);
  assert.equal(
    await readFile(path.join(skillsRoot, 'review', 'scripts', 'detect-base-branch.js'), 'utf8'),
    await readFile(path.join(skillsRoot, 'sync-base', 'scripts', 'detect-base-branch.js'), 'utf8'),
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

test('execute projects autonomous server and delivery defaults with safety gates', async () => {
  const projections = await projectContent(root);
  for (const harness of ['pi', 'claude']) {
    const skillDirectory = harness === 'pi'
      ? 'dist/packs/development/pi/skills/mp-execute'
      : 'dist/packs/development/claude/.claude/skills/mp-execute';
    const textAt = (relative: string): string => {
      const projection = projections.find(item => item.path === relative);
      assert.ok(projection, `missing projection: ${relative}`);
      return projection.content.toString('utf8');
    };
    const skill = textAt(`${skillDirectory}/SKILL.md`);
    const server = textAt(`${skillDirectory}/DEV_SERVER.md`);
    const closeOut = textAt(`${skillDirectory}/CLOSE_OUT.md`);
    const instructions = textAt(`dist/${harness}/instructions/shared/AGENTS.md`);
    assert.match(skill, /delivery defaults without routine confirmation/);
    assert.match(skill, /\]\(DEV_SERVER\.md\)/);
    assert.match(skill, /Inline work commits\s+locally/);
    assert.match(skill, /`--no-auto-merge`/);
    assert.match(skill, /For `PM_UNKNOWN=true`, ask for the package manager/);
    assert.match(server, /`package\.json` scripts and `packageManager`/);
    assert.match(server, /confirm readiness with a bounded wait/);
    assert.match(server, /stop only processes started for this execution/);
    assert.match(server, /Required browser verification remains blocked/);
    assert.match(closeOut, /prefer squash, then merge,\s+then rebase/);
    assert.match(closeOut, /Invocation\s+authorizes this without confirmation/);
    assert.match(closeOut, /Merge only after the explicit green gate/);
    assert.match(instructions, /parent may start a server/);
    const browser = textAt(`dist/${harness}/agents/mpx-chrome-devtools-tester.md`);
    const playwright = textAt(`dist/${harness}/instructions/shared/PLAYWRIGHT_TESTING.md`);
    assert.match(browser, /Return missing URLs or server failures to the parent, not the user/);
    assert.match(playwright, /parent prepares the server according to its workflow/);
    for (const policy of [instructions, browser, playwright]) {
      assert.doesNotMatch(policy, /servers are started manually|if it is missing,\s+ask/);
    }
  }
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
    assert.ok(!projected.some(item => item.path.includes('/skills/mp-grill-voice/')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
