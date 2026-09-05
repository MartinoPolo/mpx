import { spawn } from 'node:child_process';
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

it('invokes fake Pi with native discovery and no retired bridge, status, or extension overrides', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-fake-pi-native-'));
  roots.push(root);
  const fake = path.join(root, 'fake-pi.mjs');
  const contextFile = path.join(root, 'runtime-context.json');
  await Promise.all([
    mkdir(path.join(root, 'agents'), { recursive: true }),
    mkdir(path.join(root, 'skills', 'sample'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'active-content.json'), '{}\n'),
    writeFile(path.join(root, 'agents', 'Explore.md'), 'compiled agent\n'),
    writeFile(path.join(root, 'skills', 'sample', 'SKILL.md'), '# Sample\n'),
    writeFile(contextFile, '{}\n'),
    writeFile(
      fake,
      `process.stdout.write(JSON.stringify({argv:process.argv.slice(2),accountRoot:process.env.PI_CODING_AGENT_DIR,bridge:process.env.MPX_PI_LAUNCH_PRIVATE_BRIDGE,status:process.env.MPX_STATUS_SNAPSHOT_FILE,runtimeStatus:process.env.MPX_RUNTIME_STATUS_ENVELOPE_FILE}));`,
    ),
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
  const fileMap = [
    { path: 'active-content.json', sha256: h('3'), bytes: 3 },
    { path: 'agents/Explore.md', sha256: h('4'), bytes: 15 },
    { path: 'runtime-context.json', sha256: h('5'), bytes: 3 },
    { path: 'skills/sample/SKILL.md', sha256: h('6'), bytes: 9 },
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
  const plan = planPiInvocation({
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
      env: { ...process.env, ...plan.env },
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
  expect(observation.argv).not.toContain('--no-extensions');
  expect(observation.argv).not.toContain('--extension');
  expect(observation.argv).toContain('--skill');
});
