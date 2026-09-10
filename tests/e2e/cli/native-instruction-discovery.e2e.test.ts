import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const GLOBAL_AGENTS = 'native-global-agents-sentinel\n';
const APPEND_SYSTEM = 'native-append-system-sentinel\n';
const PROJECT_AGENTS = 'native-project-agents-sentinel\n';
const CLAUDE_WRAPPER = '@AGENTS.md\n';
const NESTED_AGENTS = 'native-nested-agents-sentinel\n';
const PRIVATE_AGENTS = 'native-private-agents-that-must-be-replaced\n';
const PRIVATE_BOOTSTRAP = '@PRIVATE_AGENTS.md\nnative-private-bootstrap-sentinel\n';
const PRIVATE_TARGET = 'native-private-target-must-not-expand\n';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('discovers native instructions through the installed Pi resource loader without MPX environment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-pi-native-instructions-'));
  roots.push(root);

  const agentDir = path.join(root, 'account');
  const projectDir = path.join(root, 'workspace', 'project');
  const nestedDir = path.join(projectDir, 'nested');
  const privateDir = path.join(projectDir, 'private');
  const isolatedHome = path.join(root, 'home');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(nestedDir, { recursive: true }),
    mkdir(privateDir, { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(agentDir, 'AGENTS.md'), GLOBAL_AGENTS),
    writeFile(path.join(agentDir, 'APPEND_SYSTEM.md'), APPEND_SYSTEM),
    writeFile(path.join(projectDir, 'AGENTS.md'), PROJECT_AGENTS),
    writeFile(path.join(projectDir, 'CLAUDE.md'), CLAUDE_WRAPPER),
    writeFile(path.join(nestedDir, 'AGENTS.md'), NESTED_AGENTS),
    writeFile(path.join(privateDir, 'AGENTS.md'), PRIVATE_AGENTS),
    writeFile(path.join(privateDir, 'AGENTS.override.md'), PRIVATE_BOOTSTRAP),
    writeFile(path.join(privateDir, 'PRIVATE_AGENTS.md'), PRIVATE_TARGET),
    writeFile(path.join(agentDir, 'settings.json'), '{}\n'),
  ]);

  const resolverScript = path.resolve(
    import.meta.dirname,
    '../../../runtimes/pi/extensions/test/pi-package-entry.mjs',
  );
  const { stdout: piEntryUrl } = await execFileAsync(process.execPath, [resolverScript]);
  const loaderScript = `
    const { DefaultResourceLoader } = await import(process.argv[1]);
    const agentDir = process.argv[2];
    const directories = process.argv.slice(3);
    const observations = [];
    for (const cwd of directories) {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      observations.push({
        cwd,
        agentsFiles: loader.getAgentsFiles().agentsFiles,
        appendSystemPrompt: loader.getAppendSystemPrompt(),
        extensionCount: loader.getExtensions().extensions.length,
      });
    }
    process.stdout.write(JSON.stringify({
      observations,
      mpxEnvironmentNames: Object.keys(process.env).filter((name) => name.startsWith('MPX_')),
    }));
  `;
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('MPX_')),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      loaderScript,
      piEntryUrl.trim(),
      agentDir,
      projectDir,
      nestedDir,
      privateDir,
    ],
    {
      cwd: isolatedHome,
      env: {
        ...cleanEnvironment,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
    },
  );

  const result = JSON.parse(stdout) as {
    observations: Array<{
      cwd: string;
      agentsFiles: Array<{ path: string; content: string }>;
      appendSystemPrompt: string[];
      extensionCount: number;
    }>;
    mpxEnvironmentNames: string[];
  };
  expect(result.mpxEnvironmentNames).toEqual([]);

  const [project, nested, privateProject] = result.observations;
  expect(project?.agentsFiles).toEqual([
    { path: path.join(agentDir, 'AGENTS.md'), content: GLOBAL_AGENTS },
    { path: path.join(projectDir, 'AGENTS.md'), content: PROJECT_AGENTS },
  ]);
  expect(project?.agentsFiles.some(({ path: filePath }) => filePath.endsWith('CLAUDE.md'))).toBe(
    false,
  );
  expect(nested?.agentsFiles).toEqual([
    { path: path.join(agentDir, 'AGENTS.md'), content: GLOBAL_AGENTS },
    { path: path.join(projectDir, 'AGENTS.md'), content: PROJECT_AGENTS },
    { path: path.join(nestedDir, 'AGENTS.md'), content: NESTED_AGENTS },
  ]);
  expect(privateProject?.agentsFiles).toEqual([
    { path: path.join(agentDir, 'AGENTS.md'), content: GLOBAL_AGENTS },
    { path: path.join(projectDir, 'AGENTS.md'), content: PROJECT_AGENTS },
    { path: path.join(privateDir, 'AGENTS.override.md'), content: PRIVATE_BOOTSTRAP },
  ]);

  for (const observation of result.observations) {
    expect(observation.agentsFiles.filter(({ content }) => content === GLOBAL_AGENTS)).toHaveLength(
      1,
    );
    expect(observation.appendSystemPrompt).toEqual([APPEND_SYSTEM]);
    expect(observation.extensionCount).toBe(0);
    expect(observation.agentsFiles.map(({ content }) => content)).not.toContain(PRIVATE_TARGET);
  }
});
