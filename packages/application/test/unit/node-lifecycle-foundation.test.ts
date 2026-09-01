import { expect, it } from 'vitest';
import {
  requireRepositoryBoundLifecycleState,
  verifyPreparationWorkerHandshake,
  windowsProcessIdentityInspector,
} from '@mpx/application/node';
import { deriveLifecycleKey } from '@mpx/worktrees';

it('adapts Windows process inspection for lifecycle lock identity with fail-closed errors', async () => {
  await expect(
    windowsProcessIdentityInspector({
      inspect: async (pid) => ({ pid, startFingerprint: 'windows-start' }),
    }).inspect(42),
  ).resolves.toEqual({ status: 'present', pid: 42, startFingerprint: 'windows-start' });
  await expect(
    windowsProcessIdentityInspector({ inspect: async () => undefined }).inspect(42),
  ).resolves.toEqual({ status: 'absent', pid: 42 });
  await expect(
    windowsProcessIdentityInspector({
      inspect: async () => {
        throw new Error('unknown');
      },
    }).inspect(42),
  ).resolves.toEqual({ status: 'unknown', pid: 42 });
});

it('requires lifecycle state to be bound to the requested repository', async () => {
  const key = deriveLifecycleKey('C:/repos/one/.git', 'feature/test');
  const foundation = {
    state: {
      load: async () => ({
        schemaVersion: 1,
        owner: 'mpx',
        key,
        repositoryId: 'sample/app',
        repositoryIdentity: 'C:/repos/one/.git',
        mainRoot: 'C:/repos/one',
        worktreePath: 'C:/repo.worktrees/feature',
        branch: 'feature/test',
        base: 'main',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    repository: {
      resolve: async () => ({
        commonGitDirectory: 'C:/repos/two/.git',
        mainRoot: 'C:/repos/two',
        config: { project: { id: 'sample/app' } },
      }),
    },
  } as never;
  await expect(
    requireRepositoryBoundLifecycleState(key, 'C:/repo', foundation),
  ).rejects.toMatchObject({ code: 'WORKTREE_REPOSITORY_MISMATCH' });
});

it('rejects an invalid lifecycle key before repository access', async () => {
  let resolved = false;
  const foundation = {
    state: {
      load: async () => ({
        schemaVersion: 1,
        owner: 'mpx',
        key: 'wrong',
        repositoryId: 'sample/app',
        repositoryIdentity: 'C:/repos/one/.git',
        mainRoot: 'C:/repos/one',
        worktreePath: 'C:/repo.worktrees/feature',
        branch: 'feature/test',
        base: 'main',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    repository: {
      resolve: async () => {
        resolved = true;
        throw new Error('must not resolve');
      },
    },
  } as never;
  await expect(
    requireRepositoryBoundLifecycleState('wrong', 'C:/repo', foundation),
  ).rejects.toMatchObject({ code: 'WORKTREE_LIFECYCLE_STATE_INVALID' });
  expect(resolved).toBe(false);
});

it('rejects lifecycle access when the canonical worktree belongs to another branch', async () => {
  const key = deriveLifecycleKey('C:/repos/one/.git', 'feature/other');
  const foundation = {
    state: {
      load: async () => ({
        schemaVersion: 1,
        owner: 'mpx',
        key,
        repositoryId: 'sample/app',
        repositoryIdentity: 'C:/repos/one/.git',
        mainRoot: 'C:/repos/one',
        worktreePath: 'C:/repo.worktrees/other',
        branch: 'feature/other',
        base: 'main',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    repository: {
      resolve: async () => ({
        commonGitDirectory: 'C:/repos/one/.git',
        mainRoot: 'C:/repos/one',
        config: { project: { id: 'sample/app' } },
      }),
    },
    git: { list: async () => [{ path: 'C:/repo.worktrees/other', branch: 'feature/allowed' }] },
  } as never;
  await expect(
    requireRepositoryBoundLifecycleState(key, 'C:/repo', foundation),
  ).rejects.toMatchObject({ code: 'WORKTREE_REPOSITORY_MISMATCH' });
});

it('rejects a worker handshake for a different persisted run', () => {
  expect(
    verifyPreparationWorkerHandshake(
      {
        owner: 'mpx',
        runId: 'persisted-run',
        status: 'preparing',
        worker: { pid: 42, startFingerprint: 'birth-42', ownerToken: 'token-42' },
      },
      { owner: 'mpx', startFingerprint: 'birth-42', ownerToken: 'token-42' },
      42,
      'stale-run',
    ),
  ).toBe(false);
});

it('requires exact persisted process ownership for worker handshake', () => {
  const state = {
    owner: 'mpx' as const,
    runId: 'run-42',
    status: 'preparing' as const,
    worker: { pid: 42, startFingerprint: 'birth-42', ownerToken: 'token-42' },
  };
  expect(
    verifyPreparationWorkerHandshake(
      state,
      { owner: 'mpx', startFingerprint: 'birth-42', ownerToken: 'token-42' },
      42,
      'run-42',
    ),
  ).toBe(true);
  expect(
    verifyPreparationWorkerHandshake(
      state,
      { owner: 'mpx', startFingerprint: 'birth-42', ownerToken: 'wrong' },
      42,
      'run-42',
    ),
  ).toBe(false);
  expect(
    verifyPreparationWorkerHandshake(
      { ...state, worker: { pid: 42, startFingerprint: 'birth-42' } },
      { owner: 'mpx', startFingerprint: 'birth-42' },
      42,
      'run-42',
    ),
  ).toBe(false);
});
