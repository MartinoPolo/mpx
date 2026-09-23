import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectContent } from '../src/compiler.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

function projectedText(projections: Awaited<ReturnType<typeof projectContent>>, destination: string): string {
  const projection = projections.find(item => item.path === destination);
  assert.ok(projection, `missing projection: ${destination}`);
  return projection.content.toString('utf8');
}

test('compiled agents are self-contained and contain no retired active agent names', async () => {
  const projections = await projectContent(root);
  const retiredAgent = /\bmpx-(?:tdd-executor|git-committer|review-manager)\b/;
  for (const harness of ['pi', 'claude']) {
    const agents = projections.filter(item => item.path.startsWith(`dist/${harness}/agents/`) && item.path.endsWith('.md'));
    assert.ok(agents.length > 0);
    for (const agent of agents) {
      const text = agent.content.toString('utf8');
      assert.doesNotMatch(text, /MPX_ACTIVE_CONTENT_ROOT|\{\{include:/, agent.path);
      assert.doesNotMatch(text, retiredAgent, agent.path);
    }
    for (const name of ['mpx-tdd-executor.md', 'mpx-git-committer.md', 'mpx-review-manager.md']) {
      assert.ok(!agents.some(agent => agent.path.endsWith(`/${name}`)), `${harness}:${name}`);
    }
  }
});

test('retired diagnosis agents remain archived without active projections', async () => {
  const projections = await projectContent(root);
  const retiredNames = ['ci-analyzer', 'issue-analyzer', 'check-reporter'];
  for (const name of retiredNames) {
    const archive = await readFile(path.join(root, 'content/agents/archived', `${name}.md`), 'utf8');
    assert.match(archive, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(!projections.some(projection => projection.path.endsWith(`/mpx-${name}.md`)), name);
  }
  for (const projection of projections) {
    assert.doesNotMatch(projection.path, /agents\/archived\/|REPAIR_ORCHESTRATION\.md/);
    if (!projection.path.endsWith('.md')) continue;
    assert.doesNotMatch(
      projection.content.toString('utf8'),
      /mpx-(?:ci-analyzer|issue-analyzer|check-reporter)|REPAIR_ORCHESTRATION\.md/,
      projection.path,
    );
  }
});

test('execute responsibility boundaries survive both harness projections', async () => {
  const projections = await projectContent(root);
  for (const harness of ['pi', 'claude']) {
    const skillDirectory = harness === 'pi'
      ? 'dist/packs/development/pi/skills/mpx-execute'
      : 'dist/packs/development/claude/.claude/skills/mpx-execute';
    const skill = projectedText(projections, `${skillDirectory}/SKILL.md`);
    const server = projectedText(projections, `${skillDirectory}/DEV_SERVER.md`);
    const checker = projectedText(projections, `dist/${harness}/agents/mpx-checker.md`);
    assert.match(skill, /Dispatch `mpx-executor` for the agreed scope/);
    assert.match(skill, /Ask `mpx-checker` to run `fast_checks`/);
    assert.doesNotMatch(skill, /detect-check-scripts/);
    assert.match(checker, /For discovery-only tasks, return the plan and unresolved gaps without running checks or formatting/);
    assert.match(server, /Main owns server startup and cleanup/);
    assert.match(server, /stop only processes started for this task/);
  }
});

test('check detector runs from each compiled checker link and projected dependency', async () => {
  const projections = await projectContent(root);
  const temporary = await mkdtemp(path.join(tmpdir(), 'mpx-detector-contract-'));
  const repository = path.join(temporary, 'repository');
  try {
    await mkdir(repository);
    await writeFile(path.join(repository, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10',
      scripts: {
        format: 'prettier --write .',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        lint: 'eslint .',
        build: 'vite build',
        dev: 'vite',
      },
    }));
    await writeFile(path.join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const expected = {
      fast_checks: [
        { command: 'pnpm run format', cwd: '.' },
        { command: 'pnpm run typecheck', cwd: '.' },
        { command: 'pnpm run test', cwd: '.' },
      ],
      full_checks: [
        { command: 'pnpm run lint', cwd: '.' },
        { command: 'pnpm run build', cwd: '.' },
      ],
      unresolved: [],
    };
    for (const harness of ['pi', 'claude']) {
      const checkerPath = `dist/${harness}/agents/mpx-checker.md`;
      const checker = projections.find(item => item.path === checkerPath);
      assert.ok(checker, `${harness} compiled checker`);
      const detectorLink = /\[[^\]]*\]\(([^)]+detect-check-scripts\.mjs)\)/.exec(checker.content.toString('utf8'))?.[1];
      assert.ok(detectorLink, `${harness} detector link`);
      const detectorPath = path.posix.normalize(path.posix.join(path.posix.dirname(checkerPath), detectorLink));
      const detectorDependency = projections.find(item => item.path === detectorPath);
      assert.ok(detectorDependency, `${harness} projected detector dependency`);

      const bundle = path.join(temporary, harness);
      for (const projection of [checker, detectorDependency]) {
        const destination = path.join(bundle, projection.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, projection.content);
      }
      const detector = path.resolve(bundle, path.dirname(checkerPath), detectorLink);
      const { stdout } = await exec(process.execPath, [detector, repository], { timeout: 5_000 });
      assert.deepEqual(JSON.parse(stdout), expected);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
