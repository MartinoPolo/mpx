import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('published upstream parser loads actual generated specialist names/models/effort/tools alongside project agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-native-agents-'));
  try {
    const account = join(root, 'account');
    const project = join(root, 'project');
    await mkdir(join(account, 'agents'), { recursive: true });
    await mkdir(join(project, '.pi', 'agents'), { recursive: true });
    await exec('git', ['init', '--quiet'], { cwd: project });
    const generatedRoot = join(packageRoot, 'dist', 'pi', 'agents');
    const files = (await readdir(generatedRoot)).filter(name => name.endsWith('.md'));
    for (const name of files) await copyFile(join(generatedRoot, name), join(account, 'agents', name));
    await writeFile(join(project, '.pi', 'agents', 'project-native.md'), '---\nname: project-native\ndescription: Independent project specialist\ntools: read\n---\nRead only.\n');
    const upstream = join(packageRoot, 'node_modules', '@tintinweb', 'pi-subagents', 'src', 'custom-agents.ts').replaceAll('\\', '/');
    const probe = join(root, 'definitions-probe.ts');
    await writeFile(probe, `import {loadCustomAgents} from ${JSON.stringify(upstream)};\nexport default function(pi) { const agents=loadCustomAgents(${JSON.stringify(project)}, true); pi.events.emit('mpx2:agent-definitions', [...agents.values()].map(a=>({name:a.name,model:a.model,thinking:a.thinking,tools:a.builtinToolNames}))); }\n`);
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', join(packageRoot, 'test', 'fixtures', 'native-agents.ts'), JSON.stringify({ cwd: project, account, probe })], {
      cwd: packageRoot, env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, timeout: 30_000,
    });
    const loaded = JSON.parse(stdout.trim()) as Array<{ name: string; model?: string; thinking?: string; tools: string[] }>;
    assert.equal(loaded.length, files.length + 1);
    assert.ok(loaded.some(agent => agent.name === 'project-native'));
    for (const name of files.map(file => file.slice(0, -3))) {
      const agent = loaded.find(item => item.name === name);
      assert.ok(agent, `missing generated agent ${name}`);
      const checker = name === 'mpx-checker';
      assert.equal(agent.model, checker ? 'openai-codex/gpt-5.6-luna' : 'openai-codex/gpt-5.6-terra');
      assert.equal(agent.thinking, checker ? 'low' : 'medium');
      assert.deepEqual(agent.tools, ['read', 'grep', 'find', 'ls', 'bash']);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
