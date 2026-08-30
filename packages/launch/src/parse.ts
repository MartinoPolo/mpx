import { isSafeRouteLabel } from '@mpx/config';
import { MpxError, sha256Canonical } from '@mpx/core';
import type { JsonValue } from '@mpx/core';
import type { LaunchDescriptor } from './types.js';

function fail(code: string, message: string): never {
  throw new MpxError({ code, message });
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const item = record(value, label);
  const extra = Object.keys(item).find((key) => !keys.includes(key));
  if (extra) {
    fail('LAUNCH_DESCRIPTOR_UNKNOWN_FIELD', `${label} contains unknown field '${extra}'.`);
  }
  const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(item, key));
  if (missing) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${label} is missing '${missing}'.`);
  }
  return item;
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}
const digest = /^[a-f0-9]{64}$/u;
function requireDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !digest.test(value)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${label} must be a SHA-256 digest.`);
  }
}

/** Parses only the public schema. Unknown fields are rejected and launchKey is always recomputed. */
export function parseLaunchDescriptorV2(value: unknown): LaunchDescriptor {
  const keys = [
    'schemaVersion',
    'launchKey',
    'nativeRuntimeRootDigest',
    'runtime',
    'binding',
    'identity',
    'mode',
    'skillPolicy',
    'executor',
    'executorVerification',
    'workspace',
    'networkPolicy',
    'preset',
    'provenance',
    'diagnostics',
    'contentScope',
    'grants',
    'cwdClassification',
    'routes',
    'intendedPolicy',
    'skillArtifact',
    'elevationAudit',
  ] as const;
  const item = exact(value, keys, 'launch descriptor');
  if (item.schemaVersion !== 2) {
    fail('LAUNCH_DESCRIPTOR_VERSION_UNSUPPORTED', 'Only launch descriptor schema v2 is supported.');
  }
  requireDigest(item.launchKey, 'launchKey');
  requireDigest(item.nativeRuntimeRootDigest, 'nativeRuntimeRootDigest');
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'runtime is invalid.');
  }
  const binding = exact(item.binding, ['projectId', 'repositoryId'], 'binding');
  if (
    (binding.projectId !== null && typeof binding.projectId !== 'string') ||
    typeof binding.repositoryId !== 'string'
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'binding identifiers are invalid.');
  }
  exact(item.identity, ['name', 'domain'], 'identity');
  const executor = record(item.executor, 'executor');
  if (executor.name === 'docker') {
    exact(
      executor,
      [
        'name',
        'effectiveEnforcement',
        'isolation',
        'interception',
        'mounts',
        'confidentiality',
        'availability',
      ],
      'executor',
    );
  } else if (executor.name === 'host') {
    exact(
      executor,
      ['name', 'effectiveEnforcement', 'isolation', 'interception', 'mounts', 'confidentiality'],
      'executor',
    );
  } else {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'executor name is invalid.');
  }
  exact(executor.interception, ['kind', 'intercepted', 'knownBypasses'], 'executor.interception');
  exact(executor.mounts, ['kind', 'policyEnforced'], 'executor.mounts');
  exact(
    executor.confidentiality,
    ['isolated', 'hostReadable', 'limitation'],
    'executor.confidentiality',
  );
  const evidence = exact(
    item.executorVerification,
    ['status', 'verifier', 'evidenceDigest'],
    'executorVerification',
  );
  requireDigest(evidence.evidenceDigest, 'executorVerification.evidenceDigest');
  if (
    !['verified', 'unverified', 'unavailable'].includes(evidence.status as string) ||
    typeof evidence.verifier !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(evidence.verifier)
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'executorVerification fields are invalid.');
  }
  exact(item.networkPolicy, ['name', 'declaration'], 'networkPolicy');
  exact(
    record(item.networkPolicy, 'networkPolicy').declaration,
    [
      'preset',
      'extends',
      'denyPrivateNetworks',
      'approvedProjectAdditions',
      'approvedDeliveryAdditions',
      'requiredRuntimeEndpoints',
    ],
    'networkPolicy.declaration',
    [
      'preset',
      'extends',
      'denyPrivateNetworks',
      'approvedProjectAdditions',
      'approvedDeliveryAdditions',
      'requiredRuntimeEndpoints',
    ],
  );
  if (!Array.isArray(item.diagnostics) || !Array.isArray(item.grants)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'diagnostics and grants must be arrays.');
  }
  item.diagnostics.forEach((entry, index) =>
    exact(entry, ['code', 'severity', 'status', 'message', 'remediation'], `diagnostics[${index}]`),
  );
  item.grants.forEach((entry, index) => exact(entry, ['access', 'resource'], `grants[${index}]`));
  exact(item.contentScope, ['name'], 'contentScope');
  exact(item.cwdClassification, ['domain', 'contentScope'], 'cwdClassification');
  exact(
    item.provenance,
    [
      'runtime',
      'identity',
      'mode',
      'skillPolicy',
      'contentScope',
      'executor',
      'workspace',
      'networkPolicy',
    ],
    'provenance',
  );
  const routes = exact(item.routes, ['gitAuthor', 'providers', 'ssh', 'mcp'], 'routes');
  const routeLabels = [
    routes.gitAuthor,
    routes.ssh,
    ...Object.values(record(routes.providers, 'routes.providers')),
  ].filter((route) => route !== null);
  const mcp = exact(routes.mcp, ['allow', 'shareNativeAuth'], 'routes.mcp');
  if (!Array.isArray(mcp.allow)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'routes.mcp.allow must be an array.');
  }
  routeLabels.push(...mcp.allow);
  if (routeLabels.some((route) => typeof route !== 'string' || !isSafeRouteLabel(route))) {
    fail('LAUNCH_DESCRIPTOR_PRIVATE_ROUTE', 'Routes must contain opaque labels only.');
  }
  const intended = exact(
    item.intendedPolicy,
    ['mode', 'resources', 'grants', 'inputsDigest', 'approvalsDigest'],
    'intendedPolicy',
  );
  if (!Array.isArray(intended.grants)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'intendedPolicy.grants must be an array.');
  }
  intended.grants.forEach((entry, index) =>
    exact(entry, ['access', 'resource'], `intendedPolicy.grants[${index}]`),
  );
  record(intended.resources, 'intendedPolicy.resources');
  requireDigest(intended.inputsDigest, 'intendedPolicy.inputsDigest');
  requireDigest(intended.approvalsDigest, 'intendedPolicy.approvalsDigest');
  const skill = exact(
    item.skillArtifact,
    [
      'schemaVersion',
      'runtime',
      'identity',
      'skillPolicy',
      'contentScope',
      'projectId',
      'catalogHash',
      'enabledPacks',
      'skillPolicyConfigHash',
      'contentScopeExposureHash',
      'projectExposureHash',
      'effectivePolicyHash',
      'artifactKey',
    ],
    'skillArtifact',
  );
  requireDigest(skill.artifactKey, 'skillArtifact.artifactKey');
  const elevation = exact(
    item.elevationAudit,
    ['elevated', 'reason', 'approvalsDigest', 'banner'],
    'elevationAudit',
  );
  if (elevation.banner !== null) {
    exact(elevation.banner, ['code', 'persistent', 'message'], 'elevationAudit.banner');
  }
  const serialized = JSON.stringify(item);
  if (
    /[A-Za-z]:[\\/]/u.test(serialized) ||
    /(?:token|secret|password|private[_-]?key)\s*[=:]\s*(?!\[redacted\])/iu.test(serialized)
  ) {
    fail(
      'LAUNCH_DESCRIPTOR_PRIVATE_DATA',
      'Launch descriptors may not contain native paths or secret payloads.',
    );
  }
  const { launchKey, ...tuple } = item;
  if (sha256Canonical(tuple as JsonValue) !== launchKey) {
    fail('LAUNCH_KEY_MISMATCH', 'Launch descriptor content does not match launchKey.');
  }
  return deepFreeze(structuredClone(item)) as unknown as LaunchDescriptor;
}
