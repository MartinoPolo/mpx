import path from 'node:path';
import { discoverProjectConfig, type UserConfig } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import { sanitizeHostReason, type DirectTty } from '@mpx/executors';
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
import { ProductionSessionLifecycleBridge } from './session-lifecycle-bridge.js';

export interface NodeLaunchApplicationContext extends LaunchExecutionContext {
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
  const { context, environment } = input;
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
