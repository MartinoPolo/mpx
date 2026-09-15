import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { piRuntimeBootstrap } from '../../src/runtime-install.js';

const root = process.argv[2]!;
const home = process.env.USERPROFILE!;
const account = process.env.PI_CODING_AGENT_DIR!;
const project = path.join(root, 'project');
const display = path.join(root, 'display');
const shared = path.join(home, '.agents/skills/mpx');
const exported = path.join(home, 'native-skill-exports/mpx');
const makeSkill = async (directory: string, name: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill.\n---\nFixture body.\n`);
};
await mkdir(path.join(account, 'extensions'), { recursive: true });
await mkdir(display, { recursive: true });
await mkdir(path.dirname(shared), { recursive: true });
await makeSkill(path.join(exported, 'old-global'), 'old-global');
await symlink(exported, shared, process.platform === 'win32' ? 'junction' : 'dir');
await makeSkill(path.join(home, '.agents/skills/unrelated'), 'unrelated');
await makeSkill(path.join(project, '.agents/skills/project-local'), 'project-local');
await writeFile(path.join(account, 'extensions/independent.ts'), 'export default function () {}\n');
await writeFile(path.join(display, 'index.ts'), 'export default function () {}\n');
await writeFile(path.join(display, 'package.json'), JSON.stringify({ name: 'fixture-display', version: '1.0.0', pi: { extensions: ['./index.ts'] } }));
const settings = {
  packages: [{ source: display, extensions: [] }],
  skills: [`!${shared.replaceAll('\\', '/')}/**`],
};
const common = { cwd: project, agentDir: account, noContextFiles: true, noThemes: true, noPromptTemplates: true };
const normal = new DefaultResourceLoader({ ...common, settingsManager: SettingsManager.inMemory(settings) });
await normal.reload({ resolveProjectTrust: async () => true });
assert.deepEqual(normal.getExtensions().errors, []);
assert.equal(normal.getExtensions().extensions.some(extension => extension.path.endsWith('independent.ts')), true);
assert.equal(normal.getExtensions().extensions.some(extension => extension.path.endsWith('display/index.ts') || extension.path.endsWith('display\\index.ts')), false);
assert.deepEqual(normal.getSkills().skills.map(skill => skill.name).sort(), ['project-local', 'unrelated']);
const legacy = new DefaultResourceLoader({ ...common, settingsManager: SettingsManager.inMemory(settings), noExtensions: true, additionalExtensionPaths: [display], additionalSkillPaths: [shared] });
await legacy.reload({ resolveProjectTrust: async () => true });
assert.deepEqual(legacy.getExtensions().errors, []);
assert.equal(legacy.getExtensions().extensions.length, 1);
assert.equal(path.basename(legacy.getExtensions().extensions[0]!.path), 'index.ts');
assert.deepEqual(legacy.getSkills().skills.map(skill => skill.name).sort(), ['old-global', 'project-local', 'unrelated']);
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
await writeFile(path.join(account, 'extensions/mpx2.ts'), piRuntimeBootstrap(runtimeRoot));
process.env.MPX_ACCOUNT = 'personal';
process.env.MPX_ACTIVE_CONTENT_ROOT = runtimeRoot;
const composed = new DefaultResourceLoader({ ...common, settingsManager: SettingsManager.inMemory(settings) });
await composed.reload({ resolveProjectTrust: async () => true });
assert.deepEqual(composed.getExtensions().errors, []);
const registeredTools = composed.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
for (const name of ['Agent', 'get_subagent_result', 'steer_subagent']) assert.equal(registeredTools.filter(tool => tool === name).length, 1);
console.log(JSON.stringify({ autoDisplayDisabled: true, independentExtensionsRetained: true, sharedProjectSkillsRetained: true, explicitLegacyDisplayAndSkillsRestored: true, installedRuntimeRegistrationLoads: true }));
