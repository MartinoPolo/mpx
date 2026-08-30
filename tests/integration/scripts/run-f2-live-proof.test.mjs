import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  script = path.join(root, 'scripts', 'run-f2-live-proof.ps1'),
  fake = path.join(root, 'scripts', 'fake-sbx.mjs'),
  pin = 'b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf';
const profiles = {
  implementation: [
    'api.anthropic.com:443',
    'api.github.com:443',
    'api.openai.com:443',
    'github.com:443',
    'registry.npmjs.org:443',
  ],
};
const stable = (value) =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex'),
  hash = (value) => sha(stable(value));
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mpx-f2-proof-')),
    wrapper = path.join(dir, 'fake-sbx.cmd'),
    calls = path.join(dir, 'calls.jsonl'),
    state = path.join(dir, 'state.json'),
    harness = path.join(dir, 'harness.ps1');
  await writeFile(
    wrapper,
    `@echo off\r\nnode "${fake}" %*\r\nif errorlevel 1 exit /b 1\r\nexit /b 0\r\n`,
  );
  await writeFile(
    harness,
    `function global:Mock-GetFileHash { param([string]$LiteralPath,[string]$Algorithm) if ([IO.Path]::GetFullPath($LiteralPath) -eq [IO.Path]::GetFullPath($env:MPX_SBX_EXECUTABLE)) { [pscustomobject]@{Hash='${pin}'} } else { Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm } }; Set-Alias -Name Get-FileHash -Value Mock-GetFileHash -Scope Global; . '${script.replaceAll("'", "''")}' @args\n`,
  );
  const inventory = JSON.parse(
    await readFile(path.join(root, 'evidence', 'runtime-tool-inventory.json'), 'utf8'),
  );
  const tuple = {
    schemaVersion: 1,
    launchKey: '1'.repeat(64),
    descriptorSha256: '2'.repeat(64),
    runtime: 'pi',
    identity: { name: 'work', domain: 'work' },
    artifact: {
      manifestKey: '3'.repeat(64),
      artifactKey: '4'.repeat(64),
      fileMapHash: '5'.repeat(64),
    },
    evidence: {
      sbxPinSha256: sha(await readFile(path.join(root, 'evidence', 'sbx-pin.json'))),
      runtimeToolInventorySha256: inventory.runtimeToolInventorySha256,
      executorEvidenceSha256: sha(
        await readFile(path.join(root, 'evidence', 'executor-evidence.ts')),
      ),
    },
    sandbox: {
      planKey: '6'.repeat(64),
      profile: 'implementation',
      proofSandboxName: 'mpx-proof-666666666666',
      createArgv: ['create', '--name', 'reviewed-placeholder', '.', 'shell'],
    },
    policyMatrix: Object.entries(profiles).map(([profile, allow]) => ({
      profile,
      default: 'deny',
      targets: [
        ...allow.map((target) => ({ target, decision: 'allow' })),
        { target: 'blocked.invalid:443', decision: 'deny' },
      ].sort((a, b) => a.target.localeCompare(b.target)),
    })),
  };
  const plan = {
      schemaVersion: 1,
      exportKey: hash(tuple),
      ...Object.fromEntries(Object.entries(tuple).slice(1)),
    },
    planFile = path.join(dir, 'plan.json');
  await writeFile(planFile, JSON.stringify(plan));
  return { dir, wrapper, calls, state, harness, plan, planFile };
}
async function runProof(f, args = [], mode) {
  const environment = {
    ...process.env,
    MPX_SBX_EXECUTABLE: f.wrapper,
    MPX_FAKE_SBX_CALL_LOG: f.calls,
    MPX_FAKE_SBX_STATE: f.state,
    ...(mode ? { MPX_FAKE_SBX_MODE: mode } : {}),
  };
  try {
    return {
      ok: true,
      ...(await execute(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', f.harness, ...args],
        { cwd: root, env: environment, maxBuffer: 1024 * 1024 },
      )),
    };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}
async function calls(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}
const approved = (f) => [
  '-PlanFile',
  f.planFile,
  '-PlanExportKey',
  f.plan.exportKey,
  '-ConfirmLive',
  '-ConfirmPhrase',
  'RUN MPX F2 LIVE PROOF',
];

describe('run-f2-live-proof.ps1', () => {
  it.each([
    ['PlanKey only', (f) => ['-PlanKey', f.plan.sandbox.planKey], 'PLAN_EXPORT_REQUIRED'],
    [
      'missing PlanFile',
      (f) => [
        '-PlanExportKey',
        f.plan.exportKey,
        '-ConfirmLive',
        '-ConfirmPhrase',
        'RUN MPX F2 LIVE PROOF',
      ],
      'PLAN_EXPORT_REQUIRED',
    ],
    [
      'missing export key',
      (f) => ['-PlanFile', f.planFile, '-ConfirmLive', '-ConfirmPhrase', 'RUN MPX F2 LIVE PROOF'],
      'PLAN_EXPORT_REQUIRED',
    ],
    [
      'missing ConfirmLive',
      (f) => [
        '-PlanFile',
        f.planFile,
        '-PlanExportKey',
        f.plan.exportKey,
        '-ConfirmPhrase',
        'RUN MPX F2 LIVE PROOF',
      ],
      'LIVE_PROOF_CONFIRMATION_REQUIRED',
    ],
    [
      'wrong phrase',
      (f) => [
        '-PlanFile',
        f.planFile,
        '-PlanExportKey',
        f.plan.exportKey,
        '-ConfirmLive',
        '-ConfirmPhrase',
        'wrong',
      ],
      'LIVE_PROOF_CONFIRMATION_REQUIRED',
    ],
  ])('never invokes sbx for %s', async (_label, makeArgs, code) => {
    const f = await fixture(),
      result = await runProof(f, makeArgs(f));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(code);
    expect(await calls(f.calls)).toEqual([]);
  });

  it.each([
    ['malformed', (plan) => ({ ...plan, unexpected: true }), 'PLAN_EXPORT_INVALID'],
    [
      'unsafe',
      (plan) => ({ ...plan, identity: { ...plan.identity, name: 'token-secret' } }),
      'PLAN_EXPORT_PRIVATE',
    ],
    [
      'stale',
      (plan) => ({ ...plan, sandbox: { ...plan.sandbox, planKey: '7'.repeat(64) } }),
      'PLAN_EXPORT_INVALID',
    ],
    [
      'non-derived proof name',
      (plan) => {
        const changed = {
          ...plan,
          sandbox: { ...plan.sandbox, proofSandboxName: 'mpx-proof-aaaaaaaaaaaa' },
        };
        const { exportKey: _exportKey, ...tuple } = changed;
        return { ...changed, exportKey: hash(tuple) };
      },
      'PLAN_EXPORT_INVALID',
    ],
  ])('rejects %s exports before mutation', async (_label, mutate, code) => {
    const f = await fixture();
    f.plan = mutate(f.plan);
    await writeFile(f.planFile, JSON.stringify(f.plan));
    const result = await runProof(f, [
      '-PlanFile',
      f.planFile,
      '-PlanExportKey',
      f.plan.exportKey,
      '-ConfirmLive',
      '-ConfirmPhrase',
      'RUN MPX F2 LIVE PROOF',
    ]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(code);
    expect(await calls(f.calls)).toEqual([]);
  });

  it('accepts the exact stable CLI success envelope', async () => {
    const f = await fixture();
    await writeFile(
      f.planFile,
      JSON.stringify({ apiVersion: 1, ok: true, data: f.plan, warnings: [] }),
    );
    const result = await runProof(f, approved(f));
    expect(result.ok, result.stderr).toBe(true);
    expect((await calls(f.calls))[0]).toEqual(['policy', 'ls', '--json']);
  }, 20_000);

  it.each([
    [
      'error',
      (_plan) => ({
        apiVersion: 1,
        ok: false,
        error: { code: 'LAUNCH_FAILED', message: 'failed' },
        warnings: [],
      }),
    ],
    [
      'nonempty warnings',
      (plan) => ({ apiVersion: 1, ok: true, data: plan, warnings: ['review'] }),
    ],
    ['invalid warnings', (plan) => ({ apiVersion: 1, ok: true, data: plan, warnings: null })],
    ['extra field', (plan) => ({ apiVersion: 1, ok: true, data: plan, warnings: [], extra: true })],
    [
      'mismatched nested export',
      (plan) => ({
        apiVersion: 1,
        ok: true,
        data: { ...plan, exportKey: '0'.repeat(64) },
        warnings: [],
      }),
    ],
  ])('rejects a malformed CLI %s envelope before mutation', async (_label, envelope) => {
    const f = await fixture();
    await writeFile(f.planFile, JSON.stringify(envelope(f.plan)));
    const result = await runProof(f, approved(f));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('PLAN_EXPORT_');
    expect(await calls(f.calls)).toEqual([]);
  });

  it('rejects an unpinned fake sbx build with zero calls and no hash spoof', async () => {
    const f = await fixture(),
      environment = {
        ...process.env,
        MPX_SBX_EXECUTABLE: f.wrapper,
        MPX_FAKE_SBX_CALL_LOG: f.calls,
        MPX_FAKE_SBX_STATE: f.state,
      };
    let failure;
    try {
      await execute(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', script, ...approved(f)],
        { cwd: root, env: environment, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.stderr ?? '').toContain('SBX_BUILD_MISMATCH');
    expect(await calls(f.calls)).toEqual([]);
  });

  it.each([
    ['check-mismatch', 'POLICY_CHECK_MISMATCH'],
    ['check-unknown-field', 'POLICY_CHECK_MALFORMED'],
    ['check-private-field', 'POLICY_CHECK_MALFORMED'],
    ['check-wrong-action', 'POLICY_CHECK_MISMATCH'],
    ['check-wrong-context', 'POLICY_CHECK_MISMATCH'],
    ['check-wrong-target', 'POLICY_CHECK_MISMATCH'],
    ['check-wrong-resource-type', 'POLICY_CHECK_MISMATCH'],
    ['check-wrong-governance', 'POLICY_CHECK_MALFORMED'],
    ['check-wrong-type', 'POLICY_CHECK_MISMATCH'],
    ['check-wrong-resource', 'POLICY_CHECK_MISMATCH'],
  ])('rejects %s evidence and still cleans up', async (mode, code) => {
    const f = await fixture(),
      result = await runProof(f, approved(f), mode),
      seen = await calls(f.calls);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(code);
    expect(seen.at(-1)).toEqual(['rm', '--force', f.plan.sandbox.proofSandboxName]);
  });

  it('preserves the primary proof failure and appends teardown failure', async () => {
    const f = await fixture(),
      result = await runProof(f, approved(f), 'check-mismatch-rm-fail');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('POLICY_CHECK_MISMATCH');
    expect(result.stderr).toContain('SBX_TEARDOWN_FAILED');
  });

  it('times out a hung create without a false teardown attempt', async () => {
    const f = await fixture(),
      result = await runProof(f, [...approved(f), '-InvocationTimeoutSeconds', '1'], 'hang-create'),
      seen = await calls(f.calls);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('SBX_CREATE_TIMEOUT');
    expect(seen.at(-1)?.[0]).toBe('create');
    expect(seen.some((argv) => argv[0] === 'rm')).toBe(false);
  }, 10_000);

  it('proves open allow-all with one canonical allow probe and no scoped policy mutation or deny claim', async () => {
    const f = await fixture();
    const changed = {
      ...f.plan,
      sandbox: { ...f.plan.sandbox, profile: 'open' },
      policyMatrix: [
        {
          profile: 'open',
          default: 'allow',
          targets: [{ target: 'example.com:443', decision: 'allow' }],
        },
      ],
    };
    const { exportKey: _exportKey, ...tuple } = changed;
    f.plan = { ...changed, exportKey: hash(tuple) };
    await writeFile(f.planFile, JSON.stringify(f.plan));
    const result = await runProof(f, approved(f), 'open-policy'),
      seen = await calls(f.calls);
    expect(result.ok, result.stderr).toBe(true);
    expect(seen.some((argv) => argv[0] === 'policy' && ['allow', 'deny'].includes(argv[1]))).toBe(
      false,
    );
    expect(seen.filter((argv) => argv[0] === 'policy' && argv[1] === 'check')).toEqual([
      [
        'policy',
        'check',
        'network',
        '--sandbox',
        f.plan.sandbox.proofSandboxName,
        'example.com:443',
        '--json',
      ],
    ]);
    expect(JSON.parse(result.stdout).decisions).toEqual([
      { profile: 'open', target: 'example.com:443', decision: 'allow', count: 1 },
    ]);
  }, 20_000);

  it('uses only plan-derived argv and one evaluator check per selected-profile target, with no policy logs or check profile argv', async () => {
    const f = await fixture(),
      result = await runProof(f, approved(f)),
      seen = await calls(f.calls);
    expect(result.ok, result.stderr).toBe(true);
    expect(seen[0]).toEqual(['policy', 'ls', '--json']);
    const expectedCreate = [...f.plan.sandbox.createArgv];
    expectedCreate[2] = f.plan.sandbox.proofSandboxName;
    expect(seen[1]).toEqual(expectedCreate);
    expect(seen[2]).toEqual([
      'policy',
      'allow',
      'network',
      '--sandbox',
      f.plan.sandbox.proofSandboxName,
      ...profiles.implementation,
    ]);
    const expected = f.plan.policyMatrix[0].targets.map((target) => ({
        profile: f.plan.sandbox.profile,
        ...target,
      })),
      checks = seen.filter((argv) => argv[0] === 'policy' && argv[1] === 'check'),
      logs = seen.filter((argv) => argv[0] === 'policy' && argv[1] === 'log');
    expect(checks).toHaveLength(expected.length);
    expect(logs).toHaveLength(0);
    expected.forEach((entry, index) =>
      expect(checks[index]).toEqual([
        'policy',
        'check',
        'network',
        '--sandbox',
        f.plan.sandbox.proofSandboxName,
        entry.target,
        '--json',
      ]),
    );
    expect(seen.at(-1)).toEqual(['rm', '--force', f.plan.sandbox.proofSandboxName]);
    const report = JSON.parse(result.stdout.trim());
    expect(Object.keys(report)).toEqual([
      'schemaVersion',
      'reportKey',
      'planExportKey',
      'launchKey',
      'descriptorSha256',
      'runtime',
      'identity',
      'artifact',
      'evidence',
      'sandbox',
      'policyMatrix',
      'decisions',
      'builtInClaudeEvidence',
      'verdict',
    ]);
    expect(report).toMatchObject({
      schemaVersion: 2,
      planExportKey: f.plan.exportKey,
      runtime: 'pi',
      builtInClaudeEvidence: null,
      verdict: 'pass',
    });
    const { reportKey, ...reportTuple } = report;
    expect(reportKey).toBe(hash(reportTuple));
    expect(JSON.stringify(report)).not.toMatch(
      /(?:stdout|stderr|output|authorization|token|secret|credential|password|api[_-]?key|[A-Za-z]:[\\/]|\\\\Users\\|\/home\/)/iu,
    );
  }, 20_000);
});
