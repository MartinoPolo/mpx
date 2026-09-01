import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  createF2ProofReportV1,
  createF2ProofReportV2,
  createSbxLaunchPlanExportV1,
} from '@mpx/runtime-contracts';
import { buildF2ProofPolicyMatrix, SBX_V0_39_0_PIN } from '@mpx/executors';
import {
  createProductionSbxExecutionAdapter,
  diagnoseConfiguredF2Proof,
  loadProductionSbxProofSources,
  planProductionSbxExecution,
} from '../../src/node/sbx-execution.js';

const h = (value: string) => value.repeat(64).slice(0, 64);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

it('loads all F2 evidence from a copied immutable release after the source checkout is unavailable', async () => {
  const release = await mkdtemp(path.join(tmpdir(), 'mpx-installed-release-')),
    bin = path.join(release, 'bin'),
    evidence = path.join(release, 'evidence');
  await Promise.all([mkdir(bin), mkdir(evidence)]);
  const executor = Buffer.from('installed executor evidence'),
    inventory = {
      runtimeToolInventorySha256: h('1'),
      executorEvidenceBindingSha256: sha(executor),
    };
  await Promise.all([
    writeFile(path.join(bin, 'mpx.mjs'), '// copied release bundle'),
    writeFile(path.join(evidence, 'executor-evidence.ts'), executor),
    writeFile(path.join(evidence, 'runtime-tool-inventory.json'), JSON.stringify(inventory)),
    writeFile(path.join(evidence, 'sbx-pin.json'), 'installed sbx pin'),
  ]);
  await expect(
    loadProductionSbxProofSources({}, pathToFileURL(path.join(bin, 'mpx.mjs')).href),
  ).resolves.toEqual({
    sbxPinSha256: sha('installed sbx pin'),
    runtimeToolInventorySha256: h('1'),
    executorEvidenceSha256: sha(executor),
  });
});

it('diagnoses only strict V2 proof bound to the configured canonical plan export', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-f2-diagnose-')),
    release = path.join(root, 'release'),
    evidence = path.join(release, 'evidence');
  await mkdir(evidence, { recursive: true });
  const executor = Buffer.from('diagnostic executor'),
    sources = {
      sbxPinSha256: sha('diagnostic pin'),
      runtimeToolInventorySha256: h('7'),
      executorEvidenceSha256: sha(executor),
    };
  await Promise.all([
    writeFile(path.join(evidence, 'sbx-pin.json'), 'diagnostic pin'),
    writeFile(path.join(evidence, 'executor-evidence.ts'), executor),
    writeFile(
      path.join(evidence, 'runtime-tool-inventory.json'),
      JSON.stringify({
        runtimeToolInventorySha256: sources.runtimeToolInventorySha256,
        executorEvidenceBindingSha256: sources.executorEvidenceSha256,
      }),
    ),
  ]);
  const matrix = buildF2ProofPolicyMatrix('implementation'),
    plan = createSbxLaunchPlanExportV1({
      launchKey: h('1'),
      descriptorSha256: h('2'),
      runtime: 'pi',
      identity: { name: 'work', domain: 'work' },
      artifact: { manifestKey: h('3'), artifactKey: h('4'), fileMapHash: h('5') },
      evidence: sources,
      sandbox: {
        planKey: h('6'),
        profile: 'implementation',
        proofSandboxName: 'mpx-proof-666666666666',
        createArgv: ['create', '--name', 'reviewed', 'shell', '.'],
      },
      policyMatrix: matrix,
    }),
    decisions = matrix.flatMap((profile) =>
      profile.targets.map((target) => ({ profile: profile.profile, ...target, count: 1 })),
    ),
    report = createF2ProofReportV2({
      ...plan,
      planExportKey: plan.exportKey,
      decisions,
      builtInClaudeEvidence: null,
      verdict: 'pass',
    }),
    planFile = path.join(root, 'plan.json'),
    reportFile = path.join(root, 'report.json'),
    environment = {
      MPX_RELEASE_ROOT: release,
      MPX_F2_PLAN_EXPORT_FILE: planFile,
      MPX_F2_PROOF_REPORT_FILE: reportFile,
    };
  await Promise.all([
    writeFile(planFile, JSON.stringify(plan)),
    writeFile(reportFile, JSON.stringify(report)),
  ]);
  await expect(diagnoseConfiguredF2Proof(environment)).resolves.toEqual([]);
  await writeFile(planFile, JSON.stringify({ apiVersion: 1, ok: true, data: plan, warnings: [] }));
  await expect(diagnoseConfiguredF2Proof(environment)).resolves.toEqual([]);
  await writeFile(
    reportFile,
    JSON.stringify({ apiVersion: 1, ok: true, data: report, warnings: [] }),
  );
  await expect(diagnoseConfiguredF2Proof(environment)).resolves.toContain('F2_PROOF_INVALID');
  await writeFile(
    reportFile,
    JSON.stringify(
      createF2ProofReportV1({
        planKey: plan.sandbox.planKey,
        ...sources,
        attestationSha256: h('a'),
        verdict: 'pass',
      }),
    ),
  );
  await expect(diagnoseConfiguredF2Proof(environment)).resolves.toContain('F2_PROOF_V2_REQUIRED');
  await writeFile(reportFile, JSON.stringify({ ...report, planExportKey: h('f') }));
  await expect(diagnoseConfiguredF2Proof(environment)).resolves.toContain('F2_PROOF_INVALID');
});

it('admits a strict CLI plan-export envelope at the production file boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-sbx-envelope-')),
    cwd = path.join(root, 'repo'),
    stateRoot = path.join(root, 'state'),
    planFile = path.join(root, 'plan.json');
  await Promise.all([mkdir(cwd), mkdir(stateRoot)]);
  const plan = createSbxLaunchPlanExportV1({
    launchKey: h('1'),
    descriptorSha256: h('2'),
    runtime: 'pi',
    identity: { name: 'work', domain: 'work' },
    artifact: { manifestKey: h('3'), artifactKey: h('4'), fileMapHash: h('5') },
    evidence: {
      sbxPinSha256: h('6'),
      runtimeToolInventorySha256: h('7'),
      executorEvidenceSha256: h('8'),
    },
    sandbox: {
      planKey: h('9'),
      profile: 'implementation',
      proofSandboxName: 'mpx-proof-999999999999',
      createArgv: ['create', '--name', 'reviewed', 'shell', '.'],
    },
    policyMatrix: buildF2ProofPolicyMatrix('implementation'),
  });
  await writeFile(planFile, JSON.stringify({ apiVersion: 1, ok: true, data: plan, warnings: [] }));
  const input = {
    environment: {
      MPX_F2_PLAN_EXPORT_FILE: planFile,
      MPX_RELEASE_ROOT: path.join(root, 'missing-release'),
    },
    cwd,
    stateRoot,
    runtime: 'pi' as const,
    identity: { name: 'work', domain: 'work' as const },
    workspaceMode: 'clone' as const,
    worktreeRole: 'main' as const,
    workspaceRoot: cwd,
    gitCommonDir: path.join(cwd, '.git'),
    nativeRoots: [],
    credentialRoots: [],
    oppositeDomainRoots: [],
    network: { name: 'implementation', allow: ['api.openai.com:443'] },
    ports: [],
  };
  await expect(createProductionSbxExecutionAdapter(input)).rejects.toThrow(/ENOENT/u);
});

it('selects verified standalone sbx evidence and runs create, policy, worker bridge, attach, and awaited teardown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-sbx-cli-')),
    cwd = path.join(root, 'repo'),
    stateRoot = path.join(root, 'state'),
    executable = path.join(root, 'apps', 'sbx.exe');
  await Promise.all([mkdir(cwd), mkdir(stateRoot), mkdir(path.dirname(executable))]);
  await writeFile(executable, 'fake');
  const sources = {
    sbxPinSha256: h('b'),
    runtimeToolInventorySha256: h('1'),
    executorEvidenceSha256: h('e'),
  };
  const input = {
    environment: { MPX_SBX_EXECUTABLE: executable },
    cwd,
    stateRoot,
    runtime: 'pi' as const,
    identity: { name: 'work', domain: 'work' as const },
    workspaceMode: 'clone' as const,
    worktreeRole: 'main' as const,
    workspaceRoot: cwd,
    gitCommonDir: path.join(cwd, '.git'),
    nativeRoots: [path.join(root, 'native')],
    credentialRoots: [path.join(root, 'credentials')],
    oppositeDomainRoots: [path.join(root, 'personal')],
    network: { name: 'implementation', allow: ['api.openai.com:443'] },
    ports: [4310],
    sources,
  };
  const planned = planProductionSbxExecution(input),
    proof = createF2ProofReportV1({
      planKey: planned.plan.planKey,
      ...sources,
      attestationSha256: h('a'),
      verdict: 'pass',
    });
  const calls: string[][] = [];
  const adapter = await createProductionSbxExecutionAdapter(
    { ...input, proof },
    {
      inspectExecutable: async (file) => ({
        file: true,
        realpath: file,
        sha256: SBX_V0_39_0_PIN.windowsBinarySha256,
      }),
      diagnostics: async () => ({ status: 'pass', digest: h('d') }),
      run: async (request) => {
        calls.push([...request.argv]);
        const sandbox = request.argv[request.argv.indexOf('--sandbox') + 1],
          target = request.argv[request.argv.indexOf('--sandbox') + 2];
        if (request.argv[0] === 'policy' && request.argv[1] === 'check') {
          const allowed = target !== 'blocked.invalid:443';
          return {
            exitCode: allowed ? 0 : 1,
            stdout: JSON.stringify(
              allowed
                ? {
                    action: 'net:connect:tcp',
                    allowed: true,
                    context: `sandbox:${sandbox}`,
                    governance: { active: false },
                    resource_type: 'net:domain',
                    resource_value: target,
                    target,
                    type: 'network',
                  }
                : {
                    action: 'net:connect:tcp',
                    allowed: false,
                    resource_value: target,
                    type: 'network',
                    deny_kind: 'implicit',
                    reason: 'default deny',
                    rule: 'default',
                  },
            ),
            stderr: '',
            truncated: false,
          };
        }
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    },
  );
  expect(await adapter.verify()).toEqual({
    status: 'verified',
    verifier: 'standalone-sbx-live',
    evidenceDigest: proof.reportKey,
  });
  await adapter.execute({ executable: process.execPath, argv: [], cwd, environment: {} });
  expect(calls.map((call) => call[0])).toEqual([
    'policy',
    'create',
    'ports',
    'policy',
    'policy',
    'policy',
    'exec',
    'run',
    'rm',
  ]);
  expect(adapter.bridge).toEqual({
    endpoint: `sbx://${planned.plan.appName}/worker`,
    attestationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
});

it('denies stale proof without invoking sbx or falling back to host', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-sbx-stale-')),
    cwd = path.join(root, 'repo'),
    stateRoot = path.join(root, 'state'),
    executable = path.join(root, 'sbx.exe');
  await Promise.all([mkdir(cwd), mkdir(stateRoot), writeFile(executable, 'fake')]);
  const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }));
  const adapter = await createProductionSbxExecutionAdapter(
    {
      environment: { MPX_SBX_EXECUTABLE: executable },
      cwd,
      stateRoot,
      runtime: 'claude',
      identity: { name: 'work', domain: 'work' },
      workspaceMode: 'clone',
      worktreeRole: 'main',
      workspaceRoot: cwd,
      gitCommonDir: path.join(cwd, '.git'),
      nativeRoots: [],
      credentialRoots: [],
      oppositeDomainRoots: [],
      network: { name: 'deny-all', allow: [] },
      ports: [],
      sources: {
        sbxPinSha256: h('b'),
        runtimeToolInventorySha256: h('1'),
        executorEvidenceSha256: h('e'),
      },
      proof: createF2ProofReportV1({
        planKey: h('f'),
        sbxPinSha256: h('b'),
        runtimeToolInventorySha256: h('1'),
        executorEvidenceSha256: h('e'),
        attestationSha256: h('a'),
        verdict: 'pass',
      }),
    },
    {
      inspectExecutable: async (file) => ({
        file: true,
        realpath: file,
        sha256: SBX_V0_39_0_PIN.windowsBinarySha256,
      }),
      diagnostics: async () => ({ status: 'pass', digest: h('d') }),
      run,
    },
  );
  expect((await adapter.verify()).status).toBe('unverified');
  await expect(
    adapter.execute({ executable: process.execPath, argv: [], cwd, environment: {} }),
  ).rejects.toMatchObject({ code: 'EXECUTOR_GATE_UNVERIFIED' });
  expect(run).not.toHaveBeenCalled();
});
