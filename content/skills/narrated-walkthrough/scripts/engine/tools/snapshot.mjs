import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const run = (command, argumentsList, options = {}) => {
	const result = spawnSync(command, argumentsList, { encoding: 'utf8', timeout: 120000, ...options });
	if (result.status !== 0) throw new Error(`${command} ${argumentsList.join(' ')}: ${(result.stderr || result.stdout || String(result.error)).slice(-1500)}`);
	return result.stdout.trim();
};

/* Snapshots and their installs are large and shared by every run, so they sit beside the engine install, not in a run folder. */
const sharedRoot = fileURLToPath(new URL('../../', import.meta.url));

/*
 * Dependencies are installed from the snapshot's own lockfile, never borrowed from the repository, whose
 * node_modules may be stale or mid-install. Revisions with the same lockfile share one install. Other
 * package managers are added here; without a known lockfile the snapshot has no dependencies.
 */
const installers = [
	{ lockfile: 'yarn.lock', marker: '.yarn-integrity', command: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive', '--network-timeout', '60000'] },
	{ lockfile: 'package-lock.json', marker: '.package-lock.json', command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
];
const dependenciesOf = (directory) => {
	const installer = installers.find(({ lockfile }) => existsSync(path.join(directory, lockfile)));
	if (!installer) return null;
	const lockfile = readFileSync(path.join(directory, installer.lockfile));
	const target = path.join(sharedRoot, 'dependencies', createHash('sha256').update(lockfile).digest('hex').slice(0, 12));
	if (!existsSync(path.join(target, 'node_modules', installer.marker))) {
		mkdirSync(target, { recursive: true });
		for (const name of ['package.json', installer.lockfile]) copyFileSync(path.join(directory, name), path.join(target, name));
		const [program, ...argumentsList] = installer.command;
		run(program, argumentsList, { cwd: target, timeout: 900000, shell: true });
	}
	return path.join(target, 'node_modules');
};

/* A revision is extracted once per commit with git archive, so the repository's working tree is never touched. */
export const snapshotOf = (repository, revision) => {
	const commit = run('git', ['-C', repository, 'rev-parse', revision]);
	const directory = path.join(sharedRoot, 'snapshots', commit.slice(0, 12));
	if (!existsSync(path.join(directory, '.snapshot-complete'))) {
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		const archive = path.join(directory, 'snapshot.tar');
		run('git', ['-C', repository, 'archive', '--format=tar', `--output=${archive}`, commit]);
		/* GNU tar reads "C:" in a path as a remote host, so the archive is extracted by its relative name. */
		run('tar', ['-xf', 'snapshot.tar'], { cwd: directory });
		rmSync(archive);
		writeFileSync(path.join(directory, '.snapshot-complete'), commit);
	}
	const nodeModules = path.join(directory, 'node_modules');
	if (!existsSync(nodeModules)) {
		const dependencies = dependenciesOf(directory);
		/* A link left dangling by a deleted install is replaced; removing a link never touches its target. */
		if (lstatSync(nodeModules, { throwIfNoEntry: false })) rmSync(nodeModules);
		if (dependencies) symlinkSync(dependencies, nodeModules, 'junction');
	}
	return directory.replaceAll('\\', '/');
};

/*
 * Builds the bundle of one revision inside its snapshot, once. Error reporting is switched off so a demo
 * of the bug never reaches the project's Sentry; demo.environment adds variables for other projects.
 */
export const buildRevision = ({ repository, revision, commands, output, environment = {} }) => {
	const root = snapshotOf(repository, revision);
	if (existsSync(path.join(root, output))) return root;
	for (const command of commands) {
		const [program, ...argumentsList] = command.split(' ');
		run(program, argumentsList, { cwd: root, timeout: 300000, env: { ...process.env, VITE_SENTRY_DSN: '', SENTRY_AUTH_TOKEN: '', ...environment } });
	}
	return root;
};
