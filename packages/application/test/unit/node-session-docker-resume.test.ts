import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createF2ProofReportV1, f2Sha256 } from '@mpx/runtime-contracts';
import { buildSandboxPlanV1 } from '@mpx/executors';
import { sha256Canonical } from '@mpx/core';
import { createProductionSessionDockerResumeAdmission } from '../../src/node/session-docker-resume.js';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const h = (c: string) => c.repeat(64);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-resume-admission-'));
  roots.push(root);
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const plan = buildSandboxPlanV1({
    runtime: 'claude',
    identity: { name: 'work', domain: 'work' },
    workspaceMode: 'direct',
    worktreeRole: 'main',
    directCompatibility: true,
    workspaceRoot: cwd,
    stateRoot: path.join(root, 'mpx'),
    nativeRoots: [path.join(root, 'native')],
    credentialRoots: [],
    oppositeDomainRoots: [],
    dockerSocketPaths: ['//./pipe/docker_engine'],
    gitCommonDir: path.join(cwd, '.git'),
    runtimeToolInventorySha256: h('b'),
    network: { name: 'deny-all', allow: [] },
  });
  const attestation = {
    schemaVersion: 1 as const,
    planKey: plan.planKey,
    sbxPinSha256: h('a'),
    runtimeToolInventorySha256: plan.runtimeToolInventorySha256,
    executorEvidenceSha256: h('c'),
    diagnosticsSha256: h('e'),
    outcome: 'pass' as const,
  };
  const proof = createF2ProofReportV1({
    planKey: plan.planKey,
    sbxPinSha256: attestation.sbxPinSha256,
    runtimeToolInventorySha256: plan.runtimeToolInventorySha256,
    executorEvidenceSha256: attestation.executorEvidenceSha256,
    attestationSha256: f2Sha256(attestation),
    verdict: 'pass',
  });
  const resume = {
    schemaVersion: 1,
    newLaunchRequired: true,
    previousLaunch: { launchKey: h('1'), descriptorDigest: h('2') },
    recordId: 'record',
    runtimeQualifiedId: 'claude:session',
    runtime: 'claude',
    identity: { domain: 'work', name: 'work' },
    nativeBindingRef: 'binding',
    nativeSessionRef: { schemaVersion: 1, runtime: 'claude', id: 'session' },
    cwd,
    projectId: 'project',
    repositoryId: 'repository',
    launch: {
      launchKey: h('1'),
      descriptorDigest: h('2'),
      mode: 'interactive',
      skillPolicy: 'standard',
      contentScope: 'repo',
      executor: { kind: 'docker' },
      workspace: 'direct',
      networkPolicy: 'restricted',
      grants: [],
      artifactKey: h('3'),
      manifestKey: h('4'),
    },
    confirmationDigest: h('5'),
  } as const;
  const verification = {
    workerSha256: sha256Canonical({ planKey: plan.planKey, runtime: 'claude' }),
    projectionSha256: sha256Canonical({ artifactKey: h('3'), manifestKey: h('4') }),
    mountsSha256: sha256Canonical({
      workspaceReference: plan.workspaceSource,
      cwd: path.resolve(cwd).replaceAll('\\', '/').toLowerCase(),
    }),
    networkSha256: sha256Canonical({ networkPolicy: 'restricted' }),
    portsSha256: sha256Canonical([]),
    accountEnrollmentSha256: sha256Canonical({ nativeBindingRef: 'binding' }),
    identitySha256: sha256Canonical({
      identity: { domain: 'work', name: 'work' },
      runtime: 'claude',
    }),
  };
  const state = {
    sandboxName: plan.appName,
    appNamespace: plan.appNamespace,
    launchKey: h('1'),
    planKey: plan.planKey,
    runtimeInventorySha256: plan.runtimeToolInventorySha256,
    workspaceIdentitySha256: sha256Canonical(path.resolve(cwd).replaceAll('\\', '/').toLowerCase()),
    branchIdentitySha256: sha256Canonical({
      repositoryId: 'repository',
      projectId: 'project',
      workspace: 'direct',
    }),
    attestationSha256: f2Sha256(attestation),
  };
  const stateRoot = path.join(root, 'mpx');
  await mkdir(stateRoot);
  const authority = path.join(stateRoot, 'authority.json');
  await writeFile(
    authority,
    JSON.stringify({ schemaVersion: 1, state, plan, attestation, verification }),
  );
  const proofFile = path.join(stateRoot, 'proof.json');
  await writeFile(proofFile, JSON.stringify(proof));
  return {
    root,
    cwd,
    resume,
    state,
    verification,
    authority,
    proofFile,
    observed: { ...state, ...verification, status: 'running' as const },
  };
}
it('admits attach only for the exact persisted proof, plan, inventory, attestation, identity, and sbx inventory', async () => {
  const f = await fixture(),
    list = vi.fn(async () => [f.observed]);
  const admit = createProductionSessionDockerResumeAdmission(
    {
      LOCALAPPDATA: f.root,
      MPX_F2_PROOF_REPORT_FILE: f.proofFile,
      MPX_F2_RESUME_AUTHORITY_FILE: f.authority,
    },
    { list },
  );
  await expect(admit(f.resume as never)).resolves.toMatchObject({
    admitted: true,
    action: 'attach',
    sandboxName: f.state.sandboxName,
  });
  expect(list).toHaveBeenCalledOnce();
});
it('returns a typed Docker recreate admission for an absent or mismatched sandbox without host fallback', async () => {
  const f = await fixture(),
    admit = createProductionSessionDockerResumeAdmission(
      {
        LOCALAPPDATA: f.root,
        MPX_F2_PROOF_REPORT_FILE: f.proofFile,
        MPX_F2_RESUME_AUTHORITY_FILE: f.authority,
      },
      { list: async () => [{ ...f.observed, identitySha256: h('f') }] },
    );
  await expect(admit(f.resume as never)).resolves.toMatchObject({
    admitted: true,
    action: 'recreate',
    hostFallback: false,
    recreate: { required: true, reasons: [expect.stringContaining('identitySha256')] },
  });
});
it('rejects tampered or cross-root resume authority before querying sbx', async () => {
  const f = await fixture(),
    list = vi.fn(async () => [f.observed]);
  await writeFile(
    f.authority,
    JSON.stringify({
      schemaVersion: 1,
      state: { ...f.state, workspaceIdentitySha256: h('f') },
      plan: {},
      attestation: {},
      verification: f.verification,
    }),
  );
  const admit = createProductionSessionDockerResumeAdmission(
    {
      LOCALAPPDATA: f.root,
      MPX_F2_PROOF_REPORT_FILE: f.proofFile,
      MPX_F2_RESUME_AUTHORITY_FILE: f.authority,
    },
    { list },
  );
  await expect(admit(f.resume as never)).resolves.toMatchObject({
    admitted: false,
    hostFallback: false,
  });
  expect(list).not.toHaveBeenCalled();
});
