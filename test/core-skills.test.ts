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
    await readFile(path.join(skillsRoot, 'board-to-issues', 'ISSUE_TEMPLATE.md'), 'utf8'),
    await readFile(path.join(skillsRoot, 'issue-create', 'references', 'ISSUE_TEMPLATE.md'), 'utf8'),
  );
  const boardToIssues = await readFile(path.join(skillsRoot, 'board-to-issues', 'SKILL.md'), 'utf8');
  assert.match(boardToIssues, /append the canonical ` → issue:<id>`/);
  assert.match(boardToIssues, /Only unchecked top-level items/);
  assert.equal(
    await readFile(path.join(skillsRoot, 'review', 'scripts', 'detect-base-branch.js'), 'utf8'),
    await readFile(path.join(skillsRoot, 'sync-base', 'scripts', 'detect-base-branch.js'), 'utf8'),
  );
});

test('board workflows own lane state without a shared convention dependency', async () => {
  const boardSetup = await readFile(path.join(skillsRoot, 'board-setup', 'SKILL.md'), 'utf8');
  const boardToIssues = await readFile(path.join(skillsRoot, 'board-to-issues', 'SKILL.md'), 'utf8');
  const batchExecute = await readFile(path.join(skillsRoot, 'batch-execute', 'SKILL.md'), 'utf8');

  assert.match(boardSetup, /per-machine and gitignored/);
  assert.match(boardSetup, /unchecked top-level\s+notes/);
  assert.match(boardSetup, /Issue exists/);
  assert.match(boardSetup, /implemented, awaiting manual\s+testing/);
  assert.match(boardSetup, /Only the user/);
  assert.match(boardSetup, /from the Git main checkout/);
  assert.match(boardSetup, /`projectId` as the canonical project identity/);
  assert.doesNotMatch(boardSetup, /nearest valid|project\.id/);
  assert.match(boardToIssues, /complete original item block/);
  assert.match(boardToIssues, /optional display width/);
  assert.match(batchExecute, /unchecked top-level item/);
  assert.match(batchExecute, /complete original item block/);
  assert.match(batchExecute, /Only the user/);

  for (const source of [boardSetup, boardToIssues, batchExecute]) {
    assert.doesNotMatch(source, /BOARD_CONVENTION|Board Convention/);
  }
  const projections = (await projectContent(root))
    .filter(item => /mpx-(?:board-setup|board-to-issues|batch-execute)\/SKILL\.md$/.test(item.path));
  assert.equal(projections.length, 6);
  for (const projection of projections) {
    assert.doesNotMatch(projection.content.toString('utf8'), /BOARD_CONVENTION|Board Convention/, projection.path);
  }
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
  assert.match(source, /Do not create, switch, or remove worktrees/);
  assert.match(source, /does not manage development-server processes or port state/);
  assert.match(source, /explicitly approved project test-auth context/);
});

test('execute projects autonomous server and delivery defaults with safety gates', async () => {
  const projections = await projectContent(root);
  for (const harness of ['pi', 'claude']) {
    const skillDirectory = harness === 'pi'
      ? 'dist/packs/development/pi/skills/mpx-execute'
      : 'dist/packs/development/claude/.claude/skills/mpx-execute';
    const textAt = (relative: string): string => {
      const projection = projections.find(item => item.path === relative);
      assert.ok(projection, `missing projection: ${relative}`);
      return projection.content.toString('utf8');
    };
    const skill = textAt(`${skillDirectory}/SKILL.md`);
    const server = textAt(`${skillDirectory}/DEV_SERVER.md`);
    const instructions = textAt(`dist/${harness}/instructions/shared/AGENTS.md`);
    assert.match(skill, /delivery defaults without routine confirmation/);
    assert.match(skill, /\]\(DEV_SERVER\.md\)/);
    assert.match(skill, /Inline work commits\s+locally/);
    assert.match(skill, /`--no-auto-merge`/);
    assert.match(skill, /personal repositories require confirmed merge plus safe base update/);
    assert.match(skill, /Three shipping attempts total: initial attempt plus two repair\/retry attempts/);
    assert.match(skill, /clean index\/worktree, correct\s+upstream, no in-progress Git operation, and fast-forward only/);
    assert.match(server, /`package\.json` scripts and `packageManager`/);
    assert.match(server, /confirm readiness with a bounded wait/);
    assert.match(server, /stop only processes started for this execution/);
    assert.match(server, /Required browser verification remains blocked/);
    assert.match(instructions, /parent may start a server/);
    const browser = textAt(`dist/${harness}/agents/mpx-visual-verifier.md`);
    assert.match(browser, /Return\s+missing prerequisites to the parent/);
    assert.match(browser, /Never guess a port, start or manage servers/);
    for (const policy of [instructions, browser]) {
      assert.doesNotMatch(policy, /servers are started manually|if it is missing,\s+ask/);
    }
  }
});

test('visual acceptance is self-contained and distinct from persisted E2E tests', async () => {
  const projections = await projectContent(root);
  for (const projection of projections) {
    assert.doesNotMatch(projection.path, /PLAYWRIGHT_TESTING\.md|mpx-chrome-devtools-tester\.md/);
    if (projection.path.endsWith('.md')) {
      assert.doesNotMatch(projection.content.toString('utf8'), /PLAYWRIGHT_TESTING\.md|mpx-chrome-devtools-tester/);
    }
  }
  for (const harnessRoot of ['pi', 'claude/.claude']) {
    const projectedText = (relative: string): string => {
      const projection = projections.find(item => item.path === relative);
      assert.ok(projection, relative);
      return projection.content.toString('utf8');
    };
    const harness = harnessRoot.split('/')[0];
    const verifier = projectedText(`dist/${harness}/agents/mpx-visual-verifier.md`);
    assert.match(verifier, /Open every captured screenshot/);
    assert.match(verifier, /one-time visual acceptance, complementary to persisted E2E tests/);
    assert.match(verifier, /default ceiling of 10/);
    assert.match(verifier, /channel: 'chrome'/);
    assert.match(verifier, /image\s+inspection capability is `BLOCKED`/);
    const skill = projectedText(`dist/packs/development/${harnessRoot}/skills/mpx-playwright-test/SKILL.md`);
    assert.match(skill, /Invoke `mpx-visual-verifier`/);
    assert.match(skill, /Open and critically inspect every screenshot/);
    assert.match(skill, /openable screenshot links/);
    for (const name of ['execute', 'batch-execute']) {
      const workflow = projectedText(`dist/packs/development/${harnessRoot}/skills/mpx-${name}/SKILL.md`);
      assert.match(workflow, /mpx-visual-verifier/);
      assert.match(workflow, /visually\s+observable interaction/);
      assert.match(workflow, /screenshot/);
    }
  }
});

test('repository and Issue provider roles remain independent', async () => {
  const source = await allBatchText();
  assert.match(source, /repository providers are GitHub, GitLab, or Gerrit/);
  assert.match(source, /Issue\s+providers are GitHub or KanbanFlow/);
  assert.match(source, /independently resolve `issues\.provider` and `repository\.provider`/);
  assert.match(source, /status\/login diagnostics may inspect the active account/i);
  assert.doesNotMatch(source, /Issue provider[^\n]*(?:GitLab|Gerrit)/i);
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
  assert.ok([...projected.keys()].some(item => item.endsWith('/skills/mpx-execute/references/instructions/shared/detect-check-scripts.mjs')));
  assert.ok([...projected.keys()].some(item => item.endsWith('/skills/mpx-board-to-issues/ISSUE_TEMPLATE.md')));
  assert.ok(![...projected.keys()].some(item => item.includes('/skills/mpx-grill-voice/')));
});
