import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { planAgentLinks, syncAgentLinks } from '../src/install.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('published upstream parser loads actual generated specialist names/models/effort/tools alongside project agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-native-agents-'));
  try {
    const account = join(root, 'account');
    const project = join(root, 'project');
    const accounts = { personal: { pi: account, claude: join(root, 'personal-cc') }, work: { pi: join(root, 'work-pi'), claude: join(root, 'work-cc') } };
    for (const roots of Object.values(accounts)) for (const directory of Object.values(roots)) await mkdir(directory);
    const installed = await syncAgentLinks(await planAgentLinks(packageRoot, { accounts, domains: { personal: [], work: [] } }));
    assert.equal(installed.ok, true, JSON.stringify(installed.results));
    await mkdir(join(project, '.pi', 'agents'), { recursive: true });
    await exec('git', ['init', '--quiet'], { cwd: project });
    const generatedRoot = join(packageRoot, 'dist', 'pi', 'agents');
    const files = (await readdir(generatedRoot)).filter(name => name.endsWith('.md'));
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
      const projected = await readFile(join(generatedRoot, `${name}.md`), 'utf8');
      const metadata = parse(projected.split('---')[1]!) as { model: string; thinking: string; tools: string };
      assert.equal(agent.model, metadata.model, name);
      assert.equal(agent.thinking, metadata.thinking, name);
      assert.deepEqual(agent.tools, metadata.tools.split(',').map(tool => tool.trim()).filter(tool => !tool.startsWith('ext:')), name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
