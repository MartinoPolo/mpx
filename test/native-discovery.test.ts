import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from '../src/compiler.js';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
async function put(file: string, text: string) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
function nativeSkill(name: string, marker: string) { return `---\nname: ${name}\ndescription: Native ${name}\n---\n${marker}\n`; }
interface NativeResult { skills: Array<{ name: string; hidden: boolean; filePath: string }>; prompt: string; diagnostics: unknown[]; contexts: string[]; extensions: string[]; bodies: Array<{ name: string; body: string }> }

test('separate native Pi loaders preserve additive trusted discovery, exposure and concurrent selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx2-native-discovery-'));
  try {
    const home = join(root, 'home');
    const content = join(root, 'package');
    const personal = join(home, '.pi', 'personal');
    const work = join(home, '.pi', 'work');
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    await put(join(content, 'content', 'runtime-profiles.json'), await readFile(join(packageRoot, 'content', 'runtime-profiles.json'), 'utf8'));
    for (const [name, pack, exposure] of [['normal', 'development', 'normal'], ['named', 'development', 'name-only'], ['private', 'personal', 'explicit-only']] as const) {
      const crossSkillReference = name === 'normal' ? '[Named reference](../named/SKILL.md)\n' : '';
      await put(join(content, 'content', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Meaningful ${name} description\nmetadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [${pack}]\n    defaultExposure: ${exposure}\n---\nUNIQUE_BODY_${name}\n[Support](support.txt)\n${crossSkillReference}`);
      await put(join(content, 'content', 'skills', name, 'support.txt'), `SUPPORT_${name}\n`);
    }
    await build(content);
    for (const account of [personal, work]) {
      await put(join(account, 'skills', 'independent', 'SKILL.md'), nativeSkill('independent', 'NATIVE_ACCOUNT_SKILL'));
      await put(join(account, 'AGENTS.md'), 'NATIVE_ACCOUNT_INSTRUCTIONS\n');
    }
    await put(join(personal, 'skills', 'personal-owned', 'SKILL.md'), nativeSkill('personal-owned', 'PERSONAL_ACCOUNT_ONLY'));
    await put(join(work, 'skills', 'work-owned', 'SKILL.md'), nativeSkill('work-owned', 'WORK_ACCOUNT_ONLY'));
    const packageDir = join(root, 'unrelated-package');
    await put(join(packageDir, 'package.json'), JSON.stringify({ name: 'unrelated-fixture', pi: { skills: ['./skills'] } }));
    await put(join(packageDir, 'skills', 'packaged', 'SKILL.md'), nativeSkill('packaged', 'INDEPENDENT_PACKAGE'));
    for (const account of [personal, work]) await put(join(account, 'settings.json'), JSON.stringify({ packages: [packageDir] }));
    await put(join(home, '.agents', 'skills', 'shared-global', 'SKILL.md'), nativeSkill('shared-global', 'SHARED_GLOBAL'));
    for (const repo of [repoA, repoB]) {
      await mkdir(repo, { recursive: true });
      await exec('git', ['init', '--quiet'], { cwd: repo });
      await put(join(repo, '.agents', 'skills', 'project-native', 'SKILL.md'), nativeSkill('project-native', 'PROJECT_NATIVE'));
      await put(join(repo, '.pi', 'skills', 'pi-project', 'SKILL.md'), nativeSkill('pi-project', 'PI_PROJECT'));
      await put(join(repo, 'AGENTS.md'), 'NATIVE_PROJECT_INSTRUCTIONS\n');
    }
    const paths = (pack: string) => join(content, 'dist', 'packs', pack, 'pi', 'skills');
    const load = async (cwd: string, account: string, skillPaths: string[], trusted = true): Promise<NativeResult> => {
      const { stdout } = await exec(process.execPath, ['--import', 'tsx', join(packageRoot, 'test', 'fixtures', 'native-loader.ts'), JSON.stringify({ cwd, account, skillPaths, trusted })], {
        cwd: packageRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: account, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
        timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout.trim()) as NativeResult;
    };
    const [a, b] = await Promise.all([load(repoA, personal, [paths('development'), paths('personal')]), load(repoB, work, [paths('development')])]);
    for (const result of [a, b]) {
      const names = result.skills.map(skill => skill.name);
      for (const name of ['mp-normal', 'mp-named', 'independent', 'packaged', 'shared-global', 'project-native', 'pi-project']) assert.ok(names.includes(name), `missing ${name}: ${names}`);
      assert.equal(new Set(names).size, names.length);
      assert.ok(!names.includes('named'), `bundled reference discovered as a native skill: ${names}`);
      assert.equal(result.extensions.length, 0);
      assert.ok(result.contexts.some(file => file.endsWith('AGENTS.md')));
      assert.equal(result.diagnostics.length, 0);
      assert.ok(result.prompt.includes('Meaningful normal description'));
      assert.ok(result.prompt.includes('mp-named'));
      assert.ok(!result.prompt.includes('UNIQUE_BODY_'));
      assert.ok(!result.prompt.includes('mp-private'));
    }
    assert.ok(a.skills.some(skill => skill.name === 'mp-private' && skill.hidden));
    assert.ok(!b.skills.some(skill => skill.name === 'mp-private'));
    assert.ok(a.skills.some(skill => skill.name === 'personal-owned'));
    assert.ok(!a.skills.some(skill => skill.name === 'work-owned'));
    assert.ok(b.skills.some(skill => skill.name === 'work-owned'));
    assert.ok(!b.skills.some(skill => skill.name === 'personal-owned'));
    const privateFile = a.skills.find(skill => skill.name === 'mp-private')!.filePath;
    assert.equal(await readFile(join(dirname(privateFile), 'support.txt'), 'utf8'), 'SUPPORT_private\n');
    const empty = await load(repoA, personal, []);
    assert.ok(!empty.skills.some(skill => skill.name.startsWith('mp-')));
    assert.ok(empty.skills.some(skill => skill.name === 'project-native'));
    const untrusted = await load(repoA, personal, [paths('development')], false);
    assert.ok(!untrusted.skills.some(skill => ['project-native', 'pi-project'].includes(skill.name)));
    assert.ok(untrusted.skills.some(skill => skill.name === 'mp-normal'));
    // Restart with identical selection is stable; nothing links shared account packs.
    assert.deepEqual((await load(repoA, personal, [paths('development'), paths('personal')])).skills, a.skills);
  } finally { await rm(root, { recursive: true, force: true }); }
});
