import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { UserConfig } from '@mpx/config';
import { sha256Canonical, type JsonValue } from '@mpx/core';
import type { F2SandboxSessionResumeAdmission } from '@mpx/executors';
import { canonicalNativeRootDigest } from '@mpx/launch';
import {
  BranchLeaseStore,
  BranchLineageStore,
  ConversationBranchService,
  RootAttestationService,
  RootAttestationStore,
  SessionError,
  SessionService,
  createClaudeBranchAdapter,
  createPiBranchAdapter,
  type BranchArgvExecutionAdapter,
  type BranchRequestV1,
  type BranchRuntimeAdapter,
  type ConversationBranchPlanV1,
  type ResumePlanV1,
  type SessionProcessInspector,
  type SessionStore,
} from '@mpx/sessions';
import type { StatusProvider } from '@mpx/status';
import { WindowsProcessCapabilities } from '@mpx/windows';
import type { AccountAuthVerifier } from '../account-application-service.js';
import type { LifecycleWorktreeService } from '../lifecycle-application-service.js';
import { resolveTrustedRuntimeExecutable } from './launch-execution-adapters.js';
import type { LaunchExecutionContext } from './launch-execution-runtime.js';
import {
  createProductionSessionBranchRuntimeAdapter,
  createWindowsTerminalBranchAdapter,
  diagnoseSessionBranchAdapters,
} from './session-branch-adapters.js';
import { createProductionSessionDockerResumeAdmission } from './session-docker-resume.js';
import {
  ProductionSessionLifecycleBridge,
  type SessionLifecycleBridge,
} from './session-lifecycle-bridge.js';
import { createPiAuthAvailabilityProbe } from './pi-auth-availability.js';
import { windowsProcessIdentityInspector } from './preparation-lifecycle.js';
import {
  executeNodeSessionResumeLaunch,
  type NodeSessionResumeLaunchContext,
} from './session-resume-launch.js';

export interface NodeSessionBranchProductionInput {
  readonly enabled: boolean;
  readonly cwd: string;
  readonly user: UserConfig;
  readonly store: SessionStore;
  readonly environment: NodeJS.ProcessEnv;
  stateRoot(): string;
  worktrees(): LifecycleWorktreeService;
  readonly launchContext: NodeSessionResumeLaunchContext;
  catalogRoot(cwd: string): Promise<string>;
  status(): StatusProvider;
  executionRoots(): Promise<{ readonly artifactsRoot: string; readonly stateRoot: string }>;
  readonly branchService?: ConversationBranchService;
  readonly runtimeAdapter?: BranchArgvExecutionAdapter;
  readonly terminalAdapter?: BranchArgvExecutionAdapter;
  readonly dockerAdmission?: (plan: ResumePlanV1) => Promise<F2SandboxSessionResumeAdmission>;
  readonly processInspector?: SessionProcessInspector;
  readonly rootAttestationService?: RootAttestationService;
  readonly accountAuthVerifier?: AccountAuthVerifier;
  readonly nativeAccountBindingResolver?: {
    resolve(
      identity: { domain: string; name: string },
      runtime: 'claude' | 'pi',
      root: string,
    ): Promise<string | null>;
  };
  readonly launchExecutableResolver?: LaunchExecutionContext['launchExecutableResolver'];
  readonly terminalExecutable?: string;
  readonly terminalTrustedRoots?: readonly string[];
  readonly executeFile?: typeof execFile;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test/composition seam around the already-owned resume launch boundary. */
  readonly executeResumeLaunch?: typeof executeNodeSessionResumeLaunch;
  /** Test/composition seam for observing lifecycle callback wiring without durable event fabrication. */
  readonly lifecycleBridgeFactory?: (input: {
    readonly onSessionsChanged: () => Promise<void>;
  }) => SessionLifecycleBridge;
}

export interface NodeSessionBranchProduction {
  readonly branchService?: ConversationBranchService;
  readonly terminalExecutable?: string;
}

function admissionPlan(input: BranchRequestV1 | ConversationBranchPlanV1): ResumePlanV1 {
  const confirmationDigest =
    'confirmationDigest' in input
      ? input.confirmationDigest
      : sha256Canonical(input as unknown as JsonValue);
  return {
    schemaVersion: 1,
    newLaunchRequired: true,
    previousLaunch: {
      launchKey: input.launchIdentity.launchKey,
      descriptorDigest: input.launchIdentity.descriptorDigest,
    },
    recordId: input.child.runtimeQualifiedId,
    runtimeQualifiedId: input.child.runtimeQualifiedId,
    runtime: input.child.runtime,
    identity: input.launchIdentity.identity,
    nativeBindingRef: input.launchIdentity.nativeBindingRef,
    nativeSessionRef: input.parent.nativeSessionRef,
    cwd: input.workspace.cwd,
    projectId: input.workspace.projectRef,
    repositoryId: input.workspace.repositoryRef,
    launch: {
      launchKey: input.launchIdentity.launchKey,
      descriptorDigest: input.launchIdentity.descriptorDigest,
      mode: input.launchIdentity.mode,
      skillPolicy: input.launchIdentity.skillPolicy,
      contentScope: input.launchIdentity.contentScope,
      executor: { kind: input.launchIdentity.executor },
      workspace: input.launchIdentity.workspace,
      networkPolicy: input.launchIdentity.networkPolicy,
      grants: input.launchIdentity.grants,
      artifactKey: input.launchIdentity.artifactKey,
      manifestKey: input.launchIdentity.manifestKey,
    },
    confirmationDigest,
  };
}

/** Node-only branch composition. The input is structural and has no CLI dependency. */
export async function createNodeSessionBranchProduction(
  input: NodeSessionBranchProductionInput,
): Promise<NodeSessionBranchProduction> {
  const trustedRoots =
    input.terminalTrustedRoots ??
    [
      input.environment.WINDIR,
      input.environment.LOCALAPPDATA
        ? path.join(input.environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
        : undefined,
    ].filter((value): value is string => Boolean(value && path.isAbsolute(value)));
  const candidate =
    input.terminalExecutable ??
    input.environment.MPX_WINDOWS_TERMINAL_EXECUTABLE ??
    (input.environment.LOCALAPPDATA
      ? path.join(input.environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')
      : undefined);
  const availability = await diagnoseSessionBranchAdapters({
    runtimeAvailable: true,
    ...(candidate ? { terminalCandidate: candidate } : {}),
    trustedRoots,
  });
  const terminalExecutable = availability.terminal.available
    ? availability.terminal.executable
    : undefined;
  if (!input.enabled || input.branchService) {
    return {
      ...(input.branchService ? { branchService: input.branchService } : {}),
      ...(terminalExecutable ? { terminalExecutable } : {}),
    };
  }

  const runtimeAdapter = (runtime: 'claude' | 'pi'): BranchRuntimeAdapter => ({
    plan: async (parent, cwd, selectedRoot) => {
      const trusted = await resolveTrustedRuntimeExecutable({
        runtime,
        cwd,
        environment: input.environment,
        ...(input.launchExecutableResolver ? { resolver: input.launchExecutableResolver } : {}),
      });
      if (trusted.argvPrefix.length !== 0) {
        throw new SessionError(
          'SESSION_BRANCH_EXECUTABLE_WRAPPER_UNSUPPORTED',
          'Native branch adapters require a direct trusted runtime executable.',
        );
      }
      return (
        runtime === 'claude'
          ? createClaudeBranchAdapter(trusted.executable)
          : createPiBranchAdapter(trusted.executable)
      ).plan(parent, cwd, selectedRoot);
    },
  });

  const worktrees = input.worktrees();
  const productionRuntime = createProductionSessionBranchRuntimeAdapter({
    executeNormalLaunch: async ({ invocation, plan }) => {
      let resolveLifecycle!: (event: {
        runtimeQualifiedId: string;
        nativeSessionRef: typeof plan.parent.nativeSessionRef;
      }) => void;
      let rejectLifecycle!: (error: unknown) => void;
      const lifecycle = new Promise<{
        runtimeQualifiedId: string;
        nativeSessionRef: typeof plan.parent.nativeSessionRef;
      }>((resolve, reject) => {
        resolveLifecycle = resolve;
        rejectLifecycle = reject;
      });
      const onSessionsChanged = async () => {
        const records = await new SessionService(input.store).list({
          runtime: plan.child.runtime,
        });
        const child = records.find(
          (record) =>
            record.runtimeQualifiedId !== plan.parent.runtimeQualifiedId &&
            record.location.cwd === invocation.cwd &&
            record.nativeBindingRef === plan.launchIdentity.nativeBindingRef,
        );
        if (child) {
          resolveLifecycle({
            runtimeQualifiedId: child.runtimeQualifiedId,
            nativeSessionRef: child.nativeSessionRef,
          });
        }
      };
      const bridge = input.lifecycleBridgeFactory
        ? input.lifecycleBridgeFactory({ onSessionsChanged })
        : new ProductionSessionLifecycleBridge({
            store: input.store,
            ...(input.nativeAccountBindingResolver
              ? {
                  accountBindingRef: (name: string, runtime: 'claude' | 'pi') =>
                    input.nativeAccountBindingResolver!.resolve(
                      { domain: input.user.identities[name]!.domain, name },
                      runtime,
                      input.user.identities[name]!.runtimeRoots[runtime],
                    ),
                }
              : {}),
            onSessionsChanged,
          });
      const exited = (input.executeResumeLaunch ?? executeNodeSessionResumeLaunch)(
        {
          store: input.store,
          environment: input.environment,
          context: { ...input.launchContext, launchLifecycleBridge: bridge },
          catalogRoot: input.catalogRoot,
          status: input.status,
          stateRoot: input.stateRoot,
          executionRoots: input.executionRoots,
          branchInvocation: invocation,
        },
        admissionPlan(plan),
        input.user,
      ).catch((error) => {
        rejectLifecycle(error);
        throw error;
      });
      return { lifecycle, exited };
    },
  });

  const productionTerminal =
    !input.terminalAdapter && terminalExecutable
      ? await createWindowsTerminalBranchAdapter({
          candidate: terminalExecutable,
          trustedRoots,
          run: async (request) => {
            const before = new Set(
              (await new SessionService(input.store).list()).map(
                (record) => record.runtimeQualifiedId,
              ),
            );
            let settleExit!: (value: unknown) => void;
            let rejectExit!: (error: unknown) => void;
            const exited = new Promise<unknown>((resolve, reject) => {
              settleExit = resolve;
              rejectExit = reject;
            });
            (input.executeFile ?? execFile)(
              request.executable,
              [...request.argv],
              {
                cwd: request.cwd,
                env: input.environment,
                shell: false,
                windowsHide: true,
              },
              (error, stdout, stderr) =>
                error ? rejectExit(error) : settleExit({ exitCode: 0, stdout, stderr }),
            );
            const lifecycle = (async () => {
              const now = input.now ?? Date.now;
              const sleep =
                input.sleep ??
                ((milliseconds: number) =>
                  new Promise((resolve) => setTimeout(resolve, milliseconds)));
              const deadline = now() + 120_000;
              while (now() < deadline) {
                const child = (await new SessionService(input.store).list()).find(
                  (record) =>
                    !before.has(record.runtimeQualifiedId) && record.location.cwd === request.cwd,
                );
                if (child) {
                  return {
                    runtimeQualifiedId: child.runtimeQualifiedId,
                    nativeSessionRef: child.nativeSessionRef,
                  };
                }
                await sleep(100);
              }
              throw new SessionError(
                'SESSION_BRANCH_LIFECYCLE_TIMEOUT',
                'The terminal child did not publish a lifecycle event.',
              );
            })();
            return { lifecycle, exited };
          },
        })
      : null;

  const processInspector =
    input.processInspector ?? windowsProcessIdentityInspector(new WindowsProcessCapabilities());
  const controller = await processInspector.inspect(process.pid);
  const stateRoot = input.stateRoot();
  const leases = new BranchLeaseStore(path.join(stateRoot, 'session-branch-leases'), {
    processId: process.pid,
    controllerStartFingerprint:
      controller.status === 'present' ? controller.startFingerprint : `unverified-${process.pid}`,
    processInspector,
    observeSession: async (lease) => {
      const records = await new SessionService(input.store).list();
      const candidates = records.filter(
        (record) =>
          record.runtimeQualifiedId === lease.session.runtimeQualifiedId ||
          (record.location.cwd === lease.workspace.cwd &&
            record.nativeBindingRef === lease.session.nativeBindingRef &&
            (!lease.launch.launchKey || record.launch?.launchKey === lease.launch.launchKey)),
      );
      if (candidates.length === 0) {
        return 'absent';
      }
      if (candidates.every((record) => record.liveness === 'inactive')) {
        return 'inactive';
      }
      for (const record of candidates.filter((value) => value.liveness === 'active')) {
        if (!record.process) {
          return 'unknown';
        }
        const observed = await processInspector.inspect(record.process.pid);
        if (observed.status === 'unknown') {
          return 'unknown';
        }
        if (
          observed.status === 'present' &&
          observed.startFingerprint === record.process.startFingerprint
        ) {
          return 'active';
        }
      }
      return 'inactive';
    },
  });
  await leases.reconcile();
  const dockerAdmission =
    input.dockerAdmission ?? createProductionSessionDockerResumeAdmission(input.environment);
  const service = new ConversationBranchService(
    {
      inspectWorkspace: async (workspace) => {
        try {
          const info = await lstat(workspace.cwd);
          return {
            exists: info.isDirectory() && !info.isSymbolicLink(),
            collisionDisclosure:
              workspace.repositoryRef === null
                ? []
                : ['repository refs and external fixed services remain shared'],
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { exists: false, collisionDisclosure: [] };
          }
          throw error;
        }
      },
      createIsolatedWorktree: async (workspace) => {
        if (!workspace.branch) {
          throw new SessionError(
            'SESSION_BRANCH_WORKTREE_BRANCH_REQUIRED',
            'An isolated branch requires a worktree branch ref.',
          );
        }
        const created = (await worktrees.create({
          cwd: workspace.cwd,
          branch: workspace.branch,
          execution: 'none',
        })) as { worktreePath?: unknown };
        if (typeof created.worktreePath !== 'string' || !path.isAbsolute(created.worktreePath)) {
          throw new SessionError(
            'SESSION_BRANCH_WORKTREE_CREATE_FAILED',
            'The worktree service did not return a canonical worktree path.',
          );
        }
        return { cwd: created.worktreePath, worktreeRef: workspace.branch };
      },
      removeIsolatedWorktree: async (workspace) => {
        await worktrees.remove({ cwd: input.cwd, worktreePath: workspace.cwd });
      },
      validateNativeBinding: async (plan) => {
        const configured = input.user.identities[plan.launchIdentity.identity.name];
        if (!configured || configured.domain !== plan.launchIdentity.identity.domain) {
          throw new SessionError(
            'SESSION_BRANCH_IDENTITY_MISMATCH',
            'The branch identity is no longer configured.',
          );
        }
        const binding = await input.store.readNativeBinding(plan.launchIdentity.nativeBindingRef);
        const root = configured.runtimeRoots[plan.child.runtime];
        if (
          binding.ref !== plan.launchIdentity.nativeBindingRef ||
          binding.runtime !== plan.child.runtime ||
          binding.identity.domain !== plan.launchIdentity.identity.domain ||
          binding.identity.name !== plan.launchIdentity.identity.name ||
          binding.recordedRootDigest !== plan.launchIdentity.rootDigest ||
          canonicalNativeRootDigest(root) !== binding.recordedRootDigest
        ) {
          throw new SessionError(
            'SESSION_BRANCH_NATIVE_BINDING_MISMATCH',
            'The recorded session binding no longer matches the configured identity root.',
          );
        }
        if (plan.child.runtime === 'pi') {
          const attestation =
            input.rootAttestationService ??
            new RootAttestationService(new RootAttestationStore(stateRoot));
          await attestation.verify(
            plan.launchIdentity.identity,
            root,
            binding.accountBindingRef ?? undefined,
          );
          const auth =
            input.accountAuthVerifier ??
            createPiAuthAvailabilityProbe({
              cwd: input.cwd,
              environment: input.environment,
              resolveTrustedExecutable: () =>
                resolveTrustedRuntimeExecutable({
                  runtime: 'pi',
                  cwd: input.cwd,
                  environment: input.environment,
                  ...(input.launchExecutableResolver
                    ? { resolver: input.launchExecutableResolver }
                    : {}),
                }),
            });
          await auth.verify(root);
        }
        return root;
      },
      adapters: { claude: runtimeAdapter('claude'), pi: runtimeAdapter('pi') },
      runtime: input.runtimeAdapter ?? productionRuntime,
      ...((input.terminalAdapter ?? productionTerminal)
        ? { terminal: (input.terminalAdapter ?? productionTerminal)! }
        : {}),
      lineage: new BranchLineageStore(
        path.join(stateRoot, 'sessions', 'v1', 'private', 'branch-lineage'),
      ),
      admitExecutor: async (branch) =>
        branch.launchIdentity.executor === 'host' ||
        (await dockerAdmission(admissionPlan(branch))).admitted,
    },
    leases,
  );
  return {
    branchService: service,
    ...(terminalExecutable ? { terminalExecutable } : {}),
  };
}
