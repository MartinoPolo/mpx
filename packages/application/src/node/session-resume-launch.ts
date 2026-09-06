import path from 'node:path';
import { discoverProjectConfig, type UserConfig } from '@mpx/config';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { namedSbxPolicies, type F2SandboxSessionResumeAdmission } from '@mpx/executors';
import { resolveLaunch } from '@mpx/launch';
import { SessionError, type ResumePlanV1, type SessionStore } from '@mpx/sessions';
import { inventoryCanonical, inventoryProjectSkills } from '@mpx/skills';
import { parseStatusSnapshotV1, type StatusProvider, type StatusSnapshotV1 } from '@mpx/status';
import {
  SessionResumeLaunchApplicationService,
  type ResumeExecutionRoots,
} from '../session-resume-launch-application-service.js';
import { resolveLaunchSkills } from '../launch-skill-resolution.js';
import { createPiAuthAvailabilityProbe, type PiAuthVerifier } from './pi-auth-availability.js';
import { ExactNativeRootVerifier } from './exact-native-root.js';
import {
  collectNodeExecutorEvidence,
  type LaunchExecutionContext,
} from './launch-execution-runtime.js';
import { directProcessTty } from './launch-execution-runtime.js';
import { executeResolvedNodeLaunch } from './launch-execution.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';
import {
  createProductionSbxExecutionAdapter,
  type SbxExecutionDependencies,
} from './sbx-execution.js';
import { createProductionSessionDockerResumeAdmission } from './session-docker-resume.js';
import { ProductionSessionLifecycleBridge } from './session-lifecycle-bridge.js';

export interface NodeSessionResumeLaunchContext extends LaunchExecutionContext {
  readonly launchSbxExecutionDependencies?: SbxExecutionDependencies;
  readonly exactNativeRootVerifier?: { verify(root: string): Promise<void> };
  readonly piAuthVerifier?: PiAuthVerifier;
  readonly sessionDockerResumeAdmission?: (
    plan: ResumePlanV1,
  ) => Promise<F2SandboxSessionResumeAdmission>;
}

export interface NodeSessionResumeLaunchInput {
  readonly store: SessionStore;
  readonly environment: NodeJS.ProcessEnv;
  readonly context: NodeSessionResumeLaunchContext;
  catalogRoot(cwd: string): Promise<string>;
  /** Lazily composed because Docker admission must precede status infrastructure. */
  status(): StatusProvider;
  executionRoots(): Promise<ResumeExecutionRoots>;
  readonly discoverProjectConfig?: typeof discoverProjectConfig;
}

function piAuth(input: NodeSessionResumeLaunchInput, cwd: string): PiAuthVerifier {
  return createPiAuthAvailabilityProbe({
    cwd,
    environment: input.environment,
    resolveTrustedExecutable: () =>
      resolveTrustedRuntimeExecutable({
        runtime: 'pi',
        cwd,
        environment: input.environment,
        ...(input.context.launchExecutableResolver
          ? { resolver: input.context.launchExecutableResolver }
          : {}),
      }),
  });
}

function emptyStatus(cwd: string, repositoryId: string): StatusSnapshotV1 {
  return parseStatusSnapshotV1({
    schemaVersion: 1,
    project: { id: repositoryId, cwd },
    worktree: { id: null, path: null, role: null, branch: null },
    portResolution: 'missing',
    services: [],
    diagnostics: [],
  });
}

/** Node-only production composition for the provider-neutral resume launch workflow. */
export function createNodeSessionResumeLaunchApplicationService(
  input: NodeSessionResumeLaunchInput,
  authority: { readonly approveHost?: boolean } = {},
): SessionResumeLaunchApplicationService {
  const { store, context, environment } = input;
  return new SessionResumeLaunchApplicationService({
    dockerAdmission: (plan) =>
      (
        context.sessionDockerResumeAdmission ??
        createProductionSessionDockerResumeAdmission(environment)
      )(plan),
    piPreflight: async (plan, userConfig) => {
      let nativeBinding: Awaited<ReturnType<SessionStore['readNativeBinding']>>;
      try {
        nativeBinding = await store.readNativeBinding(plan.nativeBindingRef);
      } catch {
        throw new SessionError(
          'SESSION_RESUME_BINDING_UNAVAILABLE',
          'The recorded Pi native binding is unavailable.',
        );
      }
      const configured = userConfig.identities[plan.identity.name];
      if (
        !configured ||
        configured.domain !== plan.identity.domain ||
        nativeBinding.runtime !== 'pi' ||
        nativeBinding.identity.domain !== plan.identity.domain ||
        nativeBinding.identity.name !== plan.identity.name
      ) {
        throw new SessionError(
          'SESSION_RESUME_BINDING_MISMATCH',
          'The recorded Pi native binding does not match the configured identity.',
        );
      }
      const root = configured.runtimeRoots.pi;
      const rootVerifier = context.exactNativeRootVerifier ?? new ExactNativeRootVerifier();
      const auth = context.piAuthVerifier ?? piAuth(input, plan.cwd);
      return {
        nativeBinding,
        reverify: async () => {
          try {
            await rootVerifier.verify(root);
            await auth.verify(root);
          } catch {
            throw new SessionError(
              'SESSION_RESUME_NATIVE_PREFLIGHT_UNAVAILABLE',
              'The configured Pi native root or live OAuth is unavailable.',
            );
          }
        },
      };
    },
    isAbsolutePath: path.isAbsolute,
    discoverProjectConfig: input.discoverProjectConfig ?? discoverProjectConfig,
    canonicalRoot: input.catalogRoot,
    rebuildSkills: async ({ plan, userConfig, project, repositoryId, canonicalRoot }) =>
      resolveLaunchSkills(
        {
          userConfig,
          ...(project ? { project } : {}),
          repositoryId,
          canonicalRoot,
          identity: plan.identity.name,
          skillPolicy: plan.launch.skillPolicy,
          contentScope: plan.launch.contentScope,
          runtime: plan.runtime,
        },
        { inventoryCanonical, inventoryProjectSkills },
      ),
    prepareExecutor: async ({
      plan,
      userConfig,
      project,
      repositoryId,
      selection,
      dockerAdmission,
    }) => {
      let resumeContext = context;
      if (
        plan.launch.executor.kind === 'docker' &&
        context.launchExecutorAdapters === undefined &&
        environment.LOCALAPPDATA
      ) {
        try {
          const snapshot = project
            ? await input.status().snapshot({
                cwd: plan.cwd,
                projectRoot: project.root,
                config: project.config,
                configHash: sha256Canonical(project.config as unknown as JsonValue),
              })
            : emptyStatus(plan.cwd, repositoryId);
          const configured = userConfig.identities[plan.identity.name]!;
          const network =
            namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
            namedSbxPolicies['deny-all'];
          const adapter = await createProductionSbxExecutionAdapter(
            {
              environment,
              cwd: plan.cwd,
              stateRoot: path.join(environment.LOCALAPPDATA, 'mpx'),
              runtime: plan.runtime,
              identity: {
                name: plan.identity.name,
                domain: plan.identity.domain === 'personal' ? 'personal' : 'work',
              },
              workspaceMode: selection.workspace,
              worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
              ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
              workspaceRoot: plan.cwd,
              gitCommonDir: path.join(plan.cwd, '.git'),
              nativeRoots: Object.values(userConfig.identities).flatMap((identity) =>
                Object.values(identity.runtimeRoots),
              ),
              credentialRoots: [],
              oppositeDomainRoots: Object.values(userConfig.identities)
                .filter((identity) => identity.domain !== configured.domain)
                .flatMap((identity) => Object.values(identity.runtimeRoots)),
              network: {
                name:
                  selection.networkPolicy.name in namedSbxPolicies
                    ? selection.networkPolicy.name
                    : 'deny-all',
                allow: network.allow,
              },
              ports: snapshot.services.flatMap((service) =>
                service.port === null ? [] : [service.port],
              ),
            },
            context.launchSbxExecutionDependencies,
          );
          if (dockerAdmission?.admitted) {
            adapter.setResumeAction(dockerAdmission.action);
          }
          resumeContext = {
            ...context,
            launchExecutorAdapters: [adapter],
            launchExecutorAdapterSource: 'production-admission',
          };
        } catch {
          /* Exact production proof remains unavailable and the typed Docker gate denies resume. */
        }
      }
      const evidence = await collectNodeExecutorEvidence(resumeContext, plan.launch.executor.kind);
      return {
        evidence,
        execute: async (execution) => {
          const nativeBinding = execution.nativeBinding as Awaited<
            ReturnType<SessionStore['readNativeBinding']>
          >;
          const launchContext =
            resumeContext.launchLifecycleBridge || resumeContext.launchRuntimeAdapters
              ? resumeContext
              : {
                  ...resumeContext,
                  launchLifecycleBridge: new ProductionSessionLifecycleBridge({ store }),
                };
          const statusSnapshot = project
            ? async (): Promise<StatusSnapshotV1> =>
                input.status().snapshot({
                  cwd: plan.cwd,
                  projectRoot: project.root,
                  config: project.config,
                  configHash: sha256Canonical(project.config as unknown as JsonValue),
                })
            : async (): Promise<StatusSnapshotV1> => emptyStatus(plan.cwd, repositoryId);
          return executeResolvedNodeLaunch({
            descriptor: execution.descriptor,
            manifest: execution.manifest,
            artifact: execution.artifact,
            catalog: execution.catalog,
            canonicalRoot: execution.canonicalRoot,
            agentsRoot: path.join(path.dirname(execution.canonicalRoot), 'agents'),
            runtimeProfilesFile: path.join(
              path.dirname(execution.canonicalRoot),
              'runtime-profiles.json',
            ),
            artifactsRoot: execution.roots.artifactsRoot,
            stateRoot: execution.roots.stateRoot,
            cwd: execution.cwd,
            environment,
            context: launchContext,
            tty: context.launchTty ?? directProcessTty(),
            ...(authority.approveHost ? { approveHost: true } : {}),
            nativeRuntimeRoot: execution.nativeRuntimeRoot,
            statusSnapshot,
            ...(execution.beforeChildExecution
              ? { beforeChildExecution: execution.beforeChildExecution }
              : {}),
            resume: { nativeBinding, nativeSessionRef: plan.nativeSessionRef },
          });
        },
      };
    },
    resolveDescriptor: async ({ plan, userConfig, projectId, repositoryId, skills, evidence }) =>
      resolveLaunch({
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
        grants: plan.launch.grants.map((grant) => `${grant.access}:${grant.resource}`),
        ...(plan.launch.executor.kind === 'host'
          ? {
              reason: 'confirmed session resume',
              hostApproval: {
                reason: 'confirmed session resume',
                approvalKey: sha256Canonical({
                  confirmationDigest: plan.confirmationDigest,
                } as unknown as JsonValue),
              },
            }
          : {}),
        skillArtifact: skills.skillArtifact,
        selectedNativeRuntimeRoot:
          userConfig.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
        ...(projectId ? { projectId } : {}),
        repositoryId,
        dockerAvailability:
          evidence.status === 'verified'
            ? 'available'
            : evidence.status === 'unavailable'
              ? 'unavailable'
              : 'unverified',
        executorVerification: evidence,
        policyInputs: {
          schemaVersion: 1,
          manifestKey: skills.manifest.manifestKey,
          skillArtifactKey: skills.skillArtifact.artifactKey,
        },
      }),
    descriptorDigest: (descriptor) => sha256Canonical(descriptor as unknown as JsonValue),
    requireExecutionRoots: input.executionRoots,
    readNativeBinding: (ref) => store.readNativeBinding(ref),
  });
}

export async function executeNodeSessionResumeLaunch(
  input: NodeSessionResumeLaunchInput,
  plan: ResumePlanV1,
  userConfig: UserConfig,
  authority: { readonly approveHost?: boolean } = {},
): Promise<unknown> {
  const application = createNodeSessionResumeLaunchApplicationService(input, authority);
  return application.execute(await application.prepare(plan, userConfig));
}
