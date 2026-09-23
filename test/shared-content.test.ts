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
  'visual-verifier': ['reviewer', 'medium', ['read', 'search', 'shell', 'browser'], { claude: 'high' }],
  'context7-docs-fetcher': ['mechanical', 'xhigh', ['read', 'context']],
  executor: ['advanced', 'high', ['read', 'search', 'shell', 'write']],
  'issue-finder': ['mechanical', 'high', ['read', 'search', 'shell']],
  shipper: ['mechanical', 'high', ['shell'], { claude: 'medium' }],
  simplifier: ['advanced', 'high', ['read', 'search', 'shell', 'write']],
  'ui-variant-generator': ['advanced', 'medium', ['read', 'search', 'shell', 'write']],
  'unresolved-issue-tracker': ['mechanical', 'high', ['read', 'search', 'shell'], { claude: 'low' }],
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
    'shared/COMPACT.md',
    'shared/PROJECT_DOC_TEMPLATES.md',
    'shared/PROVIDER_ROUTING.md',
    'shared/SENTRY.md',
    'shared/WRITING_FOR_AGENTS.md',
    'shared/detect-check-scripts.mjs',
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
});

test('projections exclude the retired reporting dependency', async () => {
  for (const projection of await projectContent(root)) {
    assert.doesNotMatch(projection.path, /REPORTING_LINKS\.md/);
    assert.doesNotMatch(projection.content.toString('utf8'), /REPORTING_LINKS\.md/);
  }
});

test('retired discovery policies are excluded from source and projections', async () => {
  const retiredPolicy = /(?:CONTENT_PATHS|EXPLORATION|SUBAGENT_PROTOCOL)\.md/;
  for (const file of await filesBelow(content)) {
    assert.doesNotMatch(file, retiredPolicy);
    if (file.endsWith('.md')) {
      assert.doesNotMatch(await readFile(path.join(content, file), 'utf8'), retiredPolicy, file);
    }
  }
  for (const projection of await projectContent(root)) {
    assert.doesNotMatch(projection.path, retiredPolicy);
  }
});

test('retired authoring policy is excluded from source and projections', async () => {
  const retiredPolicy = /AUTHORING\.md/;
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
});

test('retired documentation strategy is excluded from source and projections', async () => {
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
});

test('retired design pipeline is excluded from source and projections', async () => {
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
});

test('runtime profiles pin Codex Luna and Sol models and define a reviewer class', async () => {
  const profiles = JSON.parse(await readFile(path.join(content, 'runtime-profiles.json'), 'utf8'));
  assert.deepEqual(profiles.models.claude, {
    mechanical: 'sonnet',
    exploration: 'sonnet',
    standard: 'sonnet',
    reviewer: 'sonnet',
    advanced: 'opus',
    frontier: 'fable',
  });
  assert.deepEqual(profiles.models.pi, {
    mechanical: 'openai-codex/gpt-6-luna',
    exploration: 'openai-codex/gpt-6-luna',
    standard: 'openai-codex/gpt-6-luna',
    reviewer: 'openai-codex/gpt-6-sol',
    advanced: 'openai-codex/gpt-6-sol',
    frontier: 'openai-codex/astra',
  });

  const claudeAgents = (await projectContent(root)).filter(projection =>
    projection.path.startsWith('dist/claude/agents/mpx-') && projection.path.endsWith('.md'));
  assert.ok(claudeAgents.length > 0);
  for (const projection of claudeAgents) {
    assert.doesNotMatch(String(frontmatter(projection.content.toString('utf8')).model), /haiku/i, projection.path);
  }
});

test('agent model and effort defaults project consistently across harnesses', async () => {
  const expectedRouting = {
    executor: ['advanced', 'high', 'high'],
    simplifier: ['advanced', 'high', 'high'],
    shipper: ['mechanical', 'high', 'medium'],
    checker: ['mechanical', 'high', 'high'],
    explorer: ['exploration', 'xhigh', 'xhigh'],
    'context7-docs-fetcher': ['mechanical', 'xhigh', 'xhigh'],
    'issue-finder': ['mechanical', 'high', 'high'],
    'reviewer-test-quality': ['reviewer', 'high', 'high'],
    'visual-verifier': ['reviewer', 'medium', 'high'],
    'reviewer-security': ['reviewer', 'high', 'high'],
    'reviewer-performance': ['reviewer', 'high', 'high'],
    'reviewer-error-handling': ['reviewer', 'high', 'high'],
  } as const;
  const profiles = JSON.parse(await readFile(path.join(content, 'runtime-profiles.json'), 'utf8'));
  const projections = await projectContent(root);
  for (const [name, [modelClass, piThinking, claudeThinking]] of Object.entries(expectedRouting)) {
    const source = frontmatter(await readFile(path.join(content, 'agents', `${name}.md`), 'utf8'));
    assert.equal(source.metadata.mpx.modelClass, modelClass, name);
    assert.equal(source.metadata.mpx.thinking, piThinking, name);
    for (const [harness, thinking] of [['pi', piThinking], ['claude', claudeThinking]] as const) {
      const destination = `dist/${harness}/agents/mpx-${name}.md`;
      const projection = projections.find(file => file.path === destination);
      assert.ok(projection, destination);
      const native = frontmatter(projection.content.toString('utf8'));
      assert.equal(native.model, profiles.models[harness][modelClass], destination);
      assert.equal(native[harness === 'pi' ? 'thinking' : 'effort'], thinking, destination);
    }
  }
});

test('all reviewer agents use the reviewer model class', async () => {
  const reviewerNames = (await readdir(path.join(content, 'agents')))
    .filter(name => name.startsWith('reviewer-') && name.endsWith('.md'));
  assert.ok(reviewerNames.length > 0);
  for (const name of reviewerNames) {
    const data = frontmatter(await readFile(path.join(content, 'agents', name), 'utf8'));
    assert.equal(data.metadata.mpx.modelClass, 'reviewer', name);
  }
});

test('specialists have compiler metadata', async () => {
  for (const [name, [modelClass, thinking, capabilities, thinkingOverrides]] of Object.entries(specialistMetadata)) {
    const source = await readFile(path.join(content, 'agents', `${name}.md`), 'utf8');
    const data = frontmatter(source);
    assert.equal(data.name, name);
    assert.deepEqual(data.metadata?.mpx, {
      schemaVersion: 1,
      modelClass,
      thinking,
      ...(thinkingOverrides ? { thinkingOverrides } : {}),
      capabilities: [...capabilities],
    });
  }
});

test('reviewer and invoking workflow projections exclude the retired protocol', async () => {
  const projections = await projectContent(root);
  const reviewerNames = (await readdir(path.join(content, 'agents')))
    .filter(name => name.startsWith('reviewer-') && name.endsWith('.md'));
  assert.ok(reviewerNames.length > 0);
  for (const harness of ['pi', 'claude']) {
    for (const name of reviewerNames) {
      const destination = `dist/${harness}/agents/mpx-${name}`;
      assert.ok(projections.some(item => item.path === destination), destination);
    }
  }
  assert.ok(!projections.some(item => item.path.endsWith('/REVIEWER_PROTOCOL.md')));
  for (const harnessRoot of ['pi', 'claude/.claude']) {
    for (const name of ['execute', 'batch-execute', 'review', 'code-clean', 'check-fix']) {
      const destination = `dist/packs/development/${harnessRoot}/skills/mpx-${name}/SKILL.md`;
      assert.ok(projections.some(item => item.path === destination), destination);
    }
  }
});

test('GitHub initialization bundles no provider-routing files', async () => {
  const projections = await projectContent(root);
  for (const harnessRoot of ['pi', 'claude/.claude']) {
    const skillRoot = `dist/packs/development/${harnessRoot}/skills/mpx-init-github-repo/`;
    const bundle = projections.filter(projection => projection.path.startsWith(skillRoot));
    assert.ok(bundle.some(projection => projection.path === `${skillRoot}SKILL.md`));
    for (const projection of bundle) {
      assert.doesNotMatch(projection.path, /PROVIDER_ROUTING\.md|\/providers\//);
    }
  }
});