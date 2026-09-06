import { describe, expect, it, vi } from 'vitest';
import {
  createBuiltinProviderService,
  type ProviderProcessExecutor,
  type ProviderProcessRequest,
} from '../../src/index.js';

const gerritOutput = `${JSON.stringify({
  project: 'team/project',
  branch: 'main',
  number: 42,
  id: 'I1111111111111111111111111111111111111111',
  subject: 'Review',
  status: 'NEW',
  wip: false,
  currentPatchSet: {
    number: 1,
    revision: '0123456789abcdef0123456789abcdef01234567',
    ref: 'refs/changes/42/42/1',
  },
})}\n${JSON.stringify({ type: 'stats', rowCount: 1 })}\n`;

describe('built-in provider composition', () => {
  it('installs only the requested fixed built-in provider', async () => {
    const executor: ProviderProcessExecutor = {
      execute: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    };
    const service = createBuiltinProviderService(executor, {
      providerId: 'kanbanflow',
      cwd: 'C:/project',
      kanbanflow: { states: { todo: 'todo', done: 'done' } },
    });

    await expect(
      service.invoke({ providerId: 'github', capability: 'issue.list', input: {} }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('constructs the fixed Gerrit service only from selector and configured remote', async () => {
    const requests: ProviderProcessRequest[] = [];
    const executor: ProviderProcessExecutor = {
      execute: vi.fn(async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: gerritOutput, stderr: '' };
      }),
    };
    const service = createBuiltinProviderService(executor, {
      providerId: 'gerrit',
      cwd: 'C:/project',
      repository: 'review.example/team/project',
      remote: 'review-upstream',
    });

    await expect(
      service.invoke({
        providerId: 'gerrit',
        capability: 'review.view',
        route: 'work',
        input: { id: '42' },
      }),
    ).resolves.toMatchObject({ id: '42', title: 'Review' });
    expect(requests[0]?.argv).toContain('review.example');
  });
});
