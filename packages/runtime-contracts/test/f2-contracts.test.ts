import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createF2ProofReportV1,
  createF2ProofReportV2,
  createSandboxPlanV1,
  createSbxLaunchPlanExportV1,
  parseF2ProofReportV2,
  parseSbxLaunchPlanExportDocumentV1,
  parseSbxLaunchPlanExportV1,
  validateF2ProofReportV2,
  parseRemoteToolRequestV1,
  parseSandboxPlanV1,
  parseSbxPinV1,
  validateF2ProofReportV1,
  type F2PolicyProfileV1,
  type F2ProofDecisionV2,
} from '../src/index.js';

const h = (character: string) => character.repeat(64);
const pin = {
  schemaVersion: 1,
  product: 'docker-sbx-standalone',
  version: '0.39.0',
  buildCommit: 'def8cb0523a77e757bdd6ef52b459fe374f3783e',
  releaseCommit: 'bdfd32bd69bb084959b5f4779310bff21d95bb62',
  contribReviewCommit: 'cc502cd9b689ccbcade7f80de2c2660dae03d6aa',
  windowsBinarySha256: 'b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf',
  reviewedArtifactSha256: { license: h('a'), features: h('b'), commands: h('c') },
  rejectedIntegrations: ['contrib-pi-kit', 'legacy-docker-sandbox'],
} as const;

describe('Phase F2 proof contracts', () => {
  it('parses the standalone sbx pin and rejects legacy integration substitutions', () => {
    expect(parseSbxPinV1(pin)).toEqual(pin);
    expect(() => parseSbxPinV1({ ...pin, product: 'legacy-docker-sandbox' })).toThrow(
      /SBX_PIN_INVALID/u,
    );
    expect(() =>
      parseSbxPinV1({ ...pin, rejectedIntegrations: ['legacy-docker-sandbox'] }),
    ).toThrow(/SBX_PIN_INVALID/u);
  });

  it('rejects unknown, oversized, and privacy-bearing fields at proof boundaries', () => {
    expect(() =>
      parseRemoteToolRequestV1({
        schemaVersion: 1,
        requestId: 'r',
        toolPath: 'mcp/chrome/call',
        inputSha256: h('a'),
        prompt: 'steal me',
      }),
    ).toThrow(/UNKNOWN_FIELD/u);
    expect(() =>
      parseRemoteToolRequestV1({
        schemaVersion: 1,
        requestId: 'r',
        toolPath: `mcp/${'x'.repeat(300)}`,
        inputSha256: h('a'),
      }),
    ).toThrow(/INVALID_CONTRACT/u);
    expect(() =>
      parseSandboxPlanV1({
        schemaVersion: 1,
        planKey: h('a'),
        runtime: 'pi',
        sbxPinSha256: h('b'),
        runtimeToolInventorySha256: h('c'),
        executorEvidenceSha256: h('d'),
        networkPolicy: 'deny-by-default',
        workspaceReference: 'C:/Users/alice/project',
      }),
    ).toThrow(/PRIVATE_DATA/u);
  });

  it('publishes closed JSON schemas for every v1 proof contract', async () => {
    const schema = JSON.parse(
      await readFile(
        fileURLToPath(new URL('../schemas/f2-proof-contracts-v1.schema.json', import.meta.url)),
        'utf8',
      ),
    );
    const names = [
      'SbxPinV1',
      'SbxDiagnosticsV1',
      'SandboxPlanV1',
      'SandboxAttestationV1',
      'RemoteToolRequestV1',
      'RemoteToolResultV1',
      'SandboxResumeTokenV1',
      'BuiltInClaudeIdentityEvidenceV1',
      'BuiltInClaudeEvidenceV1',
      'F2ProofReportV1',
    ];
    expect(names.every((name) => schema.$defs[name].additionalProperties === false)).toBe(true);
  });

  it('invalidates proof whenever runtime tool inventory drifts', () => {
    const plan = createSandboxPlanV1({
      runtime: 'pi',
      sbxPinSha256: h('a'),
      runtimeToolInventorySha256: h('b'),
      executorEvidenceSha256: h('c'),
      networkPolicy: 'deny-by-default',
      workspaceReference: 'worktree',
    });
    const report = createF2ProofReportV1({
      planKey: plan.planKey,
      sbxPinSha256: h('a'),
      runtimeToolInventorySha256: h('b'),
      executorEvidenceSha256: h('c'),
      attestationSha256: h('d'),
      verdict: 'pass',
    });
    expect(
      validateF2ProofReportV1(report, {
        runtimeToolInventorySha256: h('b'),
        executorEvidenceSha256: h('c'),
      }).valid,
    ).toBe(true);
    expect(
      validateF2ProofReportV1(report, {
        runtimeToolInventorySha256: h('e'),
        executorEvidenceSha256: h('c'),
      }),
    ).toMatchObject({ valid: false, diagnostics: [{ code: 'RUNTIME_TOOL_INVENTORY_DRIFT' }] });
  });

  it('represents an open default with allow probes and forbids claimed deny evidence', () => {
    const input: Parameters<typeof createSbxLaunchPlanExportV1>[0] = {
      launchKey: h('1'),
      descriptorSha256: h('2'),
      runtime: 'pi' as const,
      identity: { name: 'personal', domain: 'personal' as const },
      artifact: { manifestKey: h('3'), artifactKey: h('4'), fileMapHash: h('5') },
      evidence: {
        sbxPinSha256: h('6'),
        runtimeToolInventorySha256: h('7'),
        executorEvidenceSha256: h('8'),
      },
      sandbox: {
        planKey: h('9'),
        profile: 'open',
        proofSandboxName: 'mpx-proof-999999999999',
        createArgv: ['create', '--name', 'mpx-pi-personal-123', 'shell', '.'],
      },
      policyMatrix: [
        {
          profile: 'open',
          default: 'allow' as const,
          targets: [{ target: 'example.com:443', decision: 'allow' as const }],
        },
      ],
    };
    expect(createSbxLaunchPlanExportV1(input).policyMatrix[0]).toEqual(input.policyMatrix[0]);
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...input,
        policyMatrix: [
          {
            profile: 'open',
            default: 'allow',
            targets: [{ target: 'blocked.invalid:443', decision: 'deny' }],
          },
        ],
      } as never),
    ).toThrow(/POLICY_EVIDENCE_INVALID/u);
  });

  it('strictly binds a canonical production sandbox export without private paths or auth argv', () => {
    const matrix: readonly F2PolicyProfileV1[] = [
      {
        profile: 'implementation',
        default: 'deny' as const,
        targets: [{ target: 'blocked.invalid:443', decision: 'deny' as const }],
      },
    ];
    const exportPlan = createSbxLaunchPlanExportV1({
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
        createArgv: ['create', '--name', 'mpx-pi-work-123', 'shell', '.'],
      },
      policyMatrix: matrix,
    });
    expect(parseSbxLaunchPlanExportV1(exportPlan).exportKey).toBe(exportPlan.exportKey);
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...exportPlan,
        sandbox: { ...exportPlan.sandbox, proofSandboxName: 'mpx-proof-aaaaaaaaaaaa' },
      }),
    ).toThrow(/INVALID_CONTRACT/u);
    expect(exportPlan.sandbox.profile).toBe('implementation');
    expect(exportPlan.sandbox.createArgv).not.toContain('--profile');
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...exportPlan,
        sandbox: {
          ...exportPlan.sandbox,
          createArgv: [...exportPlan.sandbox.createArgv, '--profile', 'implementation'],
        },
      }),
    ).toThrow(/ARGV_UNSAFE/u);
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...exportPlan,
        sandbox: {
          ...exportPlan.sandbox,
          createArgv: [...exportPlan.sandbox.createArgv, '--env', 'ANTHROPIC_API_KEY=x'],
        },
      }),
    ).toThrow(/ARGV_UNSAFE|PRIVATE_DATA/u);
    expect(() => parseSbxLaunchPlanExportV1({ ...exportPlan, hostRoot: 'C:/private' })).toThrow(
      /UNKNOWN_FIELD/u,
    );
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...exportPlan,
        policyMatrix: [{ profile: 'minimal', default: 'deny', targets: matrix[0]!.targets }],
      } as never),
    ).toThrow(/POLICY_EVIDENCE_INVALID/u);
    expect(() =>
      createSbxLaunchPlanExportV1({
        ...exportPlan,
        policyMatrix: [
          ...matrix,
          { profile: 'minimal', default: 'deny', targets: matrix[0]!.targets },
        ],
      } as never),
    ).toThrow(/POLICY_EVIDENCE_INVALID/u);
  });

  it('unwraps only the exact warning-free CLI success envelope for a plan export', () => {
    const matrix: readonly F2PolicyProfileV1[] = [
      {
        profile: 'implementation',
        default: 'deny' as const,
        targets: [{ target: 'blocked.invalid:443', decision: 'deny' as const }],
      },
    ];
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
        createArgv: ['create', '--name', 'mpx-pi-work-123', 'shell', '.'],
      },
      policyMatrix: matrix,
    });
    const envelope = { apiVersion: 1, ok: true, data: plan, warnings: [] };
    expect(parseSbxLaunchPlanExportDocumentV1(plan)).toEqual(plan);
    expect(parseSbxLaunchPlanExportDocumentV1(envelope)).toEqual(plan);
    for (const invalid of [
      { ...envelope, ok: false, error: { code: 'FAILED' } },
      { ...envelope, warnings: ['review'] },
      { ...envelope, extra: true },
      { ...envelope, data: { wrong: true } },
      { ...envelope, data: envelope },
    ]) {
      expect(() => parseSbxLaunchPlanExportDocumentV1(invalid)).toThrow();
    }
  });

  it('requires exact V2 export binding and complete bounded policy decisions', () => {
    const policyMatrix: readonly F2PolicyProfileV1[] = [
      {
        profile: 'implementation',
        default: 'deny' as const,
        targets: [{ target: 'blocked.invalid:443', decision: 'deny' as const }],
      },
    ];
    const plan = createSbxLaunchPlanExportV1({
      launchKey: h('1'),
      descriptorSha256: h('2'),
      runtime: 'claude',
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
        createArgv: ['create', '--name', 'mpx-claude-work-123', 'claude', '.'],
      },
      policyMatrix,
    });
    const decisions: F2ProofDecisionV2[] = policyMatrix.flatMap(({ profile, targets }) =>
      targets.map(({ target, decision }) => ({ profile, target, decision, count: 1 })),
    );
    const report = createF2ProofReportV2({
      planExportKey: plan.exportKey,
      launchKey: plan.launchKey,
      descriptorSha256: plan.descriptorSha256,
      runtime: plan.runtime,
      identity: plan.identity,
      artifact: plan.artifact,
      evidence: plan.evidence,
      sandbox: plan.sandbox,
      policyMatrix: plan.policyMatrix,
      decisions,
      builtInClaudeEvidence: null,
      verdict: 'pass',
    });
    expect(validateF2ProofReportV2(report, plan).valid).toBe(true);
    expect(() =>
      parseF2ProofReportV2({ ...report, decisions: decisions.slice(1), reportKey: h('f') }),
    ).toThrow(/POLICY_EVIDENCE_INVALID/u);
    expect(() =>
      parseF2ProofReportV2({
        ...report,
        decisions: [{ ...decisions[0]!, count: 2 }],
        reportKey: h('f'),
      }),
    ).toThrow(/POLICY_EVIDENCE_INVALID/u);
    expect(validateF2ProofReportV2({ ...report, planExportKey: h('f') } as never, plan).valid).toBe(
      false,
    );
  });

  it('binds independently captured built-in Claude evidence for both identities into the report key', () => {
    const builtInClaudeEvidence = {
      source: 'signed-fixture' as const,
      identities: [
        {
          identity: 'personal' as const,
          appNamespace: 'mpx-claude-personal',
          enrollmentEvidenceSha256: h('1'),
          isolationEvidenceSha256: h('2'),
          oppositeIdentityDenialEvidenceSha256: h('3'),
          captureSignatureSha256: h('4'),
        },
        {
          identity: 'work' as const,
          appNamespace: 'mpx-claude-work',
          enrollmentEvidenceSha256: h('5'),
          isolationEvidenceSha256: h('6'),
          oppositeIdentityDenialEvidenceSha256: h('7'),
          captureSignatureSha256: h('8'),
        },
      ] as const,
    };
    const report = createF2ProofReportV1({
      planKey: h('a'),
      sbxPinSha256: h('b'),
      runtimeToolInventorySha256: h('c'),
      executorEvidenceSha256: h('d'),
      attestationSha256: h('e'),
      builtInClaudeEvidence,
      verdict: 'pass',
    });
    expect(report.builtInClaudeEvidence).toEqual(builtInClaudeEvidence);
    expect(() =>
      createF2ProofReportV1({
        ...report,
        builtInClaudeEvidence: {
          ...builtInClaudeEvidence,
          identities: [builtInClaudeEvidence.identities[0], builtInClaudeEvidence.identities[0]],
        } as never,
      }),
    ).toThrow(/identities/iu);
  });
});
