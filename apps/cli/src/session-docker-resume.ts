import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256Canonical } from '@mpx/core';
import { f2Sha256, parseF2ProofReportV1, parseSandboxAttestationV1 } from '@mpx/runtime-contracts';
import {
  SBX_V0_39_0_PIN,
  createSandboxResumeStateV1,
  decideSandboxResume,
  parseSbxListV1,
  type F2SandboxSessionResumeAdmission,
  type SandboxLaunchPlanV1,
  type SandboxResumeVerification,
  type SbxListEntryV1,
} from '@mpx/executors';
import type { ResumePlanV1 } from '@mpx/sessions';

interface ResumeAuthorityV1 {
  readonly schemaVersion: 1;
  readonly state: Parameters<typeof createSandboxResumeStateV1>[0];
  readonly plan: SandboxLaunchPlanV1;
  readonly attestation: Parameters<typeof parseSandboxAttestationV1>[0];
  readonly verification: SandboxResumeVerification;
}
export interface ProductionResumeAdmissionDependencies {
  list(appNamespace: string, signal?: AbortSignal): Promise<readonly SbxListEntryV1[]>;
}
const SHA = /^[a-f0-9]{64}$/u;
const verificationKeys = [
  'workerSha256',
  'projectionSha256',
  'mountsSha256',
  'networkSha256',
  'portsSha256',
  'accountEnrollmentSha256',
  'identitySha256',
] as const;
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
function canonical(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}
async function boundedJson(file: string, root?: string): Promise<unknown> {
  if (!path.isAbsolute(file)) {
    throw new Error('path');
  }
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65_536) {
    throw new Error('shape');
  }
  const resolved = await realpath(file);
  if (root && !within(await realpath(root), resolved)) {
    throw new Error('escape');
  }
  return JSON.parse(await readFile(resolved, 'utf8'));
}
function expectedVerification(
  plan: ResumePlanV1,
  proofPlan: Pick<SandboxLaunchPlanV1, 'planKey' | 'workspaceSource'>,
): SandboxResumeVerification {
  return Object.freeze({
    workerSha256: sha256Canonical({ planKey: proofPlan.planKey, runtime: plan.runtime }),
    projectionSha256: sha256Canonical({
      artifactKey: plan.launch.artifactKey,
      manifestKey: plan.launch.manifestKey,
    }),
    mountsSha256: sha256Canonical({
      workspaceReference: proofPlan.workspaceSource,
      cwd: canonical(plan.cwd),
    }),
    networkSha256: sha256Canonical({ networkPolicy: plan.launch.networkPolicy }),
    portsSha256: sha256Canonical([]),
    accountEnrollmentSha256: sha256Canonical({ nativeBindingRef: plan.nativeBindingRef }),
    identitySha256: sha256Canonical({ identity: plan.identity, runtime: plan.runtime }),
  });
}
function denial(reasons: readonly string[]): F2SandboxSessionResumeAdmission {
  return Object.freeze({
    admitted: false,
    code: 'F2_ADMISSION_DENIED',
    hostFallback: false,
    recreate: Object.freeze({ required: true, reasons: Object.freeze([...reasons]) }),
  });
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
function defaultDependencies(
  environment: NodeJS.ProcessEnv,
  operationCwd: string,
  stateRoot: string,
): ProductionResumeAdmissionDependencies {
  return {
    list: async (appNamespace, signal) => {
      const executable = envValue(environment, 'MPX_SBX_EXECUTABLE');
      if (!executable || !path.isAbsolute(executable)) {
        throw new Error('sbx unavailable');
      }
      const stat = await lstat(executable),
        resolved = await realpath(executable);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        within(await realpath(operationCwd), resolved) ||
        within(await realpath(stateRoot), resolved) ||
        (await sha256File(resolved)) !== SBX_V0_39_0_PIN.windowsBinarySha256
      ) {
        throw new Error('untrusted sbx');
      }
      const result = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = execFile(
          resolved,
          ['--app-name', appNamespace, 'ls', '--json'],
          {
            cwd: operationCwd,
            env: Object.fromEntries(
              [
                'SYSTEMROOT',
                'WINDIR',
                'LOCALAPPDATA',
                'APPDATA',
                'USERPROFILE',
                'TEMP',
                'TMP',
              ].flatMap((name) =>
                environment[name] === undefined ? [] : [[name, environment[name]]],
              ),
            ),
            timeout: 30_000,
            maxBuffer: 65_536,
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(error) : resolve({ stdout })),
        );
        signal?.addEventListener('abort', () => child.kill(), { once: true });
      });
      return parseSbxListV1(result.stdout);
    },
  };
}
/** Production Docker resume admission. Local authority is fully validated before the read-only sbx inventory probe. */
export function createProductionSessionDockerResumeAdmission(
  environment: NodeJS.ProcessEnv,
  dependencies?: ProductionResumeAdmissionDependencies,
): (plan: ResumePlanV1) => Promise<F2SandboxSessionResumeAdmission> {
  return async (plan) => {
    if (
      !plan ||
      typeof plan !== 'object' ||
      !plan.launch ||
      typeof plan.launch !== 'object' ||
      plan.launch.executor?.kind !== 'docker' ||
      typeof plan.cwd !== 'string' ||
      typeof plan.launch.launchKey !== 'string'
    ) {
      return denial(['executor or resume plan: invalid']);
    }
    const localAppData = envValue(environment, 'LOCALAPPDATA');
    if (!localAppData || !path.isAbsolute(localAppData) || !path.isAbsolute(plan.cwd)) {
      return denial(['proof: absent']);
    }
    const stateRoot = path.join(localAppData, 'mpx'),
      authorityFile =
        envValue(environment, 'MPX_F2_RESUME_AUTHORITY_FILE') ??
        path.join(
          stateRoot,
          'sandbox-resume',
          sha256Canonical(plan.launch.launchKey),
          'authority.json',
        );
    try {
      const raw = await boundedJson(authorityFile, stateRoot);
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'attestation,plan,schemaVersion,state,verification' ||
        (raw as { schemaVersion?: unknown }).schemaVersion !== 1
      ) {
        throw new Error('authority');
      }
      const authority = raw as ResumeAuthorityV1,
        state = createSandboxResumeStateV1(authority.state),
        proofPlan = authority.plan,
        attestation = parseSandboxAttestationV1(authority.attestation);
      if (
        !proofPlan ||
        typeof proofPlan !== 'object' ||
        Object.keys(proofPlan).sort().join(',') !==
          'appName,appNamespace,credentialProofRequirements,environment,gitOwnership,mode,mounts,networkPolicy,planKey,runtimeToolInventorySha256,sbxArgv,schemaVersion,vmScan,workspaceSource' ||
        proofPlan.schemaVersion !== 1 ||
        !SHA.test(proofPlan.planKey) ||
        sha256Canonical(
          Object.fromEntries(Object.entries(proofPlan).filter(([key]) => key !== 'planKey')),
        ) !== proofPlan.planKey
      ) {
        throw new Error('plan');
      }
      const expectedCwd = canonical(plan.cwd),
        home = proofPlan.environment.HOME;
      if (
        proofPlan.appNamespace !== state.appNamespace ||
        proofPlan.appName !== state.sandboxName ||
        !proofPlan.appNamespace.startsWith(`mpx-${plan.runtime}-`) ||
        proofPlan.mode !== plan.launch.workspace ||
        canonical(proofPlan.workspaceSource) !== expectedCwd ||
        typeof home !== 'string' ||
        !within(canonical(stateRoot), canonical(home)) ||
        proofPlan.mounts.some((mount) => canonical(mount.source) !== expectedCwd) ||
        state.launchKey !== plan.launch.launchKey ||
        state.planKey !== proofPlan.planKey ||
        state.runtimeInventorySha256 !== proofPlan.runtimeToolInventorySha256 ||
        state.workspaceIdentitySha256 !== sha256Canonical(expectedCwd) ||
        state.branchIdentitySha256 !==
          sha256Canonical({
            repositoryId: plan.repositoryId,
            projectId: plan.projectId,
            workspace: plan.launch.workspace,
          })
      ) {
        throw new Error('foreign authority');
      }
      const expected = expectedVerification(plan, proofPlan);
      if (
        Object.keys(authority.verification as object)
          .sort()
          .join(',') !== [...verificationKeys].sort().join(',') ||
        verificationKeys.some(
          (key) =>
            !SHA.test(authority.verification[key]) || authority.verification[key] !== expected[key],
        )
      ) {
        throw new Error('identity authority');
      }
      const explicit = envValue(environment, 'MPX_F2_PROOF_REPORT_FILE'),
        proofRoot = envValue(environment, 'MPX_F2_PROOF_ROOT'),
        proofFile =
          explicit ??
          (proofRoot && path.isAbsolute(proofRoot)
            ? path.join(proofRoot, `${proofPlan.planKey}.json`)
            : undefined);
      if (!proofFile) {
        throw new Error('proof absent');
      }
      const report = parseF2ProofReportV1(await boundedJson(proofFile)),
        attestationSha256 = f2Sha256(attestation);
      if (
        attestation.outcome !== 'pass' ||
        attestation.planKey !== proofPlan.planKey ||
        attestation.runtimeToolInventorySha256 !== proofPlan.runtimeToolInventorySha256 ||
        state.attestationSha256 !== attestationSha256 ||
        report.verdict !== 'pass' ||
        report.planKey !== proofPlan.planKey ||
        report.runtimeToolInventorySha256 !== proofPlan.runtimeToolInventorySha256 ||
        report.attestationSha256 !== attestationSha256 ||
        report.sbxPinSha256 !== attestation.sbxPinSha256 ||
        report.executorEvidenceSha256 !== attestation.executorEvidenceSha256
      ) {
        throw new Error('proof mismatch');
      }
      const entries = await (
        dependencies ?? defaultDependencies(environment, plan.cwd, stateRoot)
      ).list(state.appNamespace);
      const observed = entries.find((entry) => entry.sandboxName === state.sandboxName),
        decision = decideSandboxResume(state, observed, expected);
      if (decision.action === 'attach') {
        return Object.freeze({ admitted: true, action: 'attach', sandboxName: state.sandboxName });
      }
      return Object.freeze({
        admitted: true,
        action: 'recreate',
        sandboxName: state.sandboxName,
        hostFallback: false,
        recreate: Object.freeze({ required: true, reasons: decision.reasons }),
      });
    } catch {
      return denial(['proof: malformed, absent, foreign, or cross-root']);
    }
  };
}
