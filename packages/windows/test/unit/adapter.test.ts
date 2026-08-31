import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { MpxError } from '@mpx/core';
import type { PowerShellRunner, SocketBinder } from '../../src/index.js';
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from '../../src/index.js';

const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: 'sensitive stderr', exitCode });
const runner = (...responses: Array<ReturnType<typeof result>>): PowerShellRunner => ({
  run: async () => responses.shift() ?? result(''),
});

describe('WindowsPortPlatformAdapter', () => {
  it('normalizes PowerShell null, single, and array listener output and sorts it', async () => {
    const adapter = new WindowsPortPlatformAdapter({
      runner: runner(
        result('null'),
        result(
          JSON.stringify({
            LocalPort: 5002,
            OwningProcess: 9,
            LocalAddress: '::1',
            Name: 'node',
            ExecutablePath: 'C:/node.exe',
            ProjectPath: 'C:/safe',
            StartedAt: '2025-01-01T00:00:00.000Z',
          }),
        ),
        result(
          JSON.stringify([
            { LocalPort: 5002, OwningProcess: 9 },
            { LocalPort: 5001, OwningProcess: 3 },
          ]),
        ),
      ),
    });
    expect(await adapter.inspectListeners()).toEqual([]);
    expect(await adapter.inspectListeners()).toEqual([
      {
        port: 5002,
        pid: 9,
        address: '::1',
        processName: 'node',
        executable: 'C:/node.exe',
        projectPath: 'C:/safe',
        startedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);
    expect(await adapter.inspectListeners()).toEqual([
      { port: 5001, pid: 3 },
      { port: 5002, pid: 9 },
    ]);
  });

  it('transports listener ports and kill fingerprints only through exact parameter maps', async () => {
    const calls: Array<{ script: string; parameters?: Readonly<Record<string, string>> }> = [];
    const capturing: PowerShellRunner = {
      run: async (script, parameters) => {
        calls.push(parameters === undefined ? { script } : { script, parameters });
        return calls.length === 1 ? result('[]') : result('{"status":"killed"}');
      },
    };
    const adapter = new WindowsPortPlatformAdapter({ runner: capturing });
    await adapter.inspectListeners([5001, 5002]);
    await adapter.killProcess({ pid: 42, startedAt: 'fingerprint-value' });
    const [inspectCall, killCall] = calls;
    if (!inspectCall || !killCall) {
      throw new Error('Expected inspect and kill PowerShell calls');
    }
    expect(inspectCall.parameters).toEqual({ PortsJson: '[5001,5002]' });
    expect(killCall.parameters).toEqual({ PidValue: '42', StartedAt: 'fingerprint-value' });
    expect(inspectCall.script).not.toContain('[5001,5002]');
    expect(killCall.script).not.toContain('fingerprint-value');
  });

  it.each([
    '{"LocalPort":5000,"LocalPort":5001,"OwningProcess":2}',
    '{"LocalPort":5000,"OwningProcess":2,"__proto__":{}}',
  ])('rejects duplicate and dangerous JSON keys', async (output) => {
    await expect(
      new WindowsPortPlatformAdapter({ runner: runner(result(output)) }).inspectListeners(),
    ).rejects.toMatchObject({ code: 'WINDOWS_POWERSHELL_MALFORMED' });
  });

  it('rejects malformed and nonzero PowerShell results as sanitized MpxError', async () => {
    for (const adapter of [
      new WindowsPortPlatformAdapter({ runner: runner(result('not-json')) }),
      new WindowsPortPlatformAdapter({ runner: runner(result('secret stdout', 7)) }),
    ]) {
      await expect(adapter.inspectListeners()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof MpxError &&
          !JSON.stringify(error.toPublic()).includes('secret') &&
          !JSON.stringify(error.toPublic()).includes('not-json'),
      );
    }
    await expect(
      new WindowsProcessCapabilities({ runner: runner(result('secret stdout', 7)) }).terminateTree({
        pid: 41,
        startFingerprint: 'birth-41',
      }),
    ).rejects.toMatchObject({ code: 'WINDOWS_POWERSHELL_FAILED' });
    await expect(
      new WindowsProcessCapabilities({
        runner: {
          run: async () => {
            throw new Error('boom');
          },
        },
      }).terminateTree({ pid: 41, startFingerprint: 'birth-41' }),
    ).rejects.toMatchObject({ code: 'WINDOWS_POWERSHELL_FAILED' });
  });

  it('returns JSON-safe allowlisted listener data without command lines or secrets', async () => {
    const secret = '--token super-secret';
    const adapter = new WindowsPortPlatformAdapter({
      runner: runner(
        result(
          JSON.stringify({
            LocalPort: 5000,
            OwningProcess: 2,
            Name: 'node',
            CommandLine: secret,
            Unexpected: secret,
          }),
        ),
      ),
    });
    const listeners = await adapter.inspectListeners();
    expect(JSON.stringify(listeners)).not.toContain(secret);
    expect(listeners).toEqual([{ port: 5000, pid: 2, processName: 'node' }]);
  });

  it('holds every loopback binding until release and cleans partial binds on failure', async () => {
    const released: string[] = [];
    const binder: SocketBinder = {
      bind: async (port, host) => {
        if (host === '::1') {
          throw new Error('unavailable');
        }
        return {
          release: async () => {
            released.push(`${host}:${port}`);
          },
        };
      },
    };
    const adapter = new WindowsPortPlatformAdapter({ runner: runner(), binder });
    await expect(adapter.holdAvailablePorts([5010])).rejects.toBeInstanceOf(MpxError);
    expect(released).toEqual(['127.0.0.1:5010']);
  });

  it('really holds and releases an IPv4/IPv6 loopback port', async () => {
    const adapter = new WindowsPortPlatformAdapter({ runner: runner() });
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) =>
      probe.listen({ host: '127.0.0.1', port: 0 }, resolve).once('error', reject),
    );
    const address = probe.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test port');
    }
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const hold = await adapter.holdAvailablePorts([port]);
    await expect(
      new Promise<void>((resolve, reject) =>
        net.createServer().listen({ host: '127.0.0.1', port }, resolve).once('error', reject),
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await hold.release();
    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) =>
      rebound.listen({ host: '127.0.0.1', port }, resolve).once('error', reject),
    );
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  it.runIf(process.platform === 'win32')(
    'inspects a real Windows loopback listener',
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) =>
        server.listen({ host: '127.0.0.1', port: 0 }, resolve).once('error', reject),
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('No test port');
        }
        const adapter = new WindowsPortPlatformAdapter();
        let listeners = await adapter.inspectListeners([address.port]);
        for (let attempt = 0; listeners.length === 0 && attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          listeners = await adapter.inspectListeners([address.port]);
        }
        expect(listeners).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ port: address.port, pid: process.pid }),
          ]),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000,
  );

  it('refuses termination when the fingerprint mismatches or disappears', async () => {
    for (const status of ['mismatch', 'missing'] as const) {
      const adapter = new WindowsPortPlatformAdapter({
        runner: runner(result(JSON.stringify({ status }))),
      });
      await expect(
        adapter.killProcess({ pid: 42, startedAt: '2025-01-01T00:00:00.000Z' }),
      ).rejects.toMatchObject({
        code: status === 'missing' ? 'PROCESS_DISAPPEARED' : 'PROCESS_FINGERPRINT_MISMATCH',
      });
    }
  });

  it('does not attempt descendant termination when the owned tree root is missing', async () => {
    let script = '';
    const capabilities = new WindowsProcessCapabilities({
      runner: {
        run: async (value) => {
          script = value;
          return result('{"status":"missing"}');
        },
      },
    });
    await expect(
      capabilities.terminateTree({ pid: 41, startFingerprint: 'birth-41' }),
    ).rejects.toMatchObject({ code: 'PROCESS_DISAPPEARED' });
    const rootGuard = script.indexOf('if ($null -eq $root)');
    const children = script.indexOf('$children = @{}');
    const stopProcess = script.indexOf('Stop-Process');
    expect(rootGuard).toBeGreaterThanOrEqual(0);
    expect(children).toBeGreaterThanOrEqual(0);
    expect(stopProcess).toBeGreaterThanOrEqual(0);
    expect(rootGuard).toBeLessThan(children);
    expect(rootGuard).toBeLessThan(stopProcess);
  });

  it('does not attempt descendant termination when the tree root fingerprint mismatches', async () => {
    let script = '';
    const capabilities = new WindowsProcessCapabilities({
      runner: {
        run: async (value) => {
          script = value;
          return result('{"status":"mismatch"}');
        },
      },
    });
    await expect(
      capabilities.terminateTree({ pid: 41, startFingerprint: 'birth-41' }),
    ).rejects.toMatchObject({ code: 'PROCESS_FINGERPRINT_MISMATCH' });
    const fingerprintGuard = script.indexOf('if ($actual -cne $StartedAt)');
    const children = script.indexOf('$children = @{}');
    const stopProcess = script.indexOf('Stop-Process');
    expect(fingerprintGuard).toBeGreaterThanOrEqual(0);
    expect(children).toBeGreaterThanOrEqual(0);
    expect(stopProcess).toBeGreaterThanOrEqual(0);
    expect(fingerprintGuard).toBeLessThan(children);
    expect(fingerprintGuard).toBeLessThan(stopProcess);
  });

  it('maps an unproven tree termination to structured unknown instead of success', async () => {
    const capabilities = new WindowsProcessCapabilities({
      runner: runner(result('{"status":"unknown","reason":"convergence-timeout"}')),
    });
    await expect(
      capabilities.terminateTree({ pid: 41, startFingerprint: 'birth-41' }),
    ).rejects.toMatchObject({ code: 'PROCESS_TERMINATION_UNKNOWN' });
  });

  it('stops the verified root before entering the bounded descendant convergence loop', async () => {
    let script = '';
    const capabilities = new WindowsProcessCapabilities({
      runner: {
        run: async (value) => {
          script = value;
          return result('{"status":"unknown"}');
        },
      },
    });
    await expect(
      capabilities.terminateTree({ pid: 41, startFingerprint: 'birth-41' }),
    ).rejects.toMatchObject({ code: 'PROCESS_TERMINATION_UNKNOWN' });
    const rootStop = script.indexOf('Stop-Process -Id $PidValue');
    const loop = script.indexOf('$consecutiveAbsent');
    const enumerate = script.indexOf(
      'Get-CimInstance Win32_Process -ErrorAction Stop',
      rootStop + 1,
    );
    expect(rootStop).toBeGreaterThanOrEqual(0);
    expect(loop).toBeGreaterThan(rootStop);
    expect(enumerate).toBeGreaterThan(rootStop);
    expect(script).toContain('$maxAttempts');
    expect(script).toContain('$order');
    expect(script).toContain('-Force');
  });

  it('terminates only a fingerprint-matched process tree through the narrow native adapter', async () => {
    const calls: Array<{ script: string; parameters?: Readonly<Record<string, string>> }> = [];
    const capabilities = new WindowsProcessCapabilities({
      runner: {
        run: async (script, parameters) => {
          calls.push(parameters === undefined ? { script } : { script, parameters });
          return calls.length === 1
            ? result('{"ProcessId":41,"StartedAt":"birth-41"}')
            : result('{"status":"killed","count":3}');
        },
      },
    });
    expect(await capabilities.inspect(41)).toEqual({ pid: 41, startFingerprint: 'birth-41' });
    await capabilities.terminateTree({ pid: 41, startFingerprint: 'birth-41' });
    const terminateCall = calls[1];
    if (!terminateCall) {
      throw new Error('Expected terminate PowerShell call');
    }
    expect(terminateCall.parameters).toEqual({ PidValue: '41', StartedAt: 'birth-41' });
    expect(terminateCall.script).toContain('ParentProcessId');
    expect(terminateCall.script).toContain('Get-CimInstance Win32_Process -Filter');
    expect(terminateCall.script).toContain('$rootCurrent');
    expect(terminateCall.script).toContain('-ErrorAction Stop');
    expect(terminateCall.script).not.toContain('SilentlyContinue');
    expect(terminateCall.script).not.toContain('taskkill');
  });
});
