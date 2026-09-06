import { defaultRuntimeModelSelectionV1, type ProjectConfig } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import type { StartRequest } from '@mpx/dev-services';
import {
  ExecutionError,
  ExecutionService,
  ExecutorRegistry,
  HostApprovalStore,
  RuntimeAdapterRegistry,
  sameVerificationEvidence,
  type DirectTty,
  type ExecutorAdapter,
  type LaunchAuditStore,
  type ProcessResult,
  type RuntimeAdapter,
  type RuntimeLaunchBinding,
  type VerificationEvidence,
} from '@mpx/executors';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  createRuntimeCapabilityManifestV1,
  createRuntimeContextV1,
  parseRuntimeContextV1,
  parseRuntimeSessionObservationV1,
  validateRuntimeCapabilityBinding,
  type NativeSessionRefV1,
  type PublishedRuntimeArtifactReference,
  type RuntimeCapabilityManifestV1,
  type RuntimeContextV1,
  type RuntimeSessionObservationV1,
  type SessionLifecycleBindingV1,
  type ToolAuthorityV1,
} from '@mpx/runtime-contracts';
import type { NativeBindingRecordV1 } from '@mpx/sessions';
import {
  createSkillProjectionPlan,
  type CatalogSkill,
  type ResolvedManifest,
  type RuntimeSkillArtifact,
  type SkillProjectionPlan,
} from '@mpx/skills';
import {
  composeRuntimeStatusEnvelopeV1,
  parseRuntimeStatusEnvelopeV1,
  parseStatusSnapshotV1,
  type RuntimeStatusEnvelopeV1,
  type StatusSnapshotV1,
} from '@mpx/status';

export interface LaunchStatusSnapshotBinding {
  readonly schemaVersion: 1;
  readonly launchKey: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}
export interface LaunchStatusSnapshotMaterializer {
  materialize(
    input: { readonly binding: LaunchStatusSnapshotBinding; readonly snapshot: StatusSnapshotV1 },
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}
export interface RuntimeStatusEnvelopeAuthorityV1 {
  readonly descriptorDigest: string;
  readonly runtimeRootDigest: string;
}
export interface RuntimeStatusEnvelopeMaterializer {
  materialize(
    input: {
      readonly envelope: RuntimeStatusEnvelopeV1;
      readonly authority: RuntimeStatusEnvelopeAuthorityV1;
    },
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface LaunchRuntimeWiring {
  readonly capability: RuntimeCapabilityManifestV1;
  readonly status: RuntimeStatusEnvelopeV1;
  readonly launchBinding: RuntimeLaunchBinding;
}
export interface LaunchVerifiedResumeTarget {
  readonly file: string;
}
export type LaunchRuntimeResumeTarget = NativeSessionRefV1 | LaunchVerifiedResumeTarget;
export interface LaunchRuntimePlan {
  readonly adapters: readonly RuntimeAdapter[];
  /** Paths are read only after adapter preparation, allowing projection materialization to remain lazy. */
  readonly statusPaths?: () => { readonly snapshot?: string; readonly runtime?: string };
  readonly cleanup?: () => Promise<void>;
}
export interface LaunchRuntimeComposerInput {
  readonly descriptor: LaunchDescriptor;
  readonly artifact: RuntimeSkillArtifact;
  readonly skillPlan: SkillProjectionPlan;
  readonly runtimeContext: RuntimeContextV1;
  readonly wiring: LaunchRuntimeWiring;
  readonly snapshot: StatusSnapshotV1;
  readonly materializedRoutes: Readonly<Record<string, string>>;
  readonly lifecycle?: {
    readonly binding: SessionLifecycleBindingV1;
    readonly eventDirectory: string;
  };
  readonly resumeTarget?: LaunchRuntimeResumeTarget;
}
export type LaunchRuntimeComposer = (
  input: LaunchRuntimeComposerInput,
) => Promise<LaunchRuntimePlan> | LaunchRuntimePlan;

export interface LaunchLifecyclePort {
  prepare(input: {
    readonly descriptor: LaunchDescriptor;
    readonly runtimeContext: RuntimeContextV1;
    readonly nativeRuntimeRoot: string;
    readonly cwd: string;
    readonly nativeSessionRef?: NativeSessionRefV1;
    readonly nativeBinding?: NativeBindingRecordV1;
  }): Promise<{ readonly binding: SessionLifecycleBindingV1; readonly eventDirectory: string }>;
  consume(bindingId: string): Promise<void>;
  observe?(bindingId: string): Promise<RuntimeSessionObservationV1 | undefined>;
}
export interface LaunchExecutionRequest {
  readonly descriptor: LaunchDescriptor;
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly nativeRuntimeRoot: string;
  readonly catalog: readonly CatalogSkill[];
  readonly canonicalRoot: string;
  readonly statusSnapshot: (signal?: AbortSignal) => Promise<StatusSnapshotV1>;
  readonly projectConfig?: ProjectConfig;
  readonly projectRoot?: string;
  readonly signal?: AbortSignal;
  readonly resume?: {
    readonly nativeBinding: NativeBindingRecordV1;
    readonly nativeSessionRef: NativeSessionRefV1;
  };
}
export interface LaunchExecutionDependencies {
  readonly composer: LaunchRuntimeComposer;
  readonly executorAdapters: readonly ExecutorAdapter[];
  readonly runtimeAdapterMode?: 'production' | 'injected';
  readonly runtimePreflight?: () => Promise<void>;
  readonly routes?: {
    materialize(
      descriptor: LaunchDescriptor,
      projectRoot?: string,
    ): Promise<Readonly<Record<string, string>>>;
  };
  readonly audit?: LaunchAuditStore;
  readonly tty?: DirectTty;
  readonly approveHost?: boolean;
  readonly expectedLaunchKey?: string;
  readonly lifecycle?: LaunchLifecyclePort;
  readonly sessionObservation?: RuntimeSessionObservationV1;
  readonly wiringFactory?: (input: {
    readonly descriptor: LaunchDescriptor;
    readonly artifact: RuntimeSkillArtifact;
    readonly snapshot: StatusSnapshotV1;
    readonly cwd: string;
    readonly sessionObservation?: RuntimeSessionObservationV1;
  }) => LaunchRuntimeWiring;
  readonly verifyResumeTarget?: (
    nativeRuntimeRoot: string,
    ref: NativeSessionRefV1,
  ) => Promise<LaunchVerifiedResumeTarget>;
  readonly beforeChildExecution?: () => Promise<void>;
  /** Injected containment adapters run the Pi host process through the selected wrapped adapter. */
  readonly useSelectedExecutorForHostPi?: boolean;
  readonly liveStatus?: {
    readonly materializeSnapshot: (input: {
      readonly descriptor: LaunchDescriptor;
      readonly repositoryId: string;
      readonly snapshot: StatusSnapshotV1;
      readonly signal?: AbortSignal;
    }) => Promise<string | undefined>;
    readonly readSnapshot: (file: string, signal?: AbortSignal) => Promise<StatusSnapshotV1>;
    readonly materializeRuntimeStatus: (
      input: {
        readonly envelope: RuntimeStatusEnvelopeV1;
        readonly authority: RuntimeStatusEnvelopeAuthorityV1;
      },
      signal?: AbortSignal,
    ) => Promise<string>;
    readonly schedule?: (callback: () => Promise<void>, intervalMs: number) => () => void;
    readonly waitForShutdown?: (milliseconds: number) => Promise<void>;
    readonly shutdownDeadlineMs?: number;
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
const EMPTY_MATERIALIZED_ROUTES: Readonly<Record<string, string>> = Object.freeze({});
const CLAUDE_TOOLS = Object.freeze([
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'Skill',
  'Task',
  'WebFetch',
  'WebSearch',
  'Write',
  'dev_server',
  'mcp',
]);
const PI_TOOLS = Object.freeze([
  'Agent',
  'bash',
  'dev_server',
  'edit',
  'find',
  'get_subagent_result',
  'grep',
  'ls',
  'mpx_model_load',
  'mpx_model_search',
  'read',
  'steer_subagent',
  'write',
]);
function authority(
  name: string,
  executor: 'docker' | 'host',
  routes: readonly string[],
): ToolAuthorityV1 {
  return Object.freeze({
    schemaVersion: 1,
    name,
    executors: Object.freeze([executor]),
    routes: Object.freeze([...routes]),
    network: Object.freeze({ mode: 'deny-all' as const, destinations: Object.freeze([]) }),
    paidCredits: Object.freeze({ allowed: false, maxCredits: 0 }),
    input: Object.freeze({ maxBytes: 1048576 }),
    output: Object.freeze({ maxBytes: 1048576 }),
    timeout: Object.freeze({ maxMs: 120000 }),
    cache: Object.freeze({ mode: 'disabled' as const, maxBytes: 0 }),
  });
}
function canonicalPath(value: string): string {
  const slash = value.replaceAll('\\', '/');
  const prefix = slash.match(/^(?:[A-Za-z]:|\/)/u)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of slash.slice(prefix.length).split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `${prefix}${prefix === '/' ? '' : '/'}${parts.join('/')}`.replace(/\/$/u, '');
}

export function runtimeContextForLaunch(
  descriptor: LaunchDescriptor,
  manifest: ResolvedManifest,
  artifact: RuntimeSkillArtifact,
): RuntimeContextV1 {
  const ref = descriptor.skillArtifact;
  const digest = sha256Canonical({
    schemaVersion: 1,
    manifestKey: manifest.manifestKey,
    skillArtifactKey: ref.artifactKey,
  } as unknown as JsonValue);
  if (
    descriptor.intendedPolicy.inputsDigest !== digest ||
    manifest.binding.projectId !== descriptor.binding.projectId ||
    manifest.binding.repositoryId !== descriptor.binding.repositoryId ||
    manifest.binding.contentScope !== descriptor.contentScope.name ||
    artifact.manifestKey !== manifest.manifestKey ||
    artifact.runtime !== descriptor.runtime ||
    ref.runtime !== descriptor.runtime ||
    ref.identity !== descriptor.identity.name ||
    ref.skillPolicy !== descriptor.skillPolicy ||
    ref.contentScope !== descriptor.contentScope.name ||
    ref.projectId !== descriptor.binding.projectId
  ) {
    throw new MpxError({
      code: 'LAUNCH_RESTART_REQUIRED',
      message: 'Runtime content or repository bindings changed before invocation.',
      remediation: 'Resolve a new launch and restart the runtime process.',
    });
  }
  return createRuntimeContextV1({
    launchKey: descriptor.launchKey,
    launchDescriptor: {
      reference: 'launch.json',
      digest: sha256Canonical(descriptor as unknown as JsonValue),
    },
    manifestKey: manifest.manifestKey,
    runtimeArtifact: artifact.reference,
    binding: manifest.binding,
  });
}
export function currentLaunchTuple(environment: Readonly<Record<string, string | undefined>>) {
  const raw = environment.MPX_RUNTIME_CONTEXT,
    rawProjection = environment.MPX_RUNTIME_PROJECTION_REFERENCE;
  if (!raw || !rawProjection) {
    throw new MpxError({
      code: 'LAUNCH_CONTEXT_REQUIRED',
      message: 'This command requires an immutable process-bound runtime context.',
      remediation: "Start the runtime through 'mpx launch'.",
    });
  }
  try {
    const context = parseRuntimeContextV1(JSON.parse(raw));
    const projection = JSON.parse(rawProjection) as PublishedRuntimeArtifactReference;
    const launchBinding = projection.launchBinding;
    const immutable = [
      context.launchKey,
      context.launchDescriptor.digest,
      context.manifestKey,
      context.runtimeArtifact.artifactKey,
      context.runtimeArtifact.fileMapHash,
      projection.projectionKey,
      projection.fileMapHash,
      launchBinding?.launchKey,
      launchBinding?.descriptorDigest,
      launchBinding?.runtimeArtifactKey,
      launchBinding?.manifestKey,
    ];
    if (
      immutable.some((v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v)) ||
      !launchBinding ||
      (launchBinding.runtime !== 'claude' && launchBinding.runtime !== 'pi') ||
      Object.keys(projection).sort().join(',') !== 'fileMapHash,launchBinding,projectionKey' ||
      Object.keys(launchBinding).sort().join(',') !==
        'descriptorDigest,launchKey,manifestKey,runtime,runtimeArtifactKey' ||
      launchBinding.launchKey !== context.launchKey ||
      launchBinding.descriptorDigest !== context.launchDescriptor.digest ||
      launchBinding.runtimeArtifactKey !== context.runtimeArtifact.artifactKey ||
      launchBinding.runtime !== context.runtimeArtifact.runtime ||
      launchBinding.manifestKey !== context.manifestKey
    ) {
      throw new Error('invalid');
    }
    return deepFreeze({
      launchKey: context.launchKey,
      descriptorDigest: context.launchDescriptor.digest,
      manifestKey: context.manifestKey,
      artifactKey: context.runtimeArtifact.artifactKey,
      projectionKey: projection.projectionKey,
      launchBinding: { ...launchBinding },
      binding: { ...context.binding },
    });
  } catch {
    throw new MpxError({
      code: 'LAUNCH_CONTEXT_INVALID',
      message: 'The process-bound runtime context is invalid.',
      remediation: 'Relaunch and restart the runtime process.',
    });
  }
}

export function runtimeServiceRequests(
  config: ProjectConfig | undefined,
  projectRoot: string,
  snapshot: StatusSnapshotV1,
  executor: 'host' | 'docker',
): Readonly<Record<string, StartRequest>> {
  const ports = new Map(
    snapshot.services.flatMap((s) => (s.port === null ? [] : [[s.id, s.port] as const])),
  );
  const environment: Record<string, string> = {};
  for (const [id, s] of Object.entries(config?.development?.services ?? {})) {
    const port = ports.get(id);
    if (s.environmentVariable && port !== undefined) {
      environment[s.environmentVariable] = `${s.protocol ?? 'http'}://localhost:${port}`;
    }
  }
  const manager = config?.tooling?.packageManager ?? 'auto',
    executable = manager === 'auto' ? 'npm' : manager;
  if (executable === 'none') {
    return Object.freeze({});
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(config?.development?.services ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([id, s]) => {
          const port = ports.get(id);
          if (port === undefined || s.start.type !== 'package-script') {
            return [];
          }
          const selectedRoot =
            s.scope === 'project' ? projectRoot : (snapshot.worktree.path ?? projectRoot);
          const root = /^(?:[A-Za-z]:[\\/]|\/)/u.test(selectedRoot)
            ? selectedRoot
            : canonicalPath(selectedRoot);
          return [
            [
              id,
              Object.freeze({
                id,
                executable,
                args: Object.freeze(['run', s.start.script]),
                cwd: root,
                ports: Object.freeze([port]),
                assignment: Object.freeze({ worktreeRoot: root, ports: Object.freeze([port]) }),
                executor,
                environment: Object.freeze({ ...environment }),
              }),
            ],
          ];
        }),
    ),
  );
}

export function buildLaunchRuntimeWiring(
  descriptor: LaunchDescriptor,
  artifact: RuntimeSkillArtifact,
  snapshotInput: StatusSnapshotV1,
  cwd: string,
  config?: ProjectConfig,
  projectRoot: string = cwd,
  observation?: RuntimeSessionObservationV1,
): LaunchRuntimeWiring {
  const snapshot = parseStatusSnapshotV1(snapshotInput);
  const routes = Object.freeze(
    [
      `git:${descriptor.routes.gitAuthor}`,
      ...Object.entries(descriptor.routes.providers).map(([p, l]) => `provider-${p}:${l}`),
      ...(descriptor.routes.ssh ? [`ssh:${descriptor.routes.ssh}`] : []),
      ...descriptor.routes.mcp.allow.map((l) => `mcp:${l}`),
    ].sort(),
  );
  const tools = descriptor.runtime === 'pi' ? PI_TOOLS : CLAUDE_TOOLS;
  const worktreeRoot = snapshot.worktree.path ?? cwd;
  const assignedPorts = Object.freeze(
    [...new Set(snapshot.services.flatMap((s) => (s.port === null ? [] : [s.port])))].sort(
      (a, b) => a - b,
    ),
  );
  const capability = createRuntimeCapabilityManifestV1({
    runtime: descriptor.runtime,
    launchKey: descriptor.launchKey,
    identity: {
      ...descriptor.identity,
      nativeRuntimeRootDigest: descriptor.nativeRuntimeRootDigest,
    },
    binding: { ...descriptor.binding, contentScope: descriptor.contentScope.name },
    executor: descriptor.executor.name,
    tools: tools.map((name) =>
      authority(
        name,
        descriptor.executor.name,
        name === 'mcp' || name.startsWith('mcp:') ? routes.filter((r) => r.startsWith('mcp:')) : [],
      ),
    ),
    routes,
    resources: [
      ...new Set([
        ...Object.keys(descriptor.intendedPolicy.resources),
        ...descriptor.grants.map((g) => g.resource),
      ]),
    ],
    mounts: [`worktree:${sha256Canonical(canonicalPath(worktreeRoot) as unknown as JsonValue)}`],
    destinations: [],
    skills: artifact.entries.filter((e) => e.permissions.modelInvocation).map((e) => e.identity),
    models:
      descriptor.runtime === 'pi'
        ? defaultRuntimeModelSelectionV1('pi').enabledModels
        : ['haiku', 'opus', 'sonnet'],
    nesting: { depth: 0, maxDepth: 2 },
  });
  const now = new Date().toISOString(),
    freshness = Object.freeze({
      source: 'derived' as const,
      state: 'current' as const,
      capturedAt: now,
      freshUntil: new Date(Date.parse(now) + 60000).toISOString(),
      diagnostic: null,
      unavailable: null,
    }),
    unavailable = Object.freeze({
      source: 'derived' as const,
      state: 'unavailable' as const,
      capturedAt: null,
      freshUntil: null,
      diagnostic: null,
      unavailable: 'not supported',
    }),
    binding = Object.freeze({
      launchKey: descriptor.launchKey,
      runtimeId: descriptor.runtime,
      repositoryId: descriptor.binding.repositoryId,
    });
  const launchStatus = composeRuntimeStatusEnvelopeV1({
    generatedAt: now,
    binding,
    harness:
      descriptor.runtime === 'claude'
        ? { kind: 'claude', version: null, surface: 'statusline' }
        : { kind: 'pi', version: null, surface: 'footer' },
    contributions: [
      {
        source: 'launch',
        binding,
        groups: {
          identity: {
            ...freshness,
            profile:
              descriptor.identity.name === 'personal' || descriptor.identity.name === 'work'
                ? descriptor.identity.name
                : null,
            label:
              descriptor.identity.name === 'personal'
                ? 'Personal'
                : descriptor.identity.name === 'work'
                  ? 'Work'
                  : null,
          },
          location: { ...freshness, label: snapshot.worktree.role ?? 'project' },
          development: {
            ...freshness,
            services: snapshot.services.map((s) => ({
              id: s.id,
              state: s.conflict !== 'none' ? 'conflict' : s.listening ? 'listening' : 'stopped',
              port: s.port,
            })),
          },
          actions: { ...unavailable, items: [] },
        },
      },
    ],
  });
  const status = observation
    ? composeRuntimeSessionObservation(launchStatus, observation, now)
    : launchStatus;
  const services = runtimeServiceRequests(config, projectRoot, snapshot, descriptor.executor.name);
  return validateLaunchRuntimeWiring(
    descriptor,
    snapshot,
    deepFreeze({
      capability,
      status: parseRuntimeStatusEnvelopeV1(status),
      launchBinding: {
        launchKey: descriptor.launchKey,
        runtime: descriptor.runtime,
        identity: { ...descriptor.identity },
        worktreeRoot,
        assignedPorts: [...assignedPorts],
        ...(Object.keys(services).length ? { services } : {}),
        executor: descriptor.executor.name,
      },
    }),
  );
}
export function validateLaunchRuntimeWiring(
  descriptor: LaunchDescriptor,
  snapshotInput: StatusSnapshotV1,
  wiring: LaunchRuntimeWiring,
): LaunchRuntimeWiring {
  try {
    const snapshot = parseStatusSnapshotV1(snapshotInput),
      status = parseRuntimeStatusEnvelopeV1(wiring.status);
    validateRuntimeCapabilityBinding(wiring.capability, {
      manifestKey: wiring.capability.manifestKey,
      launchKey: descriptor.launchKey,
      runtime: descriptor.runtime,
      identity: {
        ...descriptor.identity,
        nativeRuntimeRootDigest: descriptor.nativeRuntimeRootDigest,
      },
      binding: { ...descriptor.binding, contentScope: descriptor.contentScope.name },
      executor: descriptor.executor.name,
    });
    const ports = [
        ...new Set(snapshot.services.flatMap((s) => (s.port === null ? [] : [s.port]))),
      ].sort((a, b) => a - b),
      root = snapshot.worktree.path ?? snapshot.project.cwd,
      b = wiring.launchBinding;
    if (
      status.binding.launchKey !== descriptor.launchKey ||
      status.binding.runtimeId !== descriptor.runtime ||
      status.binding.repositoryId !== descriptor.binding.repositoryId ||
      status.harness.kind !== descriptor.runtime ||
      b.launchKey !== descriptor.launchKey ||
      b.runtime !== descriptor.runtime ||
      b.executor !== descriptor.executor.name ||
      b.identity.name !== descriptor.identity.name ||
      b.identity.domain !== descriptor.identity.domain ||
      canonicalPath(b.worktreeRoot) !== canonicalPath(root) ||
      JSON.stringify(b.assignedPorts) !== JSON.stringify(ports)
    ) {
      throw new Error('stale');
    }
    const required = descriptor.runtime === 'pi' ? PI_TOOLS : CLAUDE_TOOLS,
      admitted = new Set(wiring.capability.tools.map((t) => t.name));
    if (required.some((t) => !admitted.has(t))) {
      throw new Error('missing');
    }
    return deepFreeze(wiring);
  } catch {
    throw new MpxError({
      code: 'LAUNCH_RESTART_REQUIRED',
      message: 'Runtime capability or status bindings changed before invocation.',
      remediation: 'Resolve a new launch and restart the runtime process.',
    });
  }
}

async function consumeAfter<T>(
  execute: () => Promise<T>,
  consume: () => Promise<void>,
): Promise<T> {
  try {
    const result = await execute();
    await consume();
    return result;
  } catch (primary) {
    try {
      await consume();
    } catch (cleanup) {
      if (primary instanceof Error) {
        const mutable = primary as Error & { cause?: unknown; lifecycleFailure?: unknown };
        try {
          if (mutable.cause === undefined) {
            mutable.cause = cleanup;
          } else {
            mutable.lifecycleFailure = cleanup;
          }
        } catch {}
      }
    }
    throw primary;
  }
}
export async function executorEvidence(
  dependencies: Pick<LaunchExecutionDependencies, 'executorAdapters'>,
  name: 'docker' | 'host',
): Promise<VerificationEvidence> {
  const adapter = dependencies.executorAdapters.find((a) => a.name === name);
  if (!adapter) {
    throw new ExecutionError('EXECUTOR_UNAVAILABLE', `Executor '${name}' is unavailable.`, {
      executor: name,
    });
  }
  return adapter.verify();
}

export class LaunchExecutionService {
  async execute(
    request: LaunchExecutionRequest,
    dependencies: LaunchExecutionDependencies,
  ): Promise<ProcessResult> {
    const descriptor = deepFreeze({ ...request.descriptor }) as LaunchDescriptor,
      manifest = deepFreeze({ ...request.manifest }) as ResolvedManifest,
      artifact = deepFreeze({ ...request.artifact }) as RuntimeSkillArtifact;
    const runtimeContext = runtimeContextForLaunch(descriptor, manifest, artifact);
    if (dependencies.approveHost && descriptor.executor.name !== 'host') {
      throw new ExecutionError(
        'HOST_APPROVAL_SCOPE_INVALID',
        'Noninteractive host approval is valid only for an explicit host launch.',
      );
    }
    const adapter = dependencies.executorAdapters.find((a) => a.name === descriptor.executor.name);
    if (!adapter) {
      throw new ExecutionError(
        'EXECUTOR_UNAVAILABLE',
        `Executor '${descriptor.executor.name}' is unavailable.`,
        { executor: descriptor.executor.name },
      );
    }
    const evidence = await adapter.verify();
    if (!sameVerificationEvidence(evidence, descriptor.executorVerification)) {
      throw new ExecutionError(
        'LAUNCH_RESTART_REQUIRED',
        'Executor verification evidence changed before invocation.',
        { restartRequired: true },
      );
    }
    if (
      dependencies.expectedLaunchKey !== undefined &&
      dependencies.expectedLaunchKey !== descriptor.launchKey
    ) {
      throw new ExecutionError(
        'LAUNCH_RESTART_REQUIRED',
        'Launch rights or binding changed; create a new launch and restart.',
        { restartRequired: true },
      );
    }
    if (evidence.status === 'unavailable') {
      throw new ExecutionError(
        'EXECUTOR_UNAVAILABLE',
        `Executor '${adapter.name}' is unavailable.`,
        { executor: adapter.name },
      );
    }
    if (evidence.status !== 'verified') {
      throw new ExecutionError(
        'EXECUTOR_GATE_UNVERIFIED',
        `Executor '${adapter.name}' has not been verified.`,
        { executor: adapter.name },
      );
    }
    if (dependencies.runtimeAdapterMode === 'injected' && dependencies.lifecycle) {
      throw new ExecutionError(
        'RUNTIME_LIFECYCLE_CAPABILITY_REQUIRED',
        'A custom runtime adapter cannot claim production session lifecycle wiring without an explicit lifecycle capability.',
      );
    }
    await dependencies.runtimePreflight?.();
    const resumeTarget = request.resume
      ? dependencies.verifyResumeTarget
        ? await dependencies.verifyResumeTarget(
            request.nativeRuntimeRoot,
            request.resume.nativeSessionRef,
          )
        : request.resume.nativeSessionRef
      : undefined;
    const lifecycle = await dependencies.lifecycle?.prepare({
      descriptor,
      runtimeContext,
      nativeRuntimeRoot: request.nativeRuntimeRoot,
      cwd: request.cwd,
      ...(request.resume
        ? {
            nativeSessionRef: request.resume.nativeSessionRef,
            nativeBinding: request.resume.nativeBinding,
          }
        : {}),
    });
    const executeWithLifecycle = async () => {
      const productionRuntimeAdapters = dependencies.runtimeAdapterMode === 'production';
      const routes = productionRuntimeAdapters
        ? EMPTY_MATERIALIZED_ROUTES
        : dependencies.routes
          ? await dependencies.routes.materialize(descriptor, request.cwd)
          : (() => {
              throw new ExecutionError(
                'PRIVATE_ROUTE_MATERIALIZER_REQUIRED',
                'Trusted private-route materialization is required before launch.',
              );
            })();
      const snapshot = parseStatusSnapshotV1(await request.statusSnapshot());
      const wiring = validateLaunchRuntimeWiring(
        descriptor,
        snapshot,
        dependencies.wiringFactory?.({
          descriptor,
          artifact,
          snapshot,
          cwd: request.cwd,
          ...(dependencies.sessionObservation
            ? { sessionObservation: dependencies.sessionObservation }
            : {}),
        }) ??
          buildLaunchRuntimeWiring(
            descriptor,
            artifact,
            snapshot,
            request.cwd,
            request.projectConfig,
            request.projectRoot,
            dependencies.sessionObservation,
          ),
      );
      const skillPlan = await createSkillProjectionPlan({
        manifest,
        artifact,
        catalog: request.catalog,
        canonicalRoot: request.canonicalRoot,
      });
      const plan = await dependencies.composer({
        descriptor,
        artifact,
        skillPlan,
        runtimeContext,
        wiring,
        snapshot,
        materializedRoutes: routes,
        ...(lifecycle ? { lifecycle } : {}),
        ...(resumeTarget ? { resumeTarget } : {}),
      });
      const executeWithPlan = async () => {
        let stopped = false,
          pending: Promise<void> | undefined,
          expired = false;
        const abort = new AbortController();
        const refresh = async () => {
          const paths = plan.statusPaths?.();
          if (stopped || !dependencies.liveStatus || !paths?.snapshot) {
            return;
          }
          if (pending) {
            return pending;
          }
          const work = (async () => {
            try {
              const next = parseStatusSnapshotV1(await request.statusSnapshot(abort.signal));
              if (stopped) {
                return;
              }
              const refreshed = await dependencies.liveStatus!.materializeSnapshot({
                descriptor,
                repositoryId: manifest.binding.repositoryId,
                snapshot: next,
                signal: abort.signal,
              });
              if (refreshed !== paths.snapshot) {
                throw new Error('binding');
              }
              const observation =
                lifecycle && dependencies.lifecycle?.observe
                  ? await dependencies.lifecycle.observe(lifecycle.binding.bindingId)
                  : undefined;
              const nextWiring = buildLaunchRuntimeWiring(
                descriptor,
                artifact,
                next,
                request.cwd,
                request.projectConfig,
                request.projectRoot,
                observation,
              );
              const runtimePath = await dependencies.liveStatus!.materializeRuntimeStatus(
                {
                  envelope: nextWiring.status,
                  authority: {
                    descriptorDigest: runtimeContext.launchDescriptor.digest,
                    runtimeRootDigest: descriptor.nativeRuntimeRootDigest,
                  },
                },
                abort.signal,
              );
              if (paths.runtime && runtimePath !== paths.runtime) {
                throw new Error('binding');
              }
            } catch {
              if (expired || !paths.snapshot) {
                return;
              }
              try {
                const last = await dependencies.liveStatus!.readSnapshot(
                  paths.snapshot,
                  abort.signal,
                );
                if (expired) {
                  return;
                }
                await dependencies.liveStatus!.materializeSnapshot({
                  descriptor,
                  repositoryId: manifest.binding.repositoryId,
                  snapshot: parseStatusSnapshotV1({
                    ...last,
                    portResolution: 'invalid',
                    diagnostics: [
                      {
                        code: 'STATUS_REFRESH_FAILED',
                        severity: 'error',
                        message: 'Live status refresh failed.',
                        serviceId: null,
                      },
                    ],
                  }),
                  signal: abort.signal,
                });
              } catch {}
            }
          })();
          pending = work.finally(() => {
            pending = undefined;
          });
          return pending;
        };
        const processAdapter: ExecutorAdapter = {
          name: adapter.name,
          ...(adapter.remoteToolClient ? { remoteToolClient: adapter.remoteToolClient } : {}),
          verify: () => adapter.verify(),
          execute: async (child) => {
            const defaultSchedule = (callback: () => Promise<void>, milliseconds: number) => {
              const id = setInterval(() => {
                void callback();
              }, milliseconds);
              return () => clearInterval(id);
            };
            const schedule = dependencies.liveStatus
              ? (dependencies.liveStatus.schedule ?? defaultSchedule)
              : undefined;
            const cancel = schedule?.(refresh, 1_000);
            try {
              const paths = plan.statusPaths?.();
              await dependencies.beforeChildExecution?.();
              return await adapter.execute({
                ...child,
                environment: Object.freeze({
                  ...child.environment,
                  ...(paths?.snapshot ? { MPX_STATUS_SNAPSHOT_FILE: paths.snapshot } : {}),
                  ...(paths?.runtime
                    ? {
                        MPX_RUNTIME_STATUS_FILE: paths.runtime,
                        MPX_RUNTIME_STATUS_ENVELOPE_FILE: paths.runtime,
                      }
                    : {}),
                }),
              });
            } finally {
              stopped = true;
              cancel?.();
              abort.abort();
              const completion = pending?.catch(() => undefined);
              if (completion) {
                const milliseconds = dependencies.liveStatus?.shutdownDeadlineMs ?? 1_000;
                const deadline =
                  dependencies.liveStatus?.waitForShutdown?.(milliseconds) ??
                  new Promise<void>((resolve) => {
                    setTimeout(resolve, milliseconds);
                  });
                expired = await Promise.race([
                  completion.then(() => false),
                  deadline.then(
                    () => true,
                    () => true,
                  ),
                ]);
              }
            }
          },
        };
        const executors = new ExecutorRegistry();
        executors.register(processAdapter);
        const runtimes = new RuntimeAdapterRegistry();
        for (const runtime of plan.adapters) {
          runtimes.register(runtime);
        }
        const approvals = new HostApprovalStore();
        const service = new ExecutionService({
          executors,
          runtimes,
          routes: { materialize: async () => routes },
          ...(productionRuntimeAdapters ? { privateRouteConsumption: 'none' as const } : {}),
          ...(dependencies.audit ? { audit: dependencies.audit } : {}),
          approvals,
          hostPiProcessExecutor: dependencies.useSelectedExecutorForHostPi
            ? processAdapter
            : (dependencies.executorAdapters.find((a) => a.name === 'host') ?? processAdapter),
        });
        const environment = Object.fromEntries(
          Object.entries(request.environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        let hostApproval: Awaited<ReturnType<HostApprovalStore['approve']>> | undefined;
        if (descriptor.executor.name === 'host') {
          if (!dependencies.approveHost && !dependencies.tty?.direct) {
            throw new ExecutionError('HOST_TTY_REQUIRED', 'Host execution requires a direct TTY.');
          }
          const nonce = sha256Canonical({
            launchKey: descriptor.launchKey,
            runtimeContext,
          } as unknown as JsonValue);
          hostApproval = await approvals.approve(
            service.hostApprovalRequest(
              {
                descriptor,
                cwd: request.cwd,
                environment,
                ...(dependencies.expectedLaunchKey
                  ? { expectedLaunchKey: dependencies.expectedLaunchKey }
                  : {}),
              },
              nonce,
            ),
            dependencies.tty,
            dependencies.approveHost,
          );
        }
        const execute = () =>
          service.execute({
            descriptor,
            artifact: artifact.reference,
            capability: wiring.capability,
            runtimeStatusEnvelope: wiring.status,
            runtimeLaunchBinding: wiring.launchBinding,
            cwd: request.cwd,
            environment: { ...environment, MPX_RUNTIME_CONTEXT: JSON.stringify(runtimeContext) },
            ...(request.signal ? { signal: request.signal } : {}),
            privateLaunch: {
              launchKey: descriptor.launchKey,
              runtime: descriptor.runtime,
              identity: descriptor.identity,
              nativeRuntimeRoot: request.nativeRuntimeRoot,
            },
            ...(dependencies.expectedLaunchKey
              ? { expectedLaunchKey: dependencies.expectedLaunchKey }
              : {}),
            ...(hostApproval ? { hostApproval } : {}),
            ...(dependencies.tty ? { tty: dependencies.tty } : {}),
            ...(dependencies.approveHost ? { approveHost: true } : {}),
          });
        return execute();
      };
      return plan.cleanup ? consumeAfter(executeWithPlan, plan.cleanup) : executeWithPlan();
    };
    return lifecycle
      ? consumeAfter(executeWithLifecycle, () =>
          dependencies.lifecycle!.consume(lifecycle.binding.bindingId),
        )
      : executeWithLifecycle();
  }
}
export async function executeResolvedLaunch(
  request: LaunchExecutionRequest,
  dependencies: LaunchExecutionDependencies,
): Promise<ProcessResult> {
  return new LaunchExecutionService().execute(request, dependencies);
}

export function composeRuntimeSessionObservation(
  envelopeInput: RuntimeStatusEnvelopeV1,
  observationInput: RuntimeSessionObservationV1,
  now: string = new Date().toISOString(),
): RuntimeStatusEnvelopeV1 {
  const envelope = parseRuntimeStatusEnvelopeV1(envelopeInput),
    observation = parseRuntimeSessionObservationV1(observationInput);
  if (observation.runtime !== envelope.binding.runtimeId) {
    throw new MpxError({
      code: 'SESSION_OBSERVATION_BINDING_MISMATCH',
      message: 'The session observation runtime does not match the runtime status binding.',
    });
  }
  if (new Date(now).toISOString() !== now) {
    throw new MpxError({
      code: 'SESSION_OBSERVATION_TIME_INVALID',
      message: 'Session observation composition requires a canonical timestamp.',
    });
  }
  const { schemaVersion: _, generatedAt: __, binding, harness, ...groups } = envelope;
  const { session: ___, ...withoutSession } = groups;
  const metadata =
    observation.diagnostic !== null
      ? {
          source: 'cache' as const,
          state: 'error' as const,
          capturedAt: observation.capturedAt,
          freshUntil: null,
          diagnostic: observation.diagnostic,
          unavailable: null,
        }
      : {
          source: 'cache' as const,
          state:
            Date.parse(now) <= Date.parse(observation.freshUntil)
              ? ('current' as const)
              : ('stale' as const),
          capturedAt: observation.capturedAt,
          freshUntil: observation.freshUntil,
          diagnostic: null,
          unavailable: null,
        };
  return composeRuntimeStatusEnvelopeV1({
    generatedAt: now,
    binding,
    harness,
    contributions: [
      {
        source: 'cache',
        binding,
        groups: {
          session: { ...metadata, elapsedMs: null, turns: null, title: observation.title },
        },
      },
      {
        source: 'runtime',
        binding,
        groups: envelope.session.source === 'native' ? groups : withoutSession,
      },
    ],
  });
}
export function executionMpxError(error: ExecutionError): MpxError {
  const restart =
      error.code === 'LAUNCH_RESTART_REQUIRED' || error.details?.restartRequired === true,
    remediation =
      error.code === 'RUNTIME_CAPABILITY_UNSUPPORTED' &&
      typeof error.details?.remediation === 'string'
        ? error.details.remediation
        : undefined;
  return new MpxError({
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(restart
      ? {
          remediation:
            'Create a new launch and restart the runtime process; current-process rights cannot be widened.',
        }
      : remediation
        ? { remediation }
        : {}),
  });
}
