import {
  executeResolvedLaunch as executeApplicationLaunch,
  type LaunchExecutionRequest,
  type LaunchRuntimeComposer,
} from '../launch-execution-service.js';
import {
  NodeRuntimeStatusEnvelopeMaterializer,
  nodeDockerGate,
  nodeHostExecutor,
  resolveLaunchStatusSnapshotPath,
  resolveTrustedRuntimeExecutable,
  type TrustedRuntimeExecutable,
} from './launch-execution-adapters.js';
import {
  ExecutionError,
  compactLaunchBanner,
  type DirectTty,
  type ExecutorAdapter,
  type ProcessResult,
} from '@mpx/executors';
import { createPiRuntimeProfileV1, PI_CAPABILITY_IDS, verifyPiResumeTarget } from '@mpx/runtime-pi';
import { defaultRuntimeModelSelectionV1 } from '@mpx/config';
import { readStatusSnapshotV1 } from '@mpx/status';
import {
  executorAdapter,
  productionRuntimeAdapters,
  type LaunchExecutionContext,
  type LaunchProjectionBuildInput,
  type RuntimeLaunchWiring,
} from './launch-execution-runtime.js';

export * from './launch-execution-runtime.js';
export { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';

export interface NodeLaunchExecutionInput extends LaunchExecutionRequest {
  readonly context: LaunchExecutionContext;
  readonly tty?: DirectTty;
  readonly approveHost?: boolean;
  readonly agentsRoot: string;
  readonly runtimeProfilesFile: string;
  readonly artifactsRoot: string;
  readonly stateRoot: string;
  readonly beforeChildExecution?: () => Promise<void>;
}

function productionComposer(
  input: NodeLaunchExecutionInput,
  preflightResult: () => TrustedRuntimeExecutable | undefined,
): LaunchRuntimeComposer {
  return async (composition) => {
    const trustedExecutable = preflightResult();
    if (!trustedExecutable) {
      throw new ExecutionError(
        'TRUSTED_EXECUTABLE_NOT_FOUND',
        'Trusted runtime executable preflight was not completed.',
      );
    }
    let snapshotPath: string | undefined;
    let runtimeStatusPath: string | undefined;
    const piProfile =
      input.descriptor.runtime === 'pi'
        ? createPiRuntimeProfileV1(defaultRuntimeModelSelectionV1('pi'), PI_CAPABILITY_IDS)
        : undefined;
    const projectionInput: Omit<
      LaunchProjectionBuildInput,
      'statusSnapshot' | 'launchBanner' | 'compiledContent'
    > = {
      descriptor: input.descriptor,
      skillPlan: composition.skillPlan,
      agentsRoot: input.agentsRoot,
      runtimeProfilesFile: input.runtimeProfilesFile,
      artifactsRoot: input.artifactsRoot,
      runtimeContext: composition.runtimeContext,
      runtimeStatusEnvelope: composition.wiring.status,
      runtimeCapabilityManifest: composition.wiring.capability,
      runtimeLaunchBinding: composition.wiring.launchBinding,
      ...(piProfile ? { piRuntimeProfile: piProfile } : {}),
      ...(input.context.launchProjectionArtifactRevalidator
        ? { artifactRevalidator: input.context.launchProjectionArtifactRevalidator }
        : {}),
    };
    const adapters = productionRuntimeAdapters({
      descriptor: input.descriptor,
      cwd: input.cwd,
      environment: input.environment,
      nativeRuntimeRoot: input.nativeRuntimeRoot,
      stateRoot: input.stateRoot,
      projectionInput,
      launchBanner: compactLaunchBanner(input.descriptor),
      initialSnapshot: composition.snapshot,
      statusSnapshot: input.statusSnapshot,
      bindStatusPath: (value) => {
        snapshotPath = value;
      },
      bindRuntimeStatusPath: (value) => {
        runtimeStatusPath = value;
      },
      ...(composition.lifecycle ? { lifecycle: composition.lifecycle } : {}),
      ...(composition.resumeTarget ? { resumeTarget: composition.resumeTarget } : {}),
      ...(input.context.launchStatusSnapshotMaterializer
        ? { statusMaterializer: input.context.launchStatusSnapshotMaterializer }
        : {}),
      trustedExecutable,
      ...(input.context.launchProjectionBuilder
        ? { builder: input.context.launchProjectionBuilder }
        : {}),
      ...(input.context.launchProjectionValidator
        ? { validator: input.context.launchProjectionValidator }
        : {}),
    });
    return {
      adapters,
      statusPaths: () => ({
        ...(snapshotPath ? { snapshot: snapshotPath } : {}),
        ...(runtimeStatusPath ? { runtime: runtimeStatusPath } : {}),
      }),
    };
  };
}

/** CLI composition supplies only concrete runtime projection and platform ports. */
export const executeResolvedNodeLaunch = async (
  input: NodeLaunchExecutionInput,
): Promise<ProcessResult> => {
  if (
    input.descriptor.runtime === 'pi' &&
    input.descriptor.executor.name === 'docker' &&
    input.context.launchRuntimeAdapters === undefined &&
    (input.context.launchExecutorAdapters === undefined ||
      input.context.launchExecutorAdapterSource === 'production-admission')
  ) {
    throw new ExecutionError(
      'PI_DOCKER_UNAVAILABLE',
      'Pi Docker execution is unavailable pending whole-agent sandbox isolation.',
      { executor: 'docker', runtime: 'pi' },
    );
  }
  const injectedRuntimeAdapters = input.context.launchRuntimeAdapters;
  let trustedExecutable: TrustedRuntimeExecutable | undefined;
  const composer: LaunchRuntimeComposer = injectedRuntimeAdapters
    ? () => ({ adapters: injectedRuntimeAdapters })
    : productionComposer(input, () => trustedExecutable);
  const runtimePreflight = injectedRuntimeAdapters
    ? undefined
    : async () => {
        trustedExecutable = await resolveTrustedRuntimeExecutable({
          runtime: input.descriptor.runtime,
          cwd: input.cwd,
          environment: input.environment,
          ...(input.context.launchExecutableResolver
            ? { resolver: input.context.launchExecutableResolver }
            : {}),
        });
      };
  const selected = executorAdapter(input.context, input.descriptor.executor.name);
  const adapters: ExecutorAdapter[] = [selected];
  const host = input.context.launchExecutorAdapters?.find((candidate) => candidate.name === 'host');
  if (host && host !== selected) {
    adapters.push(host);
  }
  if (!host && selected.name !== 'host' && !input.context.launchRuntimeAdapters) {
    adapters.push(nodeHostExecutor);
  }
  if (selected.name !== 'docker' && !adapters.some((candidate) => candidate.name === 'docker')) {
    adapters.push(nodeDockerGate);
  }
  const runtimeMaterializer = new NodeRuntimeStatusEnvelopeMaterializer(input.stateRoot);
  return executeApplicationLaunch(
    {
      descriptor: input.descriptor,
      manifest: input.manifest,
      artifact: input.artifact,
      cwd: input.cwd,
      environment: input.environment,
      nativeRuntimeRoot: input.nativeRuntimeRoot,
      catalog: input.catalog,
      canonicalRoot: input.canonicalRoot,
      statusSnapshot: input.statusSnapshot,
      ...(input.projectConfig ? { projectConfig: input.projectConfig } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
    },
    {
      composer,
      executorAdapters: adapters,
      runtimeAdapterMode: injectedRuntimeAdapters ? 'injected' : 'production',
      ...(runtimePreflight ? { runtimePreflight } : {}),
      ...(input.context.launchRoutes ? { routes: input.context.launchRoutes } : {}),
      ...(input.context.launchAudit ? { audit: input.context.launchAudit } : {}),
      ...(input.tty ? { tty: input.tty } : {}),
      ...(input.approveHost ? { approveHost: true } : {}),
      ...(input.context.launchExpectedKey
        ? { expectedLaunchKey: input.context.launchExpectedKey }
        : {}),
      ...(input.context.launchLifecycleBridge
        ? { lifecycle: input.context.launchLifecycleBridge }
        : {}),
      ...(input.context.launchSessionObservation
        ? { sessionObservation: input.context.launchSessionObservation }
        : {}),
      ...(input.context.launchRuntimeWiringFactory
        ? {
            wiringFactory: (value) =>
              input.context.launchRuntimeWiringFactory!({
                ...value,
              }) as RuntimeLaunchWiring,
          }
        : {}),
      ...(input.descriptor.runtime === 'pi' ? { verifyResumeTarget: verifyPiResumeTarget } : {}),
      ...(input.beforeChildExecution ? { beforeChildExecution: input.beforeChildExecution } : {}),
      ...(input.context.launchExecutorAdapters &&
      input.context.launchExecutorAdapterSource !== 'production-admission'
        ? { useSelectedExecutorForHostPi: true }
        : {}),
      ...(!input.context.launchRuntimeAdapters
        ? {
            liveStatus: {
              materializeSnapshot: ({ descriptor, repositoryId, snapshot, signal }) =>
                resolveLaunchStatusSnapshotPath({
                  stateRoot: input.stateRoot,
                  descriptor,
                  repositoryId,
                  snapshot,
                  ...(signal ? { signal } : {}),
                  ...(input.context.launchStatusSnapshotMaterializer
                    ? { materializer: input.context.launchStatusSnapshotMaterializer }
                    : {}),
                }),
              readSnapshot: input.context.launchStatusSnapshotReader ?? readStatusSnapshotV1,
              materializeRuntimeStatus: (value, signal) =>
                runtimeMaterializer.materialize(value, signal),
              ...(input.context.launchStatusRefreshClock
                ? { schedule: input.context.launchStatusRefreshClock.schedule }
                : {}),
              ...(input.context.launchStatusShutdownClock
                ? { waitForShutdown: input.context.launchStatusShutdownClock.wait }
                : {}),
              ...(input.context.launchStatusShutdownDeadlineMs !== undefined
                ? { shutdownDeadlineMs: input.context.launchStatusShutdownDeadlineMs }
                : {}),
            },
          }
        : {}),
    },
  );
};

export type { LaunchExecutionContext };
