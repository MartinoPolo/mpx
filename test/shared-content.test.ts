import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectContent } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const content = path.join(root, 'content');
const specialistMetadata = {
  'chrome-devtools-tester': ['advanced', 'high', ['read', 'search', 'shell', 'browser']],
  'context7-docs-fetcher': ['mechanical', 'xhigh', ['read', 'context']],
  executor: ['advanced', 'high', ['read', 'search', 'shell', 'write']],
  'issue-finder': ['mechanical', 'high', ['read', 'search', 'shell']],
  shipper: ['standard', 'medium', ['shell']],
  simplifier: ['advanced', 'high', ['read', 'search', 'shell', 'write']],
  'ui-variant-generator': ['advanced', 'medium', ['read', 'search', 'shell', 'write']],
  'unresolved-issue-tracker': ['standard', 'low', ['read', 'search', 'shell']],
} as const;

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

function frontmatter(source: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, 'expected frontmatter');
  return parse(match[1]!) as Record<string, any>;
}

test('shared instruction, provider, rule, output-style, and helper closure is canonical', async () => {
  assert.deepEqual(await filesBelow(path.join(content, 'instructions')), [
    'claude/CLAUDE.md',
    'pi/APPEND_SYSTEM.md',
    'shared/AGENTS.md',
    'shared/BOARD_CONVENTION.md',
    'shared/COMPACT.md',
    'shared/ISSUE_TRACKER.md',
    'shared/PLAYWRIGHT_TESTING.md',
    'shared/PROJECT_DOC_TEMPLATES.md',
    'shared/PROVIDER_ROUTING.md',
    'shared/REVIEWER_PROTOCOL.md',
    'shared/SENTRY.md',
    'shared/WRITING_FOR_AGENTS.md',
    'shared/deep-modules.md',
    'shared/detect-check-scripts.mjs',
    'shared/interface-design.md',
    'shared/providers/GERRIT.md',
    'shared/providers/GITHUB.md',
    'shared/providers/GITLAB.md',
    'shared/providers/KANBANFLOW.md',
    'shared/providers/LOCAL.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(content, 'rules')), [
    'global/css-color-guide.instructions.md',
    'global/update-docs.instructions.md',
    'languages/css.md',
    'languages/python.md',
    'languages/rust.md',
    'languages/svelte.md',
    'languages/typescript.md',
    'projects/react.md',
    'projects/references/shadcn-svelte-component-catalog.md',
    'projects/shadcn-svelte.md',
    'projects/solid.md',
    'projects/storybook.md',
    'projects/svelte-context.md',
    'projects/sveltekit-dev-warmup.md',
    'projects/sveltekit-paths-server.md',
    'projects/sveltekit-paths.md',
  ]);
  assert.deepEqual(await filesBelow(path.join(content, 'output-styles')), ['mpx-terse.md']);

  const helpers = await Promise.all(['deep-modules.md', 'interface-design.md']
    .map(name => readFile(path.join(content, 'instructions/shared', name), 'utf8')));
  for (const needle of ['Deep modules', 'Interface Design for Testability']) {
    assert.ok(helpers.some(source => source.includes(needle)), needle);
  }
});

test('reporting links are self-contained in native presentation instructions', async () => {
  const projections = await projectContent(root);
  for (const harness of ['pi', 'claude']) {
    const guidance = projections.find(file => file.path === `dist/${harness}/instructions/shared/AGENTS.md`);
    assert.ok(guidance);
    assert.doesNotMatch(guidance.content.toString('utf8'), /## Reporting|file:\/\/\//);
  }
  for (const destination of ['dist/pi/instructions/pi/APPEND_SYSTEM.md', 'dist/claude/output-styles/mpx-terse.md']) {
    const presentation = projections.find(file => file.path === destination);
    assert.ok(presentation, destination);
    const text = presentation.content.toString('utf8');
    assert.match(text, /file:\/\/\//);
    assert.match(text, /#L\{number\}/);
    assert.match(text, /canonical HTTPS URL/);
  }
  for (const projection of projections) {
    assert.doesNotMatch(projection.path, /REPORTING_LINKS\.md/);
    assert.doesNotMatch(projection.content.toString('utf8'), /REPORTING_LINKS\.md/);
  }
});

test('discovery guidance does not depend on retired shared policies', async () => {
  const retiredPolicy = /(?:CONTENT_PATHS|EXPLORATION|SUBAGENT_PROTOCOL)\.md/;
  for (const file of await filesBelow(content)) {
    assert.doesNotMatch(file, retiredPolicy);
    if (file.endsWith('.md')) {
      assert.doesNotMatch(await readFile(path.join(content, file), 'utf8'), retiredPolicy, file);
    }
  }
  for (const projection of await projectContent(root)) {
    assert.doesNotMatch(projection.path, retiredPolicy);
    if (projection.path.endsWith('/instructions/shared/AGENTS.md')) {
      const guidance = projection.content.toString('utf8');
      assert.match(guidance, /Delegate broad discovery to the exploration agent/);
      assert.match(guidance, /Prefer declared agent model and effort\s+defaults/);
      assert.doesNotMatch(guidance, /MPX_ACTIVE_CONTENT_ROOT/);
    }
  }
});

test('authoring workflows use one writing standard without retired policy dependencies', async () => {
  const retiredPolicy = /AUTHORING\.md/;
  for (const file of await filesBelow(content)) {
    assert.doesNotMatch(file, retiredPolicy);
    if (file.endsWith('.md')) {
      assert.doesNotMatch(await readFile(path.join(content, file), 'utf8'), retiredPolicy, file);
    }
  }
  const projections = await projectContent(root);
  for (const projection of projections) {
    assert.doesNotMatch(projection.path, retiredPolicy);
    if (projection.path.endsWith('.md')) {
      assert.doesNotMatch(projection.content.toString('utf8'), retiredPolicy, projection.path);
    }
  }
  for (const harness of ['pi', 'claude']) {
    for (const skill of ['agent-create', 'skill-create', 'skill-audit']) {
      const skillRoot = harness === 'pi' ? 'pi/skills' : 'claude/.claude/skills';
      const destination = `dist/packs/development/${skillRoot}/mpx-${skill}/SKILL.md`;
      const projection = projections.find(file => file.path === destination);
      assert.ok(projection, destination);
      const text = projection.content.toString('utf8');
      assert.match(text, /WRITING_FOR_AGENTS\.md\)\s+completely/);
      assert.doesNotMatch(text, /(?:100|200) lines|250 characters|contentVersion/);
    }
  }
});

test('documentation workflows retain local safeguards without a shared strategy', async () => {
  const retiredPolicy = /DOCUMENTATION_STRATEGY\.md/;
  for (const file of await filesBelow(content)) {
    assert.doesNotMatch(file, retiredPolicy);
    if (file.endsWith('.md')) {
      assert.doesNotMatch(await readFile(path.join(content, file), 'utf8'), retiredPolicy, file);
    }
  }
  for (const projection of await projectContent(root)) {
    assert.doesNotMatch(projection.path, retiredPolicy);
    if (projection.path.endsWith('.md')) {
      assert.doesNotMatch(projection.content.toString('utf8'), retiredPolicy, projection.path);
    }
  }
  for (const file of ['skills/grill/SKILL.md', 'skills/unfinished/grill-voice/GRILL_WORKFLOW.md']) {
    const workflow = await readFile(path.join(content, file), 'utf8');
    assert.match(workflow, /Write only confirmed\s+terms/);
    assert.match(workflow, /only when explicitly rejected/);
    assert.match(workflow, /Replace superseded entries/);
  }
  const templates = await readFile(path.join(content, 'instructions/shared/PROJECT_DOC_TEMPLATES.md'), 'utf8');
  assert.match(templates, /preserve substantive existing content/);
  assert.match(templates, /Do not recreate or fall back/);
  assert.doesNotMatch(templates, /YYYY-MM-DD|\d+ lines/);
});

test('project documentation starts minimal and writers populate sections on demand', async () => {
  const templates = await readFile(path.join(content, 'instructions/shared/PROJECT_DOC_TEMPLATES.md'), 'utf8');
  assert.match(templates, /Create missing `\.mpx\/CONTEXT\.md` and `\.mpx\/DECISIONS\.md`/);
  assert.match(templates, /leave only the document title/);
  assert.match(templates, /only for\s+confirmed choices/);
  assert.doesNotMatch(templates, /\[Project Name\]|\[Domain\]|Three-sentence|```/);
  for (const skill of ['setup-sveltekit', 'setup-react-native', 'init-github-repo']) {
    const workflow = await readFile(path.join(content, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(workflow, /PROJECT_DOC_TEMPLATES\.md/);
    assert.doesNotMatch(workflow, /content procedure|canonical scaffold|exact.*scaffolds|project-name placeholder/);
  }
  for (const file of [
    'grill/SKILL.md', 'unfinished/grill-voice/GRILL_WORKFLOW.md',
    'unfinished/consolidate-context/SKILL.md', 'unfinished/harvest-decisions/SKILL.md',
  ]) {
    const workflow = await readFile(path.join(content, 'skills', file), 'utf8');
    assert.match(workflow, /Create missing\s+sections only/, file);
    assert.match(workflow, /(?:do not|Do not)\s+add empty sections/, file);
  }
  const initialization = await readFile(path.join(content, 'skills/init-github-repo/SKILL.md'), 'utf8');
  assert.match(initialization, /Verify both files\s+exist/);
  assert.match(initialization, /never stage unrelated files or secrets/);
});

test('design workflows carry their contracts without a shared pipeline dependency', async () => {
  const retiredPolicy = /DESIGN_PIPELINE\.md/;
  for (const file of await filesBelow(content)) {
    assert.doesNotMatch(file, retiredPolicy);
    if (file.endsWith('.md')) {
      assert.doesNotMatch(await readFile(path.join(content, file), 'utf8'), retiredPolicy, file);
    }
  }
  for (const projection of await projectContent(root)) {
    assert.doesNotMatch(projection.path, retiredPolicy);
    if (projection.path.endsWith('.md')) {
      assert.doesNotMatch(projection.content.toString('utf8'), retiredPolicy, projection.path);
    }
  }
  const mockup = await readFile(path.join(content, 'skills/mockup/SKILL.md'), 'utf8');
  const refinement = await readFile(path.join(content, 'skills/design-refine/SKILL.md'), 'utf8');
  assert.match(mockup, /link `\.\.\/\.\.\/tokens\.css`/);
  assert.match(refinement, /link `\.\.\/tokens\.css`/);
  for (const workflow of [mockup, refinement]) {
    assert.match(workflow, /inline only discovered custom properties/);
    assert.match(workflow, /without invented production claims/);
    assert.match(workflow, /keyboard focus/);
    assert.match(workflow, /component\/chrome ownership/);
  }
  assert.match(mockup, /pass the complete HTML contract/);
  assert.doesNotMatch(mockup, /Leave `designs\/tokens\.css` unread/);
  assert.match(refinement, /only once the user has reviewed `refined\.html` and approved it/);
  assert.match(refinement, /leave affected gates unchanged/);
  assert.match(refinement, /Preserve rejected variants/);
  const brief = await readFile(path.join(content, 'skills/design-brief/SKILL.md'), 'utf8');
  assert.doesNotMatch(brief, /breadth stated|skips repository instructions/);
  assert.match(brief, /required\s+manual action/);
  const initialization = await readFile(path.join(content, 'skills/design-init/SKILL.md'), 'utf8');
  assert.match(initialization, /only explicitly rejected alternatives/);
  assert.doesNotMatch(initialization, /Decided: \[date\]|alternatives\s+considered/);
});

test('agent model and effort defaults project consistently across harnesses', async () => {
  const expectedDefaults = {
    executor: ['advanced', 'high'],
    simplifier: ['advanced', 'high'],
    shipper: ['standard', 'medium'],
    checker: ['mechanical', 'high'],
    explorer: ['exploration', 'xhigh'],
    'context7-docs-fetcher': ['mechanical', 'xhigh'],
    'issue-finder': ['mechanical', 'high'],
    'reviewer-test-quality': ['standard', 'high'],
    'reviewer-security': ['standard', 'high'],
    'reviewer-performance': ['standard', 'high'],
    'reviewer-error-handling': ['standard', 'high'],
  } as const;
  const profiles = JSON.parse(await readFile(path.join(content, 'runtime-profiles.json'), 'utf8'));
  const projections = await projectContent(root);
  for (const [name, [modelClass, effort]] of Object.entries(expectedDefaults)) {
    const source = frontmatter(await readFile(path.join(content, 'agents', `${name}.md`), 'utf8'));
    assert.equal(source.metadata.mpx.modelClass, modelClass, name);
    assert.equal(source.metadata.mpx.thinking, effort, name);
    for (const harness of ['pi', 'claude']) {
      const destination = `dist/${harness}/agents/mpx-${name}.md`;
      const projection = projections.find(file => file.path === destination);
      assert.ok(projection, destination);
      const native = frontmatter(projection.content.toString('utf8'));
      assert.equal(native.model, profiles.models[harness][modelClass], destination);
      assert.equal(native[harness === 'pi' ? 'thinking' : 'effort'], effort, destination);
    }
  }
});

test('specialists have compiler metadata and preserve their workflow contracts', async () => {
  const semanticNeedles: Record<keyof typeof specialistMetadata, string[]> = {
    'chrome-devtools-tester': ['Browser actions may mutate', 'take_snapshot', 'Browser Test Report'],
    'context7-docs-fetcher': ['Resolve Library ID', 'Check Version', 'Answer from Docs Only'],
    executor: ['Implement the assigned scope', 'Implementation Quality', 'Coverage Changes'],
    'issue-finder': ['Prefer precision over recall', 'instant match', 'candidates` contains at most three'],
    shipper: ['Ship the caller', 'create or update a **draft** PR/MR', 'Safe base synchronization'],
    simplifier: ['behavior-preserving simplification', 'leave it unchanged and report success', 'perform unrelated cleanup, run a review workflow, or perform git operations'],
    'ui-variant-generator': ['one distinct visual interpretation', 'WCAG AA', 'Exact requested path'],
    'unresolved-issue-tracker': ['route every item\nwithout losing it', 'Never create a second tracking Issue', 'routed_to_siblings'],
  };
  for (const [name, [modelClass, thinking, capabilities]] of Object.entries(specialistMetadata)) {
    const source = await readFile(path.join(content, 'agents', `${name}.md`), 'utf8');
    const data = frontmatter(source);
    assert.equal(data.name, name);
    assert.deepEqual(data.metadata?.mpx, { schemaVersion: 1, modelClass, thinking, capabilities: [...capabilities] });
    for (const needle of semanticNeedles[name as keyof typeof specialistMetadata]) assert.ok(source.includes(needle), `${name}: ${needle}`);
  }
});

test('native-first content has stable projected dependencies and no retired runtime dependency', async () => {
  const relevant = [
    ...Object.keys(specialistMetadata).map(name => path.join(content, 'agents', `${name}.md`)),
    ...(await filesBelow(path.join(content, 'instructions')))
      .filter(name => !['shared/COMPACT.md', 'shared/REVIEWER_PROTOCOL.md'].includes(name))
      .map(name => path.join(content, 'instructions', name)),
    path.join(content, 'output-styles/mpx-terse.md'),
  ];
  const source = (await Promise.all(relevant.map(file => readFile(file, 'utf8')))).join('\n');
  for (const banned of [
    'skills/shared/', '~/.agents/', '@mpx/', 'mpx workspace', 'mpx port', '/mpx:',
    'MPX-Session:', 'SessionManager', 'runtime MCP gateway', 'immutable MPX launch identity',
    'application entrypoint', 'dev-server process manager',
  ]) assert.ok(!source.includes(banned), `retired dependency: ${banned}`);
  assert.doesNotMatch(source, /pnpm (?:run )?typecheck/i);
  assert.match(source, /MPX_ACTIVE_CONTENT_ROOT/);
  assert.match(source, /\/skill:mpx-<name>/);
  assert.match(source, /\/mpx-<name>/);
  assert.match(source, /parent may start a server/);
  assert.doesNotMatch(source, /Project servers are started manually/);
  assert.match(source, /Do not create, switch, or remove worktrees/);
});

test('provider roles remain independent and local is explicitly unsupported', async () => {
  const routing = await readFile(path.join(content, 'instructions/shared/PROVIDER_ROUTING.md'), 'utf8');
  const local = await readFile(path.join(content, 'instructions/shared/providers/LOCAL.md'), 'utf8');
  const gitlab = await readFile(path.join(content, 'instructions/shared/providers/GITLAB.md'), 'utf8');
  assert.match(routing, /repository operations[\s\S]*GitHub[\s\S]*GitLab[\s\S]*Gerrit/i);
  assert.match(routing, /Issue operations[\s\S]*GitHub[\s\S]*KanbanFlow/);
  assert.match(routing, /roles independently/);
  assert.match(local, /does not implement or import a local Issue provider/);
  assert.match(local, /Do not reinterpret the value as GitHub/);
  assert.match(gitlab, /Issue-provider use is unsupported/);
});

test('compiler resolves native commands and every added local Markdown dependency', async () => {
  const projections = await projectContent(root);
  const byPath = new Map(projections.map(item => [item.path, item.content.toString('utf8')]));
  assert.match(byPath.get('dist/pi/instructions/shared/AGENTS.md')!, /\/skill:mpx-<name>/);
  assert.match(byPath.get('dist/claude/instructions/shared/AGENTS.md')!, /\/mpx-<name>/);
  assert.match(byPath.get('dist/pi/agents/mpx-executor.md')!, /Use meaningful end-to-end tests for user-facing behavior/);
  assert.match(byPath.get('dist/claude/agents/mpx-chrome-devtools-tester.md')!, /Playwright Testing — Reliability Contract/);
  assert.ok(byPath.has('dist/pi/rules/projects/storybook.md'));
  assert.ok(byPath.has('dist/claude/output-styles/mpx-terse.md'));
});
