import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig, UserConfig } from '@mpx/config';
import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredNodeLocalIssueStore,
  createNodeLocalIssueViewRebuilder,
} from '../../src/node/index.js';

describe('Node local issue view rebuilder', () => {
  it('constructs the local store and maps the neutral rebuild request', async () => {
    const store = { marker: 'store' };
    const createStore = vi.fn(() => store);
    const rebuildViews = vi.fn(async () => ({ rebuilt: 2 }));
    const rebuilder = createNodeLocalIssueViewRebuilder({ createStore, rebuildViews });

    await expect(
      rebuilder.rebuild({
        storeRoot: 'C:/issues',
        projectId: 'sample/app',
        view: {
          vaultRoot: 'C:/vault',
          outputRoot: 'Projects/App',
          resumeBaseUrl: 'mpx://resume',
        },
      }),
    ).resolves.toEqual({ rebuilt: 2 });
    expect(createStore).toHaveBeenCalledWith('C:/issues', { projectId: 'sample/app' });
    expect(rebuildViews).toHaveBeenCalledWith(store, {
      vaultRoot: 'C:/vault',
      outputRoot: 'Projects/App',
      projectId: 'sample/app',
      resumeBaseUrl: 'mpx://resume',
    });
  });

  it('resolves registered roots and rebuilds the configured view after mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-local-entry-'));
    const storeRoot = path.join(root, 'account-data', 'issues');
    const vaultRoot = path.join(root, 'account-data', 'vault');
    const outputRoot = path.join(vaultRoot, 'MPX', 'Issues');
    const project = {
      schemaVersion: 1,
      project: { id: 'sample/app' },
      repository: { provider: 'generic', remote: 'origin' },
      issues: { provider: 'local', store: 'personal', view: 'obsidian' },
    } satisfies ProjectConfig;
    const user = {
      localIssueStores: { personal: { root: storeRoot } },
      localViews: {
        obsidian: {
          vaultRoot,
          outputRoot,
          vaultSubtree: 'MPX/Issues',
          resumeBaseUrl: 'mpx://resume',
        },
      },
    } as unknown as UserConfig;

    const store = createConfiguredNodeLocalIssueStore({ project, user });
    const issue = await store.create({ title: 'Visible issue', body: 'Body' });

    expect(store.root).toBe(path.resolve(storeRoot));
    expect(issue.providerData.local.projectionRebuildPending).toBeUndefined();
    await expect(
      readFile(path.join(outputRoot, '000001-visible-issue.md'), 'utf8'),
    ).resolves.toContain('project: "sample/app"');
  });

  it('fails closed when a logical store is not registered', () => {
    const project = {
      schemaVersion: 1,
      project: { id: 'sample/app' },
      repository: { provider: 'generic', remote: 'origin' },
      issues: { provider: 'local', store: 'missing' },
    } satisfies ProjectConfig;

    expect(() => createConfiguredNodeLocalIssueStore({ project, user: {} as UserConfig })).toThrow(
      /not registered/u,
    );
  });
});
