import { createHash } from 'node:crypto';

class ContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeContractError';
  }
}
const SHA = /^[a-f0-9]{64}$/u,
  SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u,
  TARGET = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:(?:[1-9]\d{0,4})$/u;
const AUTH =
  /(?:auth(?:orization)?|login|token|secret|credential|password|api[_-]?key|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|--env)/iu;
const RAW_PATH =
  /(?:^[A-Za-z]:[\\/]|^\\\\|^\/(?!workspace(?:\/|$)|opt\/mpx(?:\/|$))|\/Users\/|\/home\/)/u;
const PROFILES = ['open', 'deny-all', 'delivery', 'implementation', 'minimal', 'research'] as const;
function fail(code: string, message: string): never {
  throw new ContractError(code, message);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CONTRACT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) {
    fail('UNKNOWN_FIELD', `${label} contains unknown field '${extra}'`);
  }
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    fail('INVALID_CONTRACT', `${label} is missing '${missing}'`);
  }
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) {
    fail('INVALID_CONTRACT', `${label} must be a lowercase SHA-256`);
  }
  return value;
}
function text(value: unknown, label: string, max = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    !SAFE.test(value) ||
    RAW_PATH.test(value)
  ) {
    fail('PRIVATE_DATA', `${label} must be bounded portable text`);
  }
  return value;
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
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function privacy(value: unknown): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:hostRoot|accountId|prompt|secret|credential|token|apiKey|authorization|stdout|stderr|output)/iu.test(
        key,
      )
    ) {
      fail('PRIVATE_DATA', `field '${key}' is forbidden`);
    }
    privacy(child);
  }
}

export type F2PolicyDecision = 'allow' | 'deny';
export interface F2PolicyTargetV1 {
  readonly target: string;
  readonly decision: F2PolicyDecision;
}
export interface F2PolicyProfileV1 {
  readonly profile: (typeof PROFILES)[number];
  readonly default: 'allow' | 'deny';
  readonly targets: readonly F2PolicyTargetV1[];
}
export interface SbxLaunchPlanExportV1 {
  readonly schemaVersion: 1;
  readonly exportKey: string;
  readonly launchKey: string;
  readonly descriptorSha256: string;
  readonly runtime: 'claude' | 'pi';
  readonly identity: { readonly name: string; readonly domain: 'personal' | 'work' };
  readonly artifact: {
    readonly manifestKey: string;
    readonly artifactKey: string;
    readonly fileMapHash: string;
  };
  readonly evidence: {
    readonly sbxPinSha256: string;
    readonly runtimeToolInventorySha256: string;
    readonly executorEvidenceSha256: string;
  };
  readonly sandbox: {
    readonly planKey: string;
    readonly profile: string;
    readonly proofSandboxName: string;
    readonly createArgv: readonly string[];
  };
  readonly policyMatrix: readonly F2PolicyProfileV1[];
}
function argv(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 5 ||
    value.length > 64 ||
    value.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.length < 1 ||
        arg.length > 1024 ||
        /[\r\n\0]/u.test(arg) ||
        AUTH.test(arg) ||
        RAW_PATH.test(arg),
    )
  ) {
    fail(
      'ARGV_UNSAFE',
      'sandbox argv contains an unsafe path, environment, or authentication marker',
    );
  }
  const result = value as string[];
  if (
    result[0] !== 'create' ||
    result[1] !== '--name' ||
    result.filter((arg) => arg === '--name').length !== 1 ||
    result.includes('--profile') ||
    !result.some((arg) => arg === 'shell' || arg === 'claude')
  ) {
    fail('ARGV_UNSAFE', 'sandbox argv is not a reviewed create plan');
  }
  return Object.freeze([...result]);
}
function identity(value: unknown) {
  const item = record(value, 'identity');
  exact(item, ['name', 'domain'], 'identity');
  if (item.domain !== 'personal' && item.domain !== 'work') {
    fail('INVALID_CONTRACT', 'identity domain is invalid');
  }
  return Object.freeze({ name: text(item.name, 'identity.name', 64), domain: item.domain });
}
function artifact(value: unknown) {
  const item = record(value, 'artifact');
  exact(item, ['manifestKey', 'artifactKey', 'fileMapHash'], 'artifact');
  return Object.freeze({
    manifestKey: sha(item.manifestKey, 'manifestKey'),
    artifactKey: sha(item.artifactKey, 'artifactKey'),
    fileMapHash: sha(item.fileMapHash, 'fileMapHash'),
  });
}
function evidence(value: unknown) {
  const item = record(value, 'evidence');
  exact(item, ['sbxPinSha256', 'runtimeToolInventorySha256', 'executorEvidenceSha256'], 'evidence');
  return Object.freeze({
    sbxPinSha256: sha(item.sbxPinSha256, 'sbxPinSha256'),
    runtimeToolInventorySha256: sha(item.runtimeToolInventorySha256, 'runtimeToolInventorySha256'),
    executorEvidenceSha256: sha(item.executorEvidenceSha256, 'executorEvidenceSha256'),
  });
}
function sandbox(value: unknown) {
  const item = record(value, 'sandbox');
  exact(item, ['planKey', 'profile', 'proofSandboxName', 'createArgv'], 'sandbox');
  const planKey = sha(item.planKey, 'planKey'),
    profile = text(item.profile, 'sandbox.profile', 32),
    proofSandboxName = text(item.proofSandboxName, 'proofSandboxName', 63),
    createArgv = argv(item.createArgv);
  if (
    !PROFILES.includes(profile as (typeof PROFILES)[number]) ||
    proofSandboxName !== `mpx-proof-${planKey.slice(0, 12)}`
  ) {
    fail('INVALID_CONTRACT', 'sandbox binding is invalid');
  }
  return Object.freeze({ planKey, profile, proofSandboxName, createArgv });
}
function matrix(value: unknown, selectedProfile: string): readonly F2PolicyProfileV1[] {
  if (!Array.isArray(value) || value.length !== 1) {
    fail('POLICY_EVIDENCE_INVALID', 'matrix must contain exactly the sandbox selected profile');
  }
  const item = record(value[0], 'policyMatrix[0]');
  exact(item, ['profile', 'default', 'targets'], 'policyMatrix[0]');
  if (
    item.profile !== selectedProfile ||
    !PROFILES.includes(item.profile as (typeof PROFILES)[number]) ||
    (item.default !== 'allow' && item.default !== 'deny') ||
    !Array.isArray(item.targets) ||
    item.targets.length < 1 ||
    item.targets.length > 32
  ) {
    fail('POLICY_EVIDENCE_INVALID', 'matrix profile must match sandbox.profile');
  }
  if ((item.profile === 'open') !== (item.default === 'allow')) {
    fail('POLICY_EVIDENCE_INVALID', 'policy default does not match the selected profile');
  }
  let previous = '';
  const targets = item.targets.map((rawTarget, targetIndex) => {
    const entry = record(rawTarget, `targets[${targetIndex}]`);
    exact(entry, ['target', 'decision'], `targets[${targetIndex}]`);
    const target = text(entry.target, 'target', 256);
    if (
      !TARGET.test(target) ||
      target <= previous ||
      (entry.decision !== 'allow' && entry.decision !== 'deny')
    ) {
      fail('POLICY_EVIDENCE_INVALID', 'targets must be unique, sorted, and valid');
    }
    previous = target;
    return Object.freeze({ target, decision: entry.decision });
  });
  if (
    item.default === 'allow'
      ? targets.some((entry) => entry.decision === 'deny') ||
        !targets.every((entry) => entry.decision === 'allow')
      : !targets.some(
          (entry) => entry.target === 'blocked.invalid:443' && entry.decision === 'deny',
        )
  ) {
    fail(
      'POLICY_EVIDENCE_INVALID',
      item.default === 'allow'
        ? 'open policy forbids claimed deny evidence'
        : 'fixed deny evidence is required',
    );
  }
  return Object.freeze([
    Object.freeze({
      profile: item.profile as F2PolicyProfileV1['profile'],
      default: item.default,
      targets: Object.freeze(targets),
    }),
  ]);
}
function parseBinding(
  item: Record<string, unknown>,
): Omit<SbxLaunchPlanExportV1, 'schemaVersion' | 'exportKey'> {
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('INVALID_CONTRACT', 'runtime is invalid');
  }
  const sandboxBinding = sandbox(item.sandbox);
  return {
    launchKey: sha(item.launchKey, 'launchKey'),
    descriptorSha256: sha(item.descriptorSha256, 'descriptorSha256'),
    runtime: item.runtime,
    identity: identity(item.identity),
    artifact: artifact(item.artifact),
    evidence: evidence(item.evidence),
    sandbox: sandboxBinding,
    policyMatrix: matrix(item.policyMatrix, sandboxBinding.profile),
  };
}
type ExportInput = Omit<SbxLaunchPlanExportV1, 'schemaVersion' | 'exportKey'>;
export function createSbxLaunchPlanExportV1(input: ExportInput): SbxLaunchPlanExportV1 {
  const tuple = {
    schemaVersion: 1 as const,
    launchKey: input.launchKey,
    descriptorSha256: input.descriptorSha256,
    runtime: input.runtime,
    identity: input.identity,
    artifact: input.artifact,
    evidence: input.evidence,
    sandbox: input.sandbox,
    policyMatrix: input.policyMatrix,
  };
  return parseSbxLaunchPlanExportV1({ ...tuple, exportKey: hash(tuple) });
}
export function parseSbxLaunchPlanExportV1(value: unknown): SbxLaunchPlanExportV1 {
  const item = record(value, 'SbxLaunchPlanExportV1');
  exact(
    item,
    [
      'schemaVersion',
      'exportKey',
      'launchKey',
      'descriptorSha256',
      'runtime',
      'identity',
      'artifact',
      'evidence',
      'sandbox',
      'policyMatrix',
    ],
    'SbxLaunchPlanExportV1',
  );
  privacy(value);
  if (item.schemaVersion !== 1) {
    fail('UNKNOWN_SCHEMA_VERSION', 'only SbxLaunchPlanExportV1 is supported');
  }
  const binding = parseBinding(item),
    parsed = { schemaVersion: 1 as const, exportKey: sha(item.exportKey, 'exportKey'), ...binding };
  const { exportKey, ...tuple } = parsed;
  if (exportKey !== hash(tuple)) {
    fail('HASH_MISMATCH', 'plan export key does not match content');
  }
  return Object.freeze(parsed);
}
export function parseSbxLaunchPlanExportDocumentV1(value: unknown): SbxLaunchPlanExportV1 {
  const item = record(value, 'SbxLaunchPlanExportDocumentV1');
  if (!Object.hasOwn(item, 'apiVersion')) {
    return parseSbxLaunchPlanExportV1(value);
  }
  exact(item, ['apiVersion', 'ok', 'data', 'warnings'], 'SbxLaunchPlanExportEnvelopeV1');
  if (
    item.apiVersion !== 1 ||
    item.ok !== true ||
    !Array.isArray(item.warnings) ||
    item.warnings.length !== 0
  ) {
    fail('INVALID_CONTRACT', 'plan export envelope must be a warning-free API V1 success');
  }
  return parseSbxLaunchPlanExportV1(item.data);
}

export interface F2ProofDecisionV2 {
  readonly profile: F2PolicyProfileV1['profile'];
  readonly target: string;
  readonly decision: F2PolicyDecision;
  readonly count: number;
}
export interface F2ProofReportV2 extends Omit<
  SbxLaunchPlanExportV1,
  'schemaVersion' | 'exportKey'
> {
  readonly schemaVersion: 2;
  readonly reportKey: string;
  readonly planExportKey: string;
  readonly decisions: readonly F2ProofDecisionV2[];
  readonly builtInClaudeEvidence: import('./f2.js').BuiltInClaudeEvidenceV1 | null;
  readonly verdict: 'pass' | 'fail';
}
type ReportInput = Omit<F2ProofReportV2, 'schemaVersion' | 'reportKey'>;
export function createF2ProofReportV2(input: ReportInput): F2ProofReportV2 {
  const tuple = {
    schemaVersion: 2 as const,
    planExportKey: input.planExportKey,
    launchKey: input.launchKey,
    descriptorSha256: input.descriptorSha256,
    runtime: input.runtime,
    identity: input.identity,
    artifact: input.artifact,
    evidence: input.evidence,
    sandbox: input.sandbox,
    policyMatrix: input.policyMatrix,
    decisions: input.decisions,
    builtInClaudeEvidence: input.builtInClaudeEvidence,
    verdict: input.verdict,
  };
  return parseF2ProofReportV2({ ...tuple, reportKey: hash(tuple) });
}
function claudeEvidence(value: unknown): import('./f2.js').BuiltInClaudeEvidenceV1 | null {
  if (value === null) {
    return null;
  }
  const item = record(value, 'builtInClaudeEvidence');
  exact(item, ['source', 'identities'], 'builtInClaudeEvidence');
  if (
    (item.source !== 'live' && item.source !== 'signed-fixture') ||
    !Array.isArray(item.identities) ||
    item.identities.length !== 2
  ) {
    fail('INVALID_CONTRACT', 'Claude evidence is invalid');
  }
  const identities = item.identities.map((raw, index) => {
    const entry = record(raw, `identities[${index}]`);
    exact(
      entry,
      [
        'identity',
        'appNamespace',
        'enrollmentEvidenceSha256',
        'isolationEvidenceSha256',
        'oppositeIdentityDenialEvidenceSha256',
        'captureSignatureSha256',
      ],
      `identities[${index}]`,
    );
    const expected = index === 0 ? 'personal' : 'work';
    if (entry.identity !== expected || entry.appNamespace !== `mpx-claude-${expected}`) {
      fail('INVALID_CONTRACT', 'Claude identities must be canonical');
    }
    return {
      identity: expected,
      appNamespace: entry.appNamespace,
      enrollmentEvidenceSha256: sha(entry.enrollmentEvidenceSha256, 'enrollmentEvidenceSha256'),
      isolationEvidenceSha256: sha(entry.isolationEvidenceSha256, 'isolationEvidenceSha256'),
      oppositeIdentityDenialEvidenceSha256: sha(
        entry.oppositeIdentityDenialEvidenceSha256,
        'oppositeIdentityDenialEvidenceSha256',
      ),
      captureSignatureSha256: sha(entry.captureSignatureSha256, 'captureSignatureSha256'),
    };
  });
  return Object.freeze({
    source: item.source,
    identities: Object.freeze(identities),
  }) as import('./f2.js').BuiltInClaudeEvidenceV1;
}
export function parseF2ProofReportV2(value: unknown): F2ProofReportV2 {
  const item = record(value, 'F2ProofReportV2');
  exact(
    item,
    [
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
    ],
    'F2ProofReportV2',
  );
  privacy(value);
  if (item.schemaVersion !== 2) {
    fail('PROOF_V2_REQUIRED', 'production proof requires F2ProofReportV2');
  }
  if ((item.verdict !== 'pass' && item.verdict !== 'fail') || !Array.isArray(item.decisions)) {
    fail('INVALID_CONTRACT', 'V2 report is invalid');
  }
  const binding = parseBinding(item),
    expected = binding.policyMatrix.flatMap((profile) =>
      profile.targets.map((target) => `${profile.profile}|${target.target}|${target.decision}`),
    );
  if (item.decisions.length !== expected.length || item.decisions.length > 32) {
    fail('POLICY_EVIDENCE_INVALID', 'decisions are incomplete');
  }
  const decisions = item.decisions.map((raw, index) => {
    const entry = record(raw, `decisions[${index}]`);
    exact(entry, ['profile', 'target', 'decision', 'count'], `decisions[${index}]`);
    if (
      `${entry.profile}|${entry.target}|${entry.decision}` !== expected[index] ||
      entry.count !== 1
    ) {
      fail('POLICY_EVIDENCE_INVALID', 'decision mismatch');
    }
    return Object.freeze({
      profile: entry.profile as F2PolicyProfileV1['profile'],
      target: entry.target as string,
      decision: entry.decision as F2PolicyDecision,
      count: entry.count as number,
    });
  });
  const parsed = {
    schemaVersion: 2 as const,
    reportKey: sha(item.reportKey, 'reportKey'),
    planExportKey: sha(item.planExportKey, 'planExportKey'),
    ...binding,
    decisions: Object.freeze(decisions),
    builtInClaudeEvidence: claudeEvidence(item.builtInClaudeEvidence),
    verdict: item.verdict as 'pass' | 'fail',
  };
  const { reportKey, ...tuple } = parsed;
  if (reportKey !== hash(tuple)) {
    fail('HASH_MISMATCH', 'report key does not match content');
  }
  return Object.freeze(parsed);
}
export function validateF2ProofReportV2(
  value: unknown,
  planValue: unknown,
): { valid: boolean; diagnostics: readonly { code: string }[] } {
  try {
    const report = parseF2ProofReportV2(value),
      plan = parseSbxLaunchPlanExportV1(planValue);
    const {
      schemaVersion: _v,
      reportKey: _r,
      decisions: _d,
      builtInClaudeEvidence: _c,
      verdict: _o,
      ...reportBinding
    } = report;
    const { schemaVersion: _pv, exportKey, ...planBinding } = plan;
    const valid =
      report.verdict === 'pass' &&
      report.planExportKey === exportKey &&
      stable(reportBinding) === stable({ planExportKey: exportKey, ...planBinding });
    return Object.freeze({
      valid,
      diagnostics: Object.freeze(valid ? [] : [{ code: 'PLAN_EXPORT_MISMATCH' }]),
    });
  } catch {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([{ code: 'PROOF_V2_REQUIRED' }]),
    });
  }
}
