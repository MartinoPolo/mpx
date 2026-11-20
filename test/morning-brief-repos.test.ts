import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const reposScript = resolve('content/skills/morning-brief/scripts/repos.mjs');
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type RepositoryOptions = { remote: string; remoteName?: string; daysAgo: number; configuration?: unknown };
type Repository = { name: string; domain: string; active: boolean; remote: unknown; changedInWindow: boolean; commits?: unknown[] };

async function git(directory: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  const settings = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  await exec('git', ['-C', directory, ...settings, ...args], { env: { ...process.env, ...env }, timeout: 20_000 });
}

async function createRepository(root: string, name: string, { remote, remoteName = 'origin', daysAgo, configuration }: RepositoryOptions): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '-q']);
  await writeFile(join(directory, 'README.md'), `# ${name}\n`);
  if (configuration) await writeFile(join(directory, 'mpxconfig.json'), JSON.stringify(configuration));
  await git(directory, ['add', '-A']);
  const committedAt = new Date(Date.now() - daysAgo * DAY_MILLISECONDS).toISOString();
  await git(directory, ['commit', '-q', '--no-verify', '-m', 'Initial'], { GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt });
  await git(directory, ['remote', 'add', remoteName, remote]);
}

async function writeProjectNote(vault: string, folder: string, noteText: string): Promise<void> {
  await mkdir(join(vault, '_Projekty', folder), { recursive: true });
  await writeFile(join(vault, '_Projekty', folder, `${folder}.md`), noteText);
}

test('every repository is listed with its remote, and active means a commit in the last month or an open project task', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mpx-brief-repos-'));
  try {
    const projects = join(home, 'projects');
    const vault = join(home, 'vault');
    await createRepository(projects, 'recent', { remote: 'git@github.com:owner/recent.git', daysAgo: 0 });
    await createRepository(projects, 'dormant', { remote: 'https://gitlab.example.com/group/sub/dormant.git', daysAgo: 60 });
    await createRepository(projects, 'Tasked', {
      remote: 'https://code.example.com/team/tasked', remoteName: 'upstream', daysAgo: 60,
      configuration: { repository: { provider: 'gitlab', remote: 'upstream' } },
    });
    await createRepository(projects, 'finished', { remote: 'ssh://me@review.example.com:29418/platform/finished', daysAgo: 60 });
    await mkdir(join(projects, 'not-a-repository'));
    await writeProjectNote(vault, 'tasked', '# tasked\n\n## Tasks\n- [x] done\n- [/] started\n');
    await writeProjectNote(vault, 'finished', '# finished\n\n## Ideas\n- [ ] an idea, not a task\n\n## Tasks\n- [x] done\n');

    const since = new Date(Date.now() - DAY_MILLISECONDS).toISOString();
    const { stdout } = await exec(process.execPath, [reposScript, '--since', since], {
      env: { ...process.env, MPX_PROJECTS: projects, MPX_WORK: '', MPX_OBSIDIAN_VAULT: vault }, timeout: 60_000,
    });
    const report = JSON.parse(stdout) as { since: string; repositories: Repository[] };
    assert.equal(report.since, since);
    const byName = new Map(report.repositories.map((repository) => [repository.name, repository]));
    assert.deepEqual([...byName.keys()].sort(), ['Tasked', 'dormant', 'finished', 'recent']);

    const recent = byName.get('recent')!;
    assert.deepEqual([recent.active, recent.domain, recent.remote], [true, 'personal', { forge: 'github', host: 'github.com', fullName: 'owner/recent', web: 'https://github.com/owner/recent' }]);
    assert.equal(recent.changedInWindow, true);
    assert.equal(recent.commits?.length, 1, 'a repository changed in the window carries its Git state');

    assert.deepEqual(byName.get('dormant'), {
      name: 'dormant', domain: 'personal', active: false, changedInWindow: false,
      remote: { forge: 'gitlab', host: 'gitlab.example.com', fullName: 'group/sub/dormant', web: 'https://gitlab.example.com/group/sub/dormant' },
    });
    const tasked = byName.get('Tasked')!;
    assert.equal(tasked.active, true, 'a started task in the project note, matched in any letter case, keeps the project active');
    assert.deepEqual(tasked.remote, { forge: 'gitlab', host: 'code.example.com', fullName: 'team/tasked', web: 'https://code.example.com/team/tasked' }, 'mpxconfig.json names the remote and its provider');
    const finished = byName.get('finished')!;
    assert.equal(finished.active, false, 'only open tasks under Tasks count');
    assert.deepEqual(finished.remote, { forge: 'gerrit', host: 'review.example.com', fullName: 'platform/finished', web: null });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
