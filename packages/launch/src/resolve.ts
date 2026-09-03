import {
  isSafeRouteLabel,
  resolveEffectiveSkillPacks,
  resolveKnownLaunchCwdClassification,
} from '@mpx/config';
import type { NetworkPolicyConfig } from '@mpx/config';
import {
  canonicalSkillArtifactReference,
  isValidSkillArtifactReference,
  MpxError,
  sha256Canonical,
} from '@mpx/core';
import type { JsonValue } from '@mpx/core';
import path from 'node:path';
import { canonicalRuntimeArgs } from './runtime-args.js';
import type {
  EffectiveExecutor,
  LaunchDescriptor,
  LaunchGrant,
  LaunchProvenance,
  LaunchSelection,
  ResolveLaunchInput,
  ResolveLaunchSelectionInput,
  ShortLaunchAlias,
} from './types.js';

const resourcePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function fail(code: string, message: string, remediation?: string): never {
  throw new MpxError({ code, message, ...(remediation ? { remediation } : {}) });
}

export function parseGrant(value: string): LaunchGrant {
  const match = /^(?:(ro|rw):)?(.+)$/u.exec(value);
  const access = match?.[1] ?? 'ro';
  const resource = match?.[2];
  if (!resource || !resourcePattern.test(resource)) {
    fail(
      'GRANT_INVALID',
      `Invalid grant '${value}'.`,
      'Use ro:<resource> or rw:<resource>; omitted access defaults to ro.',
    );
  }
  return { access: access as 'ro' | 'rw', resource };
}

function normalizeGrants(values: readonly string[]): LaunchGrant[] {
  const byResource = new Map<string, LaunchGrant>();
  for (const value of values) {
    const grant = parseGrant(value);
    const previous = byResource.get(grant.resource);
    if (previous && previous.access !== grant.access) {
      fail(
        'GRANT_CONFLICT',
        `Resource '${grant.resource}' has contradictory read-only and read/write grants.`,
      );
    }
    byResource.set(grant.resource, grant);
  }
  return [...byResource.values()].sort((left, right) =>
    left.resource.localeCompare(right.resource),
  );
}

function sanitizeReason(value: string): string {
  const compact = value.replace(/[\r\n\t]+/gu, ' ').trim();
  if (!compact) {
    fail('ELEVATION_REASON_REQUIRED', 'Elevation requires a nonempty human reason.');
  }
  return compact
    .replace(/[A-Za-z]:[\\/][^\s,;]+/gu, '[path]')
    .replace(/(token|secret|password|key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 256);
}

const sha256Pattern = /^[a-f0-9]{64}$/u;

function validateSkillArtifact(input: ResolveLaunchInput['skillArtifact']): void {
  if (
    ![input.artifactKey, input.catalogHash, input.effectivePolicyHash].every((value) =>
      sha256Pattern.test(value),
    ) ||
    !isValidSkillArtifactReference(input)
  ) {
    fail(
      'SKILL_ARTIFACT_INVALID',
      'Skill artifact reference is not a valid canonical resolved artifact tuple.',
    );
  }
}

export function canonicalNativeRoot(value: string): string {
  const windows = path.win32.isAbsolute(value);
  if (!windows && !path.posix.isAbsolute(value)) {
    fail('NATIVE_RUNTIME_ROOT_INVALID', 'Selected native runtime root must be absolute.');
  }
  const normalized = windows
    ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.posix.normalize(value);
  return normalized.replace(/\/$/u, '');
}

export function canonicalNativeRootDigest(value: string): string {
  return sha256Canonical(canonicalNativeRoot(value));
}

function routeLabel(value: string, field: string): string {
  if (!isSafeRouteLabel(value)) {
    fail(
      'ROUTE_LABEL_INVALID',
      `${field} must be an opaque route label, not a path or secret payload.`,
    );
  }
  return value;
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

function effectiveExecutor(name: 'host' | 'docker'): EffectiveExecutor {
  return name === 'host'
    ? {
        name,
        effectiveEnforcement: 'advisory',
        isolation: 'none',
        interception: {
          kind: 'policy-hooks',
          intercepted: ['mpx-mediated-operations'],
          knownBypasses: ['raw-shell', 'direct-filesystem', 'unmanaged-children'],
        },
        mounts: { kind: 'host-direct', policyEnforced: false },
        confidentiality: {
          isolated: false,
          hostReadable: true,
          limitation: 'No filesystem or confidentiality isolation is enforced.',
        },
      }
    : {
        name,
        effectiveEnforcement: 'mount-enforced',
        isolation: 'container',
        interception: {
          kind: 'container-boundary',
          intercepted: ['container-filesystem', 'declared-mounts'],
          knownBypasses: ['host-services', 'direct-extra-mounts'],
        },
        mounts: { kind: 'explicit', policyEnforced: true },
        confidentiality: {
          isolated: 'mount-dependent',
          hostReadable: true,
          limitation:
            'Mounted content, host services, and direct extra mounts remain confidentiality limitations.',
        },
      };
}

const aliases = {
  cc: { runtime: 'claude', identity: 'personal' },
  ccw: { runtime: 'claude', identity: 'work' },
  pi: { runtime: 'pi', identity: 'personal' },
  piw: { runtime: 'pi', identity: 'work' },
} as const;

export function resolveLaunchAlias(alias: ShortLaunchAlias): {
  readonly runtime: 'claude' | 'pi';
  readonly identity: 'personal' | 'work';
} {
  return { ...aliases[alias] };
}

const projectIdPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

function resolvedAxis(
  explicit: string | undefined,
  presetValue: string | undefined,
  fallback: string,
): string {
  return explicit ?? presetValue ?? fallback;
}

function inferredModeName(domain: string): string {
  if (domain === 'assistant-input' || domain === 'assistant-output') {
    return 'personal-assistant';
  }
  if (domain === 'computer-control-config' || domain === 'computer-control-executable-settings') {
    return 'computer-control';
  }
  if (domain === 'oss' || domain === 'cloned-repositories') {
    return 'developer';
  }
  return 'project';
}

function effectiveNetworkPolicy(
  name: string,
  policies: ResolveLaunchSelectionInput['userConfig']['networkPolicies'],
): NetworkPolicyConfig {
  const declaration = policies[name];
  if (!declaration) {
    fail('NETWORK_POLICY_UNKNOWN', `Unknown network policy '${name}'.`);
  }
  const parent = declaration.extends ? effectiveNetworkPolicy(declaration.extends, policies) : {};
  return { ...parent, ...structuredClone(declaration) };
}

export async function resolveLaunchSelection(
  input: ResolveLaunchSelectionInput,
): Promise<LaunchSelection> {
  const alias = input.alias === undefined ? undefined : resolveLaunchAlias(input.alias);
  const runtime = input.runtime ?? alias?.runtime;
  if (runtime !== 'claude' && runtime !== 'pi') {
    fail('RUNTIME_REQUIRED', "Launch runtime must be 'claude' or 'pi'.");
  }
  if (alias && input.runtime !== undefined && alias.runtime !== input.runtime) {
    fail('ALIAS_RUNTIME_MISMATCH', `Alias '${input.alias}' selects runtime '${alias.runtime}'.`);
  }
  const identityName = input.identity ?? alias?.identity;
  if (!identityName) {
    fail('IDENTITY_REQUIRED', 'Launch identity must be supplied explicitly or by a short alias.');
  }
  const identity = input.userConfig.identities[identityName];
  if (!identity) {
    fail('IDENTITY_UNKNOWN', `Unknown identity '${identityName}'.`);
  }
  if (input.projectId !== undefined && !projectIdPattern.test(input.projectId)) {
    fail('PROJECT_ID_INVALID', 'Project id must be a canonical owner/repository id.');
  }

  const cwdClassification = await resolveKnownLaunchCwdClassification(input.cwd, input.userConfig);
  let presetName = input.preset;
  let presetSource: LaunchProvenance = 'explicit';
  if (presetName === undefined && input.projectId !== undefined) {
    presetName = input.userConfig.launchDefaults.projects[input.projectId]?.[identityName];
    presetSource = 'user-project';
  }
  if (presetName === undefined) {
    presetName =
      input.userConfig.launchDefaults.scopes[cwdClassification.contentScope]?.[identityName];
    presetSource = 'user-scope';
  }
  const preset = presetName === undefined ? undefined : input.userConfig.presets[presetName];
  if (presetName !== undefined && !preset) {
    fail('PRESET_UNKNOWN', `Unknown preset '${presetName}'.`);
  }
  if (preset && preset.identity !== identityName) {
    fail(
      'PRESET_IDENTITY_MISMATCH',
      `Preset '${presetName}' belongs to identity '${preset.identity}', not '${identityName}'.`,
    );
  }

  const modeName = resolvedAxis(
    input.mode,
    preset?.mode,
    inferredModeName(cwdClassification.domain),
  );
  const skillPolicyName = resolvedAxis(input.skillPolicy, preset?.skillPolicy, 'clean');
  const contentScopeName = resolvedAxis(
    input.contentScope,
    preset?.contentScope,
    cwdClassification.contentScope,
  );
  const executor = resolvedAxis(input.executor, preset?.executor, 'docker') as 'host' | 'docker';
  const workspace = resolvedAxis(input.workspace, preset?.workspace, 'clone') as
    'clone' | 'host-worktree' | 'direct';
  const networkPolicyName = resolvedAxis(
    input.networkPolicy,
    preset?.networkPolicy,
    'implementation',
  );
  const modeDeclaration = input.userConfig.modes[modeName];
  if (!modeDeclaration) {
    fail('MODE_UNKNOWN', `Unknown mode '${modeName}'.`);
  }
  const skillPolicyDeclaration = input.userConfig.skillPolicies[skillPolicyName];
  if (!skillPolicyDeclaration) {
    fail('SKILL_POLICY_UNKNOWN', `Unknown skill policy '${skillPolicyName}'.`);
  }
  if (!input.userConfig.contentScopes[contentScopeName]) {
    fail('CONTENT_SCOPE_UNKNOWN', `Unknown content scope '${contentScopeName}'.`);
  }
  const networkPolicyDeclaration = input.userConfig.networkPolicies[networkPolicyName];
  if (!networkPolicyDeclaration) {
    fail('NETWORK_POLICY_UNKNOWN', `Unknown network policy '${networkPolicyName}'.`);
  }
  if (executor === 'host' && workspace === 'clone') {
    fail('HOST_CLONE_UNSUPPORTED', 'Host execution cannot use clone workspace strategy.');
  }

  const source = (explicit: string | undefined): LaunchProvenance =>
    explicit !== undefined ? 'explicit' : preset ? presetSource : 'built-in';
  const provenance = {
    runtime: 'explicit' as const,
    identity: 'explicit' as const,
    mode: source(input.mode),
    skillPolicy: source(input.skillPolicy),
    contentScope: source(input.contentScope),
    executor: source(input.executor),
    workspace: source(input.workspace),
    networkPolicy: source(input.networkPolicy),
  };
  return deepFreeze({
    runtime,
    identity: { name: identityName, domain: identity.domain },
    mode: { name: modeName, declaration: structuredClone(modeDeclaration) },
    skillPolicy: { name: skillPolicyName, declaration: structuredClone(skillPolicyDeclaration) },
    contentScope: { name: contentScopeName },
    executor,
    workspace,
    networkPolicy: {
      name: networkPolicyName,
      declaration: effectiveNetworkPolicy(networkPolicyName, input.userConfig.networkPolicies),
    },
    preset: presetName ?? null,
    provenance,
    cwdClassification,
  }) as LaunchSelection;
}

export async function resolveLaunch(input: ResolveLaunchInput): Promise<LaunchDescriptor> {
  if (input.repositoryId !== undefined && !projectIdPattern.test(input.repositoryId)) {
    fail('REPOSITORY_ID_INVALID', 'Repository id must be a canonical owner/repository id.');
  }
  const selection = await resolveLaunchSelection(input);
  validateSkillArtifact(input.skillArtifact);
  if (input.skillArtifact.runtime !== selection.runtime) {
    fail(
      'SKILL_ARTIFACT_RUNTIME_MISMATCH',
      'Skill artifact runtime does not match the launch runtime.',
    );
  }
  const identityName = selection.identity.name;
  const identity = input.userConfig.identities[identityName]!;
  const mode = selection.mode.name;
  if (mode === 'project' && input.projectId === undefined) {
    fail('PROJECT_REQUIRED', 'Project mode requires a canonical project id.');
  }
  const modeDeclaration = selection.mode.declaration;
  const skillPolicy = selection.skillPolicy.name;
  const contentScope = selection.contentScope.name;
  const executor = selection.executor;
  const workspace = selection.workspace;
  if (input.skillArtifact.identity !== identityName) {
    fail(
      'SKILL_ARTIFACT_IDENTITY_MISMATCH',
      'Skill artifact identity does not match the resolved launch identity.',
    );
  }
  if (
    input.skillArtifact.skillPolicy !== skillPolicy ||
    input.skillArtifact.skillPolicyConfigHash !==
      sha256Canonical(selection.skillPolicy.declaration as unknown as JsonValue)
  ) {
    fail(
      'SKILL_ARTIFACT_POLICY_MISMATCH',
      'Skill artifact policy does not match the resolved launch policy.',
    );
  }
  if (input.skillArtifact.contentScope !== contentScope) {
    fail(
      'SKILL_ARTIFACT_CONTENT_SCOPE_MISMATCH',
      'Skill artifact content scope does not match the resolved launch content scope.',
    );
  }
  if (input.skillArtifact.projectId !== (input.projectId ?? null)) {
    fail(
      'SKILL_ARTIFACT_PROJECT_MISMATCH',
      'Skill artifact project does not match the resolved launch project.',
    );
  }
  const scope = input.userConfig.contentScopes[contentScope]!;
  const project = input.projectId ? input.userConfig.projects?.[input.projectId] : undefined;
  const expectedPacks = resolveEffectiveSkillPacks({
    contentScopeSkillPacks: scope.skillPacks,
    projectSkillPacks: project?.skillPacks,
    skillPolicySkillPacks: selection.skillPolicy.declaration.skillPacks,
  });
  if (
    JSON.stringify(input.skillArtifact.enabledPacks) !== JSON.stringify(expectedPacks) ||
    input.skillArtifact.contentScopeExposureHash !==
      sha256Canonical((scope.skillExposure ?? {}) as unknown as JsonValue) ||
    input.skillArtifact.projectExposureHash !==
      sha256Canonical((project?.skillExposure ?? null) as unknown as JsonValue)
  ) {
    fail(
      'SKILL_ARTIFACT_POLICY_MISMATCH',
      'Skill artifact effective policy facts do not match the resolved launch configuration.',
    );
  }
  const configuredNativeRoot = canonicalNativeRoot(identity.runtimeRoots[selection.runtime]);
  const selectedNativeRoot = canonicalNativeRoot(input.selectedNativeRuntimeRoot);
  if (selectedNativeRoot !== configuredNativeRoot) {
    fail(
      'NATIVE_RUNTIME_ROOT_MISMATCH',
      'Selected native runtime root does not match the resolved identity runtime root.',
    );
  }
  const nativeRuntimeRootDigest = canonicalNativeRootDigest(selectedNativeRoot);
  const cwdDomain = { status: 'known' as const, domain: selection.cwdClassification.domain };
  const cwdContent = {
    status: 'known' as const,
    contentScope: selection.cwdClassification.contentScope,
  };

  const grants = normalizeGrants(input.grants ?? []);
  const crossDomainGrant =
    identity.domain === cwdDomain.domain
      ? undefined
      : grants.find((grant) => grant.resource === cwdDomain.domain);
  if (input.projectId !== undefined && identity.domain !== cwdDomain.domain && !crossDomainGrant) {
    fail(
      'IDENTITY_DOMAIN_MISMATCH',
      `Identity '${identityName}' cannot launch in domain '${cwdDomain.domain}' without an explicit grant.`,
    );
  }
  const effectiveResources = structuredClone(modeDeclaration.resources);
  if (
    crossDomainGrant &&
    mode === 'project' &&
    crossDomainGrant.access !== 'rw' &&
    effectiveResources['selected-project'] === 'read-write'
  ) {
    effectiveResources['selected-project'] = 'read-only';
  }
  if (executor === 'host' && selection.provenance.executor !== 'explicit') {
    fail(
      'HOST_EXPLICIT_REQUIRED',
      'Host execution is elevated compatibility mode and must be explicitly selected.',
    );
  }
  const elevated = mode === 'unrestricted' || grants.length > 0 || executor === 'host';
  const reason = elevated ? sanitizeReason(input.reason ?? '') : null;
  const approvals = input.grantApprovals ?? [];
  const matchedApprovals = grants.map((grant) => {
    const approved = approvals.find(
      (approval) =>
        approval.access === grant.access &&
        approval.resource === grant.resource &&
        approval.reason.trim() === input.reason?.trim() &&
        approval.reason.trim().length > 0 &&
        sha256Pattern.test(approval.approvalKey),
    );
    if (!approved) {
      fail(
        'GRANT_APPROVAL_REQUIRED',
        `Grant '${grant.access}:${grant.resource}' requires a separate exact trusted approval with the launch reason.`,
        'Confirm the grant through the trusted launch flow and relaunch.',
      );
    }
    return { ...grant, reason, approvalKey: approved.approvalKey };
  });
  let unrestrictedApproval: { reason: string; approvalKey: string } | null = null;
  if (mode === 'unrestricted') {
    const approval = input.elevationApproval;
    if (
      !approval ||
      approval.reason.trim() !== input.reason?.trim() ||
      !approval.reason.trim() ||
      !sha256Pattern.test(approval.approvalKey)
    ) {
      fail(
        'GRANT_APPROVAL_REQUIRED',
        'Unrestricted mode requires a separate exact trusted approval with the launch reason.',
        'Confirm unrestricted elevation through the trusted launch flow and relaunch.',
      );
    }
    unrestrictedApproval = { reason: reason!, approvalKey: approval.approvalKey };
  }
  let hostApproval: { reason: string; approvalKey: string } | null = null;
  if (executor === 'host') {
    const approval = input.hostApproval;
    if (
      !approval ||
      approval.reason.trim() !== input.reason?.trim() ||
      !approval.reason.trim() ||
      !sha256Pattern.test(approval.approvalKey)
    ) {
      fail(
        'HOST_APPROVAL_REQUIRED',
        'Host compatibility execution requires a separate exact trusted approval with the human reason.',
        'Confirm elevated host compatibility mode through the trusted launch flow and relaunch.',
      );
    }
    hostApproval = { reason: reason!, approvalKey: approval.approvalKey };
  }
  const approvalsDigest = sha256Canonical({
    grants: matchedApprovals,
    unrestricted: unrestrictedApproval,
    host: hostApproval,
  } as unknown as JsonValue);
  const elevationTargets = [
    ...(executor === 'host' ? ['host-compatibility'] : []),
    ...(mode === 'unrestricted' ? ['unrestricted'] : []),
    ...grants.map((grant) => `${grant.access}:${grant.resource}`),
  ];
  const banner = elevated
    ? {
        code: 'ELEVATED_LAUNCH' as const,
        persistent: true as const,
        message: `ELEVATED LAUNCH — ${elevationTargets.join(', ')} — ${reason}`,
      }
    : null;

  const providerRoutes = Object.fromEntries(
    Object.entries(identity.providerRoutes ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, route]) => [provider, routeLabel(route, `Provider route '${provider}'`)]),
  );
  const mcpAllow = [...(identity.mcpSharing?.allow ?? [])]
    .sort()
    .map((route) => routeLabel(route, 'MCP route'));

  const dockerAvailability = input.dockerAvailability ?? 'unverified';
  const executorVerification = input.executorVerification ?? {
    status: executor === 'docker' ? dockerAvailability : 'unverified',
    verifier: 'not-verified',
    evidenceDigest: sha256Canonical({
      executor,
      status: executor === 'docker' ? dockerAvailability : 'unverified',
    }),
  };
  if (
    !executorVerification.verifier.trim() ||
    !sha256Pattern.test(executorVerification.evidenceDigest)
  ) {
    fail(
      'EXECUTOR_EVIDENCE_INVALID',
      'Executor verification evidence must name its verifier and contain a SHA-256 evidence digest.',
    );
  }
  const diagnostics =
    executor === 'docker' && dockerAvailability !== 'available'
      ? [
          {
            code:
              dockerAvailability === 'unavailable'
                ? 'DOCKER_UNAVAILABLE'
                : 'DOCKER_AVAILABILITY_UNVERIFIED',
            severity: 'warning' as const,
            status:
              dockerAvailability === 'unavailable'
                ? ('projected' as const)
                : ('unverified' as const),
            message:
              dockerAvailability === 'unavailable'
                ? 'Docker remains selected but is currently unavailable; execution is gated.'
                : 'Docker remains selected; availability has not been verified by this pure resolver.',
            remediation:
              'Start or install Docker, then verify the projected launch before execution. Do not fall back to host.',
          },
        ]
      : [];

  const tuple = {
    schemaVersion: 2 as const,
    nativeRuntimeRootDigest,
    runtime: selection.runtime,
    ...(input.runtimeArgs && input.runtimeArgs.length > 0
      ? { runtimeArgs: canonicalRuntimeArgs(input.runtimeArgs) }
      : {}),
    binding: {
      projectId: input.projectId ?? null,
      repositoryId: input.repositoryId ?? input.projectId ?? 'unbound',
    },
    identity: { name: identityName, domain: identity.domain },
    mode,
    skillPolicy,
    executor: {
      ...effectiveExecutor(executor),
      ...(executor === 'docker' ? { availability: dockerAvailability } : {}),
    },
    executorVerification: structuredClone(executorVerification),
    workspace,
    networkPolicy: {
      name: selection.networkPolicy.name,
      declaration: structuredClone(selection.networkPolicy.declaration),
    },
    preset: selection.preset,
    provenance: selection.provenance,
    diagnostics,
    contentScope: { name: contentScope },
    grants,
    cwdClassification: { domain: cwdDomain.domain, contentScope: cwdContent.contentScope },
    routes: {
      gitAuthor: routeLabel(identity.gitAuthorRoute, 'Git author route'),
      providers: providerRoutes,
      ssh: identity.sshRoute === undefined ? null : routeLabel(identity.sshRoute, 'SSH route'),
      mcp: { allow: mcpAllow, shareNativeAuth: false as const },
    },
    intendedPolicy: {
      mode,
      resources: Object.fromEntries(
        Object.entries(effectiveResources).sort(([left], [right]) => left.localeCompare(right)),
      ),
      grants,
      inputsDigest: sha256Canonical(input.policyInputs),
      approvalsDigest,
    },
    skillArtifact: canonicalSkillArtifactReference(input.skillArtifact),
    elevationAudit: { elevated, reason, approvalsDigest, banner },
  };
  const launchKey = sha256Canonical(tuple as unknown as JsonValue);
  return deepFreeze({ ...tuple, launchKey }) as LaunchDescriptor;
}
