import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRuntimeContextV1 } from '@mpx/runtime-contracts';
import { createPiRuntimeProfileV1, planPiInvocation } from '@mpx/runtime-pi';

const h = (character: string) => character.repeat(64);
const roots: string[] = [];
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['native-skill', 'sample'])(
  'loads only classified native entrypoints through installed Pi, including collision %s',
  async (nativeName) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mpx-fake-pi-native-'));
    roots.push(root);
    const fake = path.join(root, 'fake-pi.mjs');
    const contextFile = path.join(root, 'runtime-context.json');
    const nativeDirectory = path.join(root, '.agents', 'skills', 'native-skill');
    const nativeEntrypoint = path.join(nativeDirectory, 'SKILL.md');
    const childEntrypoint = path.join(nativeDirectory, 'child', 'SKILL.md');
    await mkdir(path.dirname(childEntrypoint), { recursive: true });
    await Promise.all([
      writeFile(
        nativeEntrypoint,
        `---\nname: ${nativeName}\ndescription: Native root\n---\nNative body.\n`,
      ),
      writeFile(path.join(nativeDirectory, '.ignore'), '/SKILL.md\n'),
      writeFile(path.join(nativeDirectory, 'child', '.ignore'), '!SKILL.md\n'),
      writeFile(
        childEntrypoint,
        '---\nname: child\ndescription: Must not load\nmetadata: {mpx: null}\n---\nChild body.\n',
      ),
    ]);
    await Promise.all([
      mkdir(path.join(root, 'agents'), { recursive: true }),
      mkdir(path.join(root, 'skills', 'sample'), { recursive: true }),
      mkdir(path.join(root, 'instructions', 'pi'), { recursive: true }),
    ]);
    const context = createRuntimeContextV1({
      launchKey: h('a'),
      launchDescriptor: { reference: 'launch.json', digest: h('e') },
      manifestKey: h('f'),
      runtimeArtifact: {
        schemaVersion: 4,
        runtime: 'pi',
        manifestKey: h('f'),
        artifactKey: h('1'),
        fileMapHash: h('2'),
      },
      binding: { projectId: 'app', repositoryId: 'repo', contentScope: 'personal' },
    });
    const agentBytes = Buffer.from('compiled agent\n'),
      skillBytes = Buffer.from('---\nname: sample\ndescription: Managed sample\n---\n# Sample\n'),
      contextBytes = Buffer.from('{}\n'),
      managedPromptBytes = Buffer.from('Managed fixture instructions.\n'),
      sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
      manifest = {
        schemaVersion: 1,
        compilerVersion: '1.0.0',
        runtime: 'pi',
        profileSchemaVersion: 1,
        binding: context.binding,
        manifestKey: context.manifestKey,
        manifestEnvelope: { path: 'active-content.json', includedInFileMap: false },
        skills: [
          {
            identity: 'sample',
            exposure: 'full',
            canonicalDescription: 'Sample.',
            effectiveDescription: 'Sample.',
            sourcePath: '.agents/skills/sample/SKILL.md',
            generatedPath: 'skills/sample/SKILL.md',
            generatedSha256: sha256(skillBytes),
            bodyByteOffset: 0,
            omittedOptionalFeatures: [],
          },
        ],
        agents: [
          {
            canonicalIdentity: 'mpx-explorer',
            projectedIdentity: 'Explore',
            semanticModel: 'standard',
            concreteModel: 'sonnet',
            thinking: 'medium',
            capabilities: ['read'],
            tools: ['read'],
            nesting: { canonical: [], projected: [], requiredTools: [] },
            outputSchema: 'text',
            sourcePath: 'agents/mpx-explorer.md',
            sourceSha256: h('a'),
            sourceByteCount: 1,
            generatedPath: 'agents/Explore.md',
            generatedSha256: sha256(agentBytes),
            generatedByteCount: agentBytes.byteLength,
          },
        ],
        files: [
          {
            relativePath: 'agents/Explore.md',
            sha256: sha256(agentBytes),
            byteCount: agentBytes.byteLength,
          },
          {
            relativePath: 'skills/sample/SKILL.md',
            sha256: sha256(skillBytes),
            byteCount: skillBytes.byteLength,
          },
        ],
      },
      manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await Promise.all([
      writeFile(path.join(root, 'active-content.json'), manifestBytes),
      writeFile(path.join(root, 'agents', 'Explore.md'), agentBytes),
      writeFile(path.join(root, 'skills', 'sample', 'SKILL.md'), skillBytes),
      writeFile(contextFile, contextBytes),
      writeFile(path.join(root, 'instructions', 'pi', 'MANAGED_PROMPT.md'), managedPromptBytes),
      writeFile(
        fake,
        `process.stdout.write(JSON.stringify({argv:process.argv.slice(2),accountRoot:process.env.PI_CODING_AGENT_DIR,bridge:process.env.MPX_PI_LAUNCH_PRIVATE_BRIDGE,status:process.env.MPX_STATUS_SNAPSHOT_FILE,runtimeStatus:process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE}));`,
      ),
    ]);
    const fileMap = [
      {
        path: 'active-content.json',
        sha256: sha256(manifestBytes),
        bytes: manifestBytes.byteLength,
      },
      { path: 'agents/Explore.md', sha256: sha256(agentBytes), bytes: agentBytes.byteLength },
      {
        path: 'instructions/pi/MANAGED_PROMPT.md',
        sha256: sha256(managedPromptBytes),
        bytes: managedPromptBytes.byteLength,
      },
      {
        path: 'runtime-context.json',
        sha256: sha256(contextBytes),
        bytes: contextBytes.byteLength,
      },
      { path: 'skills/sample/SKILL.md', sha256: sha256(skillBytes), bytes: skillBytes.byteLength },
    ];
    const launchBinding = {
      launchKey: context.launchKey,
      descriptorDigest: context.launchDescriptor.digest,
      runtimeArtifactKey: context.runtimeArtifact.artifactKey,
      runtime: 'pi' as const,
      manifestKey: context.manifestKey,
    };
    const fileMapHash = digest(fileMap);
    const projectionReference = {
      projectionKey: digest({ schemaVersion: 1, launchBinding, fileMapHash }),
      launchBinding,
      fileMapHash,
    };
    await writeFile(
      path.join(root, '.mpx-runtime-artifact.json'),
      JSON.stringify({ schemaVersion: 1, reference: projectionReference, fileMap }),
    );
    const plan = await planPiInvocation({
      executable: process.execPath,
      profile: createPiRuntimeProfileV1(
        {
          schemaVersion: 1,
          runtime: 'pi',
          provider: 'openai-codex',
          defaultModel: 'openai-codex/gpt-5.6-sol',
          enabledModels: ['openai-codex/gpt-5.6-sol'],
        },
        [],
      ),
      accountRoot: root,
      runtimeContextFile: contextFile,
      runtimeContext: context,
      cwd: root,
      immutableProjectionDirectory: root,
      projectionReference,
    });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(plan.executable, [fake, ...plan.args], {
        cwd: plan.cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !/^(?:MPX_|PI_)/u.test(name)),
          ),
          ...plan.env,
        },
        shell: false,
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout }));
    });
    const observation = JSON.parse(result.stdout);
    expect(result.code).toBe(0);
    expect(observation).toEqual({
      argv: plan.args,
      accountRoot: root.replaceAll('\\', '/'),
    });
    expect(observation.argv).toContain('--no-context-files');
    expect(observation.argv).toContain('--append-system-prompt');
    expect(observation.argv).toContain(
      path.join(root, 'instructions', 'pi', 'MANAGED_PROMPT.md').replaceAll('\\', '/'),
    );
    expect(observation.argv).not.toContain('--no-extensions');
    expect(observation.argv).not.toContain('--extension');
    const skillPaths = plan.args.flatMap((argument, index) =>
      argument === '--skill' ? [plan.args[index + 1]!] : [],
    );
    expect(skillPaths).toEqual([
      path.join(root, 'skills', 'sample').replaceAll('\\', '/'),
      nativeEntrypoint.replaceAll('\\', '/'),
    ]);

    const resolverScript = path.resolve(
      import.meta.dirname,
      '../../../runtimes/pi/extensions/test/pi-package-entry.mjs',
    );
    const { stdout: piEntryUrl } = await promisify(execFile)(process.execPath, [resolverScript]);
    const { loadSkills } = await import(piEntryUrl.trim());
    const directoryDiscovery = loadSkills({
      cwd: root,
      agentDir: root,
      includeDefaults: false,
      skillPaths: [nativeDirectory],
    });
    expect(directoryDiscovery.skills.map((skill: { name: string }) => skill.name)).toEqual([
      'child',
    ]);

    const loaded = loadSkills({ cwd: root, agentDir: root, includeDefaults: false, skillPaths });
    expect(loaded.skills.map((skill: { name: string }) => skill.name)).toEqual(
      nativeName === 'sample' ? ['sample'] : ['sample', 'native-skill'],
    );
    expect(
      loaded.skills.map((skill: { filePath: string }) => path.normalize(skill.filePath)),
    ).toEqual([
      path.join(root, 'skills', 'sample', 'SKILL.md'),
      ...(nativeName === 'sample' ? [] : [nativeEntrypoint]),
    ]);
    expect(loaded.skills.some((skill: { name: string }) => skill.name === 'child')).toBe(false);
    expect(
      loaded.diagnostics.some((diagnostic: { type: string }) => diagnostic.type === 'collision'),
    ).toBe(nativeName === 'sample');
  },
);
