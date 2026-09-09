import path from 'node:path';
import { discoverProjectConfig, type UserConfig } from '@mpx/config';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import { resolveLaunch } from '@mpx/launch';
import {
  SessionError,
  SessionService,
  stableDigest,
  verifyNativeResumeSeed,
  type ResumeDependencies,
  type ResumePlan,
  type SessionRecord,
  type SessionStore,
} from '@mpx/sessions';
import { inventoryCanonical, inventoryProjectSkills } from '@mpx/skills';
import { parseStatusSnapshot, type StatusProvider, type StatusSnapshot } from '@mpx/status';
import {
  SessionResumeLaunchApplicationService,
  type ResumeExecutionRoots,
} from '../session-resume-launch-application-service.js';
import { resolveLaunchSkills } from '../launch-skill-resolution.js';
import { createPiAuthAvailabilityProbe, type PiAuthVerifier } from './pi-auth-availability.js';
import { ExactNativeRootVerifier } from './exact-native-root.js';
import { executorAdapter, type LaunchExecutionContext } from './launch-execution-runtime.js';
import { directProcessTty } from './launch-execution-runtime.js';
import { executeResolvedNodeLaunch } from './launch-execution.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';
import { ProductionSessionLifecycleBridge } from './session-lifecycle-bridge.js';
import { productionSessionResumeDependencies } from './session-production-adapters.js';

export interface NodeSessionResumeLaunchContext extends LaunchExecutionContext {
  readonly exactNativeRootVerifier?: { verify(root: string): Promise<void> };
  readonly piAuthVerifier?: PiAuthVerifier;
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
  readonly resumeDependencies?: (record: SessionRecord) => Promise<ResumeDependencies>;
  readonly readUserConfig: () => Promise<UserConfig>;
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

function emptyStatus(cwd: string, repositoryId: string): StatusSnapshot {
  return parseStatusSnapshot({
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
    confirmationDigest: stableDigest,
    readUserConfig: input.readUserConfig,
    verifySeed: async (seed) => {
      const record = await new SessionService(store).show(seed.recordId);
      const user = await input.readUserConfig();
      const dependencies =
        input.resumeDependencies ??
        productionSessionResumeDependencies({
          user,
          store,
          environment,
          cwd: seed.cwd,
          ...(context.exactNativeRootVerifier
            ? { exactNativeRootVerifier: context.exactNativeRootVerifier }
            : {}),
          ...(context.piAuthVerifier ? { piAuthVerifier: context.piAuthVerifier } : {}),
        });
      return verifyNativeResumeSeed(store, record, await dependencies(record));
    },
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
    rebuildSkills: async ({
      plan,
      userConfig: _userConfig,
      project,
      repositoryId,
      canonicalRoot,
      selection,
    }) =>
      resolveLaunchSkills(
        {
          ...(project ? { project } : {}),
          repositoryId,
          canonicalRoot,
          identity: plan.identity.name,
          selection: selection.selection,
          runtime: plan.runtime,
        },
        { inventoryCanonical, inventoryProjectSkills },
      ),
    prepareExecutor: async ({
      plan,
      userConfig: _userConfig,
      project,
      repositoryId,
      selection: _selection,
    }) => {
      const resumeContext = context;
      const adapter = executorAdapter(resumeContext, plan.launch.executor.kind);
      return {
        assertReady: () => adapter.assertReady(),
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
            ? async (): Promise<StatusSnapshot> =>
                input.status().snapshot({
                  cwd: plan.cwd,
                  projectRoot: project.root,
                  config: project.config,
                  configHash: sha256Canonical(project.config as unknown as JsonValue),
                })
            : async (): Promise<StatusSnapshot> => emptyStatus(plan.cwd, repositoryId);
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
    resolveDescriptor: async ({
      plan,
      userConfig,
      projectId,
      repositoryId,
      skills,
      project,
      selectedConfigDigest,
    }) =>
      resolveLaunch({
        userConfig,
        cwd: plan.cwd,
        runtime: plan.runtime,
        identity: plan.identity.name,
        mode: plan.launch.mode,
        executor: plan.launch.executor.kind,
        workspace: plan.launch.workspace as 'clone' | 'host-worktree' | 'direct',
        networkPolicy: plan.launch.networkPolicy,
        ...(plan.launch.executor.kind === 'host'
          ? {
              reason: 'confirmed session resume',
              hostApproval: {
                reason: 'confirmed session resume',
                // Bind the current proposal to its native target, not prior launch/process audit history.
                // Human confirmation and one-shot execution authority are checked separately.
                approvalKey: sha256Canonical({
                  schemaVersion: 1,
                  purpose: 'session-resume-proposal',
                  runtimeQualifiedId: plan.runtimeQualifiedId,
                  runtime: plan.runtime,
                  identity: plan.identity,
                  nativeBindingRef: plan.nativeBindingRef,
                  nativeSessionRef: plan.nativeSessionRef,
                  cwd: plan.cwd,
                  projectId: plan.projectId,
                  repositoryId: plan.repositoryId,
                  mode: plan.launch.mode,
                  selection: plan.launch.selection,
                  executor: plan.launch.executor,
                  workspace: plan.launch.workspace,
                  networkPolicy: plan.launch.networkPolicy,
                  runtimeArtifactKey: skills.artifact.reference.artifactKey,
                  manifestKey: skills.manifest.manifestKey,
                  selectedConfigDigest,
                } as unknown as JsonValue),
              },
            }
          : {}),
        skillArtifact: skills.skillArtifact,
        selectedNativeRuntimeRoot:
          userConfig.identities[plan.identity.name]!.runtimeRoots[plan.runtime],
        ...(project ? { projectConfig: project.config } : {}),
        ...(projectId ? { projectId } : {}),
        repositoryId,
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
  plan: ResumePlan,
  userConfig: UserConfig,
  authority: { readonly approveHost?: boolean } = {},
): Promise<unknown> {
  const application = createNodeSessionResumeLaunchApplicationService(input, authority);
  return application.execute(await application.prepare(plan, userConfig));
}
