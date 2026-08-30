import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GitRemotePlanningAdapter,
  ObsidianPlanningAdapter,
  RaycastPlanningAdapter,
  classifyExternalAction,
  parseInstallIntentV1,
} from './index.js';

const temporary = () => mkdtemp(path.join(tmpdir(), 'mpx-external-'));

describe('Phase I external integration confirmation planning', () => {
  it('inspects Git per repository without a shell and emits exact confirmed proposals while retaining other remotes', async () => {
    const root = await temporary(),
      repository = path.join(root, 'repo; echo pwned');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    const config =
      '[remote "origin"]\n\turl = https://old.example/repo.git\n[remote "upstream"]\n\turl = https://upstream.example/repo.git\n';
    await writeFile(path.join(repository, '.git', 'config'), config);
    const calls: { cwd: string; argv: readonly string[] }[] = [];
    const adapter = new GitRemotePlanningAdapter({
      allowedRoots: [root],
      git: {
        run: async (cwd, argv) => {
          calls.push({ cwd, argv });
          return {
            stdout:
              'origin\thttps://old.example/repo.git (fetch)\norigin\thttps://old.example/repo.git (push)\nupstream\thttps://upstream.example/repo.git (fetch)\n',
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
        { action: 'rename', remote: 'upstream', newName: 'source' },
      ],
    });
    const plan = await adapter.plan(inspected);
    expect(await adapter.plan(inspected)).toEqual(plan);
    expect(calls).toEqual([{ cwd: repository, argv: ['remote', '-v'] }]);
    expect(plan.commands).toEqual([
      {
        executable: 'git',
        cwd: repository,
        argv: ['remote', 'add', 'mirror', 'ssh://host/repo.git;touch-nope'],
      },
      { executable: 'git', cwd: repository, argv: ['remote', 'rename', 'upstream', 'source'] },
      {
        executable: 'git',
        cwd: repository,
        argv: ['remote', 'set-url', 'origin', 'https://new.example/repo.git'],
      },
    ]);
    expect(plan.preservedRemotes).toEqual(['origin', 'upstream']);
    expect(plan.confirmation).toMatchObject({ scope: repository, required: true });
    expect(plan.rollback).toMatchObject({
      snapshot: { path: path.join(repository, '.git', 'config'), encoding: 'base64' },
      automatic: false,
    });
    expect(Buffer.from(plan.rollback.snapshot.bytes, 'base64').toString()).toBe(config);
    await expect(adapter.verify(plan)).resolves.toEqual({
      healthy: false,
      issues: ['git-remote-drift'],
    });
  });

  it('plans only the exact reviewed Obsidian MPX subtree files with atomic snapshots', async () => {
    const vault = await temporary(),
      subtree = path.join(vault, 'MPX');
    await mkdir(path.join(subtree, 'Projects'), { recursive: true });
    await mkdir(path.join(vault, 'Private'));
    await writeFile(path.join(subtree, 'Projects', 'alpha.md'), '# Alpha\n');
    await writeFile(path.join(vault, 'Private', 'unrelated.md'), 'DO NOT READ');
    const adapter = new ObsidianPlanningAdapter({ MPX_OBSIDIAN_VAULT: vault });
    const inspected = await adapter.inspect({
      reviewedFiles: ['Projects/alpha.md', 'Projects/renamed.md', 'dashboard.md', 'mpx.css'],
      changes: [
        {
          action: 'write',
          path: 'dashboard.md',
          content: '```query\npath:MPX\n```',
          purpose: 'query',
        },
        { action: 'write', path: 'mpx.css', content: '.mpx {}', purpose: 'css' },
        {
          action: 'write',
          path: 'Projects/alpha.md',
          content: '[[dashboard]]',
          purpose: 'backlinks',
        },
        { action: 'rename', path: 'Projects/alpha.md', destination: 'Projects/renamed.md' },
      ],
    });
    const plan = await adapter.plan(inspected);
    expect(plan.reviewedFiles).toEqual([
      'Projects/alpha.md',
      'Projects/renamed.md',
      'dashboard.md',
      'mpx.css',
    ]);
    expect(
      plan.rollback.snapshots.map((snapshot) => [snapshot.path, snapshot.sha256 === null]),
    ).toEqual([
      ['Projects/alpha.md', false],
      ['Projects/renamed.md', true],
      ['dashboard.md', true],
      ['mpx.css', true],
    ]);
    expect(plan.rollback.steps.join(' ')).toContain('atomic');
    expect(plan.confirmation.scope).toBe(subtree);
    expect(await readFile(path.join(vault, 'Private', 'unrelated.md'), 'utf8')).toBe('DO NOT READ');
    await expect(adapter.verify(plan)).resolves.toEqual({
      healthy: false,
      issues: expect.arrayContaining(['obsidian-file-drift:Projects/alpha.md']),
    });
  });

  it('rejects traversals and symlinks before Obsidian planning', async () => {
    const vault = await temporary(),
      outside = await temporary();
    await mkdir(path.join(vault, 'MPX'));
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await symlink(path.join(outside, 'secret.md'), path.join(vault, 'MPX', 'linked.md'));
    const adapter = new ObsidianPlanningAdapter({ MPX_OBSIDIAN_VAULT: vault });
    await expect(
      adapter.inspect({ reviewedFiles: ['../Private.md'], changes: [] }),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_REVIEW_INVALID' });
    await expect(
      adapter.inspect({ reviewedFiles: ['linked.md'], changes: [] }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_PATH_ESCAPE' });
  });

  it('re-establishes Git and Obsidian verification roots before reading or invoking git', async () => {
    const root = await temporary(),
      repository = path.join(root, 'repo'),
      outside = await temporary(),
      gitCalls: string[] = [];
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await writeFile(path.join(repository, '.git', 'config'), '');
    await mkdir(path.join(outside, '.git'), { recursive: true });
    await writeFile(path.join(outside, '.git', 'config'), '');
    const git = new GitRemotePlanningAdapter({
      allowedRoots: [root],
      git: {
        run: async (cwd) => {
          gitCalls.push(cwd);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    });
    const gitPlan = await git.plan(
      await git.inspect({
        repository,
        proposals: [{ action: 'add', remote: 'origin', url: 'https://example.test/repo' }],
      }),
    );
    gitCalls.length = 0;
    await expect(git.verify({ ...gitPlan, repository: outside })).rejects.toMatchObject({
      code: 'EXTERNAL_PATH_ESCAPE',
    });
    expect(gitCalls).toEqual([]);

    const vault = await temporary(),
      subtree = path.join(vault, 'MPX');
    await mkdir(subtree);
    const obsidian = new ObsidianPlanningAdapter({ MPX_OBSIDIAN_VAULT: vault }),
      obsidianPlan = await obsidian.plan(
        await obsidian.inspect({ reviewedFiles: [], changes: [] }),
      );
    await expect(obsidian.verify({ ...obsidianPlan, subtree: outside })).rejects.toMatchObject({
      code: 'EXTERNAL_PATH_ESCAPE',
    });
  });

  it('audits only an encrypted Raycast derivative and emits a manual-only ID/category-preserving plan', async () => {
    const adapter = new RaycastPlanningAdapter();
    const derivative = {
      encrypted: true as const,
      items: [
        { id: 'cmd-2', category: 'Development', command: 'Open project' },
        { id: 'cmd-1', category: 'MPX', command: 'Launch' },
      ],
    };
    const plan = await adapter.plan(await adapter.inspect(derivative));
    expect(plan).toMatchObject({
      classification: 'manual-only',
      automaticImport: false,
      encrypted: true,
      items: derivative.items,
    });
    expect(plan.instructions.join(' ')).toContain('post-export');
    await expect(adapter.verify(plan)).resolves.toEqual({
      healthy: false,
      issues: ['post-export-required'],
    });
    await expect(adapter.verify(plan, derivative)).resolves.toEqual({ healthy: true, issues: [] });
    await expect(
      adapter.inspect({ ...derivative, credentials: 'secret' } as never),
    ).rejects.toMatchObject({ code: 'RAYCAST_DERIVATIVE_INVALID' });
  });

  it('binds sorted typed external requests into immutable installer intent and classifies inherently interactive actions manual-only', () => {
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
        {
          id: 'raycast',
          adapter: 'raycast' as const,
          classification: 'manual-only' as const,
          planDigest: hash,
          verifierRef: 'raycast:export',
        },
      ],
    };
    expect(parseInstallIntentV1(intent)).toEqual(intent);
    expect(
      ['auth-login', 'repo-rename', 'export-import'].map((action) =>
        classifyExternalAction(action as 'auth-login'),
      ),
    ).toEqual(['manual-only', 'manual-only', 'manual-only']);
    expect(() =>
      parseInstallIntentV1({
        ...intent,
        externalIntegrations: [...intent.externalIntegrations].reverse(),
      }),
    ).toThrow();
    expect(() =>
      parseInstallIntentV1({
        ...intent,
        externalIntegrations: [
          { id: 'git', adapter: 'git-remotes', classification: 'confirmation-required' },
        ],
      }),
    ).toThrow();
  });
});
