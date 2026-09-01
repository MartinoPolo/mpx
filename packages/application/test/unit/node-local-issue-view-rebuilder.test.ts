import { describe, expect, it, vi } from 'vitest';
import { createNodeLocalIssueViewRebuilder } from '../../src/node/index.js';

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
});
