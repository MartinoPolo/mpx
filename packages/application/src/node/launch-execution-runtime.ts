import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { discoverProjectConfig, loadRuntimeProfilesV1 } from '@mpx/config';
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
import {
  createClaudeInvocationPlan,
  publishClaudeProjection,
  type ClaudeInvocationProjection,
} from '@mpx/runtime-claude';
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
import {
  productionTrustedExecutablePolicy,
  resolveTrustedExecutable,
  revalidateTrustedExecutable,
} from '@mpx/worktrees';

export interface PiFooterProviders {
  readonly repository: string;
  readonly issues: string;
  readonly repositoryUrl?: string;
  readonly issuesUrl?: string;
  readonly projectConfigPath?: string;
}

type GitRemoteReader = (cwd: string, remote: string) => Promise<string>;

const execFileAsync = promisify(execFile);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

async function productionGitRemoteReader(cwd: string, remote: string): Promise<string> {
  const policy = productionTrustedExecutablePolicy([cwd]);
  const executable = await resolveTrustedExecutable('git', cwd, policy);
  await revalidateTrustedExecutable(executable, policy);
  const result = await execFileAsync(
    executable.path,
    [...(executable.trustedPrefixArguments ?? []), 'remote', 'get-url', '--', remote],
    { cwd, shell: false, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
  );
  return result.stdout.trim();
}

function encodedRepositoryUrl(remote: string): string | undefined {
  if (!remote || CONTROL_CHARACTERS.test(remote)) {
    return undefined;
  }
  let host: string;
  let rawPath: string;
  try {
    if (/^[^/@:]+@[^/:]+:.+$/u.test(remote)) {
      const match = /^[^/@:]+@([^/:]+):(.+)$/u.exec(remote);
      if (!match) {
        return undefined;
      }
      host = match[1]!;
      rawPath = match[2]!;
    } else {
      const parsed = new URL(remote);
      if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) {
        return undefined;
      }
      host = parsed.protocol === 'https:' ? parsed.host : parsed.hostname;
      rawPath = parsed.pathname;
    }
    const segments = rawPath
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/u, '')
      .split('/')
      .map((segment) => decodeURIComponent(segment));
    if (
      segments.length < 2 ||
      segments.some((segment) => !segment || CONTROL_CHARACTERS.test(segment))
    ) {
      return undefined;
    }
    const url = new URL(`https://${host}`);
    url.pathname = segments.map(encodeURIComponent).join('/');
    return url.toString().replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

export async function readPiFooterProviders(
  cwd: string,
  readGitRemote: GitRemoteReader = productionGitRemoteReader,
): Promise<PiFooterProviders> {
  try {
    const project = await discoverProjectConfig(cwd);
    if (!project) {
      return { repository: '', issues: '' };
    }
    const repository = project.config.repository?.provider ?? '';
    const issues = project.config.issues?.provider ?? 'none';
    const result: PiFooterProviders = {
      repository,
      issues,
      projectConfigPath: project.path,
    };
    let repositoryUrl: string | undefined;
    if ((repository === 'github' || repository === 'gitlab') && project.config.repository) {
      const configured = project.config.repository.remote;
      if (!CONTROL_CHARACTERS.test(configured)) {
        const remote = encodedRepositoryUrl(configured)
          ? configured
          : await readGitRemote(project.root, configured).catch(() => '');
        repositoryUrl = encodedRepositoryUrl(remote);
      }
    }
    const issuesUrl =
      issues === 'kanbanflow' && project.config.issues?.boardId
        ? `https://kanbanflow.com/board/${encodeURIComponent(project.config.issues.boardId)}`
        : repositoryUrl && issues === repository && (issues === 'github' || issues === 'gitlab')
          ? `${repositoryUrl}${issues === 'github' ? '/issues' : '/-/issues'}`
          : undefined;
    return {
      ...result,
      ...(repositoryUrl
        ? {
            repositoryUrl: `${repositoryUrl}${repository === 'github' ? '/pulls' : '/-/merge_requests'}`,
          }
        : {}),
      ...(issuesUrl ? { issuesUrl } : {}),
    };
  } catch {
    // Unavailable display metadata must not block a launch or invent provider routes.
    return { repository: '', issues: '' };
  }
}

export interface LaunchProjection {
  readonly directory: string;
  readonly reference: PublishedRuntimeArtifactReference;
  readonly pluginDirectory?: string;
  readonly artifactKey?: string;
  readonly files?: readonly string[];
  readonly runtimeContextFile?: string;
  readonly profile?: PiRuntimeProfileV1;
}
export interface LaunchProjectionBuildInput {
  readonly descriptor: LaunchDescriptor;
  readonly skillPlan: SkillProjectionPlan;
  readonly compiledContent: CompiledContentTree;
  readonly agentsRoot: string;
  readonly cwd?: string;
  readonly globalInstructions?: string;
  readonly claudeInstructions?: string;
  readonly piAppendInstructions?: string;
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
  const instructionsRoot = path.join(input.agentsRoot, '..', 'instructions');
  const globalInstructions =
    input.globalInstructions ?? path.resolve(instructionsRoot, 'global', 'AGENTS.md');
  if (input.descriptor.runtime === 'pi') {
    if (!input.cwd) {
      throw new Error('Pi projection cwd is required');
    }
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
      globalInstructions,
      piAppendInstructions:
        input.piAppendInstructions ??
        path.resolve(instructionsRoot, 'runtime', 'pi', 'APPEND_SYSTEM.md'),
      cwd: input.cwd,
      ...(input.artifactRevalidator ? { artifactRevalidator: input.artifactRevalidator } : {}),
    });
  }
  return publishClaudeProjection({
    skillPlan: input.skillPlan,
    compiledContent,
    outputStyle: resolveClaudeCanonicalOutputStyle(input.agentsRoot),
    globalInstructions,
    claudeInstructions:
      input.claudeInstructions ?? path.resolve(instructionsRoot, 'runtime', 'claude', 'CLAUDE.md'),
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
    | 'statusSnapshot'
    | 'launchBanner'
    | 'compiledContent'
    | 'cwd'
    | 'globalInstructions'
    | 'claudeInstructions'
    | 'piAppendInstructions'
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
    const instructionsRoot = path.resolve(input.projectionInput.agentsRoot, '..', 'instructions');
    const built = await (input.builder ?? buildProductionProjection)({
      ...input.projectionInput,
      cwd: input.cwd,
      globalInstructions: path.join(instructionsRoot, 'global', 'AGENTS.md'),
      ...(runtime === 'claude'
        ? {
            claudeInstructions: path.join(instructionsRoot, 'runtime', 'claude', 'CLAUDE.md'),
          }
        : {
            piAppendInstructions: path.join(instructionsRoot, 'runtime', 'pi', 'APPEND_SYSTEM.md'),
          }),
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
            pluginDirectory = built.pluginDirectory ?? built.directory,
            hasProjectSkills = input.projectionInput.skillPlan.entries.some(
              (entry) => entry.source.kind === 'project',
            );
          if (
            hasProjectSkills &&
            (!built.artifactKey ||
              !built.files?.includes('project-skills/.claude-plugin/plugin.json'))
          ) {
            throw new MpxError({
              code: 'RUNTIME_PROJECTION_INVALID',
              message:
                'The Claude projection is missing its published project skill plugin. Rebuild the projection and restart.',
            });
          }
          const publishedProjection: ClaudeInvocationProjection | undefined =
            built.artifactKey && built.files
              ? {
                  directory: built.directory,
                  pluginDirectory,
                  artifactKey: built.artifactKey,
                  files: built.files,
                  reference: built.reference,
                }
              : undefined;
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
            ...(publishedProjection ? { projection: publishedProjection } : {}),
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
            skillPolicy: input.descriptor.skillPolicy,
          },
          projectProviders: await readPiFooterProviders(input.cwd),
          ...(typeof input.environment.APPDATA === 'string' &&
          path.isAbsolute(input.environment.APPDATA)
            ? { accountConfigPath: path.join(input.environment.APPDATA, 'mpx', 'config.json') }
            : {}),
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
