import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GitRemotePlanningAdapter,
  classifyExternalAction,
  parseInstallIntentV1,
} from '../../src/index.js';

const temporary = () => mkdtemp(path.join(tmpdir(), 'mpx-external-'));

describe('external Git remote confirmation planning', () => {
  it('inspects Git without a shell and emits exact confirmed proposals while retaining remotes', async () => {
    const root = await temporary(),
      repository = path.join(root, 'repo; echo pwned');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    const config = '[remote "origin"]\n\turl = https://old.example/repo.git\n';
    await writeFile(path.join(repository, '.git', 'config'), config);
    const calls: { cwd: string; argv: readonly string[] }[] = [];
    const adapter = new GitRemotePlanningAdapter({
      allowedRoots: [root],
      git: {
        run: async (cwd, argv) => {
          calls.push({ cwd, argv });
          return {
            stdout:
              'origin\thttps://old.example/repo.git (fetch)\norigin\thttps://old.example/repo.git (push)\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
    });
    const inspected = await adapter.inspect({
      repository,
      proposals: [
        { action: 'set-url', remote: 'origin', url: 'https://new.example/repo.git' },
        { action: 'add', remote: 'mirror', url: 'ssh://host/repo.git;touch-nope' },
      ],
    });
    const plan = await adapter.plan(inspected);
    expect(calls).toEqual([{ cwd: repository, argv: ['remote', '-v'] }]);
    expect(plan.preservedRemotes).toEqual(['origin']);
    expect(plan.confirmation).toMatchObject({ scope: repository, required: true });
    expect(Buffer.from(plan.rollback.snapshot.bytes, 'base64').toString()).toBe(config);
    await expect(adapter.verify(plan)).resolves.toEqual({
      healthy: false,
      issues: ['git-remote-drift'],
    });
  });

  it('re-establishes the approved verification root before invoking git', async () => {
    const root = await temporary(),
      repository = path.join(root, 'repo'),
      outside = await temporary();
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await writeFile(path.join(repository, '.git', 'config'), '');
    const calls: string[] = [];
    const adapter = new GitRemotePlanningAdapter({
      allowedRoots: [root],
      git: {
        run: async (cwd) => {
          calls.push(cwd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });
    const plan = await adapter.plan(
      await adapter.inspect({
        repository,
        proposals: [{ action: 'add', remote: 'origin', url: 'https://example.test/repo' }],
      }),
    );
    calls.length = 0;
    await expect(adapter.verify({ ...plan, repository: outside })).rejects.toMatchObject({
      code: 'EXTERNAL_PATH_ESCAPE',
    });
    expect(calls).toEqual([]);
  });

  it('accepts only retained Git remote integration intents', () => {
    const hash = 'a'.repeat(64);
    const intent = {
      schemaVersion: 1 as const,
      kind: 'install-intent' as const,
      releaseKey: hash,
      convergenceHash: hash,
      components: ['cli'],
      externalIntegrations: [
        {
          id: 'git',
          adapter: 'git-remotes' as const,
          classification: 'confirmation-required' as const,
          planDigest: hash,
          verifierRef: 'git:repo',
        },
      ],
    };
    expect(parseInstallIntentV1(intent)).toEqual(intent);
    expect(
      ['auth-login', 'repo-rename', 'export-import'].map((action) =>
        classifyExternalAction(action as 'auth-login'),
      ),
    ).toEqual(['manual-only', 'manual-only', 'manual-only']);
  });
});
