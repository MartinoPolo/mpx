import { describe, expect, it, vi } from 'vitest';
import { PiAuthAvailabilityProbe } from '../../src/node/pi-auth-availability.js';

describe('PiAuthAvailabilityProbe', () => {
  it('uses only the exact bounded OAuth availability protocol', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }),
      stderr: '',
    }));
    const probe = new PiAuthAvailabilityProbe({
      resolveTrustedExecutable: async () => ({
        executable: 'C:/trusted/node.exe',
        argvPrefix: ['C:/trusted/pi.js'],
      }),
      run,
      cwd: 'C:/outside',
      environment: { PATH: 'C:/trusted', pi_coding_agent_dir: 'C:/untrusted' },
    });
    await probe.verify('C:/accounts/work');
    expect(run).toHaveBeenCalledWith({
      executable: 'C:/trusted/node.exe',
      argv: [
        'C:/trusted/pi.js',
        'auth',
        'check',
        '--provider',
        'openai-codex',
        '--json',
        '--no-refresh',
      ],
      cwd: 'C:/outside',
      environment: { PATH: 'C:/trusted', PI_CODING_AGENT_DIR: 'C:/accounts/work' },
      timeoutMs: 15_000,
      maxOutputBytes: 16_384,
      shell: false,
    });
  });

  it('rejects a nonzero auth-check process exit', async () => {
    const probe = new PiAuthAvailabilityProbe({
      resolveTrustedExecutable: async () => ({ executable: 'C:/trusted/pi.exe', argvPrefix: [] }),
      run: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ status: 'ready', provider: 'openai-codex', authType: 'oauth' }),
        stderr: 'unavailable',
      }),
      cwd: 'C:/outside',
      environment: {},
    });
    await expect(probe.verify('C:/accounts/work')).rejects.toMatchObject({
      code: 'ACCOUNT_AUTH_UNAVAILABLE',
    });
  });

  it('rejects exact-shaped auth output that is not ready', async () => {
    const probe = new PiAuthAvailabilityProbe({
      resolveTrustedExecutable: async () => ({ executable: 'C:/trusted/pi.exe', argvPrefix: [] }),
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'unavailable',
          provider: 'openai-codex',
          authType: 'oauth',
        }),
        stderr: '',
      }),
      cwd: 'C:/outside',
      environment: {},
    });
    await expect(probe.verify('C:/accounts/work')).rejects.toMatchObject({
      code: 'ACCOUNT_AUTH_UNAVAILABLE',
    });
  });

  it('fails closed on malformed or secret-bearing output', async () => {
    for (const stdout of [
      'not-json',
      JSON.stringify({
        status: 'ready',
        provider: 'openai-codex',
        authType: 'oauth',
        token: 'secret',
      }),
    ]) {
      const probe = new PiAuthAvailabilityProbe({
        resolveTrustedExecutable: async () => ({ executable: 'C:/trusted/pi.exe', argvPrefix: [] }),
        run: async () => ({ exitCode: 0, stdout, stderr: '' }),
        cwd: 'C:/outside',
        environment: {},
      });
      await expect(probe.verify('C:/accounts/work')).rejects.toMatchObject({
        code: 'ACCOUNT_AUTH_UNAVAILABLE',
      });
    }
  });
});
