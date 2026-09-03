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
    stateRoot: 'C:/state',
  }) as unknown as NodeLaunchExecutionInput;

describe('Node launch runtime adapter mode', () => {
  it('marks the built-in composer as production runtime infrastructure', async () => {
    applicationLaunch.mockClear();

    await executeResolvedNodeLaunch(input());

    expect(applicationLaunch).toHaveBeenCalledOnce();
    expect(applicationLaunch.mock.calls[0]![1]).toMatchObject({ runtimeAdapterMode: 'production' });
  });

  it('does not route the host-side Pi process through a production-admitted Docker adapter', async () => {
    applicationLaunch.mockClear();
    const productionAdapter = {
      name: 'docker' as const,
      verify: vi.fn(),
      execute: vi.fn(),
    };
    const launch = {
      ...input(),
      context: {
        launchExecutorAdapters: [productionAdapter],
        launchExecutorAdapterSource: 'production-admission' as const,
      },
    };

    await executeResolvedNodeLaunch(launch);

    expect(applicationLaunch).toHaveBeenCalledOnce();
    expect(applicationLaunch.mock.calls[0]![1].executorAdapters).toContain(productionAdapter);
    expect(applicationLaunch.mock.calls[0]![1].useSelectedExecutorForHostPi).toBeUndefined();
    expect(productionAdapter.execute).not.toHaveBeenCalled();
  });

  it('keeps selected-adapter Pi process behavior for unmarked caller-injected executor contexts', async () => {
    applicationLaunch.mockClear();
    const injectedAdapter = {
      name: 'docker' as const,
      verify: vi.fn(),
      execute: vi.fn(),
    };
    const launch = {
      ...input(),
      context: { launchExecutorAdapters: [injectedAdapter] },
    };

    await executeResolvedNodeLaunch(launch);

    expect(applicationLaunch.mock.calls[0]![1]).toMatchObject({
      executorAdapters: expect.arrayContaining([injectedAdapter]),
      useSelectedExecutorForHostPi: true,
    });
  });

  it('keeps selected-adapter Pi process behavior for explicitly marked injected contexts', async () => {
    applicationLaunch.mockClear();
    const injectedAdapter = {
      name: 'docker' as const,
      verify: vi.fn(),
      execute: vi.fn(),
    };

    await executeResolvedNodeLaunch({
      ...input(),
      context: {
        launchExecutorAdapters: [injectedAdapter],
        launchExecutorAdapterSource: 'injected',
      },
    });

    expect(applicationLaunch.mock.calls[0]![1].useSelectedExecutorForHostPi).toBe(true);
  });

  it('marks caller-supplied runtime adapters as injected', async () => {
    applicationLaunch.mockClear();

    await executeResolvedNodeLaunch(input(true));

    expect(applicationLaunch).toHaveBeenCalledOnce();
    expect(applicationLaunch.mock.calls[0]![1]).toMatchObject({ runtimeAdapterMode: 'injected' });
  });
});
