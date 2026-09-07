import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { MpxError } from '@mpx/core';
import type { PowerShellRunner, SocketBinder } from '../../src/index.js';
import { WindowsPortPlatformAdapter, WindowsProcessCapabilities } from '../../src/index.js';

const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: 'sensitive stderr', exitCode });
const runner = (...responses: Array<ReturnType<typeof result>>): PowerShellRunner => ({
  run: async () => responses.shift() ?? result(''),
});

describe('Windows process batch inspection', () => {
  it('uses one bounded CIM snapshot for unique requested PIDs and rescans on every call', async () => {
    const startedAt = '2025-01-01T00:00:00.000Z';
    const run = vi.fn(async (_script: string) =>
      result(JSON.stringify([{ ProcessId: 42, StartedAt: startedAt }])),
    );
    const capabilities = new WindowsProcessCapabilities({ runner: { run } });
    expect(await capabilities.inspectMany([42, 43, 42])).toEqual(
      new Map([[42, { pid: 42, startFingerprint: startedAt }]]),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Get-CimInstance Win32_Process -Property ProcessId,CreationDate'),
      { PidsJson: '[42,43]' },
      { timeoutMs: 10_000 },
    );
    const script = run.mock.calls[0]![0];
    expect(script.match(/Get-CimInstance/gu)).toHaveLength(1);
    expect(script).toContain('ConvertTo-Json -InputObject $items');
    await capabilities.inspectMany([42]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    '',
    'null',
    '{}',
    '{',
    '[{"ProcessId":42}]',
    '[{"ProcessId":"42","StartedAt":"2025-01-01T00:00:00.000Z"}]',
    '[{"ProcessId":42,"StartedAt":"not-a-date"}]',
    '[{"ProcessId":42,"StartedAt":"2025-02-31T00:00:00.000Z"}]',
    '[{"ProcessId":43,"StartedAt":"2025-01-01T00:00:00.000Z"}]',
    '[{"ProcessId":42,"StartedAt":"2025-01-01T00:00:00.000Z"},{"ProcessId":42,"StartedAt":"2025-01-01T00:00:00.000Z"}]',
  ])('rejects malformed or incomplete batch output: %s', async (stdout) => {
    await expect(
      new WindowsProcessCapabilities({ runner: runner(result(stdout)) }).inspectMany([42]),
    ).rejects.toMatchObject({ code: 'WINDOWS_POWERSHELL_MALFORMED' });
    expect(
      await new WindowsProcessCapabilities({ runner: runner(result(stdout)) })
        .asProcessInspector()
        .inspectMany([42]),
    ).toEqual(new Map([[42, { status: 'unknown' }]]));
  });

  it('accepts only a successful explicit empty array as an empty snapshot', async () => {
    expect(
      await new WindowsProcessCapabilities({ runner: runner(result('[]')) }).inspectMany([42]),
    ).toEqual(new Map());
    await expect(
      new WindowsProcessCapabilities({ runner: runner(result('[]', 1)) }).inspectMany([42]),
    ).rejects.toMatchObject({ code: 'WINDOWS_POWERSHELL_FAILED' });
  });

  it('does not spawn for empty, invalid, or oversized requests', async () => {
    const run = vi.fn();
    const capabilities = new WindowsProcessCapabilities({ runner: { run } });
    expect(await capabilities.inspectMany([])).toEqual(new Map());
    for (const pids of [
      [0],
      [-1],
      [1.5],
      [Number.NaN],
      [2_147_483_648],
      Array.from(
        { length: WindowsProcessCapabilities.inspectionBatchLimit + 1 },
        (_, index) => index + 1,
      ),
    ]) {
      await expect(capabilities.inspectMany(pids)).rejects.toMatchObject({
        code: 'PROCESS_FINGERPRINT_INVALID',
      });
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Windows discovery process inspector', () => {
  it('exposes fresh bounded batches with exact identities and explicit absence for unique PIDs', async () => {
    const startedAt = '2025-01-01T00:00:00.000Z';
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(JSON.stringify([{ ProcessId: 42, StartedAt: startedAt }])))
      .mockResolvedValueOnce(result('[]'));
    const inspector = new WindowsProcessCapabilities({ runner: { run } }).asProcessInspector();
    const { inspectMany } = inspector;
    expect(await inspectMany([42, 43, 42])).toEqual(
      new Map([
        [42, { status: 'present', pid: 42, startFingerprint: startedAt }],
        [43, { status: 'absent' }],
      ]),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Get-CimInstance Win32_Process -Property ProcessId,CreationDate'),
      { PidsJson: '[42,43]' },
      { timeoutMs: 10_000 },
    );
    expect(await inspectMany([42])).toEqual(new Map([[42, { status: 'absent' }]]));
    expect(run).toHaveBeenCalledTimes(2);
    expect(await inspectMany([])).toEqual(new Map());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['malformed', 'failed', 'throwing'])(
    'chunks unique PIDs sequentially and preserves other batches when one is %s',
    async (failure) => {
      const limit = WindowsProcessCapabilities.inspectionBatchLimit;
      const pids = Array.from({ length: limit * 2 + 1 }, (_, index) => index + 1);
      const startedAt = '2025-01-01T00:00:00.000Z';
      const batches: number[][] = [];
      let active = 0;
      let maximumActive = 0;
      const run = vi.fn<PowerShellRunner['run']>(async (_script, parameters) => {
        const batch = JSON.parse(parameters!.PidsJson!) as number[];
        batches.push(batch);
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        if (batch[0] === limit + 1) {
          if (failure === 'throwing') {
            throw new Error('native query failed');
          }
          return failure === 'malformed' ? result('{') : result('[]', 1);
        }
        return result(JSON.stringify([{ ProcessId: batch[0], StartedAt: startedAt }]));
      });
      const inspector = new WindowsProcessCapabilities({ runner: { run } }).asProcessInspector();
      for (let scan = 0; scan < 2; scan++) {
        const inspections = await inspector.inspectMany([...pids, ...pids]);
        expect(inspections.size).toBe(pids.length);
        for (const pid of pids) {
          expect(inspections.get(pid)).toEqual(
            pid > limit && pid <= limit * 2
              ? { status: 'unknown' }
              : pid === 1 || pid === limit * 2 + 1
                ? { status: 'present', pid, startFingerprint: startedAt }
                : { status: 'absent' },
          );
        }
        expect(run).toHaveBeenCalledTimes((scan + 1) * Math.ceil(pids.length / limit));
      }
      expect(maximumActive).toBe(1);
      expect(batches.every((batch) => batch.length <= limit)).toBe(true);
      expect(batches.flat()).toEqual([...pids, ...pids]);
    },
  );

  it('reports failed and throwing native batches as unknown, never absent', async () => {
    for (const run of [
      vi.fn().mockResolvedValue(result('[]', 1)),
      vi.fn().mockRejectedValue(new Error('timeout')),
    ]) {
      const inspector = new WindowsProcessCapabilities({ runner: { run } }).asProcessInspector();
      expect(await inspector.inspectMany([42, 43, 42])).toEqual(
        new Map([
          [42, { status: 'unknown' }],
          [43, { status: 'unknown' }],
        ]),
      );
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the legacy single-process adapter compatible and bound to its capabilities', async () => {
    const startedAt = '2025-01-01T00:00:00.000Z';
    const capabilities = new WindowsProcessCapabilities({
      runner: runner(
        result(JSON.stringify({ ProcessId: 42, StartedAt: startedAt })),
        result('null'),
        result('malformed'),
        result('[]', 1),
      ),
    });
    const { inspect } = capabilities.asProcessInspector();
    expect(await inspect(42)).toEqual({ pid: 42, startFingerprint: startedAt });
    expect(await inspect(42)).toBeNull();
    expect(await inspect(42)).toBeNull();
    expect(await inspect(42)).toBeNull();
  });
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
