import { describe, expect, it, vi } from 'vitest';
import type { LaunchExecutionDependencies } from '../../src/launch-execution-service.js';
import type { NodeLaunchExecutionInput } from '../../src/node/launch-execution.js';

const applicationLaunch = vi.hoisted(() =>
  vi.fn(async (_request: unknown, _dependencies: LaunchExecutionDependencies) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
  })),
);
vi.mock('../../src/launch-execution-service.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/launch-execution-service.js')>()),
  executeResolvedLaunch: applicationLaunch,
}));

import { executeResolvedNodeLaunch } from '../../src/node/launch-execution.js';

const input = (custom = false) =>
  ({
    descriptor: { runtime: 'pi', executor: { name: 'docker' } },
    context: custom
      ? {
          launchRuntimeAdapters: [
            {
              runtime: 'pi',
              prepare: async () => ({ executable: 'pi', argv: [], environment: {} }),
            },
          ],
        }
      : {},
    cwd: 'C:/project',
    environment: {},
    agentsRoot: 'C:/content/agents',
    runtimeProfilesFile: 'C:/content/runtime-profiles.json',
    artifactsRoot: 'C:/state/runtime-artifacts',
    stateRoot: 'C:/state',
  }) as unknown as NodeLaunchExecutionInput;

describe('Node launch runtime adapter mode', () => {
  it('marks the built-in composer as production runtime infrastructure', async () => {
    applicationLaunch.mockClear();

    await executeResolvedNodeLaunch({
      ...input(),
      descriptor: { runtime: 'claude', executor: { name: 'docker' } },
    } as unknown as NodeLaunchExecutionInput);

    expect(applicationLaunch).toHaveBeenCalledOnce();
    expect(applicationLaunch.mock.calls[0]![1]).toMatchObject({ runtimeAdapterMode: 'production' });
  });

  it.each([
    ['fresh launch', undefined],
    ['resume', { nativeBinding: {}, nativeSessionRef: { file: 'C:/private/session.json' } }],
  ] as const)(
    'rejects production-admitted Pi Docker %s before application or child execution',
    async (_scenario, resume) => {
      applicationLaunch.mockClear();
      const productionAdapter = {
        name: 'docker' as const,
        verify: vi.fn(),
        execute: vi.fn(),
      };
      const launch = {
        ...input(),
        ...(resume ? { resume } : {}),
        context: {
          launchExecutorAdapters: [productionAdapter],
          launchExecutorAdapterSource: 'production-admission' as const,
        },
      } as NodeLaunchExecutionInput;

      const error = await executeResolvedNodeLaunch(launch).catch((failure) => failure);

      expect(error).toMatchObject({
        name: 'ExecutionError',
        code: 'PI_DOCKER_UNAVAILABLE',
        details: { executor: 'docker', runtime: 'pi' },
      });
      expect(JSON.stringify(error)).not.toContain('C:/private/session.json');
      expect(applicationLaunch).not.toHaveBeenCalled();
      expect(productionAdapter.verify).not.toHaveBeenCalled();
      expect(productionAdapter.execute).not.toHaveBeenCalled();
    },
  );

  it('rejects Pi Docker resume without an admitted adapter before child execution', async () => {
    applicationLaunch.mockClear();
    const launch = {
      ...input(),
      resume: { nativeBinding: {}, nativeSessionRef: { file: 'C:/private/session.json' } },
      context: {},
    } as unknown as NodeLaunchExecutionInput;

    const error = await executeResolvedNodeLaunch(launch).catch((failure) => failure);

    expect(error).toMatchObject({
      name: 'ExecutionError',
      code: 'PI_DOCKER_UNAVAILABLE',
      details: { executor: 'docker', runtime: 'pi' },
    });
    expect(applicationLaunch).not.toHaveBeenCalled();
  });

  it('marks caller-supplied runtime adapters as injected', async () => {
    applicationLaunch.mockClear();

    await executeResolvedNodeLaunch(input(true));

    expect(applicationLaunch).toHaveBeenCalledOnce();
    expect(applicationLaunch.mock.calls[0]![1]).toMatchObject({ runtimeAdapterMode: 'injected' });
  });
});
