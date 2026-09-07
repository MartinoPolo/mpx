import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = path.join(repositoryRoot, 'content/skills/init-github-repo/scripts/init-repo.mjs');
const template = path.join(
  repositoryRoot,
  'content/skills/init-github-repo/templates/gitignore.template',
);
const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'MPX Test',
  GIT_AUTHOR_EMAIL: 'mpx-test@example.invalid',
  GIT_COMMITTER_NAME: 'MPX Test',
  GIT_COMMITTER_EMAIL: 'mpx-test@example.invalid',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runScript(cwd: string, scriptPath = script) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: gitIdentity,
    encoding: 'utf8',
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitIdentity, encoding: 'utf8' }).trim();
}

describe('init-github-repo support script', () => {
  it('seeds repository hygiene files and creates a conventional initial commit', async () => {
    const root = await temporaryDirectory('mpx-init-repo-');

    const result = runScript(root);

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(
      await readFile(template, 'utf8'),
    );
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe('chore: initialize repository');
    expect(git(root, ['ls-tree', '--name-only', 'HEAD']).split(/\r?\n/).sort()).toEqual(
      ['.editorconfig', '.gitattributes', '.gitignore', 'AGENTS.md', 'CLAUDE.md'].sort(),
    );
  });

  it('preserves existing hygiene and instruction files and does not commit unrelated content', async () => {
    const root = await temporaryDirectory('mpx-init-preserve-');
    const preserved = ['.gitignore', '.gitattributes', '.editorconfig', 'AGENTS.md', 'CLAUDE.md'];
    for (const name of preserved) {
      await writeFile(path.join(root, name), `existing ${name}\n`);
    }
    await writeFile(path.join(root, 'source.txt'), 'unrelated source\n');
    await writeFile(path.join(root, '.env'), 'SECRET=value\n');

    const result = runScript(root);

    expect(result.status, result.stderr).toBe(0);
    for (const name of preserved) {
      expect(await readFile(path.join(root, name), 'utf8')).toBe(`existing ${name}\n`);
    }
    expect(git(root, ['ls-tree', '--name-only', 'HEAD']).split(/\r?\n/).sort()).toEqual(
      preserved.sort(),
    );
    expect(git(root, ['status', '--short'])).toContain('?? source.txt');
  });

  it('refuses an existing repository and a directory inside an enclosing repository', async () => {
    const existing = await temporaryDirectory('mpx-init-existing-');
    git(existing, ['init']);
    const existingResult = runScript(existing);
    expect(existingResult.status).not.toBe(0);
    expect(existingResult.stderr).toContain('already inside a Git repository');
    await expect(readFile(path.join(existing, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const parent = await temporaryDirectory('mpx-init-parent-');
    git(parent, ['init']);
    const child = path.join(parent, 'child');
    await mkdir(child);
    const childResult = runScript(child);
    expect(childResult.status).not.toBe(0);
    expect(childResult.stderr).toContain('already inside a Git repository');
    await expect(readFile(path.join(child, '.gitignore'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a dangling seed symlink before writing outside the project', async () => {
    const root = await temporaryDirectory('mpx-init-symlink-');
    const external = await temporaryDirectory('mpx-init-symlink-target-');
    await symlink(
      path.join(external, 'missing'),
      path.join(root, 'AGENTS.md'),
      process.platform === 'win32' ? 'junction' : 'file',
    );

    const result = runScript(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AGENTS.md must be a regular file');
    expect(await readdir(root)).toEqual(['AGENTS.md']);
    expect(await readdir(external)).toEqual([]);
  });

  it('refuses a malformed Git marker without modifying it', async () => {
    const root = await temporaryDirectory('mpx-init-invalid-marker-');
    await writeFile(path.join(root, '.git'), 'invalid repository marker\n');

    const result = runScript(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('already inside a Git repository');
    expect(await readdir(root)).toEqual(['.git']);
    expect(await readFile(path.join(root, '.git'), 'utf8')).toBe('invalid repository marker\n');
  });

  it('rejects inherited Git directory redirection before mutation', async () => {
    const root = await temporaryDirectory('mpx-init-redirected-');
    const external = await temporaryDirectory('mpx-init-external-');

    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...gitIdentity, GIT_DIR: path.join(external, 'redirected.git') },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GIT_DIR');
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(external)).toEqual([]);
  });

  it('fails before mutation when the bundled template is absent', async () => {
    const fixture = await temporaryDirectory('mpx-init-missing-template-');
    const scriptsDirectory = path.join(fixture, 'scripts');
    await mkdir(scriptsDirectory);
    const isolatedScript = path.join(scriptsDirectory, 'init-repo.mjs');
    await cp(script, isolatedScript);
    const target = await temporaryDirectory('mpx-init-target-');

    const result = runScript(target, isolatedScript);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundled gitignore template not found');
    expect(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: target }).status).not.toBe(0);
    expect(await readdir(target)).toEqual([]);
  });
});
