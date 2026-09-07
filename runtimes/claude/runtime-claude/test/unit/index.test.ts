import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inventoryCanonical,
  inventoryProjectSkills,
  resolveManifest,
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
} from '@mpx/skills';
import {
  buildClaudePlugin,
  publishClaudeProjection,
  createClaudeInvocationPlan,
  renderClaudeStatusLine,
  diagnoseLegacyNamespaceConflicts,
  adaptClaudeNativeStatus,
  createClaudeDevServerCapability,
} from '../../src/index.js';
import { renderClaudePortSegment } from '@mpx/status';
import { classifyDangerousCommand, dangerousCommandPolicyModuleSource } from '@mpx/runtime-hooks';
import { createRuntimeContextV1 } from '@mpx/runtime-contracts';
import { loadRuntimeProfilesV1, parseRuntimeProfilesV1 } from '@mpx/config';
import { compileContent } from '@mpx/content-compiler';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))),
);
const statusSnapshot = {
  schemaVersion: 1 as const,
  project: { id: 'sample/app', cwd: 'C:/repo' },
  worktree: { id: 'wt-1', path: 'C:/repo', role: 'main' as const, branch: 'main' },
  portResolution: 'valid' as const,
  services: [
    {
      id: 'api',
      mode: 'managed' as const,
      scope: 'checkout' as const,
      protocol: 'http' as const,
      port: 4101,
      listening: true,
      conflict: 'none' as const,
      pid: 7,
    },
    {
      id: 'web',
      mode: 'fixed-shared' as const,
      scope: 'project' as const,
      protocol: 'https' as const,
      port: 4443,
      listening: false,
      conflict: 'external' as const,
      pid: null,
    },
  ],
  diagnostics: [],
};
const launchBanner = '[mpx claude/docker 123456789abc]';
const projectionReference = {
  projectionKey: 'b'.repeat(64),
  launchBinding: {
    launchKey: 'a'.repeat(64),
    descriptorDigest: 'd'.repeat(64),
    runtimeArtifactKey: 'e'.repeat(64),
    runtime: 'claude' as const,
    manifestKey: 'f'.repeat(64),
  },
  fileMapHash: 'c'.repeat(64),
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-runtime-'));
  roots.push(root);
  const canonical = path.join(root, 'skills'),
    agents = path.join(root, 'agents'),
    shared = path.join(root, 'shared'),
    outputStyle = path.join(root, 'output-styles', 'mpx-terse.md');
  await mkdir(canonical);
  await mkdir(shared);
  await mkdir(agents);
  await mkdir(path.dirname(outputStyle));
  await writeFile(
    outputStyle,
    '---\nname: mpx-terse\ndescription: Concise, structured, action-first output\n---\n\n# Response style\n\nAnswer first.\n',
  );
  for (const [name, exposure] of Object.entries({
    full: 'full',
    named: 'name-only',
    explicit: 'explicit-only',
    off: 'off',
  })) {
    await mkdir(path.join(canonical, name));
    await writeFile(
      path.join(canonical, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: secret ${name} description\ntriggers: trigger ${name}\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [core]\n    defaultExposure: ${exposure}\n---\nBODY ${name}${name === 'full' ? ' café' : ''}\n`,
    );
  }
  await mkdir(path.join(canonical, 'full', 'references'));
  await writeFile(path.join(canonical, 'full', 'references', 'guide.txt'), 'nested café\n');
  await writeFile(path.join(canonical, 'explicit', 'asset.bin'), Uint8Array.from([0, 255, 1, 128]));
  await writeFile(
    path.join(agents, 'mpx-explorer.md'),
    '---\nname: mpx-explorer\ndescription: Exact Explore description\n---\nAGENT BODY\n',
  );
  await writeFile(
    path.join(agents, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      agents: {
        'mpx-explorer': {
          modelClass: 'exploration',
          thinking: 'medium',
          capabilities: ['read', 'search', 'shell'],
          nesting: [],
          outputSchema: 'text',
        },
      },
    }),
  );
  const catalog = await inventoryCanonical(canonical);
  const manifest = resolveManifest(catalog, {
    repositoryId: 'repo',
    contentScope: 'personal',
    identity: 'id',
    skillPolicy: 'p',
    skillPolicyConfig: {
      skillExposure: {
        default: 'full',
        skills: { full: 'full', named: 'name-only', explicit: 'explicit-only', off: 'off' },
      },
    },
    enabledPacks: ['core'],
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'claude' });
  const skillPlan = await createSkillProjectionPlan({
    manifest,
    artifact,
    catalog,
    canonicalRoot: canonical,
  });
  const trackedProfiles = await loadRuntimeProfilesV1(
    fileURLToPath(new URL('../../../../../content/runtime-profiles.json', import.meta.url)),
  );
  const profileInput = structuredClone(trackedProfiles);
  (profileInput.agentTranslation.runtimes.claude as { aliases: unknown }).aliases = {
    'mpx-explorer': 'Explore',
  };
  const runtimeProfiles = parseRuntimeProfilesV1(JSON.stringify(profileInput));
  const compiledContent = await compileContent({
    runtime: 'claude',
    plan: skillPlan,
    runtimeProfiles,
    sharedInstructionRoot: shared,
    agentRoot: agents,
  });
  const runtimeContext = createRuntimeContextV1({
    launchKey: 'a'.repeat(64),
    launchDescriptor: { reference: 'launch.json', digest: 'b'.repeat(64) },
    manifestKey: manifest.manifestKey,
    runtimeArtifact: artifact.reference,
    binding: manifest.binding,
  });
  return {
    root,
    canonical,
    agents,
    outputStyle,
    catalog,
    manifest,
    artifact,
    skillPlan,
    compiledContent,
    runtimeProfiles,
    shared,
    statusSnapshot,
    launchBanner,
    runtimeContext,
  };
}
async function tree(root: string) {
  const out: Record<string, string> = {};
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        out[path.relative(root, p).replaceAll('\\', '/')] = await readFile(p, 'utf8');
      }
    }
  }
  await walk(root);
  return out;
}
async function byteTree(root: string) {
  const out: Record<string, { bytes: string; sha256: string }> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else {
        const bytes = await readFile(file);
        out[path.relative(root, file).replaceAll('\\', '/')] = {
          bytes: bytes.toString('hex'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
    }
  }
  await walk(root);
  return Object.fromEntries(
    Object.entries(out).sort(([left], [right]) => left.localeCompare(right)),
  );
}
async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env }),
      stdout: string[] = [],
      stderr: string[] = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout: stdout.join(''), stderr: stderr.join(''), code }),
    );
    child.stdin.end(input);
  });
}
async function runGuard(
  file: string,
  env: NodeJS.ProcessEnv,
  input: unknown,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return runNode([file], env, JSON.stringify(input));
}
async function runGuardChunks(
  file: string,
  env: NodeJS.ProcessEnv,
  chunks: readonly Uint8Array[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env }),
      stdout: string[] = [],
      stderr: string[] = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout: stdout.join(''), stderr: stderr.join(''), code }),
    );
    for (const chunk of chunks) {
      child.stdin.write(chunk);
    }
    child.stdin.end();
  });
}
async function runOpenOversizedGuard(
  root: string,
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  result: { stdout: string; stderr: string; code: number | null };
  bytesRead: number;
  elapsedMs: number;
}> {
  const preload = path.join(root, 'measure-hook-stdin.mjs'),
    report = path.join(root, 'hook-stdin-bytes.json');
  await writeFile(
    preload,
    `import fs from "node:fs";let bytes=0;process.stdin.on("data",chunk=>bytes+=chunk.length);process.on("exit",()=>fs.writeFileSync(process.env.MPX_TEST_STDIN_REPORT,String(bytes)));`,
  );
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, file], {
      env: { ...env, MPX_TEST_STDIN_REPORT: report },
    }),
    stdout: string[] = [],
    stderr: string[] = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const closed = new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({ stdout: stdout.join(''), stderr: stderr.join(''), code }),
      );
    },
  );
  for (let index = 0; index < 18; index += 1) {
    child.stdin.write(Buffer.alloc(64 * 1024, 0x20));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('runtime guard did not reject oversized open stdin promptly'));
      }, 3000);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return {
    result,
    bytesRead: Number(await readFile(report, 'utf8')),
    elapsedMs: Date.now() - started,
  };
}
async function measuredGuard(
  root: string,
  file: string,
  env: NodeJS.ProcessEnv,
  input: unknown,
): Promise<{ opens: number; stats: number; reads: number; hashes: number }> {
  const preload = path.join(root, `measure-${Math.random().toString(16).slice(2)}.mjs`),
    report = `${preload}.json`;
  await writeFile(
    preload,
    `import fs from "node:fs";import crypto from "node:crypto";import {syncBuiltinESMExports} from "node:module";const counts={opens:0,stats:0,reads:0,hashes:0},originalOpen=fs.promises.open.bind(fs.promises),originalLstat=fs.promises.lstat.bind(fs.promises),originalHash=crypto.createHash.bind(crypto),write=fs.writeFileSync.bind(fs);fs.promises.open=async(...args)=>{counts.opens++;const handle=await originalOpen(...args),read=handle.read.bind(handle),stat=handle.stat.bind(handle);handle.read=(...a)=>{counts.reads++;return read(...a)};handle.stat=(...a)=>{counts.stats++;return stat(...a)};return handle};fs.promises.lstat=(...args)=>{counts.stats++;return originalLstat(...args)};crypto.createHash=(...args)=>{counts.hashes++;return originalHash(...args)};syncBuiltinESMExports();process.on("exit",()=>write(process.env.MPX_TEST_METRICS,JSON.stringify(counts)));`,
  );
  const result = await runNode(
    ['--import', pathToFileURL(preload).href, file],
    { ...env, MPX_TEST_METRICS: report },
    JSON.stringify(input),
  );
  expect(result.code).toBe(0);
  return JSON.parse(await readFile(report, 'utf8'));
}
function guardEnvironment(
  f: Awaited<ReturnType<typeof fixture>>,
  reference: unknown,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MPX_RUNTIME_CONTEXT: JSON.stringify(f.runtimeContext),
    MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(reference),
  };
}
async function expectGuardRejected(file: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await runGuard(file, environment, { hook_event_name: 'SessionStart' });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('RESTART_REQUIRED');
}
async function expectPlanRejectedWithoutWrites(
  f: Awaited<ReturnType<typeof fixture>>,
  skillPlan: any,
  name: string,
) {
  const outputRoot = path.join(f.root, name);
  await expect(buildClaudePlugin({ ...f, skillPlan, outputRoot })).rejects.toThrow(
    /SKILL_PROJECTION_PLAN/,
  );
  await expect(lstat(outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
}
describe('Claude projection', () => {
  it('rejects an unverified or changed skill plan before filesystem side effects', async () => {
    const f = await fixture();
    await expectPlanRejectedWithoutWrites(f, structuredClone(f.skillPlan), 'unverified-plan');
    const changed = f.skillPlan as any;
    changed.entries[0].body = 'tampered';
    await expectPlanRejectedWithoutWrites(f, changed, 'changed-plan');
  });
  it('rejects an invalid publication plan before creating its artifacts directory', async () => {
    const f = await fixture(),
      artifactsRoot = path.join(f.root, 'invalid-publication');
    await expect(
      publishClaudeProjection({
        ...f,
        skillPlan: structuredClone(f.skillPlan),
        artifactsRoot,
      }),
    ).rejects.toThrow(/SKILL_PROJECTION_PLAN_UNVERIFIED/);
    await expect(lstat(artifactsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('matches the complete Claude projection golden across skill exposures and harness files', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'golden'),
      canonicalBefore = await readFile(f.outputStyle),
      nativeSettings = path.join(f.root, 'native-claude', 'settings.json');
    await mkdir(path.dirname(nativeSettings));
    await writeFile(nativeSettings, '{"statusLine":{"type":"command","command":"mine"}}\n');
    const nativeBefore = await readFile(nativeSettings);
    await buildClaudePlugin({ ...f, outputRoot: out });
    expect(await readFile(f.outputStyle)).toEqual(canonicalBefore);
    expect(await readFile(nativeSettings)).toEqual(nativeBefore);
    const projected = await byteTree(out);
    expect(Object.keys(projected)).toEqual([
      '.claude-plugin/plugin.json',
      'active-content.json',
      'agents/Explore.md',
      'hooks/dangerous-command-policy.mjs',
      'hooks/hooks.json',
      'hooks/runtime-guard.mjs',
      'output-styles/mpx-terse.md',
      'runtime-context.json',
      'settings.json',
      'skills/explicit/asset.bin',
      'skills/explicit/SKILL.md',
      'skills/full/references/guide.txt',
      'skills/full/SKILL.md',
      'skills/named/SKILL.md',
      'status/status-line.mjs',
      'status/status-snapshot.json',
    ]);
    expect(Buffer.from(projected['skills/full/SKILL.md']!.bytes, 'hex').toString('utf8')).toBe(
      "---\nname: full\ndescription: 'secret full description'\n---\nBODY full café\n",
    );
    expect(Buffer.from(projected['skills/named/SKILL.md']!.bytes, 'hex').toString('utf8')).toBe(
      "---\nname: named\ndescription: 'MPX skill named. Load only when the user explicitly mentions named by name.'\n---\nBODY named\n",
    );
    expect(Buffer.from(projected['skills/explicit/SKILL.md']!.bytes, 'hex').toString('utf8')).toBe(
      "---\nname: explicit\ndescription: 'secret explicit description'\ndisable-model-invocation: true\n---\nBODY explicit\n",
    );
    expect(projected['skills/full/references/guide.txt']!.bytes).toBe(
      Buffer.from('nested café\n').toString('hex'),
    );
    expect(projected['skills/explicit/asset.bin']!.bytes).toBe('00ff0180');
    expect(Buffer.from(projected['runtime-context.json']!.bytes, 'hex').toString('utf8')).toBe(
      `${JSON.stringify(f.runtimeContext, null, 2)}\n`,
    );
    expect(
      Buffer.from(projected['output-styles/mpx-terse.md']!.bytes, 'hex').toString('utf8'),
    ).toBe(
      '---\nname: mpx-terse\ndescription: Concise, structured, action-first output\nforce-for-plugin: true\n---\n\n# Response style\n\nAnswer first.\n',
    );
    expect(Buffer.from(projected['settings.json']!.bytes, 'hex').toString('utf8')).toBe('{}\n');
    expect(
      Object.fromEntries(
        Object.entries(projected)
          .filter(([name]) => name !== 'runtime-context.json' && name !== 'settings.json')
          .map(([name, value]) => [name, value.sha256]),
      ),
    ).toMatchSnapshot();
  });
  it('copies every compiler-owned file byte-for-byte into the plugin', async () => {
    const f = await fixture();
    const outputRoot = path.join(f.root, 'compiler-pass-through');
    await buildClaudePlugin({ ...f, outputRoot });
    for (const file of f.compiledContent.files) {
      expect(await readFile(path.join(outputRoot, ...file.relativePath.split('/')))).toEqual(
        Buffer.from(file.bytes),
      );
    }
  });

  it('rejects unsafe or malformed canonical output styles before publication', async () => {
    const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<string>]> = [
      ['missing', async (f) => path.join(f.root, 'missing.md')],
      [
        'symlinked',
        async (f) => {
          const link = path.join(f.root, 'output-styles', 'linked.md');
          await symlink(f.outputStyle, link, 'file');
          return link;
        },
      ],
      [
        'oversized',
        async (f) => {
          await writeFile(f.outputStyle, Buffer.alloc(1024 * 1024 + 1));
          return f.outputStyle;
        },
      ],
      [
        'malformed',
        async (f) => {
          await writeFile(f.outputStyle, 'not frontmatter\n');
          return f.outputStyle;
        },
      ],
      ['escaping', async (f) => `${path.join(f.root, 'output-styles')}\\..\\mpx-terse.md`],
    ];
    for (const [name, arrange] of cases) {
      const f = await fixture(),
        outputStyle = await arrange(f);
      await expect(
        buildClaudePlugin({ ...f, outputStyle, outputRoot: path.join(f.root, `bad-${name}`) }),
      ).rejects.toThrow(/OUTPUT_STYLE_/);
    }
  });
  it('projects the four exposure states with exact mpx namespace and non-leaking discovery', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'out');
    await buildClaudePlugin({ ...f, outputRoot: out });
    const files = await tree(out);
    expect(Object.keys(files).filter((x) => x.startsWith('skills/'))).toEqual([
      'skills/explicit/asset.bin',
      'skills/explicit/SKILL.md',
      'skills/full/references/guide.txt',
      'skills/full/SKILL.md',
      'skills/named/SKILL.md',
    ]);
    expect(files['.claude-plugin/plugin.json']).toContain('"name": "mpx"');
    expect(files['skills/full/SKILL.md']).toContain('secret full description');
    expect(files['skills/named/SKILL.md']).not.toContain('secret named');
    expect(files['skills/explicit/SKILL.md']).toContain('disable-model-invocation: true');
    expect(files['skills/explicit/SKILL.md']).toContain('BODY explicit');
  });
  it('projects a policy-bound project skill and every support file through the combined artifact', async () => {
    const f = await fixture(),
      projectRoot = path.join(f.root, 'project');
    const directory = path.join(projectRoot, '.agents', 'skills', 'local');
    await mkdir(path.join(directory, 'reference'), { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      '---\nname: local\ndescription: Local project behavior\nmetadata:\n  mpx:\n    projectExposure: full\n---\nLOCAL BODY\n',
    );
    await writeFile(path.join(directory, 'reference', 'guide.md'), 'GUIDE local\n');
    const project = (await inventoryProjectSkills(projectRoot, f.catalog)).skills;
    const catalog = [...f.catalog, ...project];
    const manifest = resolveManifest(catalog, {
      repositoryId: 'repo',
      projectId: 'repo',
      contentScope: 'personal',
      identity: 'id',
      skillPolicy: 'p',
      skillPolicyConfig: { skillExposure: { default: 'full' } },
      enabledPacks: ['core'],
    });
    const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'claude' });
    const skillPlan = await createSkillProjectionPlan({
      manifest,
      artifact,
      catalog,
      canonicalRoot: f.canonical,
    });
    const runtimeContext = createRuntimeContextV1({
      ...f.runtimeContext,
      manifestKey: manifest.manifestKey,
      runtimeArtifact: artifact.reference,
      binding: manifest.binding,
    });
    const compiledContent = await compileContent({
      runtime: 'claude',
      plan: skillPlan,
      runtimeProfiles: f.runtimeProfiles,
      sharedInstructionRoot: f.shared,
      agentRoot: f.agents,
    });
    const outputRoot = path.join(f.root, 'project-out');
    await buildClaudePlugin({ ...f, skillPlan, compiledContent, runtimeContext, outputRoot });
    expect(await readFile(path.join(outputRoot, 'skills', 'local', 'SKILL.md'), 'utf8')).toContain(
      'LOCAL BODY',
    );
    expect(
      await readFile(path.join(outputRoot, 'skills', 'local', 'reference', 'guide.md'), 'utf8'),
    ).toBe('GUIDE local\n');
  });
  it('creates deterministic self-contained files and changes projection for a different artifact key', async () => {
    const f = await fixture(),
      a = path.join(f.root, 'a'),
      b = path.join(f.root, 'b');
    await buildClaudePlugin({ ...f, outputRoot: a });
    await buildClaudePlugin({ ...f, outputRoot: b });
    expect(await tree(a)).toEqual(await tree(b));
    for (const rel of Object.keys(await tree(a))) {
      expect((await lstat(path.join(a, rel))).isSymbolicLink()).toBe(false);
    }
    await expect(
      buildClaudePlugin({
        ...f,
        skillPlan: structuredClone(f.skillPlan),
        outputRoot: path.join(f.root, 'c'),
      }),
    ).rejects.toThrow(/SKILL_PROJECTION_PLAN_UNVERIFIED/);
  });
  it('generates canonical agents, hooks, local status renderer, and settings', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'out');
    await buildClaudePlugin({ ...f, outputRoot: out });
    const files = await tree(out);
    expect(files['agents/Explore.md']).toContain(
      "name: Explore\ndescription: Exact Explore description\nmodel: 'sonnet'\neffort: 'medium'\ntools: 'Read, Grep, Glob, Bash'\noutput-schema: 'text'",
    );
    expect(files).not.toHaveProperty('agents/mpx-explorer.md');
    expect(files['agents/Explore.md']).not.toContain('model: inherit');
    const hooks = JSON.parse(files['hooks/hooks.json']!).hooks;
    expect(hooks.PreToolUse[0]).toHaveProperty('matcher', 'Skill|Agent|Task|Bash');
    expect(Object.keys(hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'Notification',
      'Stop',
    ]);
    expect(hooks.PostToolUse[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|Bash');
    expect(JSON.parse(files['settings.json']!)).toEqual({});
    expect(files['status/status-snapshot.json']).toBe(
      `${JSON.stringify(statusSnapshot, null, 2)}\n`,
    );
    expect(
      (
        await execFile(process.execPath, [path.join(out, 'status', 'status-line.mjs')], {
          env: {
            ...process.env,
            MPX_STATUS_SNAPSHOT_FILE: path.join(out, 'status', 'status-snapshot.json'),
          },
        })
      ).stdout,
    ).toBe(renderClaudeStatusLine(statusSnapshot, { launchBanner }));
    expect(Object.keys(files).some((x) => x.includes('provider'))).toBe(false);
  });
  it('maps generated Claude event fixtures to package, session, compact, and notification outputs', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'event-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      environment = {
        ...guardEnvironment(f, published.reference),
        MPX_PACKAGE_MANAGER: 'pnpm',
        MPX_SESSION_CONTEXT: 'Launch-bound session',
        MPX_COMPACT_INSTRUCTIONS: 'Keep the launch binding.',
      };
    const blocked = await runGuard(guard, environment, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
    });
    expect(JSON.parse(blocked.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('WRONG_PACKAGE_MANAGER'),
    });
    const session = await runGuard(guard, environment, { hook_event_name: 'SessionStart' });
    expect(JSON.parse(session.stdout).hookSpecificOutput.additionalContext).toContain(
      'Launch-bound session',
    );
    const compact = await runGuard(guard, environment, { hook_event_name: 'PreCompact' });
    expect(JSON.parse(compact.stdout).hookSpecificOutput.additionalContext).toContain(
      'Keep the launch binding.',
    );
    expect(
      (
        await runGuard(guard, environment, {
          hook_event_name: 'Notification',
          message: 'Approval needed',
        })
      ).code,
    ).toBe(0);
  });
  it('publishes against the complete launch binding and separates distinct launch contexts', async () => {
    const f = await fixture(),
      artifactsRoot = path.join(f.root, 'published');
    const first = await publishClaudeProjection({ ...f, artifactsRoot });
    const secondContext = createRuntimeContextV1({
      ...f.runtimeContext,
      launchKey: 'd'.repeat(64),
    });
    const second = await publishClaudeProjection({
      ...f,
      runtimeContext: secondContext,
      artifactsRoot,
    });
    expect(first.reference.launchBinding).toEqual({
      launchKey: f.runtimeContext.launchKey,
      descriptorDigest: f.runtimeContext.launchDescriptor.digest,
      runtimeArtifactKey: f.artifact.reference.artifactKey,
      runtime: 'claude',
      manifestKey: f.manifest.manifestKey,
    });
    expect(first.artifactKey).toBe(first.reference.projectionKey);
    expect(second.reference.projectionKey).not.toBe(first.reference.projectionKey);
    expect(second.directory).not.toBe(first.directory);
  });
  it('detects projected output-style tampering through immutable metadata', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'style-tamper-artifacts'),
      });
    await writeFile(path.join(published.directory, 'output-styles', 'mpx-terse.md'), 'tampered\n');
    await expectGuardRejected(
      path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      guardEnvironment(f, published.reference),
    );
  });
  it('bounds hot-hook stats, reads, and hashes below startup validation', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'measured-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      environment = guardEnvironment(f, published.reference);
    const hot = await measuredGuard(f.root, guard, environment, {
        hook_event_name: 'UserPromptSubmit',
      }),
      startup = await measuredGuard(f.root, guard, environment, {
        hook_event_name: 'SessionStart',
      });
    expect(hot).toEqual({ opens: 2, stats: 8, reads: 4, hashes: 2 });
    expect(startup.opens).toBeGreaterThan(hot.opens);
    expect(startup.stats).toBeGreaterThan(hot.stats);
    expect(startup.reads).toBeGreaterThan(hot.reads);
    expect(startup.hashes).toBeGreaterThan(hot.hashes);
  });
  it('fails closed promptly without consuming an unbounded oversized hook stream', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'stdin-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs');
    const measured = await runOpenOversizedGuard(
      f.root,
      guard,
      guardEnvironment(f, published.reference),
    );
    expect(measured.result.code).toBe(2);
    expect(JSON.parse(measured.result.stderr)).toEqual({
      schemaVersion: 1,
      code: 'HOOK_INPUT_INVALID',
      restartRequired: true,
      message: 'RESTART_REQUIRED: HOOK_INPUT_INVALID',
    });
    expect(measured.result.stdout).toBe('');
    expect(measured.bytesRead).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
    expect(measured.elapsedMs).toBeLessThan(3000);
  });
  it('accepts valid hook JSON at the exact UTF-8 byte boundary', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'exact-stdin-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      prefix = '{"hook_event_name":"UserPromptSubmit","padding":"',
      suffix = '"}',
      padding = ' '.repeat(1024 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
    expect(Buffer.byteLength(prefix + padding + suffix)).toBe(1024 * 1024);
    expect(
      await runNode([guard], guardEnvironment(f, published.reference), prefix + padding + suffix),
    ).toEqual({ stdout: '', stderr: '', code: 0 });
  });
  it('decodes a multibyte hook value split across stream chunks', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'multibyte-stdin-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      bytes = Buffer.from('{"hook_event_name":"UserPromptSubmit","value":"€"}'),
      marker = bytes.indexOf(Buffer.from('€'));
    const result = await runGuardChunks(guard, guardEnvironment(f, published.reference), [
      bytes.subarray(0, marker + 1),
      bytes.subarray(marker + 1),
    ]);
    expect(result).toEqual({ stdout: '', stderr: '', code: 0 });
  });
  it('treats zero-byte hook stdin as an empty input object', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'zero-stdin-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs');
    expect(await runNode([guard], guardEnvironment(f, published.reference))).toEqual({
      stdout: '',
      stderr: '',
      code: 0,
    });
  });
  it('denies malformed hook JSON with only the restart-safe structured diagnostic', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'malformed-stdin-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      result = await runNode(
        [guard],
        guardEnvironment(f, published.reference),
        '{"hook_event_name":',
      );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 1,
      code: 'HOOK_INPUT_INVALID',
      restartRequired: true,
      message: 'RESTART_REQUIRED: HOOK_INPUT_INVALID',
    });
    expect(result.stderr).not.toContain(published.directory);
    expect(result.stderr).not.toContain('stack');
  });
  it('limits hot hooks to bound relevant artifacts while session start validates the full projection', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      environment = guardEnvironment(f, published.reference);
    await writeFile(path.join(published.directory, 'settings.json'), 'tampered\n');
    expect(
      await runGuard(guard, environment, { hook_event_name: 'UserPromptSubmit' }),
    ).toMatchObject({ code: 0 });
    expect(
      await runGuard(guard, environment, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'full' },
      }),
    ).toMatchObject({ code: 0 });
    const startup = await runGuard(guard, environment, { hook_event_name: 'SessionStart' });
    expect(startup.code).toBe(2);
    expect(startup.stderr).toContain('ARTIFACT_FILE_MAP_CHANGED');
  });
  it('rejects selected skill and Bash policy tamper before use', async () => {
    const f = await fixture();
    await writeFile(path.join(f.canonical, 'full', 'guide.md'), 'trusted guide\n');
    const skillPlan = await createSkillProjectionPlan({
      manifest: f.manifest,
      artifact: f.artifact,
      catalog: f.catalog,
      canonicalRoot: f.canonical,
    });
    const compiledContent = await compileContent({
      runtime: 'claude',
      plan: skillPlan,
      runtimeProfiles: f.runtimeProfiles,
      sharedInstructionRoot: f.shared,
      agentRoot: f.agents,
    });
    const published = await publishClaudeProjection({
        ...f,
        skillPlan,
        compiledContent,
        artifactsRoot: path.join(f.root, 'selected-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      environment = guardEnvironment(f, published.reference);
    await writeFile(
      path.join(published.directory, 'skills', 'full', 'guide.md'),
      'tampered guide\n',
    );
    expect(
      (
        await runGuard(guard, environment, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Skill',
          tool_input: { skill: 'full' },
        })
      ).code,
    ).toBe(2);
    await writeFile(
      path.join(published.directory, 'hooks', 'dangerous-command-policy.mjs'),
      "export const classifyDangerousCommand=()=>({action:'allow'});\n",
    );
    expect(
      (
        await runGuard(guard, environment, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
        })
      ).code,
    ).toBe(2);
  });
  it('rejects oversized and strictly malformed artifact metadata', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'metadata-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      metadataFile = path.join(published.directory, '.mpx-runtime-artifact.json'),
      original = await readFile(metadataFile);
    await writeFile(metadataFile, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    await expectGuardRejected(guard, guardEnvironment(f, published.reference));
    const malformed = [
      (value: any) => {
        value.extra = true;
      },
      (value: any) => {
        value.reference.extra = true;
      },
      (value: any) => {
        value.fileMap[0].extra = true;
      },
      (value: any) => {
        value.fileMap.push({ ...value.fileMap[0] });
      },
      (value: any) => {
        value.fileMap[0].path = '../escape';
      },
    ];
    for (const mutate of malformed) {
      const value = JSON.parse(original.toString('utf8'));
      mutate(value);
      await writeFile(metadataFile, JSON.stringify(value));
      await expectGuardRejected(guard, guardEnvironment(f, published.reference));
    }
  });
  it('rejects unexpected wide and deep directory trees without traversing them', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'unexpected-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
      environment = guardEnvironment(f, published.reference),
      wide = path.join(published.directory, 'unexpected-wide');
    await mkdir(wide);
    await Promise.all(
      Array.from({ length: 1025 }, (_, index) => mkdir(path.join(wide, `entry-${index}`))),
    );
    await expectGuardRejected(guard, environment);
    await rm(wide, { recursive: true, force: true });
    await mkdir(
      path.join(
        published.directory,
        'unexpected-deep',
        ...Array.from({ length: 33 }, (_, index) => `level-${index}`),
      ),
      { recursive: true },
    );
    await expectGuardRejected(guard, environment);
  });
  it('rejects a per-file bounded size mismatch', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'mismatch-artifacts'),
      }),
      guard = path.join(published.directory, 'hooks', 'runtime-guard.mjs');
    await writeFile(
      path.join(published.directory, 'settings.json'),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );
    await expectGuardRejected(guard, guardEnvironment(f, published.reference));
  });
  it('uses the embedded shared dangerous-command classifier for the full corpus without fallback dependencies', async () => {
    const f = await fixture(),
      published = await publishClaudeProjection({
        ...f,
        artifactsRoot: path.join(f.root, 'policy-artifacts'),
      }),
      files = await tree(published.directory);
    expect(files['hooks/dangerous-command-policy.mjs']).toBe(
      `${dangerousCommandPolicyModuleSource}\n`,
    );
    expect(files['hooks/runtime-guard.mjs']).toContain('import("./dangerous-command-policy.mjs")');
    expect(files['hooks/runtime-guard.mjs']).not.toContain('@mpx/');
    expect(files['hooks/runtime-guard.mjs']).not.toContain('recursive forced deletion');
    const commands: unknown[] = [
      'rm -fr /',
      'rm --recursive --force node_modules /',
      'rm -rf node_modules',
      'rm -rf src/obsolete',
      'remove=rm; $remove -rf /',
      '$(printf rm) -fr ~',
      'echo $remove -rf /',
      '$remove -rf dist',
      'rmdir /s /q C:\\temp',
      'del /f /q /s C:\\temp\\*',
      'DROP DATABASE app',
      'TRUNCATE TABLE logs',
      'git push -f upstream master',
      'git push --force-with-lease origin main',
      'git clean -xfd',
      'git clean -fd',
      'mkfs.xfs /dev/sdb',
      'dd if=/dev/urandom of=/dev/sda',
      'cat image > /dev/nvme0',
      'setx PATH C:\\bad',
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\bad')",
      'reg add HKCU\\Environment /v PATH',
      'setx JAVA_HOME C:\\java',
      'git status',
      undefined,
      'x'.repeat(32_769),
    ];
    for (const command of commands) {
      const expected = classifyDangerousCommand(command as string);
      const result = await runGuard(
        path.join(published.directory, 'hooks', 'runtime-guard.mjs'),
        {
          ...process.env,
          MPX_RUNTIME_CONTEXT: JSON.stringify(f.runtimeContext),
          MPX_RUNTIME_PROJECTION_REFERENCE: JSON.stringify(published.reference),
        },
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
      );
      expect(result.code, `${String(command)}: ${result.stderr}`).toBe(0);
      if (expected.action === 'allow') {
        expect(result.stdout).toBe('');
      } else {
        expect(JSON.parse(result.stdout)).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${expected.code}: ${expected.message}`,
          },
        });
      }
    }
  });
  it('reads current validated status from the private launch-bound path on every status use', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'out'),
      snapshotFile = path.join(f.root, 'live-status.json');
    await buildClaudePlugin({ ...f, outputRoot: out });
    await writeFile(snapshotFile, JSON.stringify(statusSnapshot));
    const run = () =>
      execFile(process.execPath, [path.join(out, 'status', 'status-line.mjs')], {
        env: { ...process.env, MPX_STATUS_SNAPSHOT_FILE: snapshotFile },
      });
    expect((await run()).stdout).toContain('api:4101*');
    await writeFile(
      snapshotFile,
      JSON.stringify({ ...statusSnapshot, portResolution: 'stale', services: [] }),
    );
    expect((await run()).stdout).toBe(`${launchBanner} | ports stale`);
  });
  it('renders the bounded invalid segment for an oversized live status snapshot', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'oversized-out'),
      snapshotFile = path.join(f.root, 'oversized-status.json');
    await buildClaudePlugin({ ...f, outputRoot: out });
    await writeFile(snapshotFile, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const result = await runNode([path.join(out, 'status', 'status-line.mjs')], {
      ...process.env,
      MPX_STATUS_SNAPSHOT_FILE: snapshotFile,
    });
    expect(result).toEqual({ stdout: `${launchBanner} | ports invalid`, stderr: '', code: 0 });
  });
  it('rejects pathname replacement after opening a live status snapshot', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'replaced-out'),
      snapshotFile = path.join(f.root, 'replaced-status.json'),
      replacementFile = path.join(f.root, 'replacement-status.json'),
      preloadFile = path.join(f.root, 'replace-after-open.mjs');
    await buildClaudePlugin({ ...f, outputRoot: out });
    await writeFile(snapshotFile, JSON.stringify(statusSnapshot));
    await writeFile(
      replacementFile,
      JSON.stringify({ ...statusSnapshot, portResolution: 'stale', services: [] }),
    );
    await writeFile(
      preloadFile,
      `import fs from "node:fs";\nconst target=process.env.MPX_STATUS_SNAPSHOT_FILE,replacement=process.env.MPX_TEST_REPLACEMENT_FILE,originalOpen=fs.promises.open.bind(fs.promises),remove=fs.promises.rm.bind(fs.promises),rename=fs.promises.rename.bind(fs.promises);\nfs.promises.open=async (...args)=>{const handle=await originalOpen(...args),stat=handle.stat.bind(handle),read=handle.read.bind(handle),close=handle.close.bind(handle);let replaced=false;return {read,close,stat:async()=>{const result=await stat();if(!replaced){replaced=true;await remove(target);await rename(replacement,target)}return result}}};\n`,
    );
    const result = await runNode(
      ['--import', pathToFileURL(preloadFile).href, path.join(out, 'status', 'status-line.mjs')],
      {
        ...process.env,
        MPX_STATUS_SNAPSHOT_FILE: snapshotFile,
        MPX_TEST_REPLACEMENT_FILE: replacementFile,
      },
    );
    expect(result).toEqual({ stdout: `${launchBanner} | ports invalid`, stderr: '', code: 0 });
  });
  it('never writes a private account root into public projection references or generated plugin bytes', async () => {
    const f = await fixture(),
      out = path.join(f.root, 'out'),
      accountRoot = 'C:/native/claude/private-account';
    const projection = await buildClaudePlugin({ ...f, outputRoot: out });
    expect(
      JSON.stringify({ artifactKey: projection.artifactKey, files: projection.files }),
    ).not.toContain(accountRoot);
    expect(JSON.stringify(await tree(out))).not.toContain(accountRoot);
  });
});
it('renders the validated shared status segment with the compact launch banner', () => {
  expect(renderClaudeStatusLine(statusSnapshot, { launchBanner })).toBe(
    `${launchBanner} | ${renderClaudePortSegment(statusSnapshot)}`,
  );
});
it('preserves argv-only launch context and fails closed on legacy namespace conflict', () => {
  const plan = createClaudeInvocationPlan({
    executable: 'C:/tools/claude.exe',
    pluginDirectory: 'C:/artifact',
    accountRoot: 'C:/native/claude/account-a',
    runtimeContext: { launchKey: 'k' },
    projectionReference,
    environment: { MPX_WORK: 'C:/_MP_work', MPX_PROJECTS: 'C:/_MP_projects' },
  });
  expect(plan).toMatchObject({
    executable: 'C:/tools/claude.exe',
    args: ['--plugin-dir', 'C:/artifact'],
  });
  expect(plan.env.MPX_RUNTIME_CONTEXT).toBe('{"launchKey":"k"}');
  expect(plan.env.MPX_ACTIVE_CONTENT_ROOT).toBe('C:/artifact');
  expect(plan.env.MPX_ACTIVE_CONTENT_MANIFEST).toBe(
    path.join('C:/artifact', 'active-content.json'),
  );
  expect(() => diagnoseLegacyNamespaceConflicts(['mp', 'mp-gh'])).toThrow(
    /LEGACY_NAMESPACE_CONFLICT/,
  );
});
it('exposes only one private aggregate gateway config with strict isolation', () => {
  const plan = createClaudeInvocationPlan({
    executable: 'C:/tools/claude.exe',
    pluginDirectory: 'C:/artifact',
    accountRoot: 'C:/native/claude/account-a',
    runtimeContext: { launchKey: 'k' },
    projectionReference,
    gatewayMcpConfigPath: 'C:/private/mcp/gateway.json',
    environment: {},
  });
  expect(plan.args).toEqual([
    '--plugin-dir',
    'C:/artifact',
    '--mcp-config',
    'C:/private/mcp/gateway.json',
    '--strict-mcp-config',
  ]);
  expect(plan.env).not.toHaveProperty('MPX_RUNTIME_ROUTE_MCP_ALPHA');
  expect(() =>
    createClaudeInvocationPlan({
      executable: 'C:/tools/claude.exe',
      pluginDirectory: 'C:/artifact',
      accountRoot: 'C:/native/claude/account-a',
      runtimeContext: { launchKey: 'k' },
      projectionReference,
      mcpConfigPaths: ['C:/private/mcp/context7.json'],
      environment: {},
    }),
  ).toThrow(/direct MCP route exposure/u);
});
it('binds the privately selected Claude account root only in the child environment', () => {
  const accountRoot = 'C:/native/claude/account-a';
  const plan = createClaudeInvocationPlan({
    executable: 'C:/tools/claude.exe',
    pluginDirectory: 'C:/artifact',
    accountRoot,
    runtimeContext: { launchKey: 'k' },
    projectionReference,
    environment: { CLAUDE_CONFIG_DIR: accountRoot },
  });
  expect(plan).toEqual({
    executable: 'C:/tools/claude.exe',
    args: ['--plugin-dir', 'C:/artifact'],
    env: {
      CLAUDE_CONFIG_DIR: accountRoot,
      MPX_RUNTIME_CONTEXT: '{"launchKey":"k"}',
      MPX_RUNTIME_PROJECTION_REFERENCE: expect.any(String),
      MPX_ACTIVE_CONTENT_ROOT: 'C:/artifact',
      MPX_ACTIVE_CONTENT_MANIFEST: path.join('C:/artifact', 'active-content.json'),
    },
  });
});
it('binds the live status snapshot path privately in the Claude child environment', () => {
  const plan = createClaudeInvocationPlan({
    executable: 'C:/tools/claude.exe',
    pluginDirectory: 'C:/artifact',
    accountRoot: 'C:/native/claude/account-a',
    runtimeContext: { launchKey: 'k' },
    projectionReference,
    statusSnapshotPath: 'C:/private/status/current.json',
    environment: {},
  });
  expect(plan.env.MPX_STATUS_SNAPSHOT_FILE).toBe('C:/private/status/current.json');
  expect(plan.args.join(' ')).not.toContain('current.json');
});
it('rejects a missing privately selected Claude account root', () => {
  expect(() =>
    createClaudeInvocationPlan({
      executable: 'C:/tools/claude.exe',
      pluginDirectory: 'C:/artifact',
      accountRoot: undefined as unknown as string,
      runtimeContext: { launchKey: 'k' },
      projectionReference,
      environment: {},
    }),
  ).toThrow(/NATIVE_ROOT_REQUIRED/);
});
it('rejects a relative privately selected Claude account root', () => {
  expect(() =>
    createClaudeInvocationPlan({
      executable: 'C:/tools/claude.exe',
      pluginDirectory: 'C:/artifact',
      accountRoot: 'native/claude/account-a',
      runtimeContext: { launchKey: 'k' },
      projectionReference,
      environment: {},
    }),
  ).toThrow(/NATIVE_ROOT_NOT_ABSOLUTE/);
});
it('rejects an inherited Claude config root that mismatches the private selection', () => {
  expect(() =>
    createClaudeInvocationPlan({
      executable: 'C:/tools/claude.exe',
      pluginDirectory: 'C:/artifact',
      accountRoot: 'C:/native/claude/account-a',
      runtimeContext: { launchKey: 'k' },
      projectionReference,
      environment: { CLAUDE_CONFIG_DIR: 'C:/native/claude/account-b' },
    }),
  ).toThrow(/NATIVE_ROOT_MISMATCH/);
});
it('rejects a relative Claude executable without changing argv construction', () => {
  expect(() =>
    createClaudeInvocationPlan({
      executable: 'tools/claude.exe',
      pluginDirectory: 'C:/artifact',
      accountRoot: 'C:/native/claude/account-a',
      runtimeContext: { launchKey: 'k' },
      projectionReference,
      environment: {},
    }),
  ).toThrow(/UNTRUSTED_PATH/);
});

it('adapts native Claude status data into the launch-bound envelope and renders the full safe surface', async () => {
  const base = JSON.parse(
    await readFile(
      new URL(
        '../../../../../packages/status/test/fixtures/runtime-claude-personal.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  base.providerUsage = {
    source: 'provider',
    state: 'current',
    capturedAt: base.generatedAt,
    freshUntil: base.generatedAt,
    diagnostic: null,
    unavailable: null,
    provider: 'anthropic',
    used: 25,
    limit: 100,
    unit: 'percent',
    resetAt: null,
  };
  base.actions.items.push(
    { id: 'show-tasks', enabled: true, narrowLabel: 'Tsk', wideLabel: 'Task panel' },
    { id: 'open-review', enabled: true, narrowLabel: 'PR', wideLabel: 'Review #42' },
    { id: 'show-ci', enabled: true, narrowLabel: 'CI', wideLabel: 'CI passing' },
  );
  const capturedAt = '2025-06-01T12:10:00.000Z';
  const cachedActions = structuredClone(base.actions),
    cachedDevelopment = structuredClone(base.development),
    cachedProviderUsage = structuredClone(base.providerUsage);
  const adapted = adaptClaudeNativeStatus(
    base,
    {
      title: 'Runtime wiring',
      effort: 'high',
      model: { id: 'claude-opus', display_name: 'Opus' },
      cost: { total_cost_usd: 1.25, total_duration_ms: 90000 },
      context_window: {
        total_input_tokens: 2000,
        total_output_tokens: 500,
        context_window_size: 200000,
      },
    },
    { capturedAt },
  );
  expect(adapted.binding).toEqual(base.binding);
  expect(adapted.generatedAt).toBe(capturedAt);
  expect(adapted.session).toMatchObject({
    title: 'Runtime wiring',
    elapsedMs: 90000,
    source: 'native',
    state: 'current',
    capturedAt,
    freshUntil: '2025-06-01T12:11:00.000Z',
  });
  expect(adapted.model).toMatchObject({
    modelId: 'claude-opus',
    label: 'Opus',
    effort: 'high',
    contextUsedTokens: 2500,
    contextLimitTokens: 200000,
    source: 'native',
    capturedAt,
  });
  expect(adapted.usage).toMatchObject({
    inputTokens: 2000,
    outputTokens: 500,
    totalTokens: 2500,
    source: 'native',
    capturedAt,
  });
  expect(adapted.cost).toMatchObject({ amountMicros: 1250000, source: 'native', capturedAt });
  expect(adapted.actions).toEqual({ ...cachedActions, state: 'stale' });
  expect(adapted.development).toEqual({ ...cachedDevelopment, state: 'stale' });
  expect(adapted.providerUsage).toEqual({ ...cachedProviderUsage, state: 'stale' });
  const line = renderClaudeStatusLine(adapted, {
    launchBanner: '[mpx claude/host abcdef]',
    width: 'wide',
  });
  for (const text of [
    'Personal',
    'Runtime wiring',
    'Opus/high',
    '2.5k/200k',
    '$1.25',
    'anthropic',
    'mpx/mpx@main',
    'compact:0',
    'agents:0/1',
    'Task panel',
    'Review #42',
    'CI passing',
  ]) {
    expect(line).toContain(text);
  }
});

it('binds dev_server to the selected launch/executor and fails closed for Docker without an adapter', () => {
  expect(() =>
    createClaudeDevServerCapability({
      launchKey: 'a'.repeat(64),
      executor: 'docker',
      worktreeRoot: 'C:/repo',
      assignedPorts: [4100],
    }),
  ).toThrow(/DOCKER_ADAPTER_REQUIRED/);
  expect(() =>
    createClaudeDevServerCapability({
      launchKey: 'a'.repeat(64),
      executor: 'host',
      worktreeRoot: 'C:/repo',
      assignedPorts: [4100],
      runtimeAdapter: { kind: 'docker' } as never,
    }),
  ).toThrow(/EXECUTOR_MISMATCH/);
  const capability = createClaudeDevServerCapability({
    launchKey: 'a'.repeat(64),
    executor: 'host',
    worktreeRoot: 'C:/repo',
    assignedPorts: [4100],
  });
  expect(capability.tool).toMatchObject({ name: 'dev_server', launchKey: 'a'.repeat(64) });
});

it('projects only the launch-bound RuntimeStatusEnvelopeV1 when supplied', async () => {
  const f = await fixture(),
    out = path.join(f.root, 'runtime-status-out');
  const runtimeStatusEnvelope = JSON.parse(
    await readFile(
      new URL(
        '../../../../../packages/status/test/fixtures/runtime-claude-personal.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  runtimeStatusEnvelope.binding.launchKey = f.runtimeContext.launchKey;
  runtimeStatusEnvelope.binding.repositoryId = f.runtimeContext.binding.repositoryId;
  runtimeStatusEnvelope.development.services = [{ id: 'api', port: 4100, state: 'listening' }];
  runtimeStatusEnvelope.actions.items = [
    { id: 'open-review', enabled: true, narrowLabel: 'PR', wideLabel: 'Open review' },
  ];
  await buildClaudePlugin({ ...f, runtimeStatusEnvelope, outputRoot: out });
  const files = await tree(out);
  expect(files).toHaveProperty('status/runtime-status-envelope.json');
  expect(files).not.toHaveProperty('status/status-snapshot.json');
  const statusLine = path.join(out, 'status', 'status-line.mjs'),
    environment = { ...process.env, MPX_RUNTIME_CONTEXT: JSON.stringify(f.runtimeContext) };
  const first = await runNode(
    [statusLine],
    environment,
    JSON.stringify({
      title: 'First run',
      model: { display_name: 'Opus' },
      cost: { total_cost_usd: 1.5 },
      context_window: { total_input_tokens: 2000, total_output_tokens: 500 },
    }),
  );
  expect(first).toMatchObject({
    code: 0,
    stderr: '',
    stdout: expect.stringContaining('First run'),
  });
  for (const preserved of ['Personal', 'Opus', '2.5k', '$1.50', 'api:4100*', 'Open review']) {
    expect(first.stdout).toContain(preserved);
  }
  const restarted = await runNode(
    [statusLine],
    environment,
    JSON.stringify({
      title: 'Restarted',
      model: { display_name: 'Sonnet' },
      context_window: { total_input_tokens: 100, total_output_tokens: 20 },
    }),
  );
  expect(restarted.stdout).toContain('Restarted');
  expect(restarted.stdout).toContain('Sonnet');
  expect(restarted.stdout).not.toContain('First run');
  const source = await readFile(statusLine, 'utf8');
  expect(source).toContain('function adaptClaudeNativeStatus');
  expect(source).toContain('source:"native"');
  expect(source).not.toContain('observedAt=x.generatedAt');
});
