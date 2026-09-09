import { isSafeRouteLabel, MODE_RESOURCES, RESOURCE_ACCESS } from '@mpx/config';
import { isValidSkillArtifactReference, MpxError, sha256Canonical } from '@mpx/core';
import type { JsonValue, SkillArtifactReference } from '@mpx/core';
import { parseSkillSelection } from '@mpx/runtime-contracts';
import { canonicalRuntimeArgs } from './runtime-args.js';
import type { EffectiveExecutor, LaunchDescriptor } from './types.js';

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

const digestPattern = /^[a-f0-9]{64}$/u;
const labelPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const projectIdPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${label} must be a SHA-256 digest.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function label(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!labelPattern.test(result)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${field} is invalid.`);
  }
  return result;
}

function routeLabel(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!isSafeRouteLabel(result)) {
    fail('LAUNCH_DESCRIPTOR_PRIVATE_ROUTE', 'Routes must contain opaque labels only.');
  }
  return result;
}

function literal<T extends string | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${field} is invalid.`);
  }
  return expected;
}

function fixedStrings(
  value: unknown,
  expected: readonly string[],
  field: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', `${field} is invalid.`);
  }
  return [...expected];
}

function parseExecutor(value: unknown): LaunchDescriptor['executor'] {
  const item = record(value, 'executor');
  const common = [
    'name',
    'effectiveEnforcement',
    'isolation',
    'interception',
    'mounts',
    'confidentiality',
  ];
  if (item.name === 'docker') {
    exact(item, [...common, 'availability'], 'executor');
    if (!['available', 'unavailable', 'unverified'].includes(item.availability as string)) {
      fail('LAUNCH_DESCRIPTOR_INVALID', 'executor.availability is invalid.');
    }
  } else if (item.name === 'host') {
    exact(item, common, 'executor');
  } else {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'executor.name is invalid.');
  }
  const interception = exact(
    item.interception,
    ['kind', 'intercepted', 'knownBypasses'],
    'executor.interception',
  );
  const mounts = exact(item.mounts, ['kind', 'policyEnforced'], 'executor.mounts');
  const confidentiality = exact(
    item.confidentiality,
    ['isolated', 'hostReadable', 'limitation'],
    'executor.confidentiality',
  );

  if (item.name === 'host') {
    const result: EffectiveExecutor = {
      name: 'host',
      effectiveEnforcement: literal(
        item.effectiveEnforcement,
        'advisory',
        'executor.effectiveEnforcement',
      ),
      isolation: literal(item.isolation, 'none', 'executor.isolation'),
      interception: {
        kind: literal(interception.kind, 'policy-hooks', 'executor.interception.kind'),
        intercepted: fixedStrings(
          interception.intercepted,
          ['mpx-mediated-operations'],
          'executor.interception.intercepted',
        ) as ['mpx-mediated-operations'],
        knownBypasses: fixedStrings(
          interception.knownBypasses,
          ['raw-shell', 'direct-filesystem', 'unmanaged-children'],
          'executor.interception.knownBypasses',
        ) as ['raw-shell', 'direct-filesystem', 'unmanaged-children'],
      },
      mounts: {
        kind: literal(mounts.kind, 'host-direct', 'executor.mounts.kind'),
        policyEnforced: literal(mounts.policyEnforced, false, 'executor.mounts.policyEnforced'),
      },
      confidentiality: {
        isolated: literal(confidentiality.isolated, false, 'executor.confidentiality.isolated'),
        hostReadable: literal(
          confidentiality.hostReadable,
          true,
          'executor.confidentiality.hostReadable',
        ),
        limitation: literal(
          confidentiality.limitation,
          'No filesystem or confidentiality isolation is enforced.',
          'executor.confidentiality.limitation',
        ),
      },
    };
    return result;
  }

  return {
    name: 'docker',
    effectiveEnforcement: literal(
      item.effectiveEnforcement,
      'mount-enforced',
      'executor.effectiveEnforcement',
    ),
    isolation: literal(item.isolation, 'container', 'executor.isolation'),
    interception: {
      kind: literal(interception.kind, 'container-boundary', 'executor.interception.kind'),
      intercepted: fixedStrings(
        interception.intercepted,
        ['container-filesystem', 'declared-mounts'],
        'executor.interception.intercepted',
      ) as ['container-filesystem', 'declared-mounts'],
      knownBypasses: fixedStrings(
        interception.knownBypasses,
        ['host-services', 'direct-extra-mounts'],
        'executor.interception.knownBypasses',
      ) as ['host-services', 'direct-extra-mounts'],
    },
    mounts: {
      kind: literal(mounts.kind, 'explicit', 'executor.mounts.kind'),
      policyEnforced: literal(mounts.policyEnforced, true, 'executor.mounts.policyEnforced'),
    },
    confidentiality: {
      isolated: literal(
        confidentiality.isolated,
        'mount-dependent',
        'executor.confidentiality.isolated',
      ),
      hostReadable: literal(
        confidentiality.hostReadable,
        true,
        'executor.confidentiality.hostReadable',
      ),
      limitation: literal(
        confidentiality.limitation,
        'Mounted content, host services, and direct extra mounts remain confidentiality limitations.',
        'executor.confidentiality.limitation',
      ),
    },
    availability: item.availability as 'available' | 'unavailable' | 'unverified',
  };
}

function parseNetworkPolicy(value: unknown): LaunchDescriptor['networkPolicy'] {
  const item = exact(value, ['name', 'declaration'], 'networkPolicy');
  const declaration = exact(
    item.declaration,
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
  const result: Record<string, string | boolean> = {};
  for (const field of [
    'denyPrivateNetworks',
    'approvedProjectAdditions',
    'approvedDeliveryAdditions',
    'requiredRuntimeEndpoints',
  ]) {
    if (declaration[field] !== undefined) {
      if (typeof declaration[field] !== 'boolean') {
        fail('LAUNCH_DESCRIPTOR_INVALID', `networkPolicy.declaration.${field} is invalid.`);
      }
      result[field] = declaration[field];
    }
  }
  if (declaration.preset !== undefined) {
    if (!['allow-all', 'balanced', 'deny-all'].includes(declaration.preset as string)) {
      fail('LAUNCH_DESCRIPTOR_INVALID', 'networkPolicy.declaration.preset is invalid.');
    }
    result.preset = declaration.preset as string;
  }
  if (declaration.extends !== undefined) {
    result.extends = label(declaration.extends, 'networkPolicy.declaration.extends');
  }
  return { name: label(item.name, 'networkPolicy.name'), declaration: result };
}

function parseResources(value: unknown): LaunchDescriptor['intendedPolicy']['resources'] {
  const item = record(value, 'intendedPolicy.resources');
  if (Object.keys(item).length === 0) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'intendedPolicy.resources must not be empty.');
  }
  const result: Record<string, 'read-only' | 'read-write' | 'staged-write'> = {};
  for (const [resource, access] of Object.entries(item)) {
    if (!MODE_RESOURCES.includes(resource as (typeof MODE_RESOURCES)[number])) {
      fail(
        'LAUNCH_DESCRIPTOR_INVALID',
        `intendedPolicy.resources contains invalid resource '${resource}'.`,
      );
    }
    if (!RESOURCE_ACCESS.includes(access as (typeof RESOURCE_ACCESS)[number])) {
      fail('LAUNCH_DESCRIPTOR_INVALID', `intendedPolicy.resources.${resource} is invalid.`);
    }
    result[resource] = access as 'read-only' | 'read-write' | 'staged-write';
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

/** Parses only launch descriptor schema v3. Unknown fields and stale launch keys fail closed. */
export function parseLaunchDescriptor(value: unknown): LaunchDescriptor {
  const item = exact(
    value,
    [
      'schemaVersion',
      'launchKey',
      'nativeRuntimeRootDigest',
      'runtime',
      'runtimeArgs',
      'binding',
      'identity',
      'mode',
      'selection',
      'executor',
      'workspace',
      'networkPolicy',
      'preset',
      'provenance',
      'diagnostics',
      'cwdClassification',
      'routes',
      'intendedPolicy',
      'skillArtifact',
      'elevationAudit',
    ],
    'launch descriptor',
    ['runtimeArgs'],
  );
  if (item.schemaVersion !== 3) {
    fail('LAUNCH_DESCRIPTOR_VERSION_UNSUPPORTED', 'Only launch descriptor schema v3 is supported.');
  }
  const launchKey = digest(item.launchKey, 'launchKey');
  const nativeRuntimeRootDigest = digest(item.nativeRuntimeRootDigest, 'nativeRuntimeRootDigest');
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'runtime is invalid.');
  }
  const runtimeArgs =
    item.runtimeArgs === undefined ? undefined : canonicalRuntimeArgs(item.runtimeArgs);

  const binding = exact(item.binding, ['projectId', 'repositoryId'], 'binding');
  if (
    (binding.projectId !== null &&
      (typeof binding.projectId !== 'string' || !projectIdPattern.test(binding.projectId))) ||
    typeof binding.repositoryId !== 'string' ||
    (binding.repositoryId !== 'unbound' && !projectIdPattern.test(binding.repositoryId))
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'binding identifiers are invalid.');
  }
  const identity = exact(item.identity, ['name', 'domain'], 'identity');
  const normalizedIdentity = {
    name: label(identity.name, 'identity.name'),
    domain: label(identity.domain, 'identity.domain'),
  };
  const mode = label(item.mode, 'mode');
  const selection = parseSkillSelection(item.selection, (code, message) =>
    fail(
      code === 'UNKNOWN_FIELD' ? 'LAUNCH_DESCRIPTOR_UNKNOWN_FIELD' : 'LAUNCH_DESCRIPTOR_INVALID',
      message,
    ),
  );
  const executor = parseExecutor(item.executor);
  if (!['clone', 'host-worktree', 'direct'].includes(item.workspace as string)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'workspace is invalid.');
  }
  const workspace = item.workspace as LaunchDescriptor['workspace'];
  const networkPolicy = parseNetworkPolicy(item.networkPolicy);
  const preset = item.preset === null ? null : label(item.preset, 'preset');

  const provenanceItem = exact(
    item.provenance,
    ['runtime', 'identity', 'mode', 'executor', 'workspace', 'networkPolicy'],
    'provenance',
  );
  const provenanceValues = [
    'explicit',
    'user-project',
    'user-location',
    'built-in',
    'automatic-fallback',
  ];
  if (
    Object.values(provenanceItem).some((source) => !provenanceValues.includes(source as string))
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'provenance contains an invalid source.');
  }
  const provenance = provenanceItem as unknown as LaunchDescriptor['provenance'];
  if (
    provenance.runtime !== 'explicit' ||
    provenance.identity !== 'explicit' ||
    (executor.name === 'host' && provenance.executor !== 'explicit')
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'provenance is inconsistent with launch authority.');
  }

  if (!Array.isArray(item.diagnostics) || item.diagnostics.length > 32) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'diagnostics must be a bounded array.');
  }
  const diagnostics = item.diagnostics.map((entry, index) => {
    const diagnostic = exact(
      entry,
      ['code', 'severity', 'status', 'message', 'remediation'],
      `diagnostics[${index}]`,
    );
    if (
      diagnostic.severity !== 'warning' ||
      (diagnostic.status !== 'projected' && diagnostic.status !== 'unverified')
    ) {
      fail('LAUNCH_DESCRIPTOR_INVALID', `diagnostics[${index}] is invalid.`);
    }
    return {
      code: text(diagnostic.code, `diagnostics[${index}].code`, 128),
      severity: 'warning' as const,
      status: diagnostic.status,
      message: text(diagnostic.message, `diagnostics[${index}].message`, 2048),
      remediation: text(diagnostic.remediation, `diagnostics[${index}].remediation`, 2048),
    };
  });

  const cwd = exact(
    item.cwdClassification,
    ['domain', 'location', 'applicableResource'],
    'cwdClassification',
    ['applicableResource'],
  );
  const applicableResource = cwd.applicableResource;
  if (
    applicableResource !== undefined &&
    ![
      'cloned-repositories',
      'computer-control-config',
      'computer-control-executable-settings',
    ].includes(applicableResource as string)
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'cwdClassification.applicableResource is invalid.');
  }
  const cwdClassification = {
    domain: label(cwd.domain, 'cwdClassification.domain'),
    location: label(cwd.location, 'cwdClassification.location'),
    ...(applicableResource === undefined
      ? {}
      : { applicableResource: applicableResource as string }),
  };

  const routesItem = exact(item.routes, ['gitAuthor', 'providers', 'ssh', 'mcp'], 'routes');
  const providersItem = record(routesItem.providers, 'routes.providers');
  if (Object.keys(providersItem).length > 64) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'routes.providers is too large.');
  }
  const providers = Object.fromEntries(
    Object.entries(providersItem)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, route]) => [label(provider, 'routes provider'), routeLabel(route, 'route')]),
  );
  const mcpItem = exact(routesItem.mcp, ['allow', 'shareNativeAuth'], 'routes.mcp');
  if (
    !Array.isArray(mcpItem.allow) ||
    mcpItem.allow.length > 64 ||
    new Set(mcpItem.allow).size !== mcpItem.allow.length
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'routes.mcp.allow is invalid.');
  }
  const mcpAllow = mcpItem.allow.map((route) => routeLabel(route, 'routes.mcp.allow'));
  const routes = {
    gitAuthor: routeLabel(routesItem.gitAuthor, 'routes.gitAuthor'),
    providers,
    ssh: routesItem.ssh === null ? null : routeLabel(routesItem.ssh, 'routes.ssh'),
    mcp: {
      allow: [...mcpAllow].sort(),
      shareNativeAuth: literal(mcpItem.shareNativeAuth, false, 'routes.mcp.shareNativeAuth'),
    },
  };

  const intendedItem = exact(
    item.intendedPolicy,
    ['mode', 'resources', 'inputsDigest'],
    'intendedPolicy',
  );
  const intendedPolicy = {
    mode: label(intendedItem.mode, 'intendedPolicy.mode'),
    resources: parseResources(intendedItem.resources),
    inputsDigest: digest(intendedItem.inputsDigest, 'intendedPolicy.inputsDigest'),
  };
  if (intendedPolicy.mode !== mode) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'intendedPolicy.mode must match descriptor.mode.');
  }

  if (!isValidSkillArtifactReference(item.skillArtifact)) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'skillArtifact is invalid.');
  }
  const skillArtifact: SkillArtifactReference = { ...item.skillArtifact };
  if (
    skillArtifact.runtime !== item.runtime ||
    skillArtifact.identity !== normalizedIdentity.name ||
    skillArtifact.projectId !== binding.projectId ||
    skillArtifact.repositoryId !== binding.repositoryId ||
    sha256Canonical({
      location: skillArtifact.location,
      packs: [...skillArtifact.packs],
      source: skillArtifact.selectionSource,
    }) !== sha256Canonical(selection as unknown as JsonValue)
  ) {
    fail(
      'SKILL_ARTIFACT_BINDING_MISMATCH',
      'Skill artifact binding does not match the launch descriptor.',
    );
  }

  const elevationItem = exact(
    item.elevationAudit,
    ['elevated', 'reason', 'approvalsDigest', 'banner'],
    'elevationAudit',
  );
  const shouldBeElevated = executor.name === 'host' || mode === 'unrestricted';
  if (elevationItem.elevated !== shouldBeElevated) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'elevationAudit.elevated is inconsistent.');
  }
  const reason = shouldBeElevated ? text(elevationItem.reason, 'elevationAudit.reason', 256) : null;
  if (!shouldBeElevated && elevationItem.reason !== null) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'elevationAudit.reason must be null.');
  }
  const approvalsDigest = digest(elevationItem.approvalsDigest, 'elevationAudit.approvalsDigest');
  if (
    !shouldBeElevated &&
    approvalsDigest !== sha256Canonical({ unrestricted: null, host: null })
  ) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'elevationAudit.approvalsDigest is inconsistent.');
  }
  let banner: LaunchDescriptor['elevationAudit']['banner'] = null;
  if (shouldBeElevated) {
    const bannerItem = exact(
      elevationItem.banner,
      ['code', 'persistent', 'message'],
      'elevationAudit.banner',
    );
    const targets = [
      ...(executor.name === 'host' ? ['host-compatibility'] : []),
      ...(mode === 'unrestricted' ? ['unrestricted'] : []),
    ];
    banner = {
      code: literal(bannerItem.code, 'ELEVATED_LAUNCH', 'elevationAudit.banner.code'),
      persistent: literal(bannerItem.persistent, true, 'elevationAudit.banner.persistent'),
      message: literal(
        bannerItem.message,
        `ELEVATED LAUNCH — ${targets.join(', ')} — ${reason}`,
        'elevationAudit.banner.message',
      ),
    };
  } else if (elevationItem.banner !== null) {
    fail('LAUNCH_DESCRIPTOR_INVALID', 'elevationAudit.banner must be null.');
  }

  const tuple = {
    schemaVersion: 3 as const,
    nativeRuntimeRootDigest,
    runtime: item.runtime,
    ...(runtimeArgs === undefined || runtimeArgs.length === 0 ? {} : { runtimeArgs }),
    binding: { projectId: binding.projectId as string | null, repositoryId: binding.repositoryId },
    identity: normalizedIdentity,
    mode,
    selection,
    executor,
    workspace,
    networkPolicy,
    preset,
    provenance,
    diagnostics,
    cwdClassification,
    routes,
    intendedPolicy,
    skillArtifact,
    elevationAudit: { elevated: shouldBeElevated, reason, approvalsDigest, banner },
  };
  if (sha256Canonical(tuple as unknown as JsonValue) !== launchKey) {
    fail('LAUNCH_KEY_MISMATCH', 'Launch descriptor content does not match launchKey.');
  }
  return deepFreeze({ ...tuple, launchKey }) as LaunchDescriptor;
}
