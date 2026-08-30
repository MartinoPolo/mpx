import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntimeContextV1, revalidateRuntimeArtifact } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  inventoryProjectSkills,
  loadSkillBody,
  resolveManifest,
} from '@mpx/skills';
import {
  buildPiProjection,
  createPiRuntimeProjection,
  planPiInvocation,
  renderPiRuntimeStatus,
} from '../src/index.js';
import { fixture } from './fixture.js';

const originalRuntimeContext = process.env.MPX_RUNTIME_CONTEXT;
const originalProjectionReference = process.env.MPX_RUNTIME_PROJECTION_REFERENCE;
const originalStatusSnapshotFile = process.env.MPX_STATUS_SNAPSHOT_FILE;
const originalRuntimeStatusEnvelopeFile = process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE;

function required<T>(value: T | undefined, label: string): T {
  expect(value, label).toBeDefined();
  if (value === undefined) {
    throw new Error(`${label} was not registered`);
  }
  return value;
}

afterEach(() => {
  if (originalRuntimeContext === undefined) {
    delete process.env.MPX_RUNTIME_CONTEXT;
  } else {
    process.env.MPX_RUNTIME_CONTEXT = originalRuntimeContext;
  }
  if (originalProjectionReference === undefined) {
    delete process.env.MPX_RUNTIME_PROJECTION_REFERENCE;
  } else {
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = originalProjectionReference;
  }
  if (originalStatusSnapshotFile === undefined) {
    delete process.env.MPX_STATUS_SNAPSHOT_FILE;
  } else {
    process.env.MPX_STATUS_SNAPSHOT_FILE = originalStatusSnapshotFile;
  }
  if (originalRuntimeStatusEnvelopeFile === undefined) {
    delete process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE;
  } else {
    process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE = originalRuntimeStatusEnvelopeFile;
  }
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('production Pi projection', () => {
  it('preserves the shared lazy loader canonical hash and normalized provenance wrapper', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-provenance-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let loadTool:
      | {
          execute(
            id: string,
            params: { identity: string },
          ): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }>;
        }
      | undefined;
    const pi = {
      registerCommand() {},
      registerTool(tool: {
        name: string;
        execute(
          id: string,
          params: { identity: string },
        ): Promise<{ content: Array<{ text: string }>; details: { provenance: unknown } }>;
      }) {
        if (tool.name === 'mpx_model_load') {
          loadTool = tool;
        }
      },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate(pi);
    const projected = await required(loadTool, 'model load tool').execute('load', {
      identity: 'full',
    });
    const canonical = await loadSkillBody({
      canonicalRoot: f.canonicalRoot,
      manifest: f.manifest,
      artifact: f.artifact,
      runtime: 'pi',
      identity: 'full',
      invocation: 'model',
    });
    const claudeArtifact = createRuntimeSkillArtifact(f.manifest, f.catalog, { runtime: 'claude' });
    const claude = await loadSkillBody({
      canonicalRoot: f.canonicalRoot,
      manifest: f.manifest,
      artifact: claudeArtifact,
      runtime: 'claude',
      identity: 'full',
      invocation: 'model',
    });
    expect(required(projected.content[0], 'projected content').text).toBe(canonical.wrappedBody);
    expect(projected.details.provenance).toEqual(canonical.provenance);
    expect({
      body: canonical.body,
      contentHash: canonical.provenance.contentHash,
      sourcePath: canonical.provenance.sourcePath,
    }).toEqual({
      body: claude.body,
      contentHash: claude.provenance.contentHash,
      sourcePath: claude.provenance.sourcePath,
    });
  });

  it('loads an exact project body through the generated extension without native Pi skills', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-skill-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nEXACT PROJECT BODY\n',
    );
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const context = createRuntimeContextV1({
      ...f.context,
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding: manifest.binding,
    });
    const projection = await buildPiProjection({
      ...f,
      catalog,
      manifest,
      artifact,
      context,
      currentBinding: manifest.binding,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-project-projection-')),
    });
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.exe',
      accountRoot: 'C:/native/pi',
      cwd: 'C:/repo',
      runtimeContext: context,
      projection,
    });
    expect(plan.args).not.toContain('--skill');
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const module = await import(pathToFileURL(projection.extension).href);
    let loadTool:
      | {
          execute(
            id: string,
            params: { identity: string },
          ): Promise<{ content: Array<{ text: string }> }>;
        }
      | undefined;
    await module.activate({
      registerCommand() {},
      registerTool(tool: {
        name: string;
        execute(
          id: string,
          params: { identity: string },
        ): Promise<{ content: Array<{ text: string }> }>;
      }) {
        if (tool.name === 'mpx_model_load') {
          loadTool = tool;
        }
      },
    });
    const loaded = await required(loadTool, 'model load tool').execute('load', {
      identity: 'local',
    });
    expect(required(loaded.content[0], 'loaded project content').text).toContain(
      'EXACT PROJECT BODY',
    );
  });

  it('rejects a project skill pathname swap between validation and publication', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-path-swap-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    const source = path.join(directory, 'SKILL.md');
    const trusted =
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nSAFE PROJECT BODY\n';
    const replacement = trusted.replace('SAFE', 'EVIL');
    await mkdir(directory, { recursive: true });
    await writeFile(source, trusted);
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const context = createRuntimeContextV1({
      ...f.context,
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding: manifest.binding,
    });
    const replacementFile = path.join(projectRoot, 'replacement.md');
    await writeFile(replacementFile, replacement);
    const originalReadFile = fs.promises.readFile;
    let swapped = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.readFile>) => {
        const bytes = await originalReadFile(...args);
        if (!swapped && path.resolve(String(args[0])) === path.resolve(source)) {
          swapped = true;
          await rename(source, `${source}.validated`);
          await rename(replacementFile, source);
        }
        return bytes as never;
      },
    );
    syncBuiltinESMExports();

    await expect(
      buildPiProjection({
        ...f,
        catalog,
        manifest,
        artifact,
        context,
        currentBinding: manifest.binding,
        artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-project-path-swap-output-')),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
  });

  it('rejects a same-size project skill replacement between validation and publication', async () => {
    const f = await fixture();
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'pi-project-content-swap-'));
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    const source = path.join(directory, 'SKILL.md');
    const trusted =
      '---\nname: local\ndescription: Local project skill\nmetadata:\n  mpx:\n    projectExposure: full\n---\nSAFE PROJECT BODY\n';
    const replacement = trusted.replace('SAFE', 'EVIL');
    await mkdir(directory, { recursive: true });
    await writeFile(source, trusted);
    const projectCatalog = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...projectCatalog];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'p',
      contentScope: 'scope',
      enabledPacks: ['core'],
      identity: 'id',
      skillPolicy: 'policy',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
    const context = createRuntimeContextV1({
      ...f.context,
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding: manifest.binding,
    });
    const originalReadFile = fs.promises.readFile;
    let replaced = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.readFile>) => {
        const bytes = await originalReadFile(...args);
        if (!replaced && path.resolve(String(args[0])) === path.resolve(source)) {
          replaced = true;
          await writeFile(source, replacement);
        }
        return bytes as never;
      },
    );
    syncBuiltinESMExports();

    await expect(
      buildPiProjection({
        ...f,
        catalog,
        manifest,
        artifact,
        context,
        currentBinding: manifest.binding,
        artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-project-content-swap-output-')),
      }),
    ).rejects.toThrow();
    expect(replaced).toBe(true);
  });

  it('publishes an immutable deterministic self-contained policy projection', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const input = { ...f, artifactsRoot };

    const first = await buildPiProjection(input);
    const second = await createPiRuntimeProjection(input);

    expect(second).toEqual({ ...first, reused: true });
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      await revalidateRuntimeArtifact(first.revalidation.directory, first.revalidation.reference),
    ).toMatchObject({ valid: true });
    expect(first.files).toEqual(
      expect.arrayContaining([
        'extension.mjs',
        'runtime-context.json',
        'projection.json',
        'settings.json',
        'keybindings.json',
        'status/runtime-status-envelope-v1.json',
        'themes/green.json',
        'themes/amber.json',
        'vendor/subagents/VENDORED.md',
        'vendor/subagents/LICENSE',
      ]),
    );
    const projectedAgents = first.files.filter(
      (file) => file.startsWith('agents/') && file.endsWith('.md'),
    );
    expect(projectedAgents).toHaveLength(22);
    expect(projectedAgents.filter((file) => file === 'agents/Explore.md')).toHaveLength(1);
    expect(projectedAgents).not.toContain('agents/mpx-explorer.md');
    expect(first.files).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)SKILL\.md$|(?:^|\/)pnpm-lock\.yaml$/u),
      ]),
    );

    const descriptor = JSON.parse(
      await readFile(path.join(first.directory, 'projection.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      runtime: 'pi',
      commandAllowlist: ['mpx:explicit', 'mpx:full', 'mpx:named'],
      modelSearchAllowlist: ['full', 'named'],
    });
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(f.canonicalRoot);
    expect(serialized).not.toMatch(/credential|session|nativeSkillAliases/iu);
    const extensionSource = await readFile(first.extension, 'utf8');
    expect(extensionSource).not.toContain(f.canonicalRoot);
    expect(extensionSource).not.toMatch(/regularFile|boundMetadata|\breadFile\b|\breaddir\b/u);
    expect(await readFile(path.join(first.directory, 'skills', 'full', 'body.md'))).toEqual(
      await readFile(path.join(f.canonicalRoot, 'full', 'SKILL.md')),
    );
    expect((await readdir(path.join(first.directory, 'skills'))).sort()).toEqual([
      'explicit',
      'full',
      'named',
    ]);
    expect(
      await readFile(path.join(first.directory, 'status', 'status-snapshot.json'), 'utf8'),
    ).toBe(`${JSON.stringify(f.statusSnapshot, null, 2)}\n`);
  });

  it('accepts a canonical published file map with hyphenated agent names', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-hyphenated-map-')),
    });
    const metadata = JSON.parse(
      await readFile(path.join(projection.directory, '.mpx-runtime-artifact.json'), 'utf8'),
    ) as { fileMap: Array<{ path: string }> };
    const paths = metadata.fileMap.map((entry) => entry.path);
    expect(paths.indexOf('agents/mpx-check-fixer.md')).toBeLessThan(
      paths.indexOf('agents/mpx-checker.md'),
    );

    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const module = await import(pathToFileURL(projection.extension).href);
    await expect(module.activate({ registerCommand() {} })).resolves.toBeUndefined();
  });

  it('copies canonical support assets and binds their bytes into full projection revalidation', async () => {
    const f = await fixture();
    await mkdir(path.join(f.canonicalRoot, 'full', 'references'));
    await writeFile(
      path.join(f.canonicalRoot, 'full', 'references', 'guide.txt'),
      'trusted support\n',
    );
    await writeFile(path.join(f.canonicalRoot, 'full', 'script.js'), 'export default 1;\n');
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-support-')),
    });
    expect(
      await readFile(
        path.join(projection.directory, 'skills', 'full', 'references', 'guide.txt'),
        'utf8',
      ),
    ).toBe('trusted support\n');
    expect(projection.files).toContain('skills/full/script.js');
    await writeFile(path.join(projection.directory, 'skills', 'full', 'script.js'), 'tampered\n');
    await expect(
      revalidateRuntimeArtifact(projection.directory, projection.reference),
    ).resolves.toMatchObject({ valid: false });
  });

  it('rejects symlinked generated-assets roots before reading agents or themes', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const assetsTarget = await mkdtemp(path.join(tmpdir(), 'pi-assets-target-'));
    await mkdir(path.join(assetsTarget, 'agents'));
    await mkdir(path.join(assetsTarget, 'themes'));
    const linkedAssetsRoot = path.join(
      await mkdtemp(path.join(tmpdir(), 'pi-assets-link-')),
      'projection-link',
    );
    await symlink(
      assetsTarget,
      linkedAssetsRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      buildPiProjection({ ...f, artifactsRoot, assetsRoot: linkedAssetsRoot }),
    ).rejects.toThrow(/assets|symlink/i);
  });

  it('plans Pi from projection revalidation data and a private native account root', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const plan = planPiInvocation({
      executable: 'C:/trusted/pi.cmd',
      projection,
      accountRoot: 'C:/private/pi/account-a',
      runtimeContext: f.context,
      cwd: 'C:/repo',
    });
    expect(plan.args).toEqual([
      '--no-extensions',
      '--extension',
      projection.extension.replaceAll('\\', '/'),
      '--no-skills',
      '--theme',
      'dark',
    ]);
    expect(plan.env).toEqual({
      PI_CODING_AGENT_DIR: 'C:/private/pi/account-a',
      MPX_RUNTIME: 'pi',
      MPX_RUNTIME_CONTEXT: JSON.stringify(f.context),
      MPX_RUNTIME_CONTEXT_FILE: projection.runtimeContextFile.replaceAll('\\', '/'),
      MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(projection.reference),
    });
    expect(projection.revalidation).toEqual({
      directory: projection.directory,
      reference: projection.reference,
    });
  });

  it('renders the runtime status envelope rather than the legacy port-only footer', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-projections-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    let piStatus = '';
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    });
    const sessionStart = required(
      required(events.get('session_start'), 'session start handlers')[0],
      'session start handler',
    );
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (_key: string, text: string) => {
            piStatus = text;
          },
        },
      },
    );
    expect(piStatus).toContain('Personal · Sol · app@main · 1k/272k');
    expect(piStatus).not.toMatch(/\bports\b/u);
  });

  it('bounds agent-start stats, reads, and hashes below full session validation', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-instrumentation-')),
    });
    const openSpy = vi.spyOn(fs.promises, 'open');
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const hashSpy = vi.spyOn(crypto, 'createHash');
    syncBuiltinESMExports();
    const module = await import(
      `${pathToFileURL(projection.extension).href}?instrumented=${Date.now()}`
    );
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    openSpy.mockClear();
    lstatSpy.mockClear();
    hashSpy.mockClear();
    await required(
      events.get('before_agent_start'),
      'before agent start handler',
    )({
      systemPrompt: 'BASE',
    });
    const hot = {
      opens: openSpy.mock.calls.length,
      stats: lstatSpy.mock.calls.length,
      hashes: hashSpy.mock.calls.length,
    };
    openSpy.mockClear();
    lstatSpy.mockClear();
    hashSpy.mockClear();
    await required(events.get('session_start'), 'session start handler')(
      {},
      { ui: { setStatus() {} } },
    );
    const full = {
      opens: openSpy.mock.calls.length,
      stats: lstatSpy.mock.calls.length,
      hashes: hashSpy.mock.calls.length,
    };
    expect(hot).toEqual({ opens: 2, stats: 4, hashes: 2 });
    expect(full.opens).toBeGreaterThan(hot.opens);
    expect(full.stats).toBeGreaterThan(hot.stats);
    expect(full.hashes).toBeGreaterThan(hot.hashes);
    openSpy.mockRestore();
    lstatSpy.mockRestore();
    hashSpy.mockRestore();
    syncBuiltinESMExports();
  });

  it('keeps discovery and agent-start cheap while selected skill load catches support tamper', async () => {
    const f = await fixture();
    await writeFile(path.join(f.canonicalRoot, 'full', 'guide.txt'), 'trusted\n');
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-costs-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const tools = new Map<string, { execute(id: string, params: unknown): Promise<unknown> }>();
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    await writeFile(path.join(projection.directory, 'skills', 'full', 'guide.txt'), 'altered\n');
    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('search', {
        query: 'full',
      }),
    ).resolves.toBeDefined();
    await expect(
      required(
        events.get('before_agent_start'),
        'before agent start handler',
      )({
        systemPrompt: 'BASE',
      }),
    ).resolves.toBeDefined();
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('load', {
        identity: 'full',
      }),
    ).rejects.toThrow('RESTART_REQUIRED');
    await expect(
      required(events.get('session_start'), 'session start handler')(
        {},
        { ui: { setStatus() {} } },
      ),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects same-size pathname replacement of a selected skill body', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-swap-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'body.md');
    const original = await readFile(body);
    await rename(body, `${body}.old`);
    await writeFile(body, Buffer.alloc(original.length, 88));
    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects pathname replacement of a selected skill body after opening its handle', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-open-swap-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'body.md');
    const original = await readFile(body);
    const replacement = `${body}.replacement`;
    await writeFile(replacement, original);
    const probe = await open(body, 'r');
    const bodyStat = await probe.stat();
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let replaced = false;
    vi.spyOn(fileHandlePrototype, 'read').mockImplementation(async function (
      this: { stat(): Promise<{ dev: number | bigint; ino: number | bigint }> },
      ...args: unknown[]
    ) {
      const openedStat = await this.stat();
      if (!replaced && openedStat.dev === bodyStat.dev && openedStat.ino === bodyStat.ino) {
        replaced = true;
        await rename(body, `${body}.old`);
        await rename(replacement, body);
      }
      return originalRead.apply(this, args);
    });

    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED: SKILL_BODY_INVALID');
    expect(replaced).toBe(true);
  });

  it('rejects same-size in-place mutation of a selected skill body', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-mutation-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    let load: { execute(id: string, params: unknown): Promise<unknown> } | undefined;
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) {
        if (tool.name === 'mpx_model_load') {
          load = tool;
        }
      },
    });
    const body = path.join(projection.directory, 'skills', 'full', 'body.md');
    const original = await readFile(body);
    await writeFile(body, Buffer.alloc(original.length, 89));
    await expect(
      required(load, 'model load tool').execute('load', { identity: 'full' }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('rejects bounded-metadata violations before projection traversal', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-bounds-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const metadataFile = path.join(projection.directory, '.mpx-runtime-artifact.json');
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as {
      schemaVersion: number;
      reference: unknown;
      fileMap: unknown[];
    };
    metadata.fileMap = Array.from({ length: 10_001 }, (_, index) => ({
      path: `overflow/${index}`,
      sha256: '0'.repeat(64),
      bytes: 0,
    }));
    await writeFile(metadataFile, JSON.stringify(metadata));
    await expect(module.activate({ registerCommand() {} })).rejects.toThrow(
      'RESTART_REQUIRED: ARTIFACT_BINDING_CHANGED',
    );
  });

  it('rejects unsafe, duplicate, over-depth, and over-aggregate file maps', async () => {
    const cases: Array<{ name: string; fileMap: unknown[] }> = [
      { name: 'unsafe', fileMap: [{ path: '../escape', sha256: '0'.repeat(64), bytes: 0 }] },
      {
        name: 'duplicate',
        fileMap: [
          { path: 'same', sha256: '0'.repeat(64), bytes: 0 },
          { path: 'same', sha256: '0'.repeat(64), bytes: 0 },
        ],
      },
      {
        name: 'depth',
        fileMap: [{ path: `${'directory/'.repeat(64)}file`, sha256: '0'.repeat(64), bytes: 0 }],
      },
      {
        name: 'aggregate',
        fileMap: Array.from({ length: 17 }, (_, index) => ({
          path: `large/${index}`,
          sha256: '0'.repeat(64),
          bytes: 16 * 1024 * 1024,
        })),
      },
    ];
    for (const candidate of cases) {
      const f = await fixture();
      const projection = await buildPiProjection({
        ...f,
        artifactsRoot: await mkdtemp(path.join(tmpdir(), `pi-${candidate.name}-`)),
      });
      const module = await import(pathToFileURL(projection.extension).href);
      process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
      process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
      const metadataFile = path.join(projection.directory, '.mpx-runtime-artifact.json');
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { fileMap: unknown[] };
      metadata.fileMap = candidate.fileMap;
      await writeFile(metadataFile, JSON.stringify(metadata));
      await expect(module.activate({ registerCommand() {} }), candidate.name).rejects.toThrow(
        'RESTART_REQUIRED: ARTIFACT_BINDING_CHANGED',
      );
    }
  });

  it('rejects unexpected projection entries immediately, including deep directory trees', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-tree-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await mkdir(
      path.join(
        projection.directory,
        'unexpected',
        ...Array.from({ length: 70 }, (_, index) => `d${index}`),
      ),
      { recursive: true },
    );
    await expect(module.activate({ registerCommand() {} })).rejects.toThrow(
      'RESTART_REQUIRED: ARTIFACT_FILE_MAP_CHANGED',
    );
  });

  it('binds the privacy-safe runtime envelope into immutable projection metadata', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-runtime-status-')),
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(projection.directory, 'status', 'runtime-status-envelope-v1.json'),
          'utf8',
        ),
      ),
    ).toEqual(f.runtimeStatusEnvelope);
    const source = await readFile(projection.extension, 'utf8');
    expect(source).not.toMatch(/auth\.json|jwt|bearer|credential/iu);
  });

  it('rejects embedded Bash policy tamper before classifying a command', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-policy-tamper-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    await writeFile(
      path.join(projection.directory, 'dangerous-command-policy.mjs'),
      "export const classifyDangerousCommand=()=>({action:'allow'});\n",
    );
    await expect(
      required(
        events.get('tool_call'),
        'tool call handler',
      )({
        toolName: 'bash',
        input: { command: 'rm -rf /' },
      }),
    ).rejects.toThrow('RESTART_REQUIRED');
  });

  it('registers the shared dangerous-command policy for native bash calls only', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-policy-')),
    });
    const module = await import(pathToFileURL(projection.extension).href);
    const events = new Map<string, (...args: unknown[]) => unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
    });
    const policy = required(events.get('tool_call'), 'tool call handler');
    await expect(policy({ toolName: 'bash', input: { command: 'rm -rf /' } })).resolves.toEqual({
      block: true,
      reason:
        'DANGEROUS_RECURSIVE_DELETE: Blocked: broad recursive deletion is not allowed.\nRun manually only after review: rm -rf /',
    });
    await expect(
      policy({ toolName: 'bash', input: { command: 'rm -rf dist' } }),
    ).resolves.toBeUndefined();
    await expect(
      policy({ toolName: 'bash', input: { command: 'remove=rm; $remove -rf /' } }),
    ).resolves.toEqual({
      block: true,
      reason:
        'DANGEROUS_RECURSIVE_DELETE: Blocked: broad recursive deletion is not allowed.\nRun manually only after review: remove=rm; $remove -rf /',
    });
    await expect(
      policy({ toolName: 'bash', input: { command: 'echo $remove -rf /' } }),
    ).resolves.toBeUndefined();
    await expect(
      policy({ toolName: 'read', input: { command: 'rm -rf /' } }),
    ).resolves.toBeUndefined();
  });

  it('does not fabricate production gateway or development-service results when no launch adapters are supplied', async () => {
    const f = await fixture();
    const projection = await buildPiProjection({
      ...f,
      artifactsRoot: await mkdtemp(path.join(tmpdir(), 'pi-production-no-adapters-')),
    });
    const module = await import(
      `${pathToFileURL(projection.extension).href}?production=${Date.now()}`
    );
    const tools = new Map<string, unknown>();
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    await module.activate({
      registerCommand() {},
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
    });
    expect([...tools.keys()]).toEqual([
      'mpx_model_search',
      'mpx_model_load',
      'Agent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    const source = await readFile(projection.extension, 'utf8');
    expect(source).not.toMatch(/example\.invalid|Projection result|Fetched \$/u);
  });

  it('activates the generated extension with current tool, disclosure, command, status, and restart semantics', async () => {
    const f = await fixture();
    const artifactsRoot = await mkdtemp(path.join(tmpdir(), 'pi-projections-'));
    const projection = await buildPiProjection({ ...f, artifactsRoot });
    const module = await import(pathToFileURL(projection.extension).href);
    const commands = new Map<
      string,
      { description?: string; handler(args: string): Promise<void> }
    >();
    const tools = new Map<
      string,
      {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute(toolCallId: string, params: unknown): Promise<unknown>;
      }
    >();
    const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const sent: string[] = [];
    const statusCalls: Array<[string, string]> = [];
    const pi = {
      registerCommand(
        name: string,
        specification: { description?: string; handler(args: string): Promise<void> },
      ) {
        commands.set(name, specification);
      },
      registerTool(definition: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute(toolCallId: string, params: unknown): Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
      sendUserMessage: async (content: readonly { type: 'text'; text: string }[]) => {
        sent.push(required(content[0], 'sent user message').text);
      },
    };
    process.env.MPX_RUNTIME_CONTEXT = JSON.stringify(f.context);
    process.env.MPX_RUNTIME_PROJECTION_REFERENCE = JSON.stringify(projection.reference);
    const liveStatus = path.join(artifactsRoot, 'live-status.json');
    await writeFile(liveStatus, JSON.stringify(f.statusSnapshot));
    process.env.MPX_STATUS_SNAPSHOT_FILE = liveStatus;

    await expect(module.activate(pi)).resolves.toBeUndefined();
    expect([...commands.keys()]).toEqual(['mpx:explicit', 'mpx:full', 'mpx:named']);
    expect([...tools.keys()]).toEqual([
      'mpx_model_search',
      'mpx_model_load',
      'Agent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    expect(events.has('before_agent_start')).toBe(true);
    expect(events.has('session_start')).toBe(true);
    expect(events.has('session_shutdown')).toBe(true);

    const beforeAgentStart = required(
      required(events.get('before_agent_start'), 'before agent start handlers')[0],
      'before agent start handler',
    );
    expect(await beforeAgentStart({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt:
        'BASE\n\nMPX skills:\n- /mpx:full: Full skill (triggers: full trigger)\n- /mpx:named',
    });

    const sessionStart = required(
      required(events.get('session_start'), 'session start handlers')[0],
      'session start handler',
    );
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (key: string, text: string) => {
            statusCalls.push([key, text]);
          },
        },
      },
    );
    await sessionStart(
      {},
      {
        ui: {
          setStatus: (key: string, text: string) => {
            statusCalls.push([key, text]);
          },
        },
      },
    );
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    const expectedRuntimeStatus = renderPiRuntimeStatus(f.runtimeStatusEnvelope, 'wide');
    expect(statusCalls).toEqual([
      ['mpx', expectedRuntimeStatus],
      ['mpx', expectedRuntimeStatus],
    ]);
    await writeFile(
      liveStatus,
      JSON.stringify({ ...f.statusSnapshot, portResolution: 'missing', services: [] }),
    );
    await beforeAgentStart({ systemPrompt: 'BASE' });
    expect(statusCalls.at(-1)).toEqual(['mpx', expectedRuntimeStatus]);
    await required(
      required(events.get('session_shutdown'), 'session shutdown handlers')[0],
      'session shutdown handler',
    )();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    clearIntervalSpy.mockRestore();

    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('tool-1', {
        query: '',
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              identity: 'full',
              publicName: '/mpx:full',
              description: 'Full skill',
              triggers: 'full trigger',
              score: 1,
            },
            { identity: 'named', publicName: '/mpx:named', description: 'Named skill', score: 1 },
          ]),
        },
      ],
      details: {
        results: [
          {
            identity: 'full',
            publicName: '/mpx:full',
            description: 'Full skill',
            triggers: 'full trigger',
            score: 1,
          },
          { identity: 'named', publicName: '/mpx:named', description: 'Named skill', score: 1 },
        ],
      },
    });
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-2', {
        identity: 'full',
      }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('identity=full') }],
      details: { identity: 'full', provenance: { invocation: 'model' } },
    });
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-3', {
        identity: 'explicit',
      }),
    ).rejects.toThrow(/SKILL_INVOCATION_DENIED|RESTART_REQUIRED/u);

    await required(commands.get('mpx:explicit'), 'explicit command').handler(
      'ignore /mpx:full prose',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('identity=explicit');
    expect(sent[0]).toContain('origin=human-explicit');

    await writeFile(path.join(projection.directory, 'skills', 'full', 'body.md'), 'changed\n');
    await expect(
      required(tools.get('mpx_model_load'), 'model load tool').execute('tool-4', {
        identity: 'full',
      }),
    ).rejects.toThrow(/RESTART_REQUIRED/u);

    await writeFile(
      path.join(projection.directory, '.mpx-runtime-artifact.json'),
      `${JSON.stringify({ schemaVersion: 1, reference: projection.reference, fileMap: [] }, null, 2)}\n`,
    );
    await expect(beforeAgentStart({ systemPrompt: 'BASE' })).rejects.toThrow(/RESTART_REQUIRED/u);

    process.env.MPX_RUNTIME_CONTEXT = '{bad';
    await expect(beforeAgentStart({ systemPrompt: 'BASE' })).rejects.toThrow(/RESTART_REQUIRED/u);

    delete process.env.MPX_RUNTIME_CONTEXT;
    delete process.env.MPX_STATUS_SNAPSHOT_FILE;
    await expect(
      required(tools.get('mpx_model_search'), 'model search tool').execute('tool-5', {
        query: 'full',
      }),
    ).rejects.toThrow(/RESTART_REQUIRED/u);
  });
});
