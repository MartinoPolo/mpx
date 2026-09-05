import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeDevService,
  createNodeWorkspaceApplicationService,
  createNodeWorkspacePathAdapter,
} from '../../src/node/index.js';

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
  it('compares canonical Windows workspace paths without case sensitivity', () => {
    const paths = createNodeWorkspacePathAdapter('win32');
    expect(paths.equals('C:\\Repo\\Linked', 'c:\\repo\\linked')).toBe(true);
    expect(paths.contains('C:\\Repo', 'c:\\REPO\\Linked')).toBe(true);
    expect(paths.contains('C:\\Repo', 'c:\\repo-evil')).toBe(false);
  });

  it('keeps POSIX workspace equality case-sensitive and containment bounded', () => {
    const paths = createNodeWorkspacePathAdapter('linux');
    expect(paths.equals('/Repo/Linked', '/repo/linked')).toBe(false);
    expect(paths.contains('/repo', '/repo/linked')).toBe(true);
    expect(paths.contains('/repo', '/repo-evil')).toBe(false);
  });

  it('defaults ordinary unbound process environments to host execution', async () => {
    const stateRoot = await root();
    const service = createNodeWorkspaceApplicationService({
      environment: { LOCALAPPDATA: stateRoot },
      stateRoot,
      cwd: stateRoot,
      preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
    });
    await expect(service.killPort({ schemaVersion: 2, pid: 1 } as never)).rejects.toMatchObject({
      code: 'SCHEMA_VERSION_UNSUPPORTED',
    });
    expect(createNodeDevService({ LOCALAPPDATA: stateRoot }, stateRoot).runtimeKind).toBe('host');
  });

  it('rejects malformed executor selection when a runtime context is bound', async () => {
    const stateRoot = await root();
    expect(() =>
      createNodeWorkspaceApplicationService({
        environment: {
          LOCALAPPDATA: stateRoot,
          MPX_RUNTIME_CONTEXT: '{malformed',
          MPX_RUNTIME_EXECUTOR: 'Docker',
        },
        stateRoot,
        cwd: stateRoot,
        preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DEV_EXECUTOR_UNSUPPORTED' }));
  });

  it('accepts an exact host executor for a bound runtime context', async () => {
    const stateRoot = await root();
    expect(
      createNodeDevService(
        { LOCALAPPDATA: stateRoot, MPX_RUNTIME_CONTEXT: '{}', MPX_RUNTIME_EXECUTOR: 'host' },
        stateRoot,
      ).runtimeKind,
    ).toBe('host');
  });

  it('never falls back to host composition for a docker runtime', async () => {
    const stateRoot = await root();
    const environment = {
      LOCALAPPDATA: stateRoot,
      MPX_RUNTIME_CONTEXT: '{}',
      MPX_RUNTIME_EXECUTOR: 'docker',
    };
    expect(() => createNodeDevService(environment, stateRoot)).toThrowError(
      expect.objectContaining({ code: 'DEV_EXECUTOR_UNSUPPORTED' }),
    );
    expect(() =>
      createNodeWorkspaceApplicationService({
        environment,
        stateRoot,
        cwd: stateRoot,
        preparationWorkerEntry: path.join(stateRoot, 'worker.js'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'DEV_EXECUTOR_UNSUPPORTED' }));
  });
});
