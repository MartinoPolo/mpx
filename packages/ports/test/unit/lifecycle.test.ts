import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import type { ProjectConfig } from '@mpx/config';
import {
  PortService,
  RegistryStore,
  type GitWorktreeAdapter,
  type PortPlatformAdapter,
  type WorktreeIdentity,
} from '../../src/index.js';

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-port-lifecycle-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const identity = (
  repositoryId: string,
  worktreeId: string,
  worktreePath: string,
  role: 'main' | 'linked',
): WorktreeIdentity => ({
  repositoryId,
  worktreeId,
  path: worktreePath,
  role,
  commonGitPath: path.join(worktreePath, 'common'),
  gitAdminPath: path.join(worktreePath, 'admin'),
});
const config: ProjectConfig = {
  schemaVersion: 1,
  project: { id: 'lifecycle/project' },
  repository: { provider: 'generic', remote: 'origin' },
  development: {
    services: {
      app: {
        scope: 'checkout',
        port: { mode: 'managed', preferred: 5100 },
        start: { type: 'package-script', script: 'dev' },
      },
    },
  },
};
const configHash = sha256Canonical(config as unknown as JsonValue);
const platform: PortPlatformAdapter = {
  holdAvailablePorts: async () => ({ release: async () => undefined }),
  inspectListeners: async () => [],
  killProcess: async () => undefined,
  inspectProcess: async () => undefined,
};
const request = (cwd: string) => ({ cwd, config, configHash });

async function fixture() {
  const stateRoot = await temporary(),
    mainPath = await temporary(),
    linkedPath = await temporary();
  const main = identity('repository', 'main', mainPath, 'main'),
    linked = {
      ...identity('repository', 'linked', linkedPath, 'linked'),
      commonGitPath: main.commonGitPath,
    };
  let listed: readonly WorktreeIdentity[] = [main, linked];
  const adapter: GitWorktreeAdapter = {
    identify: async (cwd) => (cwd === mainPath ? main : linked),
    list: async () => listed,
  };
  const store = new RegistryStore(stateRoot);
  await new PortService({ store, git: adapter, platform }).ensure(request(mainPath));
  const service = new PortService({ store, git: adapter, platform });
  await service.ensure(request(linkedPath));
  return {
    main,
    linked,
    mainPath,
    linkedPath,
    service,
    store,
    adapter,
    removeFromGit: () => {
      listed = [main];
    },
  };
}

describe('linked port lease lifecycle', () => {
  it('releases from an immutable pre-removal identity after Git removal and is idempotent', async () => {
    const value = await fixture();
    const captured = await value.service.captureReleaseIdentity(request(value.linkedPath));
    expect(Object.isFrozen(captured)).toBe(true);
    value.removeFromGit();
    await rm(value.linkedPath, { recursive: true });
    value.adapter.identify = async (cwd) => {
      if (cwd !== value.mainPath) {
        throw new Error('removed worktree cannot resolve');
      }
      return value.main;
    };
    const first = await value.service.releaseLinkedAfterRemoval({
      repositoryCwd: value.mainPath,
      identity: captured,
    });
    const second = await value.service.releaseLinkedAfterRemoval({
      repositoryCwd: value.mainPath,
      identity: captured,
    });
    expect(first).toMatchObject({ released: true, identity: captured });
    expect(second).toEqual({ released: false, identity: captured });
    expect((await value.service.list()).map(({ worktreeId }) => worktreeId)).toEqual(['main']);
  });

  it('never releases while Git still reports the worktree', async () => {
    const value = await fixture();
    const captured = await value.service.captureReleaseIdentity(request(value.linkedPath));
    await expect(
      value.service.releaseLinkedAfterRemoval({
        repositoryCwd: value.mainPath,
        identity: captured,
      }),
    ).rejects.toMatchObject({ code: 'PORT_WORKTREE_STILL_PRESENT' });
    expect((await value.service.list()).map(({ worktreeId }) => worktreeId)).toEqual(
      expect.arrayContaining(['main', 'linked']),
    );
  });

  it('rejects a forged binding without releasing either checkout', async () => {
    const value = await fixture();
    const captured = await value.service.captureReleaseIdentity(request(value.linkedPath));
    value.removeFromGit();
    await expect(
      value.service.releaseLinkedAfterRemoval({
        repositoryCwd: value.mainPath,
        identity: { ...captured, worktreeId: 'another' },
      }),
    ).rejects.toMatchObject({ code: 'PORT_RELEASE_IDENTITY_MISMATCH' });
    expect((await value.service.list()).map(({ worktreeId }) => worktreeId)).toContain('linked');
  });

  it('validates an optional projection tombstone before changing registry authority', async () => {
    const value = await fixture();
    const captured = await value.service.captureReleaseIdentity(request(value.linkedPath));
    value.removeFromGit();
    const projection = path.join(value.linkedPath, '.worktree-ports.json');
    const tombstone = `${projection}.released-test`;
    await writeFile(
      tombstone,
      JSON.stringify({
        ...(JSON.parse(await readFile(projection, 'utf8')) as object),
        worktreeId: 'forged',
      }),
    );
    await expect(
      value.service.releaseLinkedAfterRemoval({
        repositoryCwd: value.mainPath,
        identity: captured,
        projectionTombstonePath: tombstone,
      }),
    ).rejects.toMatchObject({ code: 'PORT_RELEASE_TOMBSTONE_INVALID' });
    expect((await value.service.list()).map(({ worktreeId }) => worktreeId)).toContain('linked');
    await unlink(tombstone);
    const target = path.join(value.linkedPath, 'target');
    await writeFile(target, '{}');
    await symlink(target, tombstone, 'file');
    await expect(
      value.service.releaseLinkedAfterRemoval({
        repositoryCwd: value.mainPath,
        identity: captured,
        projectionTombstonePath: tombstone,
      }),
    ).rejects.toMatchObject({ code: 'PORT_RELEASE_TOMBSTONE_INVALID' });
  });

  it('reports external deletion with lifecycle history until explicitly resolved', async () => {
    const value = await fixture();
    const captured = await value.service.captureReleaseIdentity(request(value.linkedPath));
    value.removeFromGit();
    await rm(value.linkedPath, { recursive: true });
    const reconciled = await value.service.reconcile({
      cwd: value.mainPath,
      orphanPolicy: 'report',
    });
    expect(reconciled.orphaned).toEqual([captured]);
    expect((await value.service.list()).map(({ worktreeId }) => worktreeId)).toContain('linked');
    const resolved = await value.service.resolveOrphan({
      repositoryCwd: value.mainPath,
      identity: captured,
    });
    expect(resolved).toMatchObject({ released: true, identity: captured });
  });
});
