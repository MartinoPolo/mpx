import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeProfiles } from '@mpx/config';
import { compileContent } from '@mpx/content-compiler';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  resolveManifest,
} from '@mpx/skills';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  bindNativeAgentDirectory,
  type NativeAgentFile,
  nodeAgentFileSystem,
  readNativeAgentFile,
  resolveAgentDirectory,
  resolveNativeAgentFile,
} from '../../../subagents/agent-file-policy.js';

import {
  buildAgentRegistry,
  getAvailableTypes,
  registerAgents,
} from '../../../subagents/agent-types.js';
import { reloadAgentRegistry } from '../../../subagents/index.js';
import {
  loadCustomAgents,
  resolveCompiledAgentsDirectory,
  type CompiledAgentsFileSystem,
} from '../../../subagents/custom-agents.js';

const originalCompiledDir = process.env.MPX_COMPILED_AGENTS_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const managedEnvironmentNames = [
  'MPX_RUNTIME',
  'MPX_RUNTIME_CONTEXT',
  'MPX_ACTIVE_CONTENT_ROOT',
  'MPX_ACTIVE_CONTENT_MANIFEST',
  'MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY',
  'MPX_RUNTIME_PROJECTION_REFERENCE',
  'MPX_IDENTITY',
  'MPX_MODE',
] as const;
const originalManagedEnvironment = new Map(
  managedEnvironmentNames.map((name) => [name, process.env[name]]),
);

async function agent(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.md`),
    `---\ndescription: ${JSON.stringify(description)}\n---\nPrompt for ${description}\n`,
    'utf8',
  );
}

function restoreEnvironment(): void {
  if (originalCompiledDir === undefined) {
    delete process.env.MPX_COMPILED_AGENTS_DIR;
  } else {
    process.env.MPX_COMPILED_AGENTS_DIR = originalCompiledDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  for (const name of managedEnvironmentNames) {
    const value = originalManagedEnvironment.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function bindManagedLaunch(root: string): Promise<string> {
  const sourceRoot = join(root, '..', 'source');
  const skillsRoot = join(sourceRoot, 'skills');
  const sharedRoot = join(sourceRoot, 'shared');
  const agentRoot = join(sourceRoot, 'agents');
  await mkdir(join(skillsRoot, 'sample'), { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await mkdir(agentRoot, { recursive: true });
  await writeFile(
    join(skillsRoot, 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Sample.\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [development]\n    defaultExposure: full\n---\nSample body.\n',
  );
  await writeFile(
    join(agentRoot, 'mpx-explorer.md'),
    '---\nname: mpx-explorer\ndescription: compiled Explore\n---\nCompiled prompt.\n',
  );
  await writeFile(
    join(agentRoot, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-explorer': {
          modelClass: 'exploration',
          thinking: 'medium',
          capabilities: ['read', 'search'],
          nesting: [],
          outputSchema: 'text',
        },
      },
    }),
  );
  const catalog = await inventoryCanonical(skillsRoot);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'sample/app',
    identity: 'personal',
    selection: {
      location: { name: 'projects', canonicalRoot: skillsRoot },
      packs: ['development'],
      source: 'project',
    },
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  const plan = await createSkillProjectionPlan({
    canonicalRoot: skillsRoot,
    manifest,
    artifact,
    catalog,
  });
  const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const loadedProfiles = await loadRuntimeProfiles(
    join(repositoryRoot, 'content', 'runtime-profiles.json'),
  );
  const runtimeProfiles = {
    ...loadedProfiles,
    agentTranslation: {
      ...loadedProfiles.agentTranslation,
      runtimes: {
        ...loadedProfiles.agentTranslation.runtimes,
        pi: {
          ...loadedProfiles.agentTranslation.runtimes.pi,
          aliases: { 'mpx-explorer': 'Explore' },
        },
      },
    },
  };
  const tree = await compileContent({
    runtime: 'pi',
    plan,
    runtimeProfiles,
    sharedInstructionRoot: sharedRoot,
    agentRoot,
  });
  for (const file of tree.files) {
    const target = join(root, ...file.relativePath.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, file.bytes);
  }

  const compiled = join(root, 'agents');
  const launchKey = 'a'.repeat(64);
  const descriptorDigest = 'b'.repeat(64);
  const manifestKey = tree.manifest.manifestKey;
  const runtimeArtifactKey = 'd'.repeat(64);
  const manifestBytes = tree.files.find(
    (file) => file.relativePath === 'active-content.json',
  )!.bytes;
  process.env.MPX_RUNTIME = 'pi';
  process.env.MPX_ACTIVE_CONTENT_ROOT = root;
  process.env.MPX_ACTIVE_CONTENT_MANIFEST = join(root, 'active-content.json');
  process.env.MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY = JSON.stringify({
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    byteCount: manifestBytes.byteLength,
  });
  process.env.MPX_COMPILED_AGENTS_DIR = compiled;
  process.env.MPX_RUNTIME_CONTEXT = JSON.stringify({
    schemaVersion: 2,
    launchKey,
    launchDescriptor: { reference: 'launch.json', digest: descriptorDigest },
    manifestKey,
    runtimeArtifact: {
      schemaVersion: 5,
      runtime: 'pi',
      manifestKey,
      artifactKey: runtimeArtifactKey,
      fileMapHash: '1'.repeat(64),
    },
    binding: tree.manifest.binding,
  });
  process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify({
    projectionKey: 'f'.repeat(64),
    fileMapHash: '1'.repeat(64),
    launchBinding: {
      launchKey,
      descriptorDigest,
      runtimeArtifactKey,
      runtime: 'pi',
      manifestKey,
    },
  });
  return compiled;
}

beforeEach(() => {
  delete process.env.MPX_COMPILED_AGENTS_DIR;
  for (const name of managedEnvironmentNames) {
    delete process.env[name];
  }
});

afterEach(() => {
  restoreEnvironment();
  vi.restoreAllMocks();
});

async function linkDirectory(target: string, alias: string): Promise<void> {
  await mkdir(resolve(alias, '..'), { recursive: true });
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
}

test('managed discovery exposes only the compiled catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-managed-agents-'));
  try {
    const cwd = join(root, 'project');
    const globalRoot = join(root, 'global');
    await bindManagedLaunch(join(root, 'projection'));
    await agent(join(globalRoot, 'agents'), 'Explore', 'native conflict');
    await agent(join(cwd, '.agents', 'agents'), 'legacy-workspace', 'legacy workspace');
    await agent(join(cwd, '.pi', 'agents'), 'legacy-project', 'legacy project');
    process.env.PI_CODING_AGENT_DIR = globalRoot;

    let boundary: 'managed' | 'native' = 'native';
    const agents = await loadCustomAgents(cwd, {
      onBoundary: (discoveredBoundary) => {
        boundary = discoveredBoundary;
      },
    });
    const registry = buildAgentRegistry(agents, boundary === 'native');

    assert.deepEqual([...registry.keys()], ['Explore']);
    assert.equal(registry.get('Explore')?.description, 'compiled Explore');
    assert.equal(registry.get('Explore')?.source, 'compiled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed registry reload removes stale identities after compiled bytes are tampered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-stale-managed-agent-'));
  try {
    const projection = join(root, 'projection');
    const compiled = await bindManagedLaunch(projection);
    await reloadAgentRegistry(join(root, 'project'), new Map());
    assert.deepEqual(getAvailableTypes(), ['Explore']);

    await writeFile(
      join(compiled, 'Explore.md'),
      '---\ndescription: tampered\n---\nTampered prompt.\n',
    );

    await assert.rejects(
      () => reloadAgentRegistry(join(root, 'project'), new Map()),
      /Active content file 'agents\/Explore\.md' is missing or changed/,
    );
    assert.deepEqual(getAvailableTypes(), []);
  } finally {
    registerAgents(new Map());
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects tampered compiled agent bytes without native fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-tampered-agent-'));
  try {
    const projection = join(root, 'projection');
    const compiled = await bindManagedLaunch(projection);
    await writeFile(
      join(compiled, 'Explore.md'),
      '---\ndescription: tampered\n---\nTampered prompt.\n',
    );
    await agent(join(root, 'global', 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');

    await assert.rejects(
      async () => await loadCustomAgents(join(root, 'project')),
      /Active content file 'agents\/Explore\.md' is missing or changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing active manifest without native fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-missing-manifest-'));
  try {
    const projection = join(root, 'projection');
    await bindManagedLaunch(projection);
    await unlink(join(projection, 'active-content.json'));
    await agent(join(root, 'global', 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');

    await assert.rejects(
      () => loadCustomAgents(join(root, 'project')),
      /Active content manifest bytes changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects mismatched active manifest bytes without native fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-mismatched-manifest-'));
  try {
    const projection = join(root, 'projection');
    await bindManagedLaunch(projection);
    await writeFile(join(projection, 'active-content.json'), '{}\n');
    await agent(join(root, 'global', 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');

    await assert.rejects(
      () => loadCustomAgents(join(root, 'project')),
      /Active content manifest bytes changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects mismatched managed file map hashes before native discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-mismatched-file-map-'));
  try {
    const cwd = join(root, 'project');
    const globalRoot = join(root, 'global');
    await agent(join(globalRoot, 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = globalRoot;
    await bindManagedLaunch(join(root, 'projection'));
    const reference = JSON.parse(process.env.MPX_RUNTIME_PROJECTION_REFERENCE!) as Record<
      string,
      unknown
    >;
    reference.fileMapHash = '0'.repeat(64);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(reference);
    let boundary: 'managed' | 'native' | undefined;

    await assert.rejects(
      () =>
        loadCustomAgents(cwd, {
          onBoundary: (discoveredBoundary) => {
            boundary = discoveredBoundary;
          },
        }),
      /Invalid managed agent discovery binding: projection identity/,
    );
    assert.equal(boundary, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partial managed identity fails closed instead of falling back to native agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-partial-managed-agents-'));
  try {
    await agent(join(root, 'global', 'agents'), 'legacy-native', 'legacy native');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');
    process.env.MPX_COMPILED_AGENTS_DIR = join(root, 'missing-compiled');

    await assert.rejects(
      () => loadCustomAgents(join(root, 'project')),
      /Invalid managed agent discovery binding: partial environment/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads linked native roots with unchanged precedence, while compiled roots remain strict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-links-'));
  try {
    const cwd = join(root, 'project');
    const globalRoot = join(root, 'global');
    const nativeFiles = new Map<string, NativeAgentFile>();
    const nativeRoots = [
      join(globalRoot, 'agents'),
      join(cwd, '.agents', 'agents'),
      join(cwd, '.pi', 'agents'),
    ];
    process.env.PI_CODING_AGENT_DIR = globalRoot;
    for (const [index, alias] of nativeRoots.entries()) {
      const target = join(root, `target-${index}`);
      await agent(target, 'specialist', `native-${index}`);
      await agent(join(target, 'nested'), 'hidden', 'nested');
      await linkDirectory(join(target, 'nested'), join(target, 'linked.md'));
      await linkDirectory(target, alias);
      assert.throws(() => resolveAgentDirectory(alias), /Unsafe agent directory/);
      assert.throws(
        () => resolveCompiledAgentsDirectory(alias),
        /Unsafe compiled agents directory/,
      );
      const agents = await loadCustomAgents(cwd, { nativeFiles });
      assert.equal(agents.get('specialist')?.description, `native-${index}`);
      assert.equal(nativeFiles.get('specialist')?.directory.declaredPath, alias);
      assert.equal(nativeFiles.get('specialist')?.directory.readOnly, true);
      assert.equal(agents.has('hidden'), false);
      assert.equal(agents.has('linked'), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native roots may have linked ancestors but compiled ancestors remain forbidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-ancestor-'));
  try {
    const target = join(root, 'target');
    const alias = join(root, 'alias');
    await agent(join(target, 'agents'), 'specialist', 'native');
    await linkDirectory(target, alias);
    process.env.PI_CODING_AGENT_DIR = alias;
    delete process.env.MPX_COMPILED_AGENTS_DIR;
    assert.equal(
      (await loadCustomAgents(join(root, 'project'))).get('specialist')?.description,
      'native',
    );
    assert.throws(
      () => resolveCompiledAgentsDirectory(join(alias, 'agents')),
      /Unsafe compiled agents directory/,
    );
    assert.throws(() => resolveAgentDirectory(join(alias, 'agents')), /Redirected agent directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real native binding rejects alias retargeting and canonical directory replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-drift-'));
  try {
    const target = join(root, 'target');
    const replacement = join(root, 'replacement');
    const alias = join(root, 'alias');
    await agent(target, 'specialist', 'original');
    await agent(replacement, 'specialist', 'replacement');
    await linkDirectory(target, alias);
    const directory = bindNativeAgentDirectory(alias);
    const file = resolveNativeAgentFile(directory, 'specialist');
    await unlink(alias);
    await linkDirectory(replacement, alias);
    assert.throws(() => readNativeAgentFile(file), /changed during discovery/);
    await unlink(alias);
    await linkDirectory(target, alias);
    const rebound = bindNativeAgentDirectory(alias);
    await rename(target, join(root, 'old-target'));
    await rename(replacement, target);
    assert.throws(() => resolveNativeAgentFile(rebound, 'specialist'), /changed during discovery/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovery discards a whole native layer on identity drift rather than rebinding each file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-layer-drift-'));
  try {
    const directory = join(root, 'global', 'agents');
    await agent(directory, 'first', 'first');
    await agent(directory, 'second', 'second');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');
    delete process.env.MPX_COMPILED_AGENTS_DIR;
    const originalLstat = nodeAgentFileSystem.lstat;
    const originalRead = nodeAgentFileSystem.read;
    let changed = false;
    vi.spyOn(nodeAgentFileSystem, 'read').mockImplementation((descriptor) => {
      const content = originalRead(descriptor);
      changed = true;
      return content;
    });
    vi.spyOn(nodeAgentFileSystem, 'lstat').mockImplementation((path) => {
      const metadata = originalLstat(path);
      return path === directory && changed ? { ...metadata, inode: 'replacement' } : metadata;
    });
    const diagnostics: string[] = [];
    assert.equal(
      (
        await loadCustomAgents(join(root, 'project'), {
          onDiagnostic: (message) => diagnostics.push(message),
        })
      ).size,
      0,
    );
    assert.ok(diagnostics.length > 0 && diagnostics.length <= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing optional native discovery roots are silent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-missing-'));
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');
    const diagnostics: string[] = [];
    assert.equal(
      (
        await loadCustomAgents(join(root, 'project'), {
          onDiagnostic: (message) => diagnostics.push(message),
        })
      ).size,
      0,
    );
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores stray compiled files and does not expose native defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-compiled-agents-'));
  try {
    const compiled = await bindManagedLaunch(join(root, 'projection'));
    await agent(compiled, 'stray', 'unlisted compiled file');
    await agent(join(root, 'global', 'agents'), 'native', 'native fallback');
    process.env.PI_CODING_AGENT_DIR = join(root, 'global');

    let boundary: 'managed' | 'native' = 'native';
    const agents = await loadCustomAgents(join(root, 'project'), {
      onBoundary: (value) => {
        boundary = value;
      },
    });
    const registry = buildAgentRegistry(agents, boundary === 'native');

    assert.deepEqual([...registry.keys()], ['Explore']);
    assert.equal(registry.has('stray'), false);
    assert.equal(registry.has('native'), false);
    assert.equal(registry.has('general-purpose'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applies native global, shared-project, and Pi-project precedence in ascending order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-native-precedence-'));
  try {
    const globalRoot = join(root, 'global');
    const cwd = join(root, 'project');
    for (const name of ['global-wins', 'workspace-wins', 'project-wins']) {
      await agent(join(globalRoot, 'agents'), name, 'global');
    }
    for (const name of ['workspace-wins', 'project-wins']) {
      await agent(join(cwd, '.agents', 'agents'), name, 'workspace');
    }
    await agent(join(cwd, '.pi', 'agents'), 'project-wins', 'project');
    process.env.PI_CODING_AGENT_DIR = globalRoot;

    const agents = await loadCustomAgents(cwd);

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

    const agents = await loadCustomAgents(cwd);

    assert.equal(agents.get('native-global')?.source, 'global');
    assert.equal(agents.get('native-project')?.source, 'project');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an invalid managed compiled binding without native fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-invalid-managed-binding-'));
  try {
    const globalRoot = join(root, 'global');
    const cwd = join(root, 'project');
    await agent(join(globalRoot, 'agents'), 'native', 'native');
    process.env.PI_CODING_AGENT_DIR = globalRoot;
    await bindManagedLaunch(join(root, 'projection'));
    process.env.MPX_COMPILED_AGENTS_DIR = join(root, 'other-agents');

    await assert.rejects(() => loadCustomAgents(cwd), /projection paths/);
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
  for (const component of components) {
    paths.push(join(paths.at(-1)!, component));
  }

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

    const agents = await loadCustomAgents(cwd);

    assert.equal(agents.has('project-agent'), true);
    assert.equal(agents.has('outside-agent'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
