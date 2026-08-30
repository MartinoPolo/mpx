import path from 'node:path';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { ExecutionError } from './index.js';

export interface SandboxMount {
  readonly source: string;
  readonly target: string;
  readonly access: 'ro' | 'rw';
  readonly classification: 'workspace' | 'reference' | 'state' | 'extra';
}
export interface SandboxPlanInput {
  readonly runtime: 'claude' | 'pi';
  readonly identity: { name: string; domain: 'personal' | 'work' };
  readonly workspaceMode: 'clone' | 'host-worktree' | 'direct';
  readonly worktreeRole: 'main' | 'linked';
  readonly directCompatibility?: boolean;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly nativeRoots: readonly string[];
  readonly credentialRoots: readonly string[];
  readonly oppositeDomainRoots: readonly string[];
  readonly dockerSocketPaths: readonly string[];
  readonly gitCommonDir: string;
  readonly runtimeToolInventorySha256: string;
  readonly network: { name: string; allow: readonly string[] };
  readonly extraMounts?: readonly { source: string; target: string; access: 'ro' | 'rw' }[];
  readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
}
export interface SandboxLaunchPlanV1 {
  readonly schemaVersion: 1;
  readonly planKey: string;
  readonly mode: SandboxPlanInput['workspaceMode'];
  readonly appName: string;
  readonly appNamespace: string;
  readonly credentialProofRequirements: {
    readonly provider: 'sbx-built-in';
    readonly enrollment: true;
    readonly credentialIsolation: true;
    readonly oppositeIdentityDenial: true;
  } | null;
  readonly workspaceSource: string;
  readonly gitOwnership: 'vm' | 'host';
  readonly mounts: readonly SandboxMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly networkPolicy: {
    readonly name: string;
    readonly default: 'allow' | 'deny';
    readonly allow: readonly string[];
  };
  readonly sbxArgv: readonly string[];
  readonly runtimeToolInventorySha256: string;
  readonly vmScan: {
    readonly credentialMaterialPresent: false;
    readonly nativeAccountPathPresent: false;
    readonly canaryPresent: false;
    readonly dockerSocketPresent: false;
  };
}
function canonical(value: string): string {
  if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    throw new ExecutionError('PATH_INVALID', 'Sandbox paths must be absolute.');
  }
  return (path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.posix.normalize(value))
    .replaceAll('\\', '/')
    .replace(/\/$/u, '');
}
function within(candidate: string, root: string): boolean {
  const c = canonical(candidate).toLowerCase(),
    r = canonical(root).toLowerCase();
  return c === r || c.startsWith(`${r}/`);
}
function safeLabel(value: string): string {
  const label = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 24);
  if (!label) {
    throw new ExecutionError('IDENTITY_INVALID', 'Sandbox identity is invalid.');
  }
  return label;
}
export function buildSandboxPlanV1(input: SandboxPlanInput): SandboxLaunchPlanV1 {
  if (input.workspaceMode === 'clone' && input.worktreeRole !== 'main') {
    throw new ExecutionError(
      'CLONE_REQUIRES_MAIN',
      'Clone mode must launch from the main checkout.',
    );
  }
  if (input.workspaceMode === 'host-worktree' && input.worktreeRole !== 'linked') {
    throw new ExecutionError(
      'HOST_WORKTREE_REQUIRED',
      'Host-worktree mode requires a linked worktree.',
    );
  }
  if (input.workspaceMode === 'direct' && input.directCompatibility !== true) {
    throw new ExecutionError('DIRECT_EXPLICIT_REQUIRED', 'Direct compatibility must be explicit.');
  }
  const state = canonical(input.stateRoot),
    workspace = canonical(input.workspaceRoot);
  const denied = [
    ...input.nativeRoots,
    ...input.credentialRoots,
    ...input.oppositeDomainRoots,
    ...input.dockerSocketPaths,
    input.gitCommonDir,
  ].map(canonical);
  if (denied.some((root) => within(state, root) || within(root, state))) {
    throw new ExecutionError(
      'STATE_ROOT_DENIED',
      'Sandbox state must not intersect native, credential, opposite-domain, Git-common, or Docker roots.',
    );
  }
  // A checkout commonly contains its own .git directory. That reviewed direct-main/clone
  // compatibility does not make a Git common directory outside (or above) the workspace mountable.
  const workspaceContainsProtected = denied.some(
    (root, index) => within(root, workspace) && index !== denied.length - 1,
  );
  if (denied.some((root) => within(workspace, root)) || workspaceContainsProtected) {
    throw new ExecutionError(
      'WORKSPACE_DENIED',
      'WORKSPACE_DENIED: workspace intersects a protected host root.',
    );
  }
  const mounts: SandboxMount[] = [];
  const add = (
    raw: { source: string; target: string; access: 'ro' | 'rw' },
    classification: SandboxMount['classification'],
    checkProtected = true,
  ): void => {
    const source = canonical(raw.source);
    if (checkProtected && denied.some((root) => within(source, root) || within(root, source))) {
      throw new ExecutionError(
        'MOUNT_DENIED',
        'MOUNT_DENIED: mount intersects a protected host root.',
      );
    }
    if (!raw.target.startsWith('/') || raw.target.includes('..') || /[\r\n\0]/u.test(raw.target)) {
      throw new ExecutionError('MOUNT_TARGET_INVALID', 'Mount target is unsafe.');
    }
    mounts.push(Object.freeze({ ...raw, source, classification }));
  };
  if (input.workspaceMode === 'host-worktree' || input.workspaceMode === 'direct') {
    add({ source: workspace, target: '/workspace', access: 'rw' }, 'workspace', false);
  }
  for (const mount of input.extraMounts ?? []) {
    add(mount, 'extra');
  }
  // State is a generated, identity-local sandbox directory; native runtime state is never mounted.
  const identity = safeLabel(input.identity.name),
    stateLocal = `${state}/sandboxes/${input.runtime}/${input.identity.domain}/${identity}`;
  const environment = Object.freeze({
    HOME: stateLocal,
    TMP: `${stateLocal}/tmp`,
    TEMP: `${stateLocal}/tmp`,
    MPX_RUNTIME_TOOL_INVENTORY_SHA256: input.runtimeToolInventorySha256,
  });
  const allow = [...new Set(input.network.allow)].sort();
  if (
    !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(input.network.name) ||
    allow.some((item) => !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(?:[1-9]\d{0,4})$/u.test(item))
  ) {
    throw new ExecutionError(
      'NETWORK_POLICY_INVALID',
      'Network policy must contain exact host:port destinations.',
    );
  }
  const appNamespace = `mpx-${input.runtime}-${input.identity.domain}`;
  const appName = `${appNamespace}-${sha256Canonical({ identity, inventory: input.runtimeToolInventorySha256 } as JsonValue).slice(0, 12)}`;
  const agent = input.runtime === 'claude' ? 'claude' : 'shell',
    environmentArgv = Object.entries(environment)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const references = mounts
    .filter((m) => m.classification !== 'workspace')
    .map((m) => (m.access === 'ro' ? `${m.source}:ro` : m.source));
  // sandbox.profile/networkPolicy.name remains MPX's logical policy selection. Standalone
  // sbx v0.39 has no locally creatable profiles, so it must never reach create argv.
  const sbxArgv = [
    'create',
    '--name',
    appName,
    ...(input.workspaceMode === 'clone' ? ['--clone'] : []),
    ...environmentArgv,
    agent,
    workspace,
    ...references,
  ];
  const vmScan = Object.freeze({
    credentialMaterialPresent: false as const,
    nativeAccountPathPresent: false as const,
    canaryPresent: false as const,
    dockerSocketPresent: false as const,
  });
  const credentialProofRequirements =
    input.runtime === 'claude'
      ? Object.freeze({
          provider: 'sbx-built-in' as const,
          enrollment: true as const,
          credentialIsolation: true as const,
          oppositeIdentityDenial: true as const,
        })
      : null;
  const networkDefault = input.network.name === 'open' ? ('allow' as const) : ('deny' as const);
  const tuple = {
    schemaVersion: 1 as const,
    mode: input.workspaceMode,
    appName,
    appNamespace,
    credentialProofRequirements,
    workspaceSource: workspace,
    gitOwnership: input.workspaceMode === 'clone' ? ('vm' as const) : ('host' as const),
    mounts: Object.freeze(mounts),
    environment,
    networkPolicy: Object.freeze({
      name: input.network.name,
      default: networkDefault,
      allow: Object.freeze(allow),
    }),
    sbxArgv: Object.freeze(sbxArgv),
    runtimeToolInventorySha256: input.runtimeToolInventorySha256,
    vmScan,
  };
  return Object.freeze({ ...tuple, planKey: sha256Canonical(tuple as unknown as JsonValue) });
}
