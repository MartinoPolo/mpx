import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type {
  LaunchRuntimeWiring,
  LaunchRuntimeResumeTarget,
  LaunchStatusSnapshotMaterializer,
  RuntimeStatusEnvelopeMaterializer,
} from '../launch-execution-service.js';
import {
  NodeRuntimeStatusEnvelopeMaterializer,
  nodeDockerGate,
  nodeHostExecutor,
  resolveLaunchStatusSnapshotPath,
  type TrustedRuntimeExecutable,
} from './launch-execution-adapters.js';
import { MpxError } from '@mpx/core';
import {
  ExecutionError,
  type DirectTty,
  type ExecutorAdapter,
  type LaunchAuditStore,
  type RuntimeAdapter,
  type RuntimeLaunchBinding,
  type VerificationEvidence,
} from '@mpx/executors';
import { loadRuntimeProfilesV1 } from '@mpx/config';
import {
  compileContent,
  verifyCompiledContentTree,
  type CompiledContentTree,
} from '@mpx/content-compiler';
import type { LaunchDescriptor } from '@mpx/launch';
import {
  revalidateRuntimeArtifact,
  type NativeSessionRefV1,
  type PublishedRuntimeArtifactReference,
  type RuntimeCapabilityManifestV1,
  type RuntimeContextV1,
  type RuntimeSessionObservationV1,
  type SessionLifecycleBindingV1,
} from '@mpx/runtime-contracts';
import type { NativeBindingRecordV1 } from '@mpx/sessions';
import { createClaudeInvocationPlan, publishClaudeProjection } from '@mpx/runtime-claude';
import { materializeClaudeGateway } from './claude-gateway.js';
import {
  buildPiProjection,
  planPiInvocation,
  type PiPublishedProjection,
  type PiRuntimeProfileV1,
  type VerifiedPiResumeTarget,
} from '@mpx/runtime-pi';
import type { SkillProjectionPlan, RuntimeSkillArtifact } from '@mpx/skills';
import type { RuntimeStatusEnvelopeV1, StatusSnapshotV1 } from '@mpx/status';

export interface LaunchProjection {
  readonly directory: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly pluginDirectory?: string;
  readonly runtimeContextFile?: string;
  readonly profile?: PiRuntimeProfileV1;
}
export interface LaunchProjectionBuildInput {
  readonly descriptor: LaunchDescriptor;
  readonly skillPlan: SkillProjectionPlan;
  readonly compiledContent: CompiledContentTree;
  readonly agentsRoot: string;
  readonly runtimeProfilesFile: string;
  readonly artifactsRoot: string;
  readonly runtimeContext: RuntimeContextV1;
  readonly statusSnapshot: StatusSnapshotV1;
  readonly runtimeStatusEnvelope: RuntimeStatusEnvelopeV1;
  readonly runtimeCapabilityManifest: RuntimeCapabilityManifestV1;
  readonly runtimeLaunchBinding: RuntimeLaunchBinding;
  readonly piRuntimeProfile?: PiRuntimeProfileV1;
  readonly launchBanner: string;
  readonly artifactRevalidator?: typeof revalidateRuntimeArtifact;
}

export interface LaunchExecutionContext {
  launchExecutorAdapters?: readonly ExecutorAdapter[];
  launchRuntimeAdapters?: readonly RuntimeAdapter[];
  launchRoutes?: {
    materialize(
      descriptor: LaunchDescriptor,
      projectRoot?: string,
    ): Promise<Readonly<Record<string, string>>>;
  };
  launchAudit?: LaunchAuditStore;
  launchTty?: DirectTty;
  launchExpectedKey?: string;
  launchProjectionBuilder?: (input: LaunchProjectionBuildInput) => Promise<LaunchProjection>;
  launchProjectionValidator?: (input: {
    runtime: 'claude' | 'pi';
    directory: string;
    reference: PublishedRuntimeArtifactReference;
  }) => Promise<void>;
  launchProjectionArtifactRevalidator?: typeof revalidateRuntimeArtifact;
  launchExecutableResolver?: (input: {
    runtime: 'claude' | 'pi';
    candidate: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }) => Promise<{ executable: string; argvPrefix: readonly string[] }>;
  launchRuntimeWiringFactory?: (input: {
    descriptor: LaunchDescriptor;
    artifact: RuntimeSkillArtifact;
    snapshot: StatusSnapshotV1;
    cwd: string;
    sessionObservation?: RuntimeSessionObservationV1;
  }) => RuntimeLaunchWiring;
  launchSessionObservation?: RuntimeSessionObservationV1;
  launchStatusSnapshotMaterializer?: LaunchStatusSnapshotMaterializer;
  launchStatusSnapshotReader?: (file: string, signal?: AbortSignal) => Promise<StatusSnapshotV1>;
  launchStatusRefreshClock?: {
    schedule(callback: () => Promise<void>, intervalMs: number): () => void;
  };
  launchStatusShutdownClock?: { wait(milliseconds: number): Promise<void> };
  launchStatusShutdownDeadlineMs?: number;
  launchLifecycleBridge?: {
    prepare(input: {
      descriptor: LaunchDescriptor;
      runtimeContext: RuntimeContextV1;
      nativeRuntimeRoot: string;
      cwd: string;
      nativeSessionRef?: NativeSessionRefV1;
      nativeBinding?: NativeBindingRecordV1;
    }): Promise<{ binding: SessionLifecycleBindingV1; eventDirectory: string }>;
    consume(bindingId: string): Promise<void>;
    observe?(bindingId: string): Promise<RuntimeSessionObservationV1 | undefined>;
  };
}

export function directProcessTty(): DirectTty {
  return {
    direct: Boolean(stdin.isTTY && stdout.isTTY),
    confirm: async (message) => {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        return (await terminal.question(`${message}\nType YES to continue: `)).trim() === 'YES';
      } finally {
        terminal.close();
      }
    },
  };
}

export function executorAdapter(
  context: LaunchExecutionContext,
  name: 'docker' | 'host',
): ExecutorAdapter {
  return (
    context.launchExecutorAdapters?.find((adapter) => adapter.name === name) ??
    (name === 'docker' ? nodeDockerGate : nodeHostExecutor)
  );
}

export async function collectNodeExecutorEvidence(
  context: LaunchExecutionContext,
  name: 'docker' | 'host',
): Promise<VerificationEvidence> {
  return executorAdapter(context, name).verify();
}

const CLAUDE_MODEL_TOOLS = Object.freeze([
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
const PI_MODEL_TOOLS = Object.freeze([
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
export interface RuntimeLaunchWiring extends LaunchRuntimeWiring {
  readonly runtimeProfile?: PiRuntimeProfileV1;
}
export function resolveClaudeCanonicalOutputStyle(agentsRoot: string): string {
  return path.join(agentsRoot, '..', 'output-styles', 'mpx-terse.md');
}
async function buildProductionProjection(
  input: LaunchProjectionBuildInput,
): Promise<LaunchProjection> {
  const compiledContent = verifyCompiledContentTree(input.compiledContent, {
    runtime: input.descriptor.runtime,
    plan: input.skillPlan,
  });
  if (input.descriptor.runtime === 'pi') {
    return buildPiProjection({
      skillPlan: input.skillPlan,
      compiledContent,
      context: input.runtimeContext,
      expectedLaunch: {
        launchKey: input.descriptor.launchKey,
        descriptorDigest: input.runtimeContext.launchDescriptor.digest,
      },
      currentBinding: input.skillPlan.binding,
      artifactsRoot: input.artifactsRoot,
      piRuntimeProfile: input.piRuntimeProfile!,
      ...(input.artifactRevalidator ? { artifactRevalidator: input.artifactRevalidator } : {}),
    });
  }
  return publishClaudeProjection({
    skillPlan: input.skillPlan,
    compiledContent,
    outputStyle: resolveClaudeCanonicalOutputStyle(input.agentsRoot),
    artifactsRoot: input.artifactsRoot,
    statusSnapshot: input.statusSnapshot,
    runtimeStatusEnvelope: input.runtimeStatusEnvelope,
    launchBanner: input.launchBanner,
    runtimeContext: input.runtimeContext,
    ...(input.artifactRevalidator ? { artifactRevalidator: input.artifactRevalidator } : {}),
  });
}
export function productionRuntimeAdapters(input: {
  descriptor: LaunchDescriptor;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  nativeRuntimeRoot: string;
  stateRoot: string;
  projectionInput: Omit<
    LaunchProjectionBuildInput,
    'statusSnapshot' | 'launchBanner' | 'compiledContent'
  >;
  launchBanner: string;
  initialSnapshot: StatusSnapshotV1;
  statusSnapshot: (signal?: AbortSignal) => Promise<StatusSnapshotV1>;
  bindStatusPath: (value: string | undefined) => void;
  bindRuntimeStatusPath: (value: string) => void;
  lifecycle?: { binding: SessionLifecycleBindingV1; eventDirectory: string };
  resumeTarget?: LaunchRuntimeResumeTarget;
  statusMaterializer?: LaunchStatusSnapshotMaterializer;
  runtimeStatusMaterializer?: RuntimeStatusEnvelopeMaterializer;
  trustedExecutable?: TrustedRuntimeExecutable;
  builder?: LaunchExecutionContext['launchProjectionBuilder'];
  validator?: LaunchExecutionContext['launchProjectionValidator'];
}): RuntimeAdapter[] {
  const projection = async (runtime: 'claude' | 'pi') => {
    const snapshot = input.initialSnapshot;
    let statusSnapshotPath: string | undefined;
    let runtimeStatusPath: string | undefined;
    if (runtime === 'claude') {
      statusSnapshotPath = await resolveLaunchStatusSnapshotPath({
        stateRoot: input.stateRoot,
        descriptor: input.descriptor,
        repositoryId: input.projectionInput.skillPlan.binding.repositoryId,
        snapshot,
        ...(input.statusMaterializer ? { materializer: input.statusMaterializer } : {}),
      });
      input.bindStatusPath(statusSnapshotPath);
      runtimeStatusPath = await (
        input.runtimeStatusMaterializer ??
        new NodeRuntimeStatusEnvelopeMaterializer(input.stateRoot)
      ).materialize({
        envelope: input.projectionInput.runtimeStatusEnvelope,
        authority: {
          descriptorDigest: input.projectionInput.runtimeContext.launchDescriptor.digest,
          runtimeRootDigest: input.descriptor.nativeRuntimeRootDigest,
        },
      });
      input.bindRuntimeStatusPath(runtimeStatusPath);
    }
    const customBuilder = input.builder !== undefined;
    const runtimeProfiles = await loadRuntimeProfilesV1(input.projectionInput.runtimeProfilesFile);
    const compiledContent = await compileContent({
      runtime,
      plan: input.projectionInput.skillPlan,
      runtimeProfiles,
      sharedInstructionRoot: path.join(
        input.projectionInput.agentsRoot,
        '..',
        'instructions',
        'shared',
      ),
      agentRoot: input.projectionInput.agentsRoot,
    });
    const built = await (input.builder ?? buildProductionProjection)({
      ...input.projectionInput,
      compiledContent,
      statusSnapshot: snapshot,
      launchBanner: input.launchBanner,
    });
    const expectedBinding = {
      launchKey: input.projectionInput.runtimeContext.launchKey,
      descriptorDigest: input.projectionInput.runtimeContext.launchDescriptor.digest,
      runtimeArtifactKey: input.projectionInput.skillPlan.artifactReference.artifactKey,
      runtime,
      manifestKey: input.projectionInput.skillPlan.manifestKey,
    };
    if (JSON.stringify(built.reference.launchBinding) !== JSON.stringify(expectedBinding)) {
      throw new MpxError({
        code: 'LAUNCH_RESTART_REQUIRED',
        message: 'The runtime projection does not match the selected launch binding.',
        remediation: 'Rebuild the projection and restart the runtime process.',
      });
    }
    if (customBuilder) {
      if (input.validator) {
        await input.validator({ runtime, directory: built.directory, reference: built.reference });
      } else {
        const validation = await revalidateRuntimeArtifact(built.directory, built.reference);
        if (!validation.valid) {
          throw new MpxError({
            code: 'LAUNCH_RESTART_REQUIRED',
            message: 'The immutable runtime projection changed before invocation.',
            remediation: 'Rebuild the projection and restart the runtime process.',
          });
        }
      }
    }
    return { built, statusSnapshotPath, runtimeStatusPath };
  };
  if (input.descriptor.runtime === 'claude') {
    return [
      {
        runtime: 'claude',
        modelTriggerableTools: CLAUDE_MODEL_TOOLS,
        prepare: async ({ routes }) => {
          if (!input.trustedExecutable) {
            throw new ExecutionError(
              'TRUSTED_EXECUTABLE_NOT_FOUND',
              'No trusted absolute runtime executable or Node entry was found.',
            );
          }
          const projectionResult = await projection('claude'),
            built = projectionResult.built,
            pluginDirectory = built.pluginDirectory ?? built.directory;
          const gateway = await materializeClaudeGateway({
            stateRoot: input.stateRoot,
            capability: input.projectionInput.runtimeCapabilityManifest,
            launchBinding: input.projectionInput.runtimeLaunchBinding,
            routes,
          });
          if (
            input.resumeTarget &&
            (!('kind' in input.resumeTarget) || input.resumeTarget.kind !== 'native-id')
          ) {
            throw new ExecutionError(
              'SESSION_RESUME_TARGET_INVALID',
              'Claude resume requires a validated native session reference.',
            );
          }
          const plan = createClaudeInvocationPlan({
            executable: input.trustedExecutable.executable,
            pluginDirectory,
            accountRoot: input.nativeRuntimeRoot,
            runtimeContext: input.projectionInput.runtimeContext,
            projectionReference: built.reference,
            environment: input.environment,
            gatewayMcpConfigPath: gateway.configPath,
            ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
            ...(input.resumeTarget ? { resumeTarget: input.resumeTarget } : {}),
            runtimeStatusEnvelopePath: projectionResult.runtimeStatusPath!,
          });
          return {
            executable: plan.executable,
            argv: [
              ...input.trustedExecutable.argvPrefix,
              ...plan.args,
              ...(input.descriptor.runtimeArgs ?? []),
            ],
            environment: plan.env,
          };
        },
      },
    ];
  }
  return [
    {
      runtime: 'pi',
      modelTriggerableTools: PI_MODEL_TOOLS,
      prepare: async () => {
        if (!input.trustedExecutable) {
          throw new ExecutionError(
            'TRUSTED_EXECUTABLE_NOT_FOUND',
            'No trusted absolute runtime executable or Node entry was found.',
          );
        }
        const projectionResult = await projection('pi'),
          built = projectionResult.built;
        if (!built.runtimeContextFile) {
          throw new MpxError({
            code: 'RUNTIME_PROJECTION_INVALID',
            message: 'The Pi projection is incomplete.',
          });
        }
        if (
          input.resumeTarget &&
          (typeof input.resumeTarget !== 'object' ||
            !('file' in input.resumeTarget) ||
            typeof input.resumeTarget.file !== 'string')
        ) {
          throw new ExecutionError(
            'SESSION_RESUME_TARGET_INVALID',
            'Pi resume requires a verified native session file.',
          );
        }
        const publishedProjection = built as Partial<PiPublishedProjection>;
        const plan = await planPiInvocation({
          executable: input.trustedExecutable.executable,
          ...((built.profile ?? input.projectionInput.piRuntimeProfile)
            ? { profile: built.profile ?? input.projectionInput.piRuntimeProfile }
            : {}),
          accountRoot: input.nativeRuntimeRoot,
          runtimeContextFile: built.runtimeContextFile,
          runtimeContext: input.projectionInput.runtimeContext,
          launchIdentity: {
            name: input.descriptor.identity.name,
            mode: input.descriptor.mode,
          },
          projectionReference: built.reference,
          ...(publishedProjection.files && publishedProjection.revalidation
            ? { projection: built as PiPublishedProjection }
            : {}),
          cwd: input.cwd,
          immutableProjectionDirectory: built.directory,
          ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
          ...(input.resumeTarget
            ? { resumeTarget: input.resumeTarget as VerifiedPiResumeTarget }
            : {}),
        });
        return {
          executable: plan.executable,
          argv: [
            ...input.trustedExecutable.argvPrefix,
            ...plan.args,
            ...(input.descriptor.runtimeArgs ?? []),
          ],
          environment: plan.env,
        };
      },
    },
  ];
}
