import { describe, expect, it } from 'vitest';
import { createBuiltinProviderAdapters, type ProviderProcessExecutor } from '../../src/index.js';

const executor: ProviderProcessExecutor = {
  execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
};

describe('built-in provider composition', () => {
  it('constructs only the requested fixed built-in adapter', () => {
    const adapters = createBuiltinProviderAdapters(executor, {
      providerId: 'kanbanflow',
      cwd: 'C:/project',
      kanbanflow: { states: { todo: 'todo', done: 'done' } },
    });

    expect(
      adapters.map(({ providerId, backend, role }) => ({ providerId, backend, role })),
    ).toEqual([{ providerId: 'kanbanflow', backend: 'kf', role: 'issues' }]);
  });

  it('constructs the fixed Gerrit adapter only when selector and configured remote are present', () => {
    const adapters = createBuiltinProviderAdapters(executor, {
      providerId: 'gerrit',
      cwd: 'C:/project',
      repository: 'review.example/team/project',
      remote: 'review-upstream',
    });
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toMatchObject({
      providerId: 'gerrit',
      backend: 'git-ssh',
      role: 'repository',
      capabilities: [
        'review.view',
        'review.create',
        'review.update',
        'review.comment',
        'review.ready',
        'review.vote',
        'review.merge',
      ],
    });
  });
});
