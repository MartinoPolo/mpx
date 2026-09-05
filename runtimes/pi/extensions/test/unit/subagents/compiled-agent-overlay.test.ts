import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

import { afterEach, test } from 'vitest';

import {
  loadCustomAgents,
  resolveCompiledAgentsDirectory,
  type CompiledAgentsFileSystem,
} from '../../../subagents/custom-agents.js';

const originalCompiledDir = process.env.MPX_COMPILED_AGENTS_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function agent(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.md`),
    `---\ndescription: ${JSON.stringify(description)}\n---\nPrompt for ${description}\n`,
    'utf8',
  );
}

function restoreEnvironment(): void {
  if (originalCompiledDir === undefined) delete process.env.MPX_COMPILED_AGENTS_DIR;
  else process.env.MPX_COMPILED_AGENTS_DIR = originalCompiledDir;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
}

afterEach(restoreEnvironment);

test('loads only direct regular safe-name markdown files from the compiled directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-compiled-agents-'));
  try {
    const compiled = join(root, 'compiled');
    await agent(compiled, 'compiled-only', 'compiled only');
    await agent(join(compiled, 'nested'), 'nested-agent', 'nested');
    await writeFile(join(compiled, 'unsafe name.md'), '---\ndescription: unsafe\n---\n', 'utf8');
    await mkdir(join(compiled, 'not-a-file.md'));
    process.env.MPX_COMPILED_AGENTS_DIR = compiled;
    process.env.PI_CODING_AGENT_DIR = join(root, 'empty-global');

    const agents = loadCustomAgents(join(root, 'project'));

    assert.equal(agents.get('compiled-only')?.source, 'compiled');
    assert.equal(agents.get('compiled-only')?.description, 'compiled only');
    assert.equal(agents.has('nested-agent'), false);
    assert.equal(agents.has('unsafe name'), false);
    assert.equal(agents.has('not-a-file'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies compiled, global, shared-project, and Pi-project precedence in ascending order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-compiled-precedence-'));
  try {
    const compiled = join(root, 'compiled');
    const globalRoot = join(root, 'global');
    const cwd = join(root, 'project');
    for (const name of ['global-wins', 'workspace-wins', 'project-wins']) {
      await agent(compiled, name, 'compiled');
      await agent(join(globalRoot, 'agents'), name, 'global');
    }
    for (const name of ['workspace-wins', 'project-wins']) {
      await agent(join(cwd, '.agents', 'agents'), name, 'workspace');
    }
    await agent(join(cwd, '.pi', 'agents'), 'project-wins', 'project');
    process.env.MPX_COMPILED_AGENTS_DIR = compiled;
    process.env.PI_CODING_AGENT_DIR = globalRoot;

    const agents = loadCustomAgents(cwd);

    assert.equal(agents.get('global-wins')?.description, 'global');
    assert.equal(agents.get('workspace-wins')?.description, 'workspace');
    assert.equal(agents.get('project-wins')?.description, 'project');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves native global and project discovery unchanged when the overlay environment is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-agents-'));
  try {
    const globalRoot = join(root, 'global');
    const cwd = join(root, 'project');
    await agent(join(globalRoot, 'agents'), 'native-global', 'global');
    await agent(join(cwd, '.pi', 'agents'), 'native-project', 'project');
    delete process.env.MPX_COMPILED_AGENTS_DIR;
    process.env.PI_CODING_AGENT_DIR = globalRoot;

    const agents = loadCustomAgents(cwd);

    assert.equal(agents.get('native-global')?.source, 'global');
    assert.equal(agents.get('native-project')?.source, 'project');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed overlay environment values without suppressing native discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-malformed-overlay-'));
  try {
    const globalRoot = join(root, 'global');
    const cwd = join(root, 'project');
    await agent(join(globalRoot, 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = globalRoot;

    for (const malformed of [
      'relative/agents',
      `${root}\nredirect`,
      `${root}\u0001redirect`,
      `/${'x'.repeat(4097)}`,
    ]) {
      process.env.MPX_COMPILED_AGENTS_DIR = malformed;
      const agents = loadCustomAgents(cwd);
      assert.equal(agents.get('native')?.source, 'global');
      assert.equal(agents.size, 1);
    }
    assert.throws(
      () => resolveCompiledAgentsDirectory(`${root}\u0000redirect`),
      /Unsafe compiled agents directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lstats and realpaths every directory component and rejects simulated links or reparse points', () => {
  const target = resolve('safe', 'compiled', 'agents');
  const root = parse(target).root;
  const components = relative(root, target).split(sep).filter(Boolean);
  const paths = [root];
  for (const component of components) paths.push(join(paths.at(-1)!, component));

  for (const unsafeProperty of ['isSymbolicLink', 'isReparsePoint'] as const) {
    const lstatPaths: string[] = [];
    const realpathPaths: string[] = [];
    const unsafePath = paths[Math.max(0, paths.length - 2)]!;
    const fileSystem: CompiledAgentsFileSystem = {
      lstat: (path) => {
        lstatPaths.push(path);
        return {
          isDirectory: () => true,
          isSymbolicLink: () => unsafeProperty === 'isSymbolicLink' && path === unsafePath,
          isReparsePoint: () => unsafeProperty === 'isReparsePoint' && path === unsafePath,
        };
      },
      realpath: (path) => {
        realpathPaths.push(path);
        return path;
      },
    };

    assert.throws(
      () => resolveCompiledAgentsDirectory(target, fileSystem),
      /Unsafe compiled agents directory/,
    );
    assert.deepEqual(lstatPaths, paths.slice(0, paths.indexOf(unsafePath) + 1));
    assert.deepEqual(realpathPaths, paths.slice(0, paths.indexOf(unsafePath)));
  }
});

test('project files and cwd names cannot select a compiled overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-project-overlay-'));
  try {
    const cwd = join(root, 'MPX_COMPILED_AGENTS_DIR=outside');
    const projectAgents = join(cwd, '.pi', 'agents');
    await agent(projectAgents, 'project-agent', 'MPX_COMPILED_AGENTS_DIR: ../outside');
    await agent(join(root, 'outside'), 'outside-agent', 'outside');
    delete process.env.MPX_COMPILED_AGENTS_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, 'empty-global');

    const agents = loadCustomAgents(cwd);

    assert.equal(agents.has('project-agent'), true);
    assert.equal(agents.has('outside-agent'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
