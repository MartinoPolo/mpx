import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import {
  parseF2ProofReportV1,
  parseF2ProofReportV2,
  parseSbxLaunchPlanExportV1,
  validateF2ProofReportV2,
  type F2ProofReportV1,
  type F2ProofReportV2,
  type SbxLaunchPlanExportV1,
} from '@mpx/runtime-contracts';
import {
  buildF2ProofPolicyMatrix,
  buildSandboxPlanV1,
  diagnoseSbx,
  resolveTrustedSbxExecutable,
  SBX_V0_39_0_PIN,
  StandaloneSbxExecutorAdapter,
  type BoundedProcessRunner,
  type ClaudeVmProjection,
  type ProcessResult,
  type StandaloneSbxRunRequest,
  type SandboxLaunchPlanV1,
  type SbxPolicyName,
} from '@mpx/executors';

export interface SbxProofSources {
  readonly sbxPinSha256: string;
  readonly runtimeToolInventorySha256: string;
  readonly executorEvidenceSha256: string;
}
export interface ProductionSbxExecutionInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stateRoot: string;
  readonly runtime: 'claude' | 'pi';
  readonly identity: { readonly name: string; readonly domain: 'personal' | 'work' };
  readonly workspaceMode: 'clone' | 'host-worktree' | 'direct';
  readonly worktreeRole: 'main' | 'linked';
  readonly workspaceRoot: string;
  readonly gitCommonDir: string;
  readonly nativeRoots: readonly string[];
  readonly credentialRoots: readonly string[];
  readonly oppositeDomainRoots: readonly string[];
  readonly network: { readonly name: string; readonly allow: readonly string[] };
  readonly ports: readonly number[];
  readonly directCompatibility?: boolean;
  readonly sources?: SbxProofSources;
  readonly proof?: F2ProofReportV1 | F2ProofReportV2;
  readonly planExport?: SbxLaunchPlanExportV1;
  /** Exact launch-bound bytes and Docker credential proof required for a new Claude VM. */
  readonly claudeLaunch?: { readonly projection: ClaudeVmProjection };
}
export interface SbxExecutionDependencies {
  inspectExecutable(file: string): Promise<{ file: boolean; realpath: string; sha256: string }>;
  diagnostics(
    executable: string,
    cwd: string,
  ): Promise<{ status: 'pass' | 'fail'; digest: string }>;
  run(request: StandaloneSbxRunRequest): Promise<ProcessResult>;
  readonly allowSignedFixtureEvidence?: boolean;
}
export type SbxExecutionAdapter = StandaloneSbxExecutorAdapter;
const SHA = /^[a-f0-9]{64}$/u;
function contained(root: string, relative: string): string {
  const candidate = path.resolve(root, ...relative.split('/')),
    rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Release evidence path escapes its immutable root.');
  }
  return candidate;
}
export function resolveProductionReleaseRoot(
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  const explicit = value(environment, 'MPX_RELEASE_ROOT');
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('MPX_RELEASE_ROOT must be absolute.');
    }
    return path.resolve(explicit);
  }
  const moduleFile = fileURLToPath(moduleUrl),
    directory = path.dirname(moduleFile);
  if (
    path.basename(moduleFile).toLowerCase() === 'mpx.mjs' &&
    path.basename(directory).toLowerCase() === 'bin'
  ) {
    return path.dirname(directory);
  }
  if (value(environment, 'MPX_DEV_MODE') === '1') {
    return path.resolve(directory, '../../..');
  }
  throw new Error('Immutable MPX release root is unavailable outside explicit development mode.');
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
export async function loadProductionSbxProofSources(
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): Promise<SbxProofSources> {
  const root = resolveProductionReleaseRoot(environment, moduleUrl),
    evidence = (name: string) => contained(root, `evidence/${name}`);
  const inventory = JSON.parse(await readFile(evidence('runtime-tool-inventory.json'), 'utf8')) as {
    runtimeToolInventorySha256?: unknown;
    executorEvidenceBindingSha256?: unknown;
  };
  if (
    typeof inventory.runtimeToolInventorySha256 !== 'string' ||
    typeof inventory.executorEvidenceBindingSha256 !== 'string' ||
    !SHA.test(inventory.runtimeToolInventorySha256) ||
    !SHA.test(inventory.executorEvidenceBindingSha256)
  ) {
    throw new Error('Packaged F2 inventory is invalid.');
  }
  const executorEvidenceSha256 = await sha256File(evidence('executor-evidence.ts'));
  if (executorEvidenceSha256 !== inventory.executorEvidenceBindingSha256) {
    throw new Error('Packaged executor evidence drifted.');
  }
  return {
    sbxPinSha256: await sha256File(evidence('sbx-pin.json')),
    runtimeToolInventorySha256: inventory.runtimeToolInventorySha256,
    executorEvidenceSha256,
  };
}
export function productionProofCreateArgv(plan: SandboxLaunchPlanV1): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < plan.sbxArgv.length; index++) {
    const value = plan.sbxArgv[index]!;
    if (value === '--env') {
      index++;
      continue;
    }
    result.push(value === plan.workspaceSource ? '.' : value);
  }
  return Object.freeze(result);
}
export function planProductionSbxExecution(
  input: ProductionSbxExecutionInput & { sources: SbxProofSources },
) {
  const plan = buildSandboxPlanV1({
    runtime: input.runtime,
    identity: input.identity,
    workspaceMode: input.workspaceMode,
    worktreeRole: input.worktreeRole,
    ...(input.directCompatibility ? { directCompatibility: true } : {}),
    workspaceRoot: input.workspaceRoot,
    stateRoot: input.stateRoot,
    nativeRoots: input.nativeRoots,
    credentialRoots: input.credentialRoots,
    oppositeDomainRoots: input.oppositeDomainRoots,
    dockerSocketPaths: ['//./pipe/docker_engine'],
    gitCommonDir: input.gitCommonDir,
    runtimeToolInventorySha256: input.sources.runtimeToolInventorySha256,
    network: input.network,
  });
  const bridge = Object.freeze({
    endpoint: `sbx://${plan.appName}/worker`,
    attestationSha256: sha256Canonical({
      schemaVersion: 1,
      kind: 'standalone-sbx-worker',
      planKey: plan.planKey,
      runtimeToolInventorySha256: plan.runtimeToolInventorySha256,
    } as JsonValue),
  });
  return Object.freeze({ plan, bridge });
}
function value(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
function candidates(environment: NodeJS.ProcessEnv): {
  candidates: string[];
  trustedRoots: string[];
} {
  const configured = value(environment, 'MPX_SBX_EXECUTABLE'),
    directories = (value(environment, 'PATH') ?? '').split(path.delimiter).filter(path.isAbsolute);
  return {
    candidates: [
      ...(configured ? [configured] : []),
      ...directories.map((directory) => path.join(directory, 'sbx.exe')),
    ],
    trustedRoots: [
      ...(configured && path.isAbsolute(configured) ? [path.dirname(configured)] : []),
      ...directories,
      ...[
        value(environment, 'MPX_APPS'),
        value(environment, 'LOCALAPPDATA') &&
          path.join(value(environment, 'LOCALAPPDATA')!, 'DockerSandboxes', 'bin'),
      ].filter((item): item is string => Boolean(item) && path.isAbsolute(item!)),
    ],
  };
}
const processEnvironment = (environment: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    ['SYSTEMROOT', 'WINDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP'].flatMap(
      (name) => (value(environment, name) === undefined ? [] : [[name, value(environment, name)!]]),
    ),
  );
function nodeRun(
  environment: NodeJS.ProcessEnv,
): (request: StandaloneSbxRunRequest) => Promise<ProcessResult> {
  return (request) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        request.executable,
        [...request.argv],
        {
          cwd: request.cwd,
          env: { ...processEnvironment(environment), ...request.environment },
          windowsHide: true,
          maxBuffer: 65_536,
          timeout: 120_000,
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            reject(error);
            return;
          }
          resolve({
            exitCode:
              typeof (error as { code?: unknown } | null)?.code === 'number'
                ? (error as { code: number }).code
                : 0,
            stdout,
            stderr,
            truncated: false,
          });
        },
      );
      request.signal?.addEventListener('abort', () => child.kill(), { once: true });
    });
}
function defaults(environment: NodeJS.ProcessEnv): SbxExecutionDependencies {
  const run = nodeRun(environment);
  return {
    inspectExecutable: async (file) => {
      const info = await lstat(file),
        canonical = await realpath(file);
      return {
        file: info.isFile() && !info.isSymbolicLink(),
        realpath: canonical,
        sha256: await sha256File(canonical),
      };
    },
    run,
    diagnostics: async (executable, cwd) => {
      const runner: BoundedProcessRunner = { run: (request) => run(request) };
      const result = await diagnoseSbx({ executable, cwd, runner, pin: SBX_V0_39_0_PIN });
      return {
        status: result.failureCodes.length === 0 ? 'pass' : 'fail',
        digest: sha256Canonical(result as unknown as JsonValue),
      };
    },
  };
}
async function boundedContractJson(file: string): Promise<unknown> {
  if (!path.isAbsolute(file)) {
    throw new Error('contract path must be absolute');
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 1024 * 1024) {
    throw new Error('contract file is unsafe');
  }
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function diagnoseConfiguredF2Proof(
  environment: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const reportFile = value(environment, 'MPX_F2_PROOF_REPORT_FILE');
  if (!reportFile) {
    return Object.freeze(['F2_PROOF_NOT_CONFIGURED']);
  }
  if (!path.isAbsolute(reportFile)) {
    return Object.freeze(['F2_PROOF_INVALID']);
  }
  let rawReport: unknown;
  try {
    rawReport = await boundedContractJson(reportFile);
  } catch {
    return Object.freeze(['F2_PROOF_INVALID']);
  }
  if ((rawReport as { schemaVersion?: unknown })?.schemaVersion === 1) {
    return Object.freeze(['F2_PROOF_V2_REQUIRED']);
  }
  let report: F2ProofReportV2;
  try {
    report = parseF2ProofReportV2(rawReport);
  } catch {
    return Object.freeze(['F2_PROOF_INVALID']);
  }
  const planFile = value(environment, 'MPX_F2_PLAN_EXPORT_FILE');
  if (!planFile) {
    return Object.freeze(['F2_PLAN_EXPORT_NOT_CONFIGURED']);
  }
  if (!path.isAbsolute(planFile)) {
    return Object.freeze(['F2_PLAN_EXPORT_INVALID']);
  }
  let plan: SbxLaunchPlanExportV1;
  try {
    plan = parseSbxLaunchPlanExportV1(await boundedContractJson(planFile));
  } catch {
    return Object.freeze(['F2_PLAN_EXPORT_INVALID']);
  }
  let sources: SbxProofSources;
  try {
    sources = await loadProductionSbxProofSources(environment);
  } catch {
    return Object.freeze(['F2_PACKAGED_EVIDENCE_INVALID']);
  }
  const codes = [
    ...(report.evidence.sbxPinSha256 === sources.sbxPinSha256 ? [] : ['SBX_PIN_DIGEST_DRIFT']),
    ...(report.evidence.runtimeToolInventorySha256 === sources.runtimeToolInventorySha256
      ? []
      : ['RUNTIME_TOOL_INVENTORY_DRIFT']),
    ...(report.evidence.executorEvidenceSha256 === sources.executorEvidenceSha256
      ? []
      : ['EXECUTOR_EVIDENCE_DRIFT']),
    ...validateF2ProofReportV2(report, plan).diagnostics.map((item) => item.code),
    ...(report.verdict === 'pass' ? [] : ['F2_PROOF_FAILED']),
  ];
  return Object.freeze([...new Set(codes)]);
}

async function readProof(
  input: ProductionSbxExecutionInput,
  planKey: string,
): Promise<F2ProofReportV1 | F2ProofReportV2> {
  if (input.proof) {
    return input.planExport ? parseF2ProofReportV2(input.proof) : parseF2ProofReportV1(input.proof);
  }
  const explicit = value(input.environment, 'MPX_F2_PROOF_REPORT_FILE'),
    root = value(input.environment, 'MPX_F2_PROOF_ROOT');
  const file =
    explicit ?? (root && path.isAbsolute(root) ? path.join(root, `${planKey}.json`) : undefined);
  if (!file || !path.isAbsolute(file)) {
    throw new Error('A launch-bound F2 proof report file is required.');
  }
  const raw = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion?: unknown };
  return input.planExport || raw.schemaVersion === 2
    ? parseF2ProofReportV2(raw)
    : parseF2ProofReportV1(raw);
}
export async function createProductionSbxExecutionAdapter(
  input: ProductionSbxExecutionInput,
  dependencies?: SbxExecutionDependencies,
): Promise<SbxExecutionAdapter> {
  const exportFile = value(input.environment, 'MPX_F2_PLAN_EXPORT_FILE'),
    loadedExport =
      input.planExport ??
      (dependencies === undefined && exportFile && path.isAbsolute(exportFile)
        ? parseSbxLaunchPlanExportV1(JSON.parse(await readFile(exportFile, 'utf8')))
        : undefined);
  if (dependencies === undefined && !loadedExport) {
    throw new Error(
      'PLAN_EXPORT_REQUIRED: production Docker admission requires an exact reviewed sandbox plan export.',
    );
  }
  const deps = dependencies ?? defaults(input.environment),
    sources = input.sources ?? (await loadProductionSbxProofSources(input.environment)),
    planned = planProductionSbxExecution({ ...input, sources }),
    locations = candidates(input.environment);
  if (
    loadedExport &&
    (loadedExport.sandbox.planKey !== planned.plan.planKey ||
      loadedExport.runtime !== input.runtime ||
      loadedExport.identity.name !== input.identity.name ||
      loadedExport.identity.domain !== input.identity.domain ||
      loadedExport.evidence.sbxPinSha256 !== sources.sbxPinSha256 ||
      loadedExport.evidence.runtimeToolInventorySha256 !== sources.runtimeToolInventorySha256 ||
      loadedExport.evidence.executorEvidenceSha256 !== sources.executorEvidenceSha256 ||
      loadedExport.sandbox.profile !== planned.plan.networkPolicy.name ||
      loadedExport.sandbox.proofSandboxName !== `mpx-proof-${planned.plan.planKey.slice(0, 12)}` ||
      JSON.stringify(loadedExport.sandbox.createArgv) !==
        JSON.stringify(productionProofCreateArgv(planned.plan)) ||
      JSON.stringify(loadedExport.policyMatrix) !==
        JSON.stringify(buildF2ProofPolicyMatrix(planned.plan.networkPolicy.name as SbxPolicyName)))
  ) {
    throw new Error(
      'PLAN_EXPORT_MISMATCH: reviewed export does not match the regenerated production sandbox plan.',
    );
  }
  const executable = await resolveTrustedSbxExecutable({
    candidates: locations.candidates,
    projectRoot: input.cwd,
    trustedRoots: locations.trustedRoots,
    expectedSha256: SBX_V0_39_0_PIN.windowsBinarySha256,
    inspect: (file) => deps.inspectExecutable(file),
  });
  const proof = await readProof(
      { ...input, ...(loadedExport ? { planExport: loadedExport } : {}) },
      planned.plan.planKey,
    ),
    planExport = loadedExport;
  return new StandaloneSbxExecutorAdapter({
    executable,
    cwd: input.cwd,
    plan: planned.plan,
    agent: input.runtime === 'claude' ? 'claude' : 'shell',
    report: proof,
    ...(planExport ? { planExport } : {}),
    sbxPinSha256: sources.sbxPinSha256,
    executorEvidenceSha256: sources.executorEvidenceSha256,
    ports: input.ports.map((port) => `127.0.0.1:${port}:${port}/tcp4`),
    worker: {
      argv: [
        'mpx-f2-worker',
        '--bridge',
        planned.bridge.endpoint,
        '--attestation',
        planned.bridge.attestationSha256,
      ],
      ...planned.bridge,
    },
    ...(input.claudeLaunch ? { projection: input.claudeLaunch.projection } : {}),
    ...(proof.builtInClaudeEvidence ? { claudeEvidence: proof.builtInClaudeEvidence } : {}),
    ...(deps.allowSignedFixtureEvidence ? { allowSignedFixtureEvidence: true } : {}),
    diagnostics: () => deps.diagnostics(executable, input.cwd),
    run: deps.run,
  });
}
