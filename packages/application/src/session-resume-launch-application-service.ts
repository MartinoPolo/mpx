import {
  MODE_RESOURCES,
  type DiscoveredConfig,
  type ModeResource,
  type ResourceAccess,
  type UserConfig,
} from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue, type SkillArtifactReference } from '@mpx/core';
import { resolveLaunchSelection, type LaunchDescriptor, type LaunchSelection } from '@mpx/launch';
import type { LaunchSnapshot, NativeVerifiedResumeSeed, ResumePlan } from '@mpx/sessions';
import type { CatalogSkill, ResolvedManifest, RuntimeSkillArtifact } from '@mpx/skills/contracts';

export interface ResumePiPreflight {
  readonly nativeBinding: unknown;
  readonly reverify: () => Promise<void>;
}

export interface ResumeExecutionRoots {
  readonly artifactsRoot: string;
  readonly stateRoot: string;
  readonly [key: string]: unknown;
}

export interface ResumeSkillFacts {
  readonly catalog: readonly CatalogSkill[];
  readonly manifest: ResolvedManifest;
  readonly artifact: RuntimeSkillArtifact;
  readonly skillArtifact: SkillArtifactReference;
}

export interface ResumeExecutionInput extends ResumeSkillFacts {
  readonly plan: ResumePlan;
  readonly descriptor: LaunchDescriptor;
  readonly selection: LaunchSelection;
  readonly project?: DiscoveredConfig;
  readonly repositoryId: string;
  readonly canonicalRoot: string;
  readonly cwd: string;
  readonly nativeRuntimeRoot: string;
  readonly nativeBinding: unknown;
  readonly roots: ResumeExecutionRoots;
  readonly beforeChildExecution: () => Promise<void>;
}

export interface PreparedResumeExecutor {
  readonly assertReady: () => Promise<void>;
  readonly execute: (input: ResumeExecutionInput) => Promise<object>;
}

export interface SessionResumeLaunchApplicationDependencies {
  confirmationDigest(plan: Omit<ResumePlan, 'confirmationDigest'>): string;
  verifySeed(seed: NativeVerifiedResumeSeed): Promise<NativeVerifiedResumeSeed>;
  readUserConfig?(current: UserConfig): Promise<UserConfig>;
  piPreflight(plan: NativeVerifiedResumeSeed, userConfig: UserConfig): Promise<ResumePiPreflight>;
  isAbsolutePath(value: string): boolean;
  discoverProjectConfig(cwd: string): Promise<DiscoveredConfig | undefined>;
  canonicalRoot(cwd: string): Promise<string>;
  rebuildSkills(input: {
    readonly plan: NativeVerifiedResumeSeed;
    readonly userConfig: UserConfig;
    readonly project?: DiscoveredConfig;
    readonly repositoryId: string;
    readonly canonicalRoot: string;
    readonly selection: LaunchSelection;
  }): Promise<ResumeSkillFacts>;
  prepareExecutor(input: {
    readonly plan: NativeVerifiedResumeSeed;
    readonly userConfig: UserConfig;
    readonly project?: DiscoveredConfig;
    readonly repositoryId: string;
    readonly selection: LaunchSelection;
  }): Promise<PreparedResumeExecutor>;
  resolveDescriptor(input: {
    readonly plan: NativeVerifiedResumeSeed;
    readonly userConfig: UserConfig;
    readonly projectId?: string;
    readonly repositoryId: string;
    readonly selection: LaunchSelection;
    readonly skills: ResumeSkillFacts;
    readonly project?: DiscoveredConfig;
    readonly selectedConfigDigest: string;
  }): Promise<LaunchDescriptor>;
  descriptorDigest?(descriptor: LaunchDescriptor): string;
  requireExecutionRoots(): Promise<ResumeExecutionRoots>;
  readNativeBinding(ref: string): Promise<unknown>;
}

export interface ResumeEffectiveAuthority {
  readonly schemaVersion: 1;
  readonly resources: readonly {
    readonly selector: ModeResource;
    readonly access: ResourceAccess | 'none';
  }[];
  readonly network: {
    readonly preset: 'allow-all' | 'balanced' | 'deny-all' | null;
    readonly denyPrivateNetworks: boolean | null;
    readonly approvedProjectAdditions: boolean | null;
    readonly approvedDeliveryAdditions: boolean | null;
    readonly requiredRuntimeEndpoints: boolean | null;
  };
  readonly routes: {
    readonly gitAuthor: string;
    readonly providers: readonly { readonly provider: string; readonly route: string }[];
    readonly ssh: string | null;
    readonly mcp: { readonly allow: readonly string[]; readonly shareNativeAuth: false };
  };
  readonly executor: {
    readonly kind: 'host' | 'docker';
    readonly enforcement: 'advisory' | 'mount-enforced';
    readonly isolation: 'none' | 'container';
  };
  readonly skills: {
    readonly manifestKey: string;
    readonly artifactKey: string;
    readonly decisions: readonly {
      readonly identity: string;
      readonly included: boolean;
      readonly exclusionReasons: readonly string[];
      readonly exposure: 'full' | 'name-only' | 'explicit-only';
      readonly humanInvocation: boolean;
      readonly modelInvocation: boolean;
      readonly metadataHash: string;
      readonly sourceHash: string;
    }[];
  };
}

export interface ProspectiveSessionResumePlan extends ResumePlan {
  readonly effectiveAuthority: ResumeEffectiveAuthority;
}

function effectiveAuthority(
  descriptor: LaunchDescriptor,
  skills: ResumeSkillFacts,
): ResumeEffectiveAuthority {
  const network = descriptor.networkPolicy.declaration;
  return {
    schemaVersion: 1,
    resources: [...MODE_RESOURCES].sort().map((selector) => ({
      selector,
      access: descriptor.intendedPolicy.resources[selector] ?? 'none',
    })),
    network: {
      preset: network.preset ?? null,
      denyPrivateNetworks: network.denyPrivateNetworks ?? null,
      approvedProjectAdditions: network.approvedProjectAdditions ?? null,
      approvedDeliveryAdditions: network.approvedDeliveryAdditions ?? null,
      requiredRuntimeEndpoints: network.requiredRuntimeEndpoints ?? null,
    },
    routes: {
      gitAuthor: descriptor.routes.gitAuthor,
      providers: Object.entries(descriptor.routes.providers)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([provider, route]) => ({ provider, route })),
      ssh: descriptor.routes.ssh,
      mcp: { allow: [...descriptor.routes.mcp.allow].sort(), shareNativeAuth: false },
    },
    executor: {
      kind: descriptor.executor.name,
      enforcement: descriptor.executor.effectiveEnforcement,
      isolation: descriptor.executor.isolation,
    },
    skills: {
      manifestKey: skills.manifest.manifestKey,
      artifactKey: skills.artifact.reference.artifactKey,
      decisions: [...skills.manifest.decisions]
        .sort((left, right) =>
          left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0,
        )
        .map((decision) => ({
          identity: decision.identity,
          included: decision.included,
          exclusionReasons: [...decision.exclusionReasons].sort(),
          exposure: decision.exposure,
          humanInvocation: decision.permissions.humanInvocation,
          modelInvocation: decision.permissions.modelInvocation,
          metadataHash: decision.metadataHash,
          sourceHash: decision.sourceHash,
        })),
    },
  };
}

declare const preparedResumeBrand: unique symbol;
export interface PreparedSessionResumeLaunch {
  readonly [preparedResumeBrand]: true;
}

interface PreparedFacts {
  readonly execute: () => Promise<unknown>;
}

const fail = (code: string, message: string, details?: Record<string, string | boolean | null>) =>
  new MpxError({ code, message, ...(details ? { details } : {}) });

const invalidState = () =>
  fail(
    'SESSION_RESUME_LAUNCH_STATE_INVALID',
    'Prepared session resume launch is invalid, consumed, or belongs to another service.',
  );

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      immutable(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function stableDigest(value: unknown): string {
  return sha256Canonical(value as JsonValue);
}

type ApprovalAxis =
  'native' | 'launch' | 'selectedConfig' | 'recordedLaunch' | 'effectiveAuthority';

function assertCommitment(axis: ApprovalAxis, approved: unknown, current: unknown): void {
  const approvedDigest = stableDigest(approved);
  const currentDigest = stableDigest(current);
  if (approvedDigest !== currentDigest) {
    throw fail('SESSION_RESUME_PLAN_STALE', 'Resume approval evidence has changed.', {
      axis,
      approvedDigest,
      currentDigest,
    });
  }
}

function nativeAxes(seed: NativeVerifiedResumeSeed) {
  return {
    schemaVersion: seed.schemaVersion,
    newLaunchRequired: seed.newLaunchRequired,
    previousLaunch: seed.previousLaunch,
    recordId: seed.recordId,
    runtimeQualifiedId: seed.runtimeQualifiedId,
    runtime: seed.runtime,
    identity: seed.identity,
    nativeBindingRef: seed.nativeBindingRef,
    nativeSessionRef: seed.nativeSessionRef,
    nativeVerificationDigest: seed.nativeVerificationDigest,
    cwd: seed.cwd,
    projectId: seed.projectId,
    repositoryId: seed.repositoryId,
  };
}

function selectedConfigDigest(
  seed: NativeVerifiedResumeSeed,
  user: UserConfig,
  canonicalRoot: string,
  project?: DiscoveredConfig,
): string {
  const identity = user.identities[seed.identity.name]!;
  const networkPolicies: Record<string, UserConfig['networkPolicies'][string]> = {};
  let name: string | undefined = seed.launch.networkPolicy;
  while (name && !Object.hasOwn(networkPolicies, name)) {
    const declaration: UserConfig['networkPolicies'][string] | undefined =
      user.networkPolicies[name];
    if (!declaration) {
      break;
    }
    networkPolicies[name] = declaration;
    name = declaration.extends;
  }
  return stableDigest({
    identity: {
      domain: identity.domain,
      nativeRuntimeRoot: identity.runtimeRoots[seed.runtime],
      gitAuthorRoute: identity.gitAuthorRoute,
      providerRoutes: identity.providerRoutes ?? {},
      sshRoute: identity.sshRoute ?? null,
      mcpSharing: identity.mcpSharing ?? null,
    },
    domains: user.domains,
    locations: user.locations,
    selection: seed.launch.selection,
    mode: user.modes[seed.launch.mode],
    networkPolicies,
    executor: user.executors[seed.launch.executor.kind],
    projectOverride: user.projects?.[seed.projectId ?? ''] ?? null,
    project: project ? { root: project.root, config: project.config } : null,
    canonicalRoot,
  });
}

export class SessionResumeLaunchApplicationService {
  readonly #prepared = new WeakMap<object, PreparedFacts>();
  constructor(private readonly dependencies: SessionResumeLaunchApplicationDependencies) {}

  async #build(plan: NativeVerifiedResumeSeed, userConfig: UserConfig) {
    if (plan.launch.executor.kind === 'docker') {
      throw fail('EXECUTOR_UNAVAILABLE', 'Docker execution is unavailable.', {
        hostFallback: false,
      });
    }
    const pi =
      plan.runtime === 'pi' ? await this.dependencies.piPreflight(plan, userConfig) : undefined;
    await pi?.reverify();
    if (!this.dependencies.isAbsolutePath(plan.cwd)) {
      throw fail(
        'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
        'The recorded workspace is not an absolute launch cwd.',
      );
    }
    const discovered = await this.dependencies.discoverProjectConfig(plan.cwd);
    const project = discovered ? immutable(structuredClone(discovered)) : undefined;
    if ((project?.config.project.id ?? null) !== plan.projectId) {
      throw fail(
        'SESSION_RESUME_LAUNCH_BINDING_MISMATCH',
        'The current project binding does not match the recorded launch.',
      );
    }
    if (
      plan.repositoryId === null ||
      !(['clone', 'host-worktree', 'direct'] as readonly string[]).includes(plan.launch.workspace)
    ) {
      throw fail(
        'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
        'The recorded launch lacks a repository binding or valid workspace strategy.',
      );
    }
    // A persisted snapshot is not proof of unrestricted approval.
    if (plan.launch.mode === 'unrestricted') {
      throw fail(
        'SESSION_RESUME_APPROVAL_UNAVAILABLE',
        'Resume cannot reconstruct unrestricted approval evidence.',
      );
    }
    const projectId = plan.projectId ?? undefined;
    const selection = await resolveLaunchSelection({
      userConfig,
      cwd: plan.cwd,
      runtime: plan.runtime,
      identity: plan.identity.name,
      mode: plan.launch.mode,
      executor: plan.launch.executor.kind,
      workspace: plan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
      networkPolicy: plan.launch.networkPolicy,
      ...(project ? { projectConfig: project.config } : {}),
      ...(projectId ? { projectId } : {}),
    });
    if (selection.identity.domain !== plan.identity.domain) {
      throw fail(
        'SESSION_RESUME_IDENTITY_MISMATCH',
        'The current launch identity does not match the recorded domain.',
      );
    }
    const canonicalRoot = await this.dependencies.canonicalRoot(plan.cwd);
    const configurationDigest = selectedConfigDigest(plan, userConfig, canonicalRoot, project);
    const skills = await this.dependencies.rebuildSkills({
      plan,
      userConfig,
      ...(project ? { project } : {}),
      repositoryId: plan.repositoryId,
      canonicalRoot,
      selection,
    });
    const preparedExecutor = await this.dependencies.prepareExecutor({
      plan,
      userConfig,
      ...(project ? { project } : {}),
      repositoryId: plan.repositoryId,
      selection,
    });
    await preparedExecutor.assertReady();
    const descriptor = immutable(
      await this.dependencies.resolveDescriptor({
        plan,
        userConfig,
        ...(projectId ? { projectId } : {}),
        repositoryId: plan.repositoryId,
        selection,
        skills,
        ...(project ? { project } : {}),
        selectedConfigDigest: configurationDigest,
      }),
    );
    if (
      descriptor.runtime !== plan.runtime ||
      descriptor.identity.domain !== plan.identity.domain ||
      descriptor.identity.name !== plan.identity.name
    ) {
      assertCommitment(
        'native',
        { runtime: plan.runtime, identity: plan.identity },
        { runtime: descriptor.runtime, identity: descriptor.identity },
      );
    }
    const launch: LaunchSnapshot = {
      launchKey: descriptor.launchKey,
      descriptorDigest:
        this.dependencies.descriptorDigest?.(descriptor) ??
        sha256Canonical(descriptor as unknown as JsonValue),
      mode: descriptor.mode,
      selection: structuredClone(descriptor.selection),
      executor: { kind: descriptor.executor.name },
      workspace: descriptor.workspace,
      networkPolicy: descriptor.networkPolicy.name,
      artifactKey: skills.artifact.reference.artifactKey,
      manifestKey: skills.manifest.manifestKey,
    };
    return {
      launch,
      effectiveAuthority: effectiveAuthority(descriptor, skills),
      configurationDigest,
      skills,
      preparedExecutor,
      descriptor,
      selection,
      canonicalRoot,
      project,
      pi,
    };
  }

  async plan(
    seed: NativeVerifiedResumeSeed,
    userConfig: UserConfig,
  ): Promise<ProspectiveSessionResumePlan> {
    seed = immutable(structuredClone(seed));
    userConfig = immutable(structuredClone(userConfig));
    const verified = await this.dependencies.verifySeed(seed);
    assertCommitment('native', nativeAxes(seed), nativeAxes(verified));
    assertCommitment('recordedLaunch', seed.launch, verified.launch);
    const current = await this.#build(seed, userConfig);
    const unsigned = {
      ...nativeAxes(seed),
      launch: current.launch,
      effectiveAuthority: current.effectiveAuthority,
      approval: {
        schemaVersion: 1 as const,
        selectedConfigDigest: current.configurationDigest,
        recordedLaunchDigest: stableDigest(seed.launch),
        resurrection:
          stableDigest(seed.launch) === stableDigest(current.launch)
            ? ('unchanged' as const)
            : ('confirmation-required' as const),
      },
    };
    return immutable({
      ...unsigned,
      confirmationDigest: this.dependencies.confirmationDigest(unsigned),
    });
  }

  async #verifiedBuild(plan: ResumePlan, userConfig: UserConfig) {
    const seed = immutable(await this.dependencies.verifySeed(plan));
    assertCommitment('native', nativeAxes(plan), nativeAxes(seed));
    assertCommitment(
      'recordedLaunch',
      plan.approval.recordedLaunchDigest,
      stableDigest(seed.launch),
    );
    const current = await this.#build(seed, userConfig);
    assertCommitment(
      'selectedConfig',
      plan.approval.selectedConfigDigest,
      current.configurationDigest,
    );
    assertCommitment('launch', plan.launch, current.launch);
    assertCommitment(
      'effectiveAuthority',
      'effectiveAuthority' in plan ? plan.effectiveAuthority : null,
      current.effectiveAuthority,
    );
    return current;
  }

  async prepare(plan: ResumePlan, userConfig: UserConfig): Promise<PreparedSessionResumeLaunch> {
    plan = immutable(structuredClone(plan));
    userConfig = immutable(structuredClone(userConfig));
    if (plan.launch.executor.kind === 'docker') {
      throw fail('EXECUTOR_UNAVAILABLE', 'Docker execution is unavailable.', {
        hostFallback: false,
      });
    }
    if (!plan.approval || plan.approval.schemaVersion !== 1) {
      throw fail(
        'SESSION_RESUME_APPROVAL_UNAVAILABLE',
        'A prospective resume approval is required.',
      );
    }
    const { confirmationDigest, ...unsigned } = plan;
    if (this.dependencies.confirmationDigest(unsigned) !== confirmationDigest) {
      throw fail(
        'SESSION_RESUME_CONFIRMATION_MISMATCH',
        'Resume plan confirmation digest does not match.',
      );
    }
    userConfig = immutable(
      structuredClone((await this.dependencies.readUserConfig?.(userConfig)) ?? userConfig),
    );
    const current = await this.#verifiedBuild(plan, userConfig);
    const roots = immutable(structuredClone(await this.dependencies.requireExecutionRoots()));
    const nativeBinding = immutable(
      structuredClone(
        current.pi?.nativeBinding ??
          (await this.dependencies.readNativeBinding(plan.nativeBindingRef)),
      ),
    );
    let childVerificationAvailable = true;
    const executionInput: ResumeExecutionInput = immutable({
      plan,
      descriptor: current.descriptor,
      selection: current.selection,
      ...current.skills,
      ...(current.project ? { project: current.project } : {}),
      repositoryId: plan.repositoryId!,
      canonicalRoot: current.canonicalRoot,
      cwd: plan.cwd,
      nativeRuntimeRoot: userConfig.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
      nativeBinding,
      roots,
      beforeChildExecution: async () => {
        if (!childVerificationAvailable) {
          throw invalidState();
        }
        childVerificationAvailable = false;
        await this.#verifiedBuild(
          plan,
          (await this.dependencies.readUserConfig?.(userConfig)) ?? userConfig,
        );
      },
    });
    const token = Object.freeze(Object.create(null)) as PreparedSessionResumeLaunch;
    this.#prepared.set(token as object, {
      execute: async () => {
        await this.#verifiedBuild(
          plan,
          (await this.dependencies.readUserConfig?.(userConfig)) ?? userConfig,
        );
        const result = await current.preparedExecutor.execute(executionInput);
        return {
          ...result,
          resumeLaunch: {
            previousLaunchKey: plan.previousLaunch.launchKey,
            previousDescriptorDigest: plan.previousLaunch.descriptorDigest,
            newLaunchKey: current.launch.launchKey,
            newDescriptorDigest: current.launch.descriptorDigest,
          },
        };
      },
    });
    return token;
  }

  async execute(state: PreparedSessionResumeLaunch): Promise<unknown> {
    const facts = this.#prepared.get(state as object);
    if (!facts) {
      throw invalidState();
    }
    this.#prepared.delete(state as object);
    return facts.execute();
  }
}
