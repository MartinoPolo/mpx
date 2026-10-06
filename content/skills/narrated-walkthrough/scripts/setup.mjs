import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Installs the engine once into MPX_TEMP, shared by every run with the same lock file, and prints its path.
 * Run folders hold only their own content and call the engine's tools from there. Safe to rerun.
 */
const run = (command, argumentsList, options) => {
	const result = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 900000, stdio: 'inherit', ...options });
	if (result.status !== 0) throw new Error(`${command} ${argumentsList.join(' ')} failed: ${result.error ?? `exit ${result.status}`}`);
};

const source = fileURLToPath(new URL('./engine/', import.meta.url));
const temporaryRoot = process.env.MPX_TEMP;
if (!temporaryRoot || !path.isAbsolute(temporaryRoot)) throw new Error('MPX_TEMP must be set to an absolute path');
const lockHash = createHash('sha256').update(readFileSync(path.join(source, 'package-lock.json'))).digest('hex').slice(0, 12);
const engine = path.join(temporaryRoot, 'narrated-walkthrough', `engine-${lockHash}`);

/* Engine files are replaced on every setup, so the install always matches this skill version. */
for (const name of ['tools', 'player', 'demo']) rmSync(path.join(engine, name), { recursive: true, force: true });
mkdirSync(engine, { recursive: true });
cpSync(source, engine, { recursive: true });
if (!existsSync(path.join(engine, 'node_modules', '.package-lock.json'))) {
	run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: engine, shell: process.platform === 'win32' });
	run(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], { cwd: engine });
}
run(process.execPath, ['player/build.mjs'], { cwd: engine });

for (const [tool, flag] of [['ffmpeg', '-version'], ['ffprobe', '-version'], ['git', '--version']]) {
	if (spawnSync(tool, [flag], { encoding: 'utf8', timeout: 30000 }).status !== 0) console.error(`missing on PATH: ${tool}`);
}
console.log(`engine: ${engine.replaceAll('\\', '/')}`);
