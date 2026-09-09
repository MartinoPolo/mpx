import {
  isSafeRouteLabel,
  resolveKnownLaunchCwdClassification,
  resolveSkillSelection,
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
  LaunchProvenance,
  LaunchSelection,
  ResolveLaunchInput,
  ResolveLaunchSelectionInput,
  ShortLaunchAlias,
} from './types.js';

function fail(code: string, message: string, remediation?: string): never {
  throw new MpxError({ code, message, ...(remediation ? { remediation } : {}) });
}

export function identityDomainMismatchMessage(
  _runtime: 'claude' | 'pi',
  identityName: string,
  domain: string,
): string {
  return `Identity '${identityName}' cannot launch in domain '${domain}'. Select the owning identity or an explicit mode that admits the configured resource.`;
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
  if (!isValidSkillArtifactReference(input)) {
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

export function validateLaunchDomain(selection: LaunchSelection): void {
  const { domain, applicableResource } = selection.cwdClassification;
  if (selection.identity.domain === domain) {
    return;
  }
  const explicitlyAdmitted =
    selection.provenance.mode === 'explicit' &&
    applicableResource !== undefined &&
    selection.mode.declaration.resources[
      applicableResource as keyof typeof selection.mode.declaration.resources
    ] !== undefined;
  if (explicitlyAdmitted) {
    return;
  }
  fail(
    'IDENTITY_DOMAIN_MISMATCH',
    identityDomainMismatchMessage(selection.runtime, selection.identity.name, domain),
  );
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
  if (
    input.projectConfig &&
    input.projectId &&
    input.projectConfig.project.id !== input.projectId
  ) {
    fail('PROJECT_ID_MISMATCH', 'Project config id does not match the selected project id.');
  }

  const cwdClassification = await resolveKnownLaunchCwdClassification(input.cwd, input.userConfig);
  let presetName = input.preset;
  let presetSource: LaunchProvenance = 'explicit';
  const selectedProjectId = input.projectConfig?.project.id ?? input.projectId;
  if (presetName === undefined && selectedProjectId !== undefined) {
    presetName = input.userConfig.launchDefaults.projects[selectedProjectId]?.[identityName];
    presetSource = 'user-project';
  }
  if (presetName === undefined) {
    presetName =
      input.userConfig.launchDefaults.locations[cwdClassification.location]?.[identityName];
    presetSource = 'user-location';
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

  const normalMode = resolvedAxis(input.mode, preset?.mode, 'project');
  const useAutomaticFallback =
    input.automaticModeFallback === 'missing-project-config' &&
    normalMode === 'project' &&
    identity.domain === 'work' &&
    cwdClassification.domain === 'work' &&
    input.mode === undefined &&
    input.preset === undefined;
  const modeName = useAutomaticFallback ? 'developer' : normalMode;
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
  if (!input.userConfig.networkPolicies[networkPolicyName]) {
    fail('NETWORK_POLICY_UNKNOWN', `Unknown network policy '${networkPolicyName}'.`);
  }
  if (executor === 'host' && workspace === 'clone') {
    fail('HOST_CLONE_UNSUPPORTED', 'Host execution cannot use clone workspace strategy.');
  }

  const source = (explicit: string | undefined): LaunchProvenance =>
    explicit !== undefined ? 'explicit' : preset ? presetSource : 'built-in';
  const result = {
    runtime,
    identity: { name: identityName, domain: identity.domain },
    mode: { name: modeName, declaration: structuredClone(modeDeclaration) },
    selection: await resolveSkillSelection(
      input.projectConfig,
      input.userConfig,
      input.cwd,
      identityName,
      input.projectId,
    ),
    executor,
    workspace,
    networkPolicy: {
      name: networkPolicyName,
      declaration: effectiveNetworkPolicy(networkPolicyName, input.userConfig.networkPolicies),
    },
    preset: presetName ?? null,
    provenance: {
      runtime: 'explicit' as const,
      identity: 'explicit' as const,
      mode: useAutomaticFallback ? ('automatic-fallback' as const) : source(input.mode),
      executor: source(input.executor),
      workspace: source(input.workspace),
      networkPolicy: source(input.networkPolicy),
    },
    cwdClassification,
  };
  return deepFreeze(result) as LaunchSelection;
}

function exactApproval(
  approval: Readonly<{ reason: string; approvalKey: string }> | undefined,
  rawReason: string | undefined,
  code: string,
  message: string,
): { reason: string; approvalKey: string } {
  if (
    !approval ||
    approval.reason.trim() !== rawReason?.trim() ||
    !approval.reason.trim() ||
    !sha256Pattern.test(approval.approvalKey)
  ) {
    fail(code, message);
  }
  return { reason: sanitizeReason(approval.reason), approvalKey: approval.approvalKey };
}

export async function resolveLaunch(input: ResolveLaunchInput): Promise<LaunchDescriptor> {
  if (input.repositoryId !== undefined && !projectIdPattern.test(input.repositoryId)) {
    fail('REPOSITORY_ID_INVALID', 'Repository id must be a canonical owner/repository id.');
  }
  const selection = await resolveLaunchSelection(input);
  validateLaunchDomain(selection);
  validateSkillArtifact(input.skillArtifact);
  if (input.skillArtifact.runtime !== selection.runtime) {
    fail(
      'SKILL_ARTIFACT_RUNTIME_MISMATCH',
      'Skill artifact runtime does not match the launch runtime.',
    );
  }
  const projectId = input.projectConfig?.project.id ?? input.projectId ?? null;
  const repositoryId = input.repositoryId ?? projectId ?? 'unbound';
  if (selection.mode.name === 'project' && projectId === null) {
    fail('PROJECT_REQUIRED', 'Project mode requires a canonical project id.');
  }
  if (input.skillArtifact.identity !== selection.identity.name) {
    fail(
      'SKILL_ARTIFACT_IDENTITY_MISMATCH',
      'Skill artifact identity does not match the resolved launch identity.',
    );
  }
  if (input.skillArtifact.projectId !== projectId) {
    fail(
      'SKILL_ARTIFACT_PROJECT_MISMATCH',
      'Skill artifact project does not match the resolved launch project.',
    );
  }
  if (input.skillArtifact.repositoryId !== repositoryId) {
    fail(
      'SKILL_ARTIFACT_REPOSITORY_MISMATCH',
      'Skill artifact repository does not match the resolved launch repository.',
    );
  }
  const artifactSelection = {
    location: input.skillArtifact.location,
    packs: input.skillArtifact.packs,
    source: input.skillArtifact.selectionSource,
  };
  if (
    sha256Canonical(artifactSelection as unknown as JsonValue) !==
    sha256Canonical(selection.selection as unknown as JsonValue)
  ) {
    fail(
      'SKILL_ARTIFACT_SELECTION_MISMATCH',
      'Skill artifact selection does not match the resolved launch selection.',
    );
  }

  const identity = input.userConfig.identities[selection.identity.name]!;
  const configuredNativeRoot = canonicalNativeRoot(identity.runtimeRoots[selection.runtime]);
  const selectedNativeRoot = canonicalNativeRoot(input.selectedNativeRuntimeRoot);
  if (selectedNativeRoot !== configuredNativeRoot) {
    fail(
      'NATIVE_RUNTIME_ROOT_MISMATCH',
      'Selected native runtime root does not match the resolved identity runtime root.',
    );
  }
  if (selection.executor === 'host' && input.executor !== 'host') {
    fail(
      'HOST_EXPLICIT_REQUIRED',
      'Host execution is elevated compatibility mode and must be explicitly selected.',
    );
  }

  const elevated = selection.mode.name === 'unrestricted' || selection.executor === 'host';
  const reason = elevated ? sanitizeReason(input.reason ?? '') : null;
  const unrestrictedApproval =
    selection.mode.name === 'unrestricted'
      ? exactApproval(
          input.elevationApproval,
          input.reason,
          'ELEVATION_APPROVAL_REQUIRED',
          'Unrestricted mode requires a separate exact trusted approval with the launch reason.',
        )
      : null;
  const hostApproval =
    selection.executor === 'host'
      ? exactApproval(
          input.hostApproval,
          input.reason,
          'HOST_APPROVAL_REQUIRED',
          'Host compatibility execution requires a separate exact trusted approval with the human reason.',
        )
      : null;
  const approvalsDigest = sha256Canonical({
    unrestricted: unrestrictedApproval,
    host: hostApproval,
  });
  const elevationTargets = [
    ...(selection.executor === 'host' ? ['host-compatibility'] : []),
    ...(selection.mode.name === 'unrestricted' ? ['unrestricted'] : []),
  ];

  const providerRoutes = Object.fromEntries(
    Object.entries(identity.providerRoutes ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, route]) => [provider, routeLabel(route, `Provider route '${provider}'`)]),
  );
  const mcpAllow = [...(identity.mcpSharing?.allow ?? [])]
    .sort()
    .map((route) => routeLabel(route, 'MCP route'));
  const dockerAvailability = input.dockerAvailability ?? 'unverified';
  const diagnostics = [
    ...(selection.provenance.mode === 'automatic-fallback'
      ? [
          {
            code: 'PROJECT_CONFIG_MISSING_DEVELOPER_FALLBACK',
            severity: 'warning' as const,
            status: 'projected' as const,
            message: 'Project configuration is missing; developer mode was selected automatically.',
            remediation:
              'Add project configuration to use project mode, or select a mode explicitly.',
          },
        ]
      : []),
    ...(selection.executor === 'docker' && dockerAvailability !== 'available'
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
      : []),
  ];

  const tuple = {
    schemaVersion: 3 as const,
    nativeRuntimeRootDigest: canonicalNativeRootDigest(selectedNativeRoot),
    runtime: selection.runtime,
    ...(input.runtimeArgs && input.runtimeArgs.length > 0
      ? { runtimeArgs: canonicalRuntimeArgs(input.runtimeArgs) }
      : {}),
    binding: { projectId, repositoryId },
    identity: selection.identity,
    mode: selection.mode.name,
    selection: structuredClone(selection.selection),
    executor: {
      ...effectiveExecutor(selection.executor),
      ...(selection.executor === 'docker' ? { availability: dockerAvailability } : {}),
    },
    workspace: selection.workspace,
    networkPolicy: structuredClone(selection.networkPolicy),
    preset: selection.preset,
    provenance: selection.provenance,
    diagnostics,
    cwdClassification: selection.cwdClassification,
    routes: {
      gitAuthor: routeLabel(identity.gitAuthorRoute, 'Git author route'),
      providers: providerRoutes,
      ssh: identity.sshRoute === undefined ? null : routeLabel(identity.sshRoute, 'SSH route'),
      mcp: { allow: mcpAllow, shareNativeAuth: false as const },
    },
    intendedPolicy: {
      mode: selection.mode.name,
      resources: Object.fromEntries(
        Object.entries(selection.mode.declaration.resources).sort(([a], [b]) => a.localeCompare(b)),
      ),
      inputsDigest: sha256Canonical(input.policyInputs),
    },
    skillArtifact: canonicalSkillArtifactReference(input.skillArtifact),
    elevationAudit: {
      elevated,
      reason,
      approvalsDigest,
      banner: elevated
        ? {
            code: 'ELEVATED_LAUNCH' as const,
            persistent: true as const,
            message: `ELEVATED LAUNCH — ${elevationTargets.join(', ')} — ${reason}`,
          }
        : null,
    },
  };
  return deepFreeze({
    ...tuple,
    launchKey: sha256Canonical(tuple as unknown as JsonValue),
  }) as LaunchDescriptor;
}
