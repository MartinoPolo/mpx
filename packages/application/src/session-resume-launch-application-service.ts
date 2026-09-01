import type { DiscoveredConfig, UserConfig } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue, type SkillArtifactReference } from '@mpx/core';
import {
  resolveLaunchSelection,
  type ExecutorVerificationEvidence,
  type LaunchDescriptor,
  type LaunchSelection,
} from '@mpx/launch';
import type { F2SandboxSessionResumeAdmission } from '@mpx/executors';
import type { ResumePlanV1 } from '@mpx/sessions';
import type { CatalogSkill, ResolvedManifest, RuntimeSkillArtifact } from '@mpx/skills';

export type ResumeDockerAdmission = F2SandboxSessionResumeAdmission;
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
  readonly plan: ResumePlanV1;
  readonly descriptor: LaunchDescriptor;
  readonly selection: LaunchSelection;
  readonly project?: DiscoveredConfig;
  readonly repositoryId: string;
  readonly canonicalRoot: string;
  readonly cwd: string;
  readonly nativeRuntimeRoot: string;
  readonly nativeBinding: unknown;
  readonly roots: ResumeExecutionRoots;
  /** Service-owned one-shot Pi account check delegated to the exact child boundary. */
  readonly beforeChildExecution?: () => Promise<void>;
}
export interface PreparedResumeExecutor {
  readonly evidence: ExecutorVerificationEvidence;
  /** This closure is the sole execution authority corresponding to evidence. */
  readonly execute: (input: ResumeExecutionInput) => Promise<object>;
}
export interface SessionResumeLaunchApplicationDependencies {
  dockerAdmission(plan: ResumePlanV1): Promise<ResumeDockerAdmission>;
  piPreflight(plan: ResumePlanV1, userConfig: UserConfig): Promise<ResumePiPreflight>;
  isAbsolutePath(value: string): boolean;
  discoverProjectConfig(cwd: string): Promise<DiscoveredConfig | undefined>;
  canonicalRoot(cwd: string): Promise<string>;
  rebuildSkills(input: {
    readonly plan: ResumePlanV1;
    readonly userConfig: UserConfig;
    readonly project?: DiscoveredConfig;
    readonly repositoryId: string;
    readonly canonicalRoot: string;
    readonly selection: LaunchSelection;
  }): Promise<ResumeSkillFacts>;
  prepareExecutor(input: {
    readonly plan: ResumePlanV1;
    readonly userConfig: UserConfig;
    readonly project?: DiscoveredConfig;
    readonly repositoryId: string;
    readonly selection: LaunchSelection;
    readonly dockerAdmission?: ResumeDockerAdmission;
  }): Promise<PreparedResumeExecutor>;
  resolveDescriptor(input: {
    readonly plan: ResumePlanV1;
    readonly userConfig: UserConfig;
    readonly projectId?: string;
    readonly repositoryId: string;
    readonly selection: LaunchSelection;
    readonly skills: ResumeSkillFacts;
    readonly evidence: ExecutorVerificationEvidence;
  }): Promise<LaunchDescriptor>;
  descriptorDigest?(descriptor: LaunchDescriptor): string;
  requireExecutionRoots(): Promise<ResumeExecutionRoots>;
  readNativeBinding(ref: string): Promise<unknown>;
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

export class SessionResumeLaunchApplicationService {
  readonly #prepared = new WeakMap<object, PreparedFacts>();
  constructor(private readonly dependencies: SessionResumeLaunchApplicationDependencies) {}

  async prepare(plan: ResumePlanV1, userConfig: UserConfig): Promise<PreparedSessionResumeLaunch> {
    plan = immutable(structuredClone(plan));
    userConfig = immutable(structuredClone(userConfig));
    const dockerAdmission =
      plan.launch.executor.kind === 'docker'
        ? await this.dependencies.dockerAdmission(plan)
        : undefined;
    if (dockerAdmission && !dockerAdmission.admitted) {
      throw fail(
        'SESSION_RESUME_F2_ADMISSION_DENIED',
        'Docker resume requires matching persisted F2 proof, plan, inventory, attestation, and identity; recreate in Docker is required.',
        {
          hostFallback: false,
          action: 'recreate',
          admissionCode: dockerAdmission.code,
        },
      );
    }

    const pi =
      plan.runtime === 'pi' ? await this.dependencies.piPreflight(plan, userConfig) : undefined;
    const reverify = pi?.reverify;
    const piNativeBinding = pi ? immutable(structuredClone(pi.nativeBinding)) : undefined;
    await reverify?.();

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
    if (plan.repositoryId === null) {
      throw fail(
        'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
        'The recorded launch lacks a repository binding.',
      );
    }
    if (
      !(['clone', 'host-worktree', 'direct'] as readonly string[]).includes(plan.launch.workspace)
    ) {
      throw fail(
        'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
        'The recorded launch lacks a valid workspace strategy.',
      );
    }

    const projectId = plan.projectId ?? undefined;
    const selection = await resolveLaunchSelection({
      userConfig,
      cwd: plan.cwd,
      runtime: plan.runtime,
      identity: plan.identity.name,
      mode: plan.launch.mode,
      skillPolicy: plan.launch.skillPolicy,
      contentScope: plan.launch.contentScope,
      executor: plan.launch.executor.kind,
      workspace: plan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
      networkPolicy: plan.launch.networkPolicy,
      ...(projectId ? { projectId } : {}),
    });
    if (selection.identity.domain !== plan.identity.domain) {
      throw fail(
        'SESSION_RESUME_IDENTITY_MISMATCH',
        'The current launch identity does not match the recorded domain.',
      );
    }
    if (!userConfig.contentScopes[plan.launch.contentScope]) {
      throw fail(
        'SESSION_RESUME_LAUNCH_SNAPSHOT_INCOMPLETE',
        'The recorded content scope is no longer configured.',
      );
    }

    const canonicalRoot = await this.dependencies.canonicalRoot(plan.cwd);
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
      ...(dockerAdmission ? { dockerAdmission } : {}),
    });
    const executorEvidence = immutable(structuredClone(preparedExecutor.evidence));
    const executePrepared = preparedExecutor.execute;
    const descriptor = await this.dependencies.resolveDescriptor({
      plan,
      userConfig,
      ...(projectId ? { projectId } : {}),
      repositoryId: plan.repositoryId,
      selection,
      skills,
      evidence: executorEvidence,
    });
    const descriptorDigest =
      this.dependencies.descriptorDigest?.(descriptor) ??
      sha256Canonical(descriptor as unknown as JsonValue);
    const currentLaunch = {
      launchKey: descriptor.launchKey,
      descriptorDigest,
      mode: descriptor.mode,
      skillPolicy: descriptor.skillPolicy,
      contentScope: descriptor.contentScope.name,
      executor: { kind: descriptor.executor.name },
      workspace: descriptor.workspace,
      networkPolicy: descriptor.networkPolicy.name,
      grants: descriptor.grants,
      artifactKey: skills.artifact.reference.artifactKey,
      manifestKey: skills.manifest.manifestKey,
    };
    const {
      launchKey: currentLaunchKey,
      descriptorDigest: currentDescriptorDigest,
      ...currentAxes
    } = currentLaunch;
    const {
      launchKey: previousLaunchKey,
      descriptorDigest: previousDescriptorDigest,
      ...recordedAxes
    } = plan.launch;
    if (
      previousLaunchKey !== plan.previousLaunch.launchKey ||
      previousDescriptorDigest !== plan.previousLaunch.descriptorDigest ||
      descriptor.runtime !== plan.runtime ||
      descriptor.identity.domain !== plan.identity.domain ||
      descriptor.identity.name !== plan.identity.name ||
      sha256Canonical(currentAxes as unknown as JsonValue) !==
        sha256Canonical(recordedAxes as unknown as JsonValue)
    ) {
      throw fail(
        'SESSION_RESUME_PLAN_STALE',
        'Current capability, policy, grant, artifact, or manifest evidence differs from the explicitly confirmed resume plan.',
      );
    }

    const roots = immutable(structuredClone(await this.dependencies.requireExecutionRoots()));
    const nativeBinding = immutable(
      structuredClone(
        piNativeBinding ?? (await this.dependencies.readNativeBinding(plan.nativeBindingRef)),
      ),
    );
    let childReverifyAvailable = reverify !== undefined;
    const beforeChildExecution = reverify
      ? async (): Promise<void> => {
          if (!childReverifyAvailable) {
            throw invalidState();
          }
          childReverifyAvailable = false;
          await reverify();
        }
      : undefined;
    const executionInput: ResumeExecutionInput = immutable({
      plan,
      descriptor,
      selection,
      ...skills,
      ...(project ? { project } : {}),
      repositoryId: plan.repositoryId,
      canonicalRoot,
      cwd: plan.cwd,
      nativeRuntimeRoot: userConfig.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
      nativeBinding,
      roots,
      ...(beforeChildExecution ? { beforeChildExecution } : {}),
    });
    const token = Object.freeze(Object.create(null)) as PreparedSessionResumeLaunch;
    this.#prepared.set(token as object, {
      execute: async () => {
        const result = await executePrepared(executionInput);
        return {
          ...result,
          resumeLaunch: {
            previousLaunchKey,
            previousDescriptorDigest,
            newLaunchKey: currentLaunchKey,
            newDescriptorDigest: currentDescriptorDigest,
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
