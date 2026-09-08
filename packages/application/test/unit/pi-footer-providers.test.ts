import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { readPiFooterProviders } from '../../src/node/launch-execution-runtime.js';

async function fixture(config: unknown, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-footer-providers-'));
  try {
    await writeFile(path.join(root, 'mpxconfig.json'), JSON.stringify(config));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('resolves a named GitHub remote and publishes its pull and issue routes', async () => {
  await fixture(
    {
      schemaVersion: 1,
      project: { id: 'example/project' },
      repository: { provider: 'github', remote: 'upstream' },
      issues: { provider: 'github' },
    },
    async (root) => {
      await expect(
        readPiFooterProviders(root, async (cwd, remote) => {
          expect({ cwd, remote }).toEqual({ cwd: root, remote: 'upstream' });
          return 'git@github.com:example/a repo.git';
        }),
      ).resolves.toEqual({
        repository: 'github',
        issues: 'github',
        repositoryUrl: 'https://github.com/example/a%20repo/pulls',
        issuesUrl: 'https://github.com/example/a%20repo/issues',
        projectConfigPath: path.join(root, 'mpxconfig.json'),
      });
    },
  );
});

it('supports SSH self-hosted GitLab while stripping its transport port', async () => {
  await fixture(
    {
      schemaVersion: 1,
      project: { id: 'example/project' },
      repository: { provider: 'gitlab', remote: 'ssh://git@git.example:2222/group/sub/repo.git' },
      issues: { provider: 'gitlab' },
    },
    async (root) => {
      await expect(readPiFooterProviders(root)).resolves.toMatchObject({
        repositoryUrl: 'https://git.example/group/sub/repo/-/merge_requests',
        issuesUrl: 'https://git.example/group/sub/repo/-/issues',
      });
    },
  );
});

it('respects explicit KanbanFlow issues independently from a GitLab repository', async () => {
  await fixture(
    {
      schemaVersion: 1,
      project: { id: 'example/project' },
      repository: { provider: 'gitlab', remote: 'https://git.example:8443/group/repo.git' },
      issues: {
        provider: 'kanbanflow',
        boardId: 'team/one',
        states: { todo: 'a', wip: 'b', review: 'c', done: 'd' },
      },
    },
    async (root) => {
      await expect(readPiFooterProviders(root)).resolves.toMatchObject({
        repositoryUrl: 'https://git.example:8443/group/repo/-/merge_requests',
        issuesUrl: 'https://kanbanflow.com/board/team%2Fone',
      });
    },
  );
});

it('does not invent routes for no tracker, directory projects, or malicious remotes', async () => {
  await fixture(
    {
      schemaVersion: 1,
      project: { id: 'example/project' },
      repository: {
        provider: 'github',
        remote: 'https://user:secret@github.com/example/repo.git\nspoof',
      },
    },
    async (root) => {
      await expect(readPiFooterProviders(root, async () => 'should-not-run')).resolves.toEqual({
        repository: 'github',
        issues: 'none',
        projectConfigPath: path.join(root, 'mpxconfig.json'),
      });
    },
  );
  await fixture(
    { schemaVersion: 1, project: { id: 'example/directory', kind: 'directory' } },
    async (root) => {
      await expect(readPiFooterProviders(root)).resolves.toEqual({
        repository: '',
        issues: 'none',
        projectConfigPath: path.join(root, 'mpxconfig.json'),
      });
    },
  );
});
