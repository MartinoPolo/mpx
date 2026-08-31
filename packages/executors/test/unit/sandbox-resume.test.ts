import { describe, expect, it, vi } from 'vitest';
import {
  SandboxLifecycle,
  createSandboxResumeStateV1,
  decideSandboxResume,
  parseSbxListV1,
  planF2SandboxSessionResume,
} from '../../src/index.js';
import { createF2ProofReportV1, createSandboxPlanV1, f2Sha256 } from '@mpx/runtime-contracts';
const h = (c: string) => c.repeat(64);
const expected = {
  sandboxName: 'mpx-pi-work-abc',
  appNamespace: 'mpx-pi-work',
  launchKey: h('a'),
  planKey: h('b'),
  runtimeInventorySha256: h('c'),
  workspaceIdentitySha256: h('d'),
  branchIdentitySha256: h('e'),
  attestationSha256: h('f'),
};
const observed = {
  sandboxName: expected.sandboxName,
  appNamespace: expected.appNamespace,
  status: 'running' as const,
  launchKey: expected.launchKey,
  planKey: expected.planKey,
  runtimeInventorySha256: expected.runtimeInventorySha256,
  workerSha256: h('1'),
  projectionSha256: h('2'),
  mountsSha256: h('3'),
  networkSha256: h('4'),
  portsSha256: h('5'),
  accountEnrollmentSha256: h('6'),
  identitySha256: h('7'),
  workspaceIdentitySha256: expected.workspaceIdentitySha256,
  branchIdentitySha256: expected.branchIdentitySha256,
  attestationSha256: expected.attestationSha256,
};
const verification = {
  workerSha256: h('1'),
  projectionSha256: h('2'),
  mountsSha256: h('3'),
  networkSha256: h('4'),
  portsSha256: h('5'),
  accountEnrollmentSha256: h('6'),
  identitySha256: h('7'),
};
describe('sandbox resume and recreation', () => {
  it('persists only launch-neutral sandbox resume authority', () => {
    expect(Object.keys(createSandboxResumeStateV1(expected)).sort()).toEqual(
      [
        'appNamespace',
        'attestationSha256',
        'branchIdentitySha256',
        'launchKey',
        'planKey',
        'runtimeInventorySha256',
        'sandboxName',
        'workspaceIdentitySha256',
      ].sort(),
    );
  });
  it('attaches only after exact ls, worker, projection, mount, network, port, account, and identity verification', () => {
    expect(
      decideSandboxResume(createSandboxResumeStateV1(expected), observed, verification),
    ).toEqual({ action: 'attach', reasons: [] });
    for (const key of Object.keys(verification) as (keyof typeof verification)[]) {
      expect(
        decideSandboxResume(
          createSandboxResumeStateV1(expected),
          { ...observed, [key]: h('9') },
          verification,
        ),
      ).toMatchObject({ action: 'recreate', reasons: [expect.stringContaining(key)] });
    }
  });
  it('rejects malicious or foreign sbx ls data', () => {
    expect(() =>
      parseSbxListV1(JSON.stringify([{ ...observed, sandboxName: '../foreign' }])),
    ).toThrow();
    expect(() => parseSbxListV1(JSON.stringify([{ ...observed, extra: 'patch-me' }]))).toThrow();
  });
  it('recreates rather than patching mismatch and cleans failed/cancelled creation', async () => {
    const calls: string[] = [];
    const lifecycle = new SandboxLifecycle({
      list: async () => [observed],
      attach: async () => {
        calls.push('attach');
        return { name: observed.sandboxName };
      },
      destroy: async (name) => {
        calls.push(`destroy:${name}`);
      },
      create: async (_state, signal) => {
        calls.push('create');
        if (signal?.aborted) {
          throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
        }
        throw new Error('crash');
      },
    });
    await expect(
      lifecycle.resumeOrRecreate(createSandboxResumeStateV1(expected), {
        ...verification,
        portsSha256: h('9'),
      }),
    ).rejects.toThrow('crash');
    expect(calls).toEqual([
      `destroy:${expected.sandboxName}`,
      'create',
      `destroy:${expected.sandboxName}`,
    ]);
    expect(calls).not.toContain('patch');
  });
  it('cleans a partially created sandbox when cancellation interrupts creation', async () => {
    const controller = new AbortController(),
      destroy = vi.fn(async () => {});
    const lifecycle = new SandboxLifecycle({
      list: async () => [],
      attach: vi.fn(),
      destroy,
      create: async () => {
        controller.abort();
        throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });
      },
    });
    await expect(
      lifecycle.resumeOrRecreate(
        createSandboxResumeStateV1(expected),
        verification,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(destroy).toHaveBeenCalledWith(expected.sandboxName);
  });
  it('treats a stale stopped sandbox PID as recreation', () => {
    expect(
      decideSandboxResume(
        createSandboxResumeStateV1(expected),
        { ...observed, status: 'stopped' },
        verification,
      ),
    ).toMatchObject({ action: 'recreate', reasons: [expect.stringContaining('status')] });
  });
  it('treats daemon restart/orphan absence as recreation', async () => {
    const create = vi.fn(async () => ({ name: expected.sandboxName }));
    const lifecycle = new SandboxLifecycle({
      list: async () => [],
      attach: vi.fn(),
      destroy: vi.fn(),
      create,
    });
    await lifecycle.resumeOrRecreate(createSandboxResumeStateV1(expected), verification);
    expect(create).toHaveBeenCalledOnce();
  });
  it('admits Docker attach only with matching persisted F2 plan, proof, inventory, attestation, and identity', () => {
    const plan = createSandboxPlanV1({
      runtime: 'pi',
      sbxPinSha256: h('8'),
      runtimeToolInventorySha256: expected.runtimeInventorySha256,
      executorEvidenceSha256: h('9'),
      networkPolicy: 'deny-by-default',
      workspaceReference: 'repo/worktree',
    });
    const attestation = {
      schemaVersion: 1 as const,
      planKey: plan.planKey,
      sbxPinSha256: plan.sbxPinSha256,
      runtimeToolInventorySha256: plan.runtimeToolInventorySha256,
      executorEvidenceSha256: plan.executorEvidenceSha256,
      diagnosticsSha256: h('0'),
      outcome: 'pass' as const,
    };
    const state = { ...expected, planKey: plan.planKey, attestationSha256: f2Sha256(attestation) };
    const entry = { ...observed, ...state };
    const report = createF2ProofReportV1({
      planKey: plan.planKey,
      sbxPinSha256: plan.sbxPinSha256,
      runtimeToolInventorySha256: plan.runtimeToolInventorySha256,
      executorEvidenceSha256: plan.executorEvidenceSha256,
      attestationSha256: state.attestationSha256,
      verdict: 'pass',
    });
    const input = {
      executor: 'docker' as const,
      launchKey: state.launchKey,
      persistedState: state,
      observed: entry,
      verification,
      plan,
      attestation,
      proofReport: report,
    };
    expect(planF2SandboxSessionResume(input)).toMatchObject({ admitted: true, action: 'attach' });
    expect(
      planF2SandboxSessionResume({
        ...input,
        verification: { ...verification, identitySha256: h('a') },
      }),
    ).toMatchObject({
      admitted: false,
      code: 'F2_ADMISSION_DENIED',
      recreate: { required: true, reasons: [expect.stringContaining('identitySha256')] },
    });
    expect(planF2SandboxSessionResume({ ...input, executor: 'host' })).toMatchObject({
      admitted: false,
      hostFallback: false,
      recreate: { required: true },
    });
  });
});
