import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { sanitizedEnvironment } from '@mpx/executors';

const cleanupRoots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

async function fileInventory(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await fileInventory(root, relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runNode(
  argv: string[],
  options: { cwd: string; inheritOutput?: boolean },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: options.inheritOutput ? 'inherit' : 'pipe',
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Node subprocess timed out: ${argv.join(' ')}`));
    }, 30_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Node subprocess exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

async function managedNativeDiscoveryProjection(root: string): Promise<Record<string, string>> {
  const files: Array<{ relativePath: string; sha256: string; byteCount: number }> = [];
  const skills = [];
  for (const [identity, exposure, source, relativePath] of [
    ['commit', 'full', 'content', 'skills/commit/SKILL.md'],
    ['canonical-manual', 'explicit-only', 'content', 'skills/canonical-manual/SKILL.md'],
    ['skill:commit', 'full', '.agents', 'project-skills/skills/commit/SKILL.md'],
  ] as const) {
    const bareName = identity.replace(/^skill:/u, '');
    const header = `---\nname: ${bareName}\ndescription: ${bareName} description\n${exposure === 'explicit-only' ? 'disable-model-invocation: true\n' : ''}---\n`;
    const bytes = Buffer.from(`${header}Instructions for ${identity}.\n`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), bytes);
    files.push({ relativePath, sha256, byteCount: bytes.byteLength });
    skills.push({
      identity,
      exposure,
      canonicalDescription: `${identity} description`,
      effectiveDescription: `${identity} description`,
      sourcePath: `${source}/skills/${bareName}/SKILL.md`,
      generatedPath: relativePath,
      generatedSha256: sha256,
      bodyByteOffset: Buffer.byteLength(header),
      omittedOptionalFeatures: [],
    });
  }
  const binding = {
    projectId: null,
    repositoryId: 'fixture',
    identity: 'personal',
    selection: {
      location: { name: 'personal', canonicalRoot: process.cwd() },
      packs: ['personal'],
      source: 'user-location',
    },
  };
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const manifestKey = digest(JSON.stringify({ runtime: 'pi', binding, skills, files }));
  const manifestPath = path.join(root, 'active-content.json');
  const manifest = JSON.stringify({
    schemaVersion: 2,
    compilerVersion: '2.0.0',
    runtime: 'pi',
    profileSchemaVersion: 1,
    binding,
    manifestKey,
    manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
    skills,
    agents: [],
    files,
  });
  const manifestBytes = Buffer.from(manifest);
  await Promise.all([
    mkdir(path.join(root, 'agents'), { recursive: true }),
    writeFile(manifestPath, manifestBytes),
  ]);

  const fileMapHash = digest(JSON.stringify(files));
  const runtimeArtifactKey = digest(
    JSON.stringify({ schemaVersion: 5, runtime: 'pi', manifestKey, fileMapHash }),
  );
  const descriptorDigest = digest(manifest);
  const launchKey = digest(JSON.stringify({ descriptorDigest, runtimeArtifactKey }));
  const projectionKey = digest(JSON.stringify({ launchKey, manifestKey, fileMapHash }));
  return {
    MPX_RUNTIME: 'pi',
    MPX_RUNTIME_CONTEXT: JSON.stringify({
      schemaVersion: 2,
      launchKey,
      launchDescriptor: { reference: 'native-package-discovery.json', digest: descriptorDigest },
      manifestKey,
      runtimeArtifact: {
        schemaVersion: 5,
        runtime: 'pi',
        manifestKey,
        artifactKey: runtimeArtifactKey,
        fileMapHash,
      },
      binding,
    }),
    MPX_ACTIVE_CONTENT_ROOT: root,
    MPX_ACTIVE_CONTENT_MANIFEST: manifestPath,
    MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY: JSON.stringify({
      sha256: digest(manifest),
      byteCount: manifestBytes.byteLength,
    }),
    MPX_COMPILED_AGENTS_DIR: path.join(root, 'agents'),
    MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify({
      projectionKey,
      fileMapHash,
      launchBinding: {
        launchKey,
        descriptorDigest,
        runtimeArtifactKey,
        runtime: 'pi',
        manifestKey,
      },
    }),
  };
}

afterEach(async () => {
  await Promise.all([...children].map(stop));
  children.clear();
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('discovers the native Pi package and separates commands within a managed launch', async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
  const artifactRoot = path.join(workspaceRoot, 'runtimes/pi/extensions/dist/package');
  const releaseScript = path.join(workspaceRoot, 'runtimes/pi/extensions/scripts/release.mjs');
  const resolverScript = path.join(
    workspaceRoot,
    'runtimes/pi/extensions/test/pi-package-entry.mjs',
  );
  const piEntryUrl = await runNode([resolverScript], { cwd: workspaceRoot });
  const piPackageEntry = fileURLToPath(piEntryUrl);
  const piPackageRoot = path.resolve(path.dirname(piPackageEntry), '..');
  const piManifest = JSON.parse(
    await readFile(path.join(piPackageRoot, 'package.json'), 'utf8'),
  ) as {
    bin: { pi: string };
  };
  const piCli = path.resolve(piPackageRoot, piManifest.bin.pi);

  for (const action of ['build', 'verify']) {
    await runNode([releaseScript, action], { cwd: workspaceRoot, inheritOutput: true });
  }
  expect((await stat(path.join(artifactRoot, 'mpx-extension.mjs'))).isFile()).toBe(true);

  const disposable = await mkdtemp(path.join(os.tmpdir(), 'mpx-real-pi-discovery-'));
  cleanupRoots.push(disposable);
  const agentRoot = path.join(disposable, 'agent');
  const cwd = path.join(disposable, 'workspace');
  await Promise.all([mkdir(agentRoot), mkdir(cwd)]);
  const settingsPath = path.join(agentRoot, 'settings.json');
  const authPath = path.join(agentRoot, 'auth.json');
  const settings = `${JSON.stringify({ packages: [artifactRoot] }, null, 2)}\n`;
  const emptyAuth = '{}';
  await Promise.all([writeFile(settingsPath, settings), writeFile(authPath, emptyAuth)]);
  const settingsDigest = createHash('sha256').update(settings).digest('hex');
  const authDigest = createHash('sha256').update(emptyAuth).digest('hex');

  const activeRoot = path.join(disposable, 'active');
  const managedEnvironment = await managedNativeDiscoveryProjection(activeRoot);
  const child = spawn(
    process.execPath,
    [
      piCli,
      '--mode',
      'rpc',
      '--no-session',
      '--no-skills',
      '--skill',
      path.join(activeRoot, 'project-skills', 'skills', 'commit'),
    ],
    {
      cwd,
      env: {
        ...sanitizedEnvironment(
          Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !/^(?:MPX_|PI_)/u.test(name)),
          ),
          managedEnvironment,
        ),
        PI_CODING_AGENT_DIR: agentRoot,
      },
      shell: false,
    },
  );
  children.add(child);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const records: unknown[] = [];
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Pi RPC timed out. stderr: ${stderr}`)),
      20_000,
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Pi RPC exited ${String(code)}. stderr: ${stderr}`)),
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        stdout = stdout.slice(newline + 1);
        if (!line) {
          continue;
        }
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.type === 'response' && record.command === 'get_commands') {
          clearTimeout(timeout);
          resolve(record);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`);
  });

  expect(response).toMatchObject({ id: 'commands', success: true });
  const commands = (
    response.data as {
      commands: Array<{
        name: string;
        source: string;
        sourceInfo?: { path?: string };
      }>;
    }
  ).commands;
  const canonicalCommands = commands.filter(({ name }) => ['agents', 'dev-servers'].includes(name));
  expect(canonicalCommands.map(({ name }) => name).sort()).toEqual(['agents', 'dev-servers']);
  expect(canonicalCommands).toEqual(
    canonicalCommands.map((command) =>
      expect.objectContaining({
        name: command.name,
        source: 'extension',
        sourceInfo: expect.objectContaining({ path: path.join(artifactRoot, 'mpx-extension.mjs') }),
      }),
    ),
  );
  expect(
    commands
      .filter(({ name }) => name.startsWith('mpx:'))
      .map(({ name }) => name)
      .sort(),
  ).toEqual(['mpx:canonical-manual', 'mpx:commit']);
  expect(commands.filter(({ name }) => name.startsWith('skill:')).map(({ name }) => name)).toEqual([
    'skill:commit',
  ]);
  expect(commands.find(({ name }) => name === 'skill:commit')).toMatchObject({ source: 'skill' });
  expect(
    records.filter((record) => (record as { type?: string }).type === 'extension_error'),
  ).toEqual([]);
  expect(stderr).toBe('');
  await stop(child);
  children.delete(child);

  const { DefaultResourceLoader } = await import(piEntryUrl);
  const previousContentEnvironment = Object.fromEntries(
    Object.keys(managedEnvironment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, managedEnvironment);
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: agentRoot, noSkills: true });
    for (let reload = 0; reload < 2; reload += 1) {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      expect(
        loaded.extensions.map((extension: { resolvedPath: string }) =>
          path.normalize(extension.resolvedPath),
        ),
      ).toEqual([path.normalize(path.join(artifactRoot, 'mpx-extension.mjs'))]);
    }
  } finally {
    for (const [name, value] of Object.entries(previousContentEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }

  expect(await fileInventory(agentRoot)).toEqual([
    'auth.json',
    'models-store.json',
    'settings.json',
  ]);
  expect(
    createHash('sha256')
      .update(await readFile(settingsPath))
      .digest('hex'),
  ).toBe(settingsDigest);
  expect(
    createHash('sha256')
      .update(await readFile(authPath))
      .digest('hex'),
  ).toBe(authDigest);
  expect(await fileInventory(cwd)).toEqual([]);
}, 60_000);
