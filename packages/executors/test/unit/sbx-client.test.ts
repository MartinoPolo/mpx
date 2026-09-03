import { describe, expect, it, vi } from 'vitest';
import {
  diagnoseSbx,
  parseSbxDaemonStatus,
  type BoundedProcessRunner,
  type ProcessResult,
  type SbxFailureCode,
} from '../../src/index.js';

const executable = 'C:/trusted/sbx.exe';
const pin = { version: '0.39.0', buildCommit: 'def8cb0523a77e757bdd6ef52b459fe374f3783e' };
const help =
  'Available Commands:\n create x\n daemon x\n diagnose x\n exec x\n ls x\n policy x\n ports x\n rm x\n run x\n version x\n';
const auth = (status: 'pass' | 'fail') =>
  JSON.stringify({
    version: '1.0',
    checks: [{ name: 'Authentication', status, message: 'state', detail: '', hint: '' }],
    summary: { pass: status === 'pass' ? 1 : 0, warn: 0, fail: status === 'fail' ? 1 : 0, skip: 0 },
  });
const ok = (stdout: string): ProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  truncated: false,
});
describe('parseSbxDaemonStatus', () => {
  it('accepts the optional bounded logs field emitted by standalone sbx v0.39', () => {
    expect(
      parseSbxDaemonStatus(
        '{"status":"running","socket":"pipe","logs":"C:/Users/alice/.docker/sbx/daemon.log"}',
      ),
    ).toEqual({
      status: 'running',
      socket: 'pipe',
      logs: 'C:/Users/alice/.docker/sbx/daemon.log',
    });
  });

  it('continues to reject unknown fields', () => {
    expect(() =>
      parseSbxDaemonStatus('{"status":"running","socket":"pipe","surprise":true}'),
    ).toThrow();
  });

  it('rejects a malformed logs field', () => {
    expect(() => parseSbxDaemonStatus('{"status":"running","socket":"pipe","logs":42}')).toThrow();
  });

  it('rejects an unbounded logs field', () => {
    expect(() =>
      parseSbxDaemonStatus(
        JSON.stringify({ status: 'running', socket: 'pipe', logs: 'x'.repeat(513) }),
      ),
    ).toThrow();
  });

  it.each([
    'line one\nline two',
    'line one\rline two',
    'line one\0line two',
    'line one\u0001line two',
  ])('rejects control characters in the logs field', (logs) => {
    expect(() =>
      parseSbxDaemonStatus(JSON.stringify({ status: 'running', socket: 'pipe', logs })),
    ).toThrow();
  });
});

const defaults: Readonly<Record<string, ProcessResult>> = {
  version: ok(`sbx version: v${pin.version} ${pin.buildCommit}\n`),
  '--help': ok(help),
  'daemon status --json': ok(
    '{"status":"running","socket":"pipe","logs":"C:/Users/alice/.docker/sbx/daemon.log"}',
  ),
  'diagnose --output json': ok(auth('pass')),
  'policy ls --json': ok('{"default":"deny","rules":[]}'),
};

type Scenario = {
  name: string;
  command: string;
  result: ProcessResult | Error;
  expected: readonly SbxFailureCode[];
};
const scenarios: readonly Scenario[] = [
  {
    name: 'unsupported version',
    command: 'version',
    result: ok(`sbx version: v0.40.0 ${pin.buildCommit}\n`),
    expected: ['VERSION_UNSUPPORTED'],
  },
  {
    name: 'version build mismatch',
    command: 'version',
    result: ok('sbx version: v0.39.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'),
    expected: ['BUILD_MISMATCH'],
  },
  {
    name: 'legacy-only command surface',
    command: '--help',
    result: ok('Usage: docker sandbox run [OPTIONS]\n'),
    expected: ['LEGACY_ONLY'],
  },
  {
    name: 'authentication unavailable',
    command: 'diagnose --output json',
    result: ok(auth('fail')),
    expected: ['AUTH_UNAVAILABLE'],
  },
  {
    name: 'stopped daemon',
    command: 'daemon status --json',
    result: ok('{"status":"stopped","socket":"pipe"}'),
    expected: ['DAEMON_STOPPED'],
  },
  {
    name: 'unreachable daemon',
    command: 'daemon status --json',
    result: new Error('daemon pipe unavailable'),
    expected: ['UNREACHABLE'],
  },
  {
    name: 'client and daemon mismatch',
    command: 'daemon status --json',
    result: ok(
      '{"status":"running","socket":"pipe","clientVersion":"0.39.0","daemonVersion":"0.38.0"}',
    ),
    expected: ['CLIENT_DAEMON_MISMATCH'],
  },
  {
    name: 'global policy uninitialized',
    command: 'policy ls --json',
    result: { exitCode: 1, stdout: '', stderr: 'not initialized', truncated: false },
    expected: ['SBX_GLOBAL_POLICY_UNINITIALIZED'],
  },
];

describe('diagnoseSbx failure classification', () => {
  it.each(scenarios)(
    'independently classifies $name without mutating sbx or invoking Docker Desktop',
    async (scenario) => {
      const runner: BoundedProcessRunner = {
        run: vi.fn(async (request) => {
          const command = request.argv.join(' ');
          expect(request.executable).toBe(executable);
          expect(request.shell).toBe(false);
          expect([
            'version',
            '--help',
            'daemon status --json',
            'diagnose --output json',
            'policy ls --json',
          ]).toContain(command);
          expect(request.argv).not.toEqual(
            expect.arrayContaining(['start', 'stop', 'reset', 'init', 'create', 'run', 'rm']),
          );
          if (command === scenario.command) {
            if (scenario.result instanceof Error) {
              throw scenario.result;
            }
            return scenario.result;
          }
          const result = defaults[command];
          if (!result) {
            throw new Error(`missing default result for ${command}`);
          }
          return result;
        }),
      };

      const result = await diagnoseSbx({ executable, cwd: 'C:/offline-fixture', runner, pin });

      expect(result).toMatchObject({
        available: true,
        failureCodes: scenario.expected,
        readOnly: true,
      });
      expect(runner.run).toHaveBeenCalledTimes(5);
    },
  );
});
