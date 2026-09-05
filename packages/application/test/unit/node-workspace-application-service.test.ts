import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeWorkspaceApplicationService } from '../../src/node/index.js';

const roots: string[] = [];
async function root() {
  const value = await mkdtemp(path.join(tmpdir(), 'mpx-node-workspace-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('Node workspace composition', () => {
  it('requires an exact runtime executor before constructing any concrete adapters', async () => {
    const stateRoot = await root();
    expect(() =>
      createNodeWorkspaceApplicationService({
        environment: { LOCALAPPDATA: stateRoot, MPX_RUNTIME_EXECUTOR: 'Docker' },
        stateRoot,
        cwd: stateRoot,
        preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DEV_EXECUTOR_UNSUPPORTED' }));
  });

  it('constructs the real host workspace composition from environment, state, and cwd', async () => {
    const stateRoot = await root();
    const service = createNodeWorkspaceApplicationService({
      environment: { LOCALAPPDATA: stateRoot, MPX_RUNTIME_EXECUTOR: 'host' },
      stateRoot,
      cwd: stateRoot,
      preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
    });
    await expect(service.killPort({ schemaVersion: 2, pid: 1 } as never)).rejects.toMatchObject({
      code: 'SCHEMA_VERSION_UNSUPPORTED',
    });
  });

  it('never falls back to host composition for a docker runtime', async () => {
    const stateRoot = await root();
    expect(() =>
      createNodeWorkspaceApplicationService({
        environment: { LOCALAPPDATA: stateRoot, MPX_RUNTIME_EXECUTOR: 'docker' },
        stateRoot,
        cwd: stateRoot,
        preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DEV_EXECUTOR_UNSUPPORTED' }));
  });
});
