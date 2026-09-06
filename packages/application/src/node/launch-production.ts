import path from 'node:path';
import { discoverProjectConfig, type UserConfig } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import {
  buildF2ProofPolicyMatrix,
  namedSbxPolicies,
  sanitizeHostReason,
  type DirectTty,
} from '@mpx/executors';
import { createSbxLaunchPlanExportV1 } from '@mpx/runtime-contracts';
import type { SessionStore } from '@mpx/sessions';
import { inventoryCanonical, inventoryProjectSkills } from '@mpx/skills';
import type { StatusProvider } from '@mpx/status';
import {
  LaunchApplicationService,
  type LaunchExecutionInput as ApplicationLaunchExecutionInput,
} from '../launch-application-service.js';
import { createPiAuthAvailabilityProbe, type PiAuthVerifier } from './pi-auth-availability.js';
import { ExactNativeRootVerifier } from './exact-native-root.js';
import { executeResolvedNodeLaunch } from './launch-execution.js';
import {
  collectNodeExecutorEvidence,
  directProcessTty,
  type LaunchExecutionContext,
} from './launch-execution-runtime.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';
import {
  createProductionSbxExecutionAdapter,
  loadProductionSbxProofSources,
  planProductionSbxExecution,
  productionProofCreateArgv,
  type SbxExecutionDependencies,
} from './sbx-execution.js';
import { ProductionSessionLifecycleBridge } from './session-lifecycle-bridge.js';

export interface NodeLaunchApplicationContext extends LaunchExecutionContext {
  readonly launchSbxExecutionDependencies?: SbxExecutionDependencies;
  readonly exactNativeRootVerifier?: { verify(root: string): Promise<void> };
  readonly piAuthVerifier?: PiAuthVerifier;
}

export interface NodeLaunchInteractionPort {
  readonly json: boolean;
  readonly reason?: string;
  readonly approveHost?: boolean;
  readonly tty?: DirectTty;
}

export interface NodeLaunchApplicationInput {
  readonly cwd: string;
  readonly catalogRoot?: string;
  readonly userConfig: UserConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly context: NodeLaunchApplicationContext;
  readonly interaction: NodeLaunchInteractionPort;
  readonly discoverProjectConfig?: typeof discoverProjectConfig;
  /** Lazily initialized; candidate, selection, and unbound paths never call it. */
  status(): StatusProvider;
  /** Lazily initialized; read-only paths never call it. */
  sessions(): SessionStore;
  readonly sbxDiagnostics?: () => Promise<{
    readonly available: boolean;
    readonly failureCodes: readonly string[];
    readonly readOnly: boolean;
  }>;
}

function piAuth(input: NodeLaunchApplicationInput): PiAuthVerifier {
  return createPiAuthAvailabilityProbe({
    cwd: input.cwd,
    environment: input.environment,
    resolveTrustedExecutable: () =>
      resolveTrustedRuntimeExecutable({
        runtime: 'pi',
        cwd: input.cwd,
        environment: input.environment,
        ...(input.context.launchExecutableResolver
          ? { resolver: input.context.launchExecutableResolver }
          : {}),
      }),
  });
}

/** Node-only production policy and adapter composition for ordinary launch operations. */
export function createNodeLaunchApplicationService(
  input: NodeLaunchApplicationInput,
): LaunchApplicationService {
  const { context, environment, userConfig } = input;
  const requirePiPreflight =
    context.launchExecutorAdapters === undefined ||
    context.exactNativeRootVerifier !== undefined ||
    context.piAuthVerifier !== undefined;

  return new LaunchApplicationService({
    discoverProjectConfig: input.discoverProjectConfig ?? discoverProjectConfig,
    inventoryCanonical,
    inventoryProjectSkills,
    statusSnapshot: ({ cwd, projectRoot, config }) =>
      input.status().snapshot({
        cwd,
        projectRoot,
        config,
        configHash: sha256Canonical(config as unknown as JsonValue),
      }),
    ...(input.sbxDiagnostics
      ? {
          dockerDiagnostics: async () => {
            const diagnostics = await input.sbxDiagnostics!();
            const code = diagnostics.failureCodes[0];
            if (!diagnostics.readOnly) {
              throw new MpxError({
                code: 'SBX_DIAGNOSTICS_UNSAFE',
                message: 'Sandbox diagnostics must be read-only.',
              });
            }
            if (code) {
              throw new MpxError({
                code,
                message: `Standalone sbx launch diagnostic: ${code}.`,
                details: { executor: 'docker' },
              });
            }
          },
        }
      : {}),
    dockerAdmission: async ({ selection, statusSnapshot }) => {
      if (context.launchExecutorAdapters !== undefined || !environment.LOCALAPPDATA) {
        return;
      }
      try {
        const snapshot = await statusSnapshot();
        const configured = userConfig.identities[selection.identity.name]!;
        const network =
          namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
          namedSbxPolicies['deny-all'];
        const adapter = await createProductionSbxExecutionAdapter(
          {
            environment,
            cwd: input.cwd,
            stateRoot: path.join(environment.LOCALAPPDATA, 'mpx'),
            runtime: selection.runtime,
            identity: {
              name: selection.identity.name,
              domain: configured.domain === 'personal' ? 'personal' : 'work',
            },
            workspaceMode: selection.workspace,
            worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
            ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
            workspaceRoot: input.cwd,
            gitCommonDir: path.join(input.cwd, '.git'),
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
        const admittedContext: NodeLaunchApplicationContext = {
          ...context,
          launchExecutorAdapters: [adapter],
          launchExecutorAdapterSource: 'production-admission',
        };
        return {
          evidence: await collectNodeExecutorEvidence(admittedContext, 'docker'),
          execute: (execution) => execute(execution, admittedContext),
        };
      } catch (failure) {
        if (failure instanceof MpxError) {
          throw failure;
        }
        const message =
          failure instanceof Error ? failure.message : 'Docker admission setup failed.';
        const matched = /^([A-Z][A-Z0-9_]+)(?::|\b)/u.exec(message);
        throw new MpxError({
          code: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
          message: 'Docker admission setup failed closed.',
          details: {
            executor: 'docker',
            diagnostic: matched?.[1] ?? 'DOCKER_ADMISSION_SETUP_FAILED',
          },
        });
      }
    },
    executorEvidence: (executor) => collectNodeExecutorEvidence(context, executor),
    prepareExecutor: async (executor) => ({
      evidence: await collectNodeExecutorEvidence(context, executor),
      execute: (execution) => execute(execution, context),
    }),
    approveHost: async (selection) => {
      const tty = input.interaction.tty ?? directProcessTty();
      const reason = input.interaction.reason;
      if (!input.interaction.approveHost && (input.interaction.json || !tty.direct)) {
        throw new MpxError({
          code: 'HOST_TTY_REQUIRED',
          message: 'Host approval requires a current direct interactive TTY.',
          remediation: 'Run the explicit host launch interactively, or use Docker.',
        });
      }
      if (!reason?.trim()) {
        throw new MpxError({
          code: 'HOST_REASON_REQUIRED',
          message: 'Host execution requires a nonempty reason.',
        });
      }
      if (
        !input.interaction.approveHost &&
        !(await tty.confirm(
          `Approve elevated host compatibility execution — ${sanitizeHostReason(reason)}`,
        ))
      ) {
        throw new MpxError({
          code: 'HOST_APPROVAL_DENIED',
          message: 'Host execution was not approved.',
        });
      }
      return {
        reason,
        approvalKey: sha256Canonical({
          cwd: input.cwd,
          runtime: selection.runtime,
          identity: selection.identity.name,
          reason,
        } as unknown as JsonValue),
      };
    },
    piPreflight: async ({ runtimeRoot }) => {
      if (!requirePiPreflight) {
        return;
      }
      const rootVerifier = context.exactNativeRootVerifier ?? new ExactNativeRootVerifier();
      const auth = context.piAuthVerifier ?? piAuth(input);
      await rootVerifier.verify(runtimeRoot);
      await auth.verify(runtimeRoot);
      return {
        beforeChildExecution: async () => {
          await rootVerifier.verify(runtimeRoot);
          await auth.verify(runtimeRoot);
        },
      };
    },
    sandboxExport: async ({ descriptor, selection, artifact }) => {
      if (!environment.LOCALAPPDATA) {
        throw new MpxError({
          code: 'STATE_ROOT_REQUIRED',
          message: 'LOCALAPPDATA is required to plan a production sandbox.',
        });
      }
      const configured = userConfig.identities[selection.identity.name]!;
      const network =
        namedSbxPolicies[selection.networkPolicy.name as keyof typeof namedSbxPolicies] ??
        namedSbxPolicies['deny-all'];
      const sources = await loadProductionSbxProofSources(environment);
      const planned = planProductionSbxExecution({
        environment,
        cwd: input.cwd,
        stateRoot: path.join(environment.LOCALAPPDATA, 'mpx'),
        runtime: selection.runtime,
        identity: {
          name: selection.identity.name,
          domain: selection.identity.domain === 'personal' ? 'personal' : 'work',
        },
        workspaceMode: selection.workspace,
        worktreeRole: selection.workspace === 'host-worktree' ? 'linked' : 'main',
        ...(selection.workspace === 'direct' ? { directCompatibility: true } : {}),
        workspaceRoot: input.cwd,
        gitCommonDir: path.join(input.cwd, '.git'),
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
        ports: [],
        sources,
      });
      return createSbxLaunchPlanExportV1({
        launchKey: descriptor.launchKey,
        descriptorSha256: sha256Canonical(descriptor as unknown as JsonValue),
        runtime: selection.runtime,
        identity: {
          name: selection.identity.name,
          domain: selection.identity.domain === 'personal' ? 'personal' : 'work',
        },
        artifact: {
          manifestKey: artifact.reference.manifestKey,
          artifactKey: artifact.reference.artifactKey,
          fileMapHash: artifact.reference.fileMapHash,
        },
        evidence: {
          sbxPinSha256: sources.sbxPinSha256,
          runtimeToolInventorySha256: sources.runtimeToolInventorySha256,
          executorEvidenceSha256: sources.executorEvidenceSha256,
        },
        sandbox: {
          planKey: planned.plan.planKey,
          profile: planned.plan.networkPolicy.name,
          proofSandboxName: `mpx-proof-${planned.plan.planKey.slice(0, 12)}`,
          createArgv: productionProofCreateArgv(planned.plan),
        },
        policyMatrix: buildF2ProofPolicyMatrix(
          planned.plan.networkPolicy.name as keyof typeof namedSbxPolicies,
        ),
      });
    },
    launchExecution: (execution) => execute(execution, context),
  });

  async function execute(
    execution: ApplicationLaunchExecutionInput,
    executionContext: NodeLaunchApplicationContext,
  ): Promise<{ readonly exitCode: number }> {
    const appData = environment.APPDATA;
    if (!appData) {
      throw new MpxError({
        code: 'USER_CONFIG_ROOT_MISSING',
        message: 'APPDATA is required to publish immutable runtime projections.',
      });
    }
    const launchContext =
      executionContext.launchLifecycleBridge ||
      executionContext.launchRuntimeAdapters ||
      !environment.LOCALAPPDATA
        ? executionContext
        : {
            ...executionContext,
            launchLifecycleBridge: new ProductionSessionLifecycleBridge({
              store: input.sessions(),
            }),
          };
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
      artifactsRoot: path.join(appData, 'mpx', 'runtime-artifacts'),
      stateRoot: environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'mpx') : '',
      cwd: execution.cwd,
      environment,
      context: launchContext,
      tty: input.interaction.tty ?? directProcessTty(),
      ...(input.interaction.approveHost ? { approveHost: true } : {}),
      nativeRuntimeRoot: execution.nativeRuntimeRoot,
      statusSnapshot: execution.statusSnapshot,
      ...(execution.project
        ? { projectConfig: execution.project.config, projectRoot: execution.project.root }
        : {}),
      ...(execution.beforeChildExecution
        ? { beforeChildExecution: execution.beforeChildExecution }
        : {}),
    });
  }
}
