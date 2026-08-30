import { sha256Canonical, type JsonValue } from '@mpx/core';
import { ExecutionError } from './index.js';
export type SbxPolicyName =
  'open' | 'deny-all' | 'minimal' | 'implementation' | 'delivery' | 'research';
export interface NamedSbxPolicy {
  readonly default: 'allow' | 'deny';
  readonly allow: readonly string[];
}
export const namedSbxPolicies: Readonly<Record<SbxPolicyName, NamedSbxPolicy>> = Object.freeze({
  open: Object.freeze({ default: 'allow', allow: Object.freeze([]) }),
  'deny-all': Object.freeze({ default: 'deny', allow: Object.freeze([]) }),
  minimal: Object.freeze({
    default: 'deny',
    allow: Object.freeze(['api.anthropic.com:443', 'api.openai.com:443']),
  }),
  implementation: Object.freeze({
    default: 'deny',
    allow: Object.freeze([
      'api.anthropic.com:443',
      'api.github.com:443',
      'api.openai.com:443',
      'github.com:443',
      'registry.npmjs.org:443',
    ]),
  }),
  delivery: Object.freeze({
    default: 'deny',
    allow: Object.freeze(['api.github.com:443', 'github.com:443']),
  }),
  research: Object.freeze({
    default: 'deny',
    allow: Object.freeze(['api.anthropic.com:443', 'api.openai.com:443', 'github.com:443']),
  }),
});
type Decision = 'allow' | 'deny';
export interface F2ProofPolicyProfile {
  readonly profile: SbxPolicyName;
  readonly default: 'allow' | 'deny';
  readonly targets: readonly { readonly target: string; readonly decision: Decision }[];
}
export interface SbxPolicyPlan {
  readonly profile: SbxPolicyName;
  readonly apply: readonly (readonly string[])[];
  readonly checks: readonly {
    readonly target: string;
    readonly decision: Decision;
    readonly argv: readonly string[];
  }[];
}
/** The single authority for production and proof policy materialization and inspection. */
export function buildSbxPolicyPlan(
  sandboxName: string,
  profile: SbxPolicyName,
  allow: readonly string[] = namedSbxPolicies[profile]?.allow ?? [],
): SbxPolicyPlan {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(sandboxName) || !namedSbxPolicies[profile]) {
    throw new ExecutionError(
      'POLICY_EVIDENCE_INVALID',
      'POLICY_EVIDENCE_INVALID: policy plan binding is invalid.',
    );
  }
  const expected = [...new Set(allow)].sort();
  if (
    expected.some((value) => !target.test(value)) ||
    expected.some((value) => !namedSbxPolicies[profile].allow.includes(value))
  ) {
    throw new ExecutionError(
      'POLICY_EVIDENCE_INVALID',
      'POLICY_EVIDENCE_INVALID: selected targets exceed the logical policy.',
    );
  }
  const policy = namedSbxPolicies[profile];
  const apply =
    policy.default === 'allow' || expected.length === 0
      ? []
      : [['policy', 'allow', 'network', '--sandbox', sandboxName, ...expected] as const];
  const checks =
    policy.default === 'allow'
      ? [
          Object.freeze({
            target: 'example.com:443',
            decision: 'allow' as const,
            argv: Object.freeze([
              'policy',
              'check',
              'network',
              '--sandbox',
              sandboxName,
              'example.com:443',
              '--json',
            ]),
          }),
        ]
      : [
          ...expected.map((value) =>
            Object.freeze({
              target: value,
              decision: 'allow' as const,
              argv: Object.freeze([
                'policy',
                'check',
                'network',
                '--sandbox',
                sandboxName,
                value,
                '--json',
              ]),
            }),
          ),
          Object.freeze({
            target: 'blocked.invalid:443',
            decision: 'deny' as const,
            argv: Object.freeze([
              'policy',
              'check',
              'network',
              '--sandbox',
              sandboxName,
              'blocked.invalid:443',
              '--json',
            ]),
          }),
        ];
  return Object.freeze({
    profile,
    apply: Object.freeze(apply.map((item) => Object.freeze(item))),
    checks: Object.freeze(checks),
  });
}
/** Builds proof checks only for the profile selected when this sandbox is created. */
export function buildF2ProofPolicyMatrix(profile: SbxPolicyName): readonly F2ProofPolicyProfile[] {
  const policy = namedSbxPolicies[profile];
  if (!policy) {
    throw new ExecutionError(
      'POLICY_EVIDENCE_INVALID',
      'POLICY_EVIDENCE_INVALID: selected profile is unknown.',
    );
  }
  const targets = (
    policy.default === 'allow'
      ? [{ target: 'example.com:443', decision: 'allow' as const }]
      : [
          ...policy.allow.map((target) => ({ target, decision: 'allow' as const })),
          { target: 'blocked.invalid:443', decision: 'deny' as const },
        ]
  ).sort((a, b) => a.target.localeCompare(b.target));
  return Object.freeze([
    Object.freeze({ profile, default: policy.default, targets: Object.freeze(targets) }),
  ]);
}
interface PolicyCheckResult {
  readonly target: string;
  readonly exitCode: number;
  readonly stdout: string;
}
const target = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:(?:[1-9]\d{0,4})$/u;
const responseFields = new Set([
  'action',
  'allowed',
  'resource_value',
  'type',
  'deny_kind',
  'reason',
  'rule',
]);
function invalid(message: string): never {
  throw new ExecutionError('POLICY_EVIDENCE_INVALID', `POLICY_EVIDENCE_INVALID: ${message}`);
}
function boundedOptional(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/u.test(value))
  );
}
export function parsePolicyEvidence(input: {
  expected: readonly { target: string; decision: Decision }[];
  checks: readonly PolicyCheckResult[];
}): {
  verdict: 'pass';
  evidenceSha256: string;
  decisions: readonly { target: string; decision: Decision; count: 1 }[];
} {
  if (Object.keys(input).some((key) => key !== 'expected' && key !== 'checks')) {
    invalid('policy logs and unknown evidence fields are not evaluator proof.');
  }
  if (
    input.expected.length === 0 ||
    input.expected.length > 32 ||
    input.checks.length !== input.expected.length
  ) {
    invalid('policy evidence is incomplete.');
  }
  const expected = [...input.expected].sort((a, b) => a.target.localeCompare(b.target)),
    checks = [...input.checks].sort((a, b) => a.target.localeCompare(b.target));
  if (
    expected.some(
      (item, index) =>
        !target.test(item.target) ||
        (item.decision !== 'allow' && item.decision !== 'deny') ||
        (index > 0 && expected[index - 1]!.target === item.target),
    )
  ) {
    invalid('policy target is invalid.');
  }
  const decisions = expected.map((want, index) => {
    const check = checks[index];
    if (
      !check ||
      check.target !== want.target ||
      !Number.isSafeInteger(check.exitCode) ||
      check.exitCode < 0 ||
      check.exitCode > 255 ||
      typeof check.stdout !== 'string' ||
      Buffer.byteLength(check.stdout, 'utf8') > 65536
    ) {
      invalid('policy check result is malformed.');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(check.stdout);
    } catch {
      invalid('policy check JSON is malformed.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid('policy check JSON must be an object.');
    }
    const result = raw as Record<string, unknown>;
    if (
      Object.keys(result).some((key) => !responseFields.has(key)) ||
      !['action', 'allowed', 'resource_value', 'type'].every((key) => Object.hasOwn(result, key))
    ) {
      invalid('policy check JSON fields are invalid.');
    }
    if (
      result.action !== 'net:connect:tcp' ||
      result.type !== 'network' ||
      result.resource_value !== want.target ||
      typeof result.allowed !== 'boolean' ||
      !boundedOptional(result.deny_kind) ||
      !boundedOptional(result.reason) ||
      !boundedOptional(result.rule)
    ) {
      invalid('policy check JSON does not describe the requested network resource.');
    }
    const decision: Decision = result.allowed ? 'allow' : 'deny';
    if (
      decision !== want.decision ||
      (decision === 'allow' ? check.exitCode !== 0 : check.exitCode === 0)
    ) {
      invalid('policy check decision or exit status is invalid.');
    }
    if (
      decision === 'allow' &&
      (result.deny_kind !== undefined || result.reason !== undefined || result.rule !== undefined)
    ) {
      invalid('allowed response contains denial fields.');
    }
    return Object.freeze({ target: want.target, decision, count: 1 as const });
  });
  const normalized = Object.freeze(decisions);
  return Object.freeze({
    verdict: 'pass',
    evidenceSha256: sha256Canonical({ expected, decisions: normalized } as unknown as JsonValue),
    decisions: normalized,
  });
}
export function verifyNoSharedSkillsMounts(
  mounts: readonly { source: string; target: string }[],
): void {
  if (
    mounts.some(
      (m) =>
        /(?:^|[\\/])(?:\.claude|\.pi|skills)(?:[\\/]|$)/iu.test(m.source) ||
        /(?:^|\/)skills(?:\/|$)/iu.test(m.target),
    )
  ) {
    throw new ExecutionError(
      'SHARED_SKILLS_MOUNTED',
      'SHARED_SKILLS_MOUNTED: mount inspection found shared host skills.',
    );
  }
}
