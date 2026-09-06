import { describe, expect, it, vi } from 'vitest';
import {
  probeProvider,
  runProviderCommand,
  type ProviderProcessExecutor,
} from '../../src/index.js';

const request = {
  providerId: 'github',
  route: 'github-personal',
  argv: ['gh', 'issue', 'list'] as const,
};

describe('provider process execution', () => {
  it('uses injected argv-only execution without exposing a shell option', async () => {
    const execute = vi.fn(async (_request: Parameters<ProviderProcessExecutor['execute']>[0]) => ({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: '',
    }));
    const result = await runProviderCommand(
      request,
      { execute },
      (output) => JSON.parse(output) as unknown,
    );
    expect(result).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({
      argv: ['gh', 'issue', 'list'],
      route: 'github-personal',
    });
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('shell');
  });

  it.each([
    [
      Object.assign(new Error('spawn C:/secret/tool ENOENT'), { code: 'ENOENT' }),
      'EXECUTABLE_MISSING',
    ],
    [new Error('token=super-secret C:/private'), 'COMMAND_FAILURE'],
  ] as const)(
    'maps process rejection to %s without leaking process details',
    async (failure, code) => {
      const executor: ProviderProcessExecutor = {
        execute: async () => {
          throw failure;
        },
      };
      let caught: unknown;
      try {
        await runProviderCommand(request, executor);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code,
        retryable: code === 'COMMAND_FAILURE',
        details: { providerData: { github: {} } },
      });
      expect(JSON.stringify(caught)).not.toContain('super-secret');
      expect(JSON.stringify(caught)).not.toContain('C:/private');
    },
  );

  it.each([
    Object.assign(new Error('timed out token=secret'), { code: 'ETIMEDOUT', killed: true }),
    Object.assign(new Error('buffer C:/private'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    Object.assign(new Error('signal token=secret'), { code: null, signal: 'SIGTERM' }),
  ])(
    'maps timeout, max-buffer, and signal start failures to redacted retryable errors',
    async (failure) => {
      const executor: ProviderProcessExecutor = {
        execute: async () => {
          throw failure;
        },
      };
      let caught: unknown;
      try {
        await runProviderCommand(request, executor);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'COMMAND_FAILURE',
        retryable: true,
        details: { providerData: { github: {} } },
      });
      expect(JSON.stringify(caught)).not.toMatch(/secret|private/u);
    },
  );

  it('makes ambiguous mutation transport failures non-retryable', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true });
      },
    };
    await expect(
      runProviderCommand({ ...request, mutation: true }, executor),
    ).rejects.toMatchObject({
      code: 'MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
    });
  });

  it('classifies mutation preflight rejections as command failures', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => {
        throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
      },
    };
    await expect(
      runProviderCommand({ ...request, mutation: true }, executor),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILURE',
      retryable: true,
    });
  });

  it('preserves authentication failure classification for mutating commands', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => ({
        exitCode: 255,
        stdout: '',
        stderr: 'secret diagnostic',
        failure: 'auth',
      }),
    };
    let failure: unknown;
    try {
      await runProviderCommand({ ...request, providerId: 'gerrit', mutation: true }, executor);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'AUTH_FAILURE', retryable: false });
    expect(JSON.stringify(failure)).not.toContain('secret diagnostic');
  });

  it('forwards operation timeout and backend-specific authentication exit metadata', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    await runProviderCommand(
      { ...request, timeoutMilliseconds: 1_800_000, authExitCodes: [4] },
      { execute },
    );
    expect(execute).toHaveBeenCalledWith({
      argv: ['gh', 'issue', 'list'],
      route: 'github-personal',
      timeoutMilliseconds: 1_800_000,
      authExitCodes: [4],
    });
  });

  it('accepts and parses an explicitly accepted nonzero exit', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 8, stdout: '{"state":"pending"}', stderr: '' }),
    };
    await expect(
      runProviderCommand(
        { ...request, acceptedExitCodes: [8] },
        executor,
        (output) => JSON.parse(output) as unknown,
      ),
    ).resolves.toEqual({ state: 'pending' });
  });

  it('distinguishes authentication and unlisted command failures with sanitized providerData', async () => {
    const auth: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 4, stdout: '', stderr: 'token=secret', failure: 'auth' }),
    };
    const command: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 9, stdout: '', stderr: 'C:/private/repo' }),
    };
    await expect(runProviderCommand(request, auth)).rejects.toMatchObject({
      code: 'AUTH_FAILURE',
      details: { providerData: { github: { exitCode: 4 } } },
    });
    let failure: unknown;
    try {
      await runProviderCommand({ ...request, acceptedExitCodes: [1, 8] }, command);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'COMMAND_FAILURE',
      details: { providerData: { github: { exitCode: 9 } } },
    });
    expect(JSON.stringify(failure)).not.toContain('C:/private/repo');
  });

  it('maps malformed provider output to INVALID_RESPONSE without exposing output', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '{token:super-secret}', stderr: '' }),
    };
    let failure: unknown;
    try {
      await runProviderCommand(request, executor, (output) => JSON.parse(output) as unknown);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'INVALID_RESPONSE',
      details: { providerData: { github: { outputBytes: 20 } } },
    });
    expect(JSON.stringify(failure)).not.toContain('super-secret');
  });

  it('treats malformed output after successful mutation dispatch as an unknown non-retryable outcome', async () => {
    const executor: ProviderProcessExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '{token:super-secret}', stderr: '' }),
    };
    let failure: unknown;
    try {
      await runProviderCommand(
        { ...request, mutation: true },
        executor,
        (output) => JSON.parse(output) as unknown,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      remediation: 'Inspect remote state before attempting the mutation again.',
      details: { providerData: { github: { outputBytes: 20 } } },
    });
    expect(JSON.stringify(failure)).not.toContain('super-secret');
  });
});

describe('provider probes', () => {
  it.each([
    ['github', 'repository', 'github-work', ['gh', 'auth', 'status']],
    ['gitlab', 'repository', 'gitlab-work', ['glab', 'auth', 'status']],
    ['kanbanflow', 'issues', 'kanban-work', ['kf', 'issue', 'list', '--json']],
  ] as const)(
    'performs a route-bound read-only %s probe',
    async (providerId, role, route, argv) => {
      const execute = vi.fn(async () => ({
        exitCode: 0,
        stdout: providerId === 'kanbanflow' ? '[]' : '',
        stderr: 'token=secret',
      }));
      await expect(
        probeProvider({ providerId, role, route, cwd: 'C:/repo' }, { execute }),
      ).resolves.toEqual({ status: 'ready' });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ argv, route, cwd: 'C:/repo' }),
      );
    },
  );

  it('reports missing executables without exposing process details', async () => {
    const execute = async (): Promise<never> => {
      throw Object.assign(new Error('C:/secret/gh token=value'), { code: 'ENOENT' });
    };
    const result = await probeProvider(
      { providerId: 'github', role: 'repository', route: 'work' },
      { execute },
    );
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'EXECUTABLE_MISSING', retryable: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/C:\/secret|token=value/u);
  });

  it('reports authentication exits as redacted non-retryable errors', async () => {
    const execute = vi.fn(async () => ({
      exitCode: 1,
      stdout: 'token=secret',
      stderr: 'C:/private',
      failure: 'auth' as const,
    }));
    const result = await probeProvider(
      { providerId: 'gitlab', role: 'repository', route: 'isolated-route' },
      { execute },
    );
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'AUTH_FAILURE', retryable: false },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ route: 'isolated-route' }));
    expect(JSON.stringify(result)).not.toMatch(/secret|private/u);
  });

  it('keeps providers without a native probe unsupported', async () => {
    const execute = vi.fn();
    await expect(
      probeProvider({ providerId: 'generic', role: 'repository' }, { execute }),
    ).resolves.toEqual({ status: 'unsupported' });
    expect(execute).not.toHaveBeenCalled();
  });
});
