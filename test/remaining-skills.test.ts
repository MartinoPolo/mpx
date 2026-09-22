import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectContent } from '../src/compiler.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const contentRoot = path.join(root, 'content', 'skills');
const skills = {
  'agent-create': ['development', 'explicit-only'],
  'board-setup': ['development', 'explicit-only'],
  'clean-pc': ['personal', 'explicit-only'],
  'code-clean': ['development', 'name-only'],
  'components-audit': ['development', 'name-only'],
  'fallow-fix': ['development', 'name-only'],
  hitl: ['development', 'explicit-only'],
  'init-github-repo': ['development', 'name-only'],
  notebooklm: ['development', 'name-only'],
  'playwright-test': ['development', 'explicit-only'],
  podcast: ['personal', 'explicit-only'],
  'project-register': ['personal', 'explicit-only'],
  'raycast-config': ['personal', 'explicit-only'],
  'script-discovery': ['development', 'name-only'],
  'setup-react-native': ['development', 'explicit-only'],
  'setup-sveltekit': ['development', 'explicit-only'],
  'skill-audit': ['development', 'name-only'],
  'skill-create': ['development', 'name-only'],
  'suppression-audit': ['development', 'name-only'],
  symlink: ['development', 'name-only'],
  'tutorial-create': ['personal', 'explicit-only'],
  'video-to-image': ['personal', 'explicit-only'],
} as const;

const scriptExtensions = new Set(['.bash', '.cjs', '.cts', '.js', '.mjs', '.mts', '.ps1', '.py', '.sh', '.ts']);

function frontmatter(source: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, 'expected YAML frontmatter');
  return parse(match[1]!) as Record<string, any>;
}

async function filesBelow(directory: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(directory, child));
    else files.push(child);
  }
  return files.sort();
}

function isBinary(content: Buffer): boolean {
  return content.includes(0) || !Buffer.from(content.toString('utf8')).equals(content);
}

function compilerTransforms(content: Buffer): boolean {
  if (isBinary(content)) return false;
  const source = content.toString('utf8');
  return source.includes('{{MPX_') || source.includes('{{include:');
}

test('active workflows retain source metadata', async () => {
  for (const [name, [pack, exposure]] of Object.entries(skills)) {
    const source = await readFile(path.join(contentRoot, name, 'SKILL.md'), 'utf8');
    const data = frontmatter(source);
    assert.equal(data.name, name);
    assert.deepEqual(data.metadata?.mpx, {
      schemaVersion: 1,
      skillPacks: [pack],
      defaultExposure: exposure,
    });
  }
});

test('compiler projects pack exposure, support closure, commands, and sibling prefixes', async () => {
  const projections = await projectContent(root);
  const byPath = new Map(projections.map(item => [item.path, item.content]));
  for (const [name, [pack, exposure]] of Object.entries(skills)) {
    for (const harness of ['pi', 'claude'] as const) {
      const base = harness === 'pi'
        ? `dist/packs/${pack}/pi/skills/mpx-${name}`
        : `dist/packs/${pack}/claude/.claude/skills/mpx-${name}`;
      const projected = byPath.get(`${base}/SKILL.md`);
      assert.ok(projected, `${harness}:${name}`);
      const data = frontmatter(projected.toString('utf8'));
      assert.equal(data.name, `mpx-${name}`);
      assert.equal(data['disable-model-invocation'], exposure === 'explicit-only' ? true : undefined);
      if (exposure === 'name-only') assert.equal(data.description, `Loads the mpx-${name} skill when explicitly referenced.`);
      for (const relative of await filesBelow(path.join(contentRoot, name))) {
        if (relative === 'SKILL.md') continue;
        const projectedSupport = byPath.get(`${base}/${relative}`);
        assert.ok(projectedSupport, `${base}/${relative}`);
        const sourceSupport = await readFile(path.join(contentRoot, name, relative));
        if ((scriptExtensions.has(path.extname(relative)) || isBinary(sourceSupport)) && !compilerTransforms(sourceSupport)) {
          assert.deepEqual(projectedSupport, sourceSupport, `${base}/${relative}`);
        }
      }
    }
  }
  assert.match(byPath.get('dist/packs/personal/pi/skills/mpx-project-register/SKILL.md')!.toString(), /\.\.\/mpx-raycast-config\/SKILL\.md/);
  assert.match(byPath.get('dist/packs/personal/claude/.claude/skills/mpx-podcast/SKILL.md')!.toString(), /\/mpx-notebooklm/);
  assert.match(byPath.get('dist/packs/development/pi/skills/mpx-board-setup/SKILL.md')!.toString(), /\/skill:mpx-board-to-issues/);
});

test('support placeholders and template tokens are valid and bundled JavaScript parses', async () => {
  const platform = await readFile(path.join(contentRoot, 'setup-react-native/PLATFORM_REFERENCE.md'), 'utf8');
  assert.match(platform, /dist\/\{\{MPX_HARNESS\}\}\/rules\/projects\/react\.md/);
  const notebookFlow = await readFile(path.join(contentRoot, 'podcast/reference/NOTEBOOKLM_FLOW.md'), 'utf8');
  assert.match(notebookFlow, /\{\{MPX_SKILL_COMMAND\}\}notebooklm/);

  const template = await readFile(path.join(contentRoot, 'tutorial-create/TEMPLATE.html'), 'utf8');
  const compiler = await readFile(path.join(contentRoot, 'tutorial-create/scripts/compile.js'), 'utf8');
  assert.doesNotMatch(`${template}\n${compiler}`, /\{\{[A-Z][A-Z0-9_]*\}\}/);
  for (const token of ['tutorial_title', 'tutorial_sections', 'tutorial_glossary_json', 'tutorial_slug']) {
    assert.ok(template.includes(`{{${token}}}`), token);
    assert.ok(compiler.includes(`'{{${token}}}'`), token);
  }

  const scripts = (await Promise.all(Object.keys(skills).map(async skill =>
    (await filesBelow(path.join(contentRoot, skill)))
      .filter(file => /\.(?:mjs|js)$/.test(file))
      .map(file => path.join(contentRoot, skill, file))))).flat();
  for (const script of scripts) {
    const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${path.relative(root, script)}\n${checked.stderr}`);
  }
  const detector = spawnSync(process.execPath, [path.join(contentRoot, 'script-discovery/scripts/detect-project-scripts.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(detector.status, 0, detector.stderr);
  assert.match(detector.stdout, /Usage:/);
});
