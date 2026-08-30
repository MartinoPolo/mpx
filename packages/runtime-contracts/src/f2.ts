import { createHash } from 'node:crypto';

class F2ContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeContractError';
  }
}

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const PRIVATE_KEYS = /(?:hostRoot|accountId|prompt|secret|credential|token|apiKey|authorization)/iu;
const ABSOLUTE = /(?:^[A-Za-z]:[\\/]|^\/|\\\\|\/Users\/|\/home\/)/u;
function fail(code: string, message: string): never {
  throw new F2ContractError(code, message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CONTRACT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function exact(item: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(item).find((key) => !keys.includes(key));
  if (extra) {
    fail('UNKNOWN_FIELD', `${label} contains unknown field '${extra}'`);
  }
  const missing = keys.find((key) => !Object.hasOwn(item, key));
  if (missing) {
    fail('INVALID_CONTRACT', `${label} is missing '${missing}'`);
  }
}
function text(value: unknown, label: string, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_TEXT.test(value)
  ) {
    fail('INVALID_CONTRACT', `${label} must be bounded portable text`);
  }
  if (ABSOLUTE.test(value)) {
    fail('PRIVATE_DATA', `${label} must not expose a host root`);
  }
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) {
    fail('INVALID_CONTRACT', `${label} must be a lowercase SHA-256`);
  }
  return value;
}
function commit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COMMIT.test(value)) {
    fail('INVALID_CONTRACT', `${label} must be a lowercase commit hash`);
  }
  return value;
}
function privacy(value: unknown): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) {
      fail('PRIVATE_DATA', `field '${key}' is forbidden at proof boundaries`);
    }
    privacy(child);
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function f2Sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export interface SbxPinV1 {
  readonly schemaVersion: 1;
  readonly product: 'docker-sbx-standalone';
  readonly version: '0.39.0';
  readonly buildCommit: string;
  readonly releaseCommit: string;
  readonly contribReviewCommit: string;
  readonly windowsBinarySha256: string;
  readonly reviewedArtifactSha256: {
    readonly license: string;
    readonly features: string;
    readonly commands: string;
  };
  readonly rejectedIntegrations: readonly ['contrib-pi-kit', 'legacy-docker-sandbox'];
}
export function parseSbxPinV1(value: unknown): SbxPinV1 {
  const item = object(value, 'SbxPinV1');
  exact(
    item,
    [
      'schemaVersion',
      'product',
      'version',
      'buildCommit',
      'releaseCommit',
      'contribReviewCommit',
      'windowsBinarySha256',
      'reviewedArtifactSha256',
      'rejectedIntegrations',
    ],
    'SbxPinV1',
  );
  if (
    item.schemaVersion !== 1 ||
    item.product !== 'docker-sbx-standalone' ||
    item.version !== '0.39.0'
  ) {
    fail('SBX_PIN_INVALID', 'only installed standalone sbx v0.39.0 is accepted');
  }
  const artifacts = object(item.reviewedArtifactSha256, 'reviewedArtifactSha256');
  exact(artifacts, ['license', 'features', 'commands'], 'reviewedArtifactSha256');
  if (
    !Array.isArray(item.rejectedIntegrations) ||
    stable(item.rejectedIntegrations) !== stable(['contrib-pi-kit', 'legacy-docker-sandbox'])
  ) {
    fail('SBX_PIN_INVALID', 'legacy Docker sandbox and contrib Pi kit must be explicitly rejected');
  }
  return Object.freeze({
    schemaVersion: 1,
    product: 'docker-sbx-standalone',
    version: '0.39.0',
    buildCommit: commit(item.buildCommit, 'buildCommit'),
    releaseCommit: commit(item.releaseCommit, 'releaseCommit'),
    contribReviewCommit: commit(item.contribReviewCommit, 'contribReviewCommit'),
    windowsBinarySha256: sha(item.windowsBinarySha256, 'windowsBinarySha256'),
    reviewedArtifactSha256: Object.freeze({
      license: sha(artifacts.license, 'license'),
      features: sha(artifacts.features, 'features'),
      commands: sha(artifacts.commands, 'commands'),
    }),
    rejectedIntegrations: Object.freeze(['contrib-pi-kit', 'legacy-docker-sandbox'] as const),
  });
}

export interface SbxDiagnosticsV1 {
  readonly schemaVersion: 1;
  readonly sbxPinSha256: string;
  readonly status: 'pass' | 'fail';
  readonly checks: readonly {
    readonly code: string;
    readonly status: 'pass' | 'fail';
    readonly evidenceSha256: string;
  }[];
}
export function parseSbxDiagnosticsV1(value: unknown): SbxDiagnosticsV1 {
  privacy(value);
  const item = object(value, 'SbxDiagnosticsV1');
  exact(item, ['schemaVersion', 'sbxPinSha256', 'status', 'checks'], 'SbxDiagnosticsV1');
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.checks) ||
    item.checks.length > 64 ||
    !(item.status === 'pass' || item.status === 'fail')
  ) {
    fail('INVALID_CONTRACT', 'invalid diagnostics');
  }
  const checks = item.checks.map((raw, index) => {
    const check = object(raw, `checks[${index}]`);
    exact(check, ['code', 'status', 'evidenceSha256'], `checks[${index}]`);
    if (!(check.status === 'pass' || check.status === 'fail')) {
      fail('INVALID_CONTRACT', 'invalid check status');
    }
    return Object.freeze({
      code: text(check.code, 'code', 64),
      status: check.status,
      evidenceSha256: sha(check.evidenceSha256, 'evidenceSha256'),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    sbxPinSha256: sha(item.sbxPinSha256, 'sbxPinSha256'),
    status: item.status,
    checks: Object.freeze(checks),
  });
}

export interface SandboxPlanV1 {
  readonly schemaVersion: 1;
  readonly planKey: string;
  readonly runtime: 'claude' | 'pi';
  readonly sbxPinSha256: string;
  readonly runtimeToolInventorySha256: string;
  readonly executorEvidenceSha256: string;
  readonly networkPolicy: 'deny-by-default';
  readonly workspaceReference: string;
}
type PlanInput = Omit<SandboxPlanV1, 'schemaVersion' | 'planKey'>;
export function createSandboxPlanV1(input: PlanInput): SandboxPlanV1 {
  const tuple = { schemaVersion: 1 as const, ...input };
  return parseSandboxPlanV1({ ...tuple, planKey: f2Sha256(tuple) });
}
export function parseSandboxPlanV1(value: unknown): SandboxPlanV1 {
  privacy(value);
  const item = object(value, 'SandboxPlanV1');
  exact(
    item,
    [
      'schemaVersion',
      'planKey',
      'runtime',
      'sbxPinSha256',
      'runtimeToolInventorySha256',
      'executorEvidenceSha256',
      'networkPolicy',
      'workspaceReference',
    ],
    'SandboxPlanV1',
  );
  if (
    item.schemaVersion !== 1 ||
    !(item.runtime === 'claude' || item.runtime === 'pi') ||
    item.networkPolicy !== 'deny-by-default'
  ) {
    fail('INVALID_CONTRACT', 'invalid sandbox plan');
  }
  const parsed: SandboxPlanV1 = {
    schemaVersion: 1,
    planKey: sha(item.planKey, 'planKey'),
    runtime: item.runtime,
    sbxPinSha256: sha(item.sbxPinSha256, 'sbxPinSha256'),
    runtimeToolInventorySha256: sha(item.runtimeToolInventorySha256, 'runtimeToolInventorySha256'),
    executorEvidenceSha256: sha(item.executorEvidenceSha256, 'executorEvidenceSha256'),
    networkPolicy: 'deny-by-default' as const,
    workspaceReference: text(item.workspaceReference, 'workspaceReference', 128),
  };
  const { planKey, ...tuple } = parsed;
  if (planKey !== f2Sha256(tuple)) {
    fail('HASH_MISMATCH', 'sandbox plan key does not match content');
  }
  return Object.freeze(parsed);
}

export interface SandboxAttestationV1 {
  readonly schemaVersion: 1;
  readonly planKey: string;
  readonly sbxPinSha256: string;
  readonly runtimeToolInventorySha256: string;
  readonly executorEvidenceSha256: string;
  readonly diagnosticsSha256: string;
  readonly outcome: 'pass' | 'fail';
}
export function parseSandboxAttestationV1(value: unknown): SandboxAttestationV1 {
  privacy(value);
  const item = object(value, 'SandboxAttestationV1');
  exact(
    item,
    [
      'schemaVersion',
      'planKey',
      'sbxPinSha256',
      'runtimeToolInventorySha256',
      'executorEvidenceSha256',
      'diagnosticsSha256',
      'outcome',
    ],
    'SandboxAttestationV1',
  );
  if (item.schemaVersion !== 1 || !(item.outcome === 'pass' || item.outcome === 'fail')) {
    fail('INVALID_CONTRACT', 'invalid attestation');
  }
  return Object.freeze({
    schemaVersion: 1,
    planKey: sha(item.planKey, 'planKey'),
    sbxPinSha256: sha(item.sbxPinSha256, 'sbxPinSha256'),
    runtimeToolInventorySha256: sha(item.runtimeToolInventorySha256, 'runtimeToolInventorySha256'),
    executorEvidenceSha256: sha(item.executorEvidenceSha256, 'executorEvidenceSha256'),
    diagnosticsSha256: sha(item.diagnosticsSha256, 'diagnosticsSha256'),
    outcome: item.outcome,
  });
}

export interface RemoteToolRequestV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly toolPath: string;
  readonly inputSha256: string;
}
export function parseRemoteToolRequestV1(value: unknown): RemoteToolRequestV1 {
  const item = object(value, 'RemoteToolRequestV1');
  exact(item, ['schemaVersion', 'requestId', 'toolPath', 'inputSha256'], 'RemoteToolRequestV1');
  privacy(value);
  if (item.schemaVersion !== 1) {
    fail('INVALID_CONTRACT', 'invalid request version');
  }
  return Object.freeze({
    schemaVersion: 1,
    requestId: text(item.requestId, 'requestId', 64),
    toolPath: text(item.toolPath, 'toolPath', 256),
    inputSha256: sha(item.inputSha256, 'inputSha256'),
  });
}
export interface RemoteToolResultV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly status: 'ok' | 'error';
  readonly outputSha256: string;
  readonly errorCode: string | null;
}
export function parseRemoteToolResultV1(value: unknown): RemoteToolResultV1 {
  privacy(value);
  const item = object(value, 'RemoteToolResultV1');
  exact(
    item,
    ['schemaVersion', 'requestId', 'status', 'outputSha256', 'errorCode'],
    'RemoteToolResultV1',
  );
  if (
    item.schemaVersion !== 1 ||
    !(item.status === 'ok' || item.status === 'error') ||
    (item.errorCode !== null && typeof item.errorCode !== 'string')
  ) {
    fail('INVALID_CONTRACT', 'invalid result');
  }
  return Object.freeze({
    schemaVersion: 1,
    requestId: text(item.requestId, 'requestId', 64),
    status: item.status,
    outputSha256: sha(item.outputSha256, 'outputSha256'),
    errorCode: item.errorCode === null ? null : text(item.errorCode, 'errorCode', 64),
  });
}
export interface SandboxResumeTokenV1 {
  readonly schemaVersion: 1;
  readonly tokenKey: string;
  readonly planKey: string;
  readonly attestationSha256: string;
  readonly expiresAtEpochMs: number;
}
export function parseSandboxResumeTokenV1(value: unknown): SandboxResumeTokenV1 {
  privacy(value);
  const item = object(value, 'SandboxResumeTokenV1');
  exact(
    item,
    ['schemaVersion', 'tokenKey', 'planKey', 'attestationSha256', 'expiresAtEpochMs'],
    'SandboxResumeTokenV1',
  );
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.expiresAtEpochMs) ||
    Number(item.expiresAtEpochMs) < 0
  ) {
    fail('INVALID_CONTRACT', 'invalid resume token');
  }
  return Object.freeze({
    schemaVersion: 1,
    tokenKey: sha(item.tokenKey, 'tokenKey'),
    planKey: sha(item.planKey, 'planKey'),
    attestationSha256: sha(item.attestationSha256, 'attestationSha256'),
    expiresAtEpochMs: item.expiresAtEpochMs as number,
  });
}
export interface BuiltInClaudeIdentityEvidenceV1 {
  readonly identity: 'personal' | 'work';
  readonly appNamespace: string;
  readonly enrollmentEvidenceSha256: string;
  readonly isolationEvidenceSha256: string;
  readonly oppositeIdentityDenialEvidenceSha256: string;
  readonly captureSignatureSha256: string;
}
export interface BuiltInClaudeEvidenceV1 {
  readonly source: 'live' | 'signed-fixture';
  readonly identities: readonly [BuiltInClaudeIdentityEvidenceV1, BuiltInClaudeIdentityEvidenceV1];
}
function parseBuiltInClaudeEvidence(value: unknown): BuiltInClaudeEvidenceV1 | null {
  if (value === null) {
    return null;
  }
  const item = object(value, 'builtInClaudeEvidence');
  exact(item, ['source', 'identities'], 'builtInClaudeEvidence');
  if (
    !(item.source === 'live' || item.source === 'signed-fixture') ||
    !Array.isArray(item.identities) ||
    item.identities.length !== 2
  ) {
    fail(
      'INVALID_CONTRACT',
      'builtInClaudeEvidence identities must contain personal and work captures',
    );
  }
  const identities = item.identities.map((raw, index) => {
    const evidence = object(raw, `builtInClaudeEvidence.identities[${index}]`);
    exact(
      evidence,
      [
        'identity',
        'appNamespace',
        'enrollmentEvidenceSha256',
        'isolationEvidenceSha256',
        'oppositeIdentityDenialEvidenceSha256',
        'captureSignatureSha256',
      ],
      `builtInClaudeEvidence.identities[${index}]`,
    );
    if (
      !(evidence.identity === 'personal' || evidence.identity === 'work') ||
      evidence.appNamespace !== `mpx-claude-${evidence.identity}`
    ) {
      fail('INVALID_CONTRACT', 'builtInClaudeEvidence identity or app namespace is invalid');
    }
    return Object.freeze({
      identity: evidence.identity,
      appNamespace: evidence.appNamespace,
      enrollmentEvidenceSha256: sha(evidence.enrollmentEvidenceSha256, 'enrollmentEvidenceSha256'),
      isolationEvidenceSha256: sha(evidence.isolationEvidenceSha256, 'isolationEvidenceSha256'),
      oppositeIdentityDenialEvidenceSha256: sha(
        evidence.oppositeIdentityDenialEvidenceSha256,
        'oppositeIdentityDenialEvidenceSha256',
      ),
      captureSignatureSha256: sha(evidence.captureSignatureSha256, 'captureSignatureSha256'),
    });
  });
  if (identities[0]!.identity !== 'personal' || identities[1]!.identity !== 'work') {
    fail('INVALID_CONTRACT', 'builtInClaudeEvidence identities must be ordered personal then work');
  }
  return Object.freeze({
    source: item.source,
    identities: Object.freeze(identities) as unknown as readonly [
      BuiltInClaudeIdentityEvidenceV1,
      BuiltInClaudeIdentityEvidenceV1,
    ],
  });
}
export interface F2ProofReportV1 {
  readonly schemaVersion: 1;
  readonly reportKey: string;
  readonly planKey: string;
  readonly sbxPinSha256: string;
  readonly runtimeToolInventorySha256: string;
  readonly executorEvidenceSha256: string;
  readonly attestationSha256: string;
  readonly builtInClaudeEvidence: BuiltInClaudeEvidenceV1 | null;
  readonly verdict: 'pass' | 'fail';
}
type ReportInput = Omit<
  F2ProofReportV1,
  'schemaVersion' | 'reportKey' | 'builtInClaudeEvidence'
> & { readonly builtInClaudeEvidence?: BuiltInClaudeEvidenceV1 | null };
export function createF2ProofReportV1(input: ReportInput): F2ProofReportV1 {
  const tuple = {
    schemaVersion: 1 as const,
    ...input,
    builtInClaudeEvidence: input.builtInClaudeEvidence ?? null,
  };
  return parseF2ProofReportV1({ ...tuple, reportKey: f2Sha256(tuple) });
}
export function parseF2ProofReportV1(value: unknown): F2ProofReportV1 {
  privacy(value);
  const item = object(value, 'F2ProofReportV1');
  exact(
    item,
    [
      'schemaVersion',
      'reportKey',
      'planKey',
      'sbxPinSha256',
      'runtimeToolInventorySha256',
      'executorEvidenceSha256',
      'attestationSha256',
      'builtInClaudeEvidence',
      'verdict',
    ],
    'F2ProofReportV1',
  );
  if (item.schemaVersion !== 1 || !(item.verdict === 'pass' || item.verdict === 'fail')) {
    fail('INVALID_CONTRACT', 'invalid proof report');
  }
  const parsed: F2ProofReportV1 = {
    schemaVersion: 1,
    reportKey: sha(item.reportKey, 'reportKey'),
    planKey: sha(item.planKey, 'planKey'),
    sbxPinSha256: sha(item.sbxPinSha256, 'sbxPinSha256'),
    runtimeToolInventorySha256: sha(item.runtimeToolInventorySha256, 'runtimeToolInventorySha256'),
    executorEvidenceSha256: sha(item.executorEvidenceSha256, 'executorEvidenceSha256'),
    attestationSha256: sha(item.attestationSha256, 'attestationSha256'),
    builtInClaudeEvidence: parseBuiltInClaudeEvidence(item.builtInClaudeEvidence),
    verdict: item.verdict,
  };
  const { reportKey, ...tuple } = parsed;
  if (reportKey !== f2Sha256(tuple)) {
    fail('HASH_MISMATCH', 'proof report key does not match content');
  }
  return Object.freeze(parsed);
}
export function validateF2ProofReportV1(
  value: unknown,
  current: { runtimeToolInventorySha256: string; executorEvidenceSha256: string },
): { valid: boolean; diagnostics: readonly { code: string }[] } {
  const report = parseF2ProofReportV1(value);
  const diagnostics: { code: string }[] = [];
  if (
    report.runtimeToolInventorySha256 !==
    sha(current.runtimeToolInventorySha256, 'runtimeToolInventorySha256')
  ) {
    diagnostics.push({ code: 'RUNTIME_TOOL_INVENTORY_DRIFT' });
  }
  if (
    report.executorEvidenceSha256 !== sha(current.executorEvidenceSha256, 'executorEvidenceSha256')
  ) {
    diagnostics.push({ code: 'EXECUTOR_EVIDENCE_DRIFT' });
  }
  return Object.freeze({
    valid: diagnostics.length === 0 && report.verdict === 'pass',
    diagnostics: Object.freeze(diagnostics),
  });
}
