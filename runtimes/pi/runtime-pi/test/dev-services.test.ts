import { expect, it, vi } from 'vitest';
import { createLaunchBoundDevServer } from '../src/dev-services.js';

it('registers dev services against the exact launch, worktree, ports, and executor and cleans up', async () => {
  const start = vi.fn(async (request) => ({ ...request, state: 'ready' }));
  const shutdown = vi.fn(async () => undefined);
  const events: unknown[] = [];
  const server = createLaunchBoundDevServer(
    { launchKey: 'launch-a', worktree: 'C:/repo.wt/x', ports: [4310], executor: 'docker' },
    { start, shutdown, publish: (event) => events.push(event) },
  );
  await expect(
    server.start({
      launchKey: 'wrong',
      id: 'web',
      executable: 'pnpm',
      args: ['dev'],
      cwd: 'C:/repo.wt/x',
    }),
  ).rejects.toThrow('DEV_SERVER_LAUNCH_STALE');
  await server.start({
    launchKey: 'launch-a',
    id: 'web',
    executable: 'pnpm',
    args: ['dev'],
    cwd: 'C:/repo.wt/x',
  });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      assignment: { worktreeRoot: 'C:/repo.wt/x', ports: [4310] },
      ports: [4310],
      executor: 'docker',
    }),
  );
  expect(events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'dev-server:status' })]),
  );
  await server.cleanup();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(events.at(-1)).toMatchObject({ type: 'dev-server:cleanup', launchKey: 'launch-a' });
});

it('never falls back from Docker to host', async () => {
  const server = createLaunchBoundDevServer(
    { launchKey: 'launch', worktree: 'C:/repo', ports: [], executor: 'docker' },
    {
      start: async () => {
        throw new Error('docker unavailable');
      },
      shutdown: async () => undefined,
      publish() {},
    },
  );
  await expect(
    server.start({ launchKey: 'launch', id: 'web', executable: 'pnpm', args: [], cwd: 'C:/repo' }),
  ).rejects.toThrow('docker unavailable');
});
