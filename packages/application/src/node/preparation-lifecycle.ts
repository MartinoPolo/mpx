import path from 'node:path';
import { sha256Canonical, MpxError, type JsonValue } from '@mpx/core';
import type { WorktreePreparationResult } from '../lifecycle-application-service.js';
import type { PreparationPlan } from '@mpx/config';
import { WindowsProcessCapabilities } from '@mpx/windows';
import {
  NodePreparationEvidenceAdapter,
  NodePreparationExecutionAdapter,
  NodePreparationProcessAdapter,
  NodePreparationStore,
  PreparationEngine,
  awaitBackgroundPreparationActivation,
  createNodeLifecycleFoundation,
  createPreparationApproval,
  nodePreparationPaths,
  preparationApprovalPhrases,
  resolvePreparationPackageManager,
  assertLifecycleStateIdentity,
  deriveLifecycleKey,
  sameLifecyclePath,
  type ConfiguredPackageManager,
  type PreparationAdapters,
  type PreparationStatus,
} from '@mpx/worktrees';

export function windowsProcessIdentityInspector(
  windows: Pick<WindowsProcessCapabilities, 'inspect'>,
) {
  return {
    inspect: async (pid: number) => {
      try {
        const identity = await windows.inspect(pid);
        return identity
          ? { status: 'present' as const, pid, startFingerprint: identity.startFingerprint }
          : { status: 'absent' as const, pid };
      } catch {
        return { status: 'unknown' as const, pid };
      }
    },
  };
}

export interface PreparationRuntimeResult extends WorktreePreparationResult {
  status: PreparationStatus | 'approval-required' | 'approved';
}

export interface CliPreparationRuntime {
  run(request: {
    key: string;
    plan: PreparationPlan;
    worktreeRoot: string;
    packageManager: ConfiguredPackageManager;
    exactApproval?: string;
    validateOnly?: boolean;
  }): Promise<PreparationRuntimeResult>;
  retry(request: {
    key: string;
    plan: PreparationPlan;
    worktreeRoot: string;
    packageManager: ConfiguredPackageManager;
    exactApproval?: string;
  }): Promise<PreparationRuntimeResult>;
  cancel(key: string): Promise<PreparationRuntimeResult>;
  reconcile(key: string): Promise<PreparationRuntimeResult>;
}

export interface PreparationRuntime extends CliPreparationRuntime {
  adapters: PreparationAdapters;
  engine: PreparationEngine;
}

export function preparationRuntime(
  root: string,
  environment: NodeJS.ProcessEnv,
  workerEntry: string,
): PreparationRuntime {
  const preparationRoot = path.join(root, 'worktrees', 'preparation');
  const windowsProcesses = new WindowsProcessCapabilities();
  const processAdapter = new NodePreparationProcessAdapter(windowsProcesses, preparationRoot);
  const adapters: PreparationAdapters = {
    evidence: new NodePreparationEvidenceAdapter(),
    store: new NodePreparationStore(preparationRoot, {
      processIdentityInspector: windowsProcessIdentityInspector(windowsProcesses),
    }),
    process: processAdapter,
    execution: new NodePreparationExecutionAdapter({
      process: processAdapter,
      stateRoot: preparationRoot,
      workerEntry,
      environment: environment as Readonly<Record<string, string>>,
    }),
    clock: {
      now: Date.now,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
    paths: nodePreparationPaths,
  };
  const engine = new PreparationEngine(adapters);
  const approvedRequest = async (request: {
    key: string;
    plan: PreparationPlan;
    worktreeRoot: string;
    packageManager: ConfiguredPackageManager;
    exactApproval?: string;
    validateOnly?: boolean;
  }) => {
    const logDirectory = path.join(
      preparationRoot,
      'logs',
      sha256Canonical(request.key as unknown as JsonValue),
    );
    const packageManager = await resolvePreparationPackageManager(
      request.worktreeRoot,
      request.plan,
      request.packageManager,
    );
    const approval = await createPreparationApproval(
      { ...request, packageManager, environment },
      adapters,
    );
    const expectedApprovals = preparationApprovalPhrases(approval);
    const expectedApproval = JSON.stringify(expectedApprovals);
    if (request.exactApproval === undefined) {
      return {
        response: {
          schemaVersion: 1,
          owner: 'mpx',
          status: 'approval-required' as const,
          expectedApproval,
          expectedApprovals,
          approval,
        },
      };
    }
    let supplied: unknown;
    try {
      supplied = JSON.parse(request.exactApproval);
    } catch {
      supplied = undefined;
    }
    if (JSON.stringify(supplied) !== expectedApproval) {
      throw new MpxError({
        code: 'PREPARATION_APPROVAL_STALE',
        message:
          'Separate exact package-automation and explicit-executable approvals are required for the current evidence.',
        details: { expectedApprovals },
      });
    }
    return {
      engineRequest: {
        ...request,
        ...expectedApprovals,
        packageManager,
        approval,
        environment,
        logDirectory,
      },
      expectedApproval,
      approval,
    };
  };
  return {
    adapters,
    engine,
    cancel: (key) => engine.cancel(key),
    reconcile: (key) => engine.reconcile(key),
    run: async (request) => {
      if (request.plan.execution === 'none') {
        return { status: 'ready' as const };
      }
      const approved = await approvedRequest(request);
      if (approved.response) {
        return approved.response;
      }
      if (request.validateOnly) {
        return {
          status: 'approved' as const,
          expectedApproval: approved.expectedApproval,
          approval: approved.approval,
        };
      }
      return engine.prepare(approved.engineRequest);
    },
    retry: async (request) => {
      const approved = await approvedRequest(request);
      return approved.response ?? engine.retry(approved.engineRequest);
    },
  };
}

export function verifyPreparationWorkerHandshake(
  state:
    | {
        worker?: { pid: number; startFingerprint: string; ownerToken?: string };
        owner?: string;
        runId?: string;
        status?: string;
      }
    | undefined,
  inspection: { startFingerprint: string; owner: 'mpx' | 'other'; ownerToken?: string } | undefined,
  pid: number,
  runId: string,
): boolean {
  return (
    state?.owner === 'mpx' &&
    state.runId === runId &&
    state.status === 'preparing' &&
    state.worker?.pid === pid &&
    typeof state.worker.startFingerprint === 'string' &&
    state.worker.startFingerprint.length > 0 &&
    state.worker.ownerToken !== undefined &&
    inspection?.owner === 'mpx' &&
    inspection.startFingerprint === state.worker.startFingerprint &&
    inspection.ownerToken === state.worker.ownerToken
  );
}

export async function requireRepositoryBoundLifecycleState(
  key: string,
  cwd: string,
  foundation: ReturnType<typeof createNodeLifecycleFoundation>,
) {
  const state = await foundation.state.load(key);
  if (!state) {
    throw new MpxError({
      code: 'WORKTREE_LIFECYCLE_STATE_MISSING',
      message: 'The lifecycle key does not exist.',
    });
  }
  assertLifecycleStateIdentity(state);
  if (key !== deriveLifecycleKey(state.repositoryIdentity, state.branch)) {
    throw new MpxError({
      code: 'WORKTREE_LIFECYCLE_STATE_INVALID',
      message: 'The lifecycle key identity is invalid.',
    });
  }
  const repository = await foundation.repository.resolve(cwd);
  if (
    !sameLifecyclePath(repository.commonGitDirectory, state.repositoryIdentity) ||
    !sameLifecyclePath(repository.mainRoot, state.mainRoot)
  ) {
    throw new MpxError({
      code: 'WORKTREE_REPOSITORY_MISMATCH',
      message: 'The lifecycle key belongs to another repository.',
    });
  }
  if (repository.config.project.id !== state.repositoryId) {
    throw new MpxError({
      code: 'WORKTREE_REPOSITORY_MISMATCH',
      message: 'The lifecycle key belongs to another repository.',
    });
  }
  const inventoryEntry = (await foundation.git.list(repository.mainRoot)).find((entry) =>
    sameLifecyclePath(entry.path, state.worktreePath),
  );
  if (!inventoryEntry || inventoryEntry.branch !== state.branch) {
    throw new MpxError({
      code: 'WORKTREE_REPOSITORY_MISMATCH',
      message: 'The lifecycle key is not bound to this repository worktree and branch.',
    });
  }
  return { state, repository };
}

export async function executeInternalPreparationWorker(
  requestFile: string,
  workerToken: string | undefined,
): Promise<void> {
  const preparationRoot = path.dirname(path.dirname(path.resolve(requestFile)));
  const request = await awaitBackgroundPreparationActivation(
    requestFile,
    preparationRoot,
    workerToken,
  );
  delete process.env.MPX_PREPARATION_WORKER_TOKEN;
  const runtime = preparationRuntime(
    path.dirname(path.dirname(preparationRoot)),
    process.env,
    path.resolve(process.argv[1] ?? process.execPath),
  );
  const store = runtime.adapters.store;
  const processAdapter = runtime.adapters.process;
  let persistedWorker: { pid: number; startFingerprint: string; ownerToken?: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await store.load(request.key);
    const inspection = await processAdapter.inspect(process.pid);
    if (verifyPreparationWorkerHandshake(state, inspection, process.pid, request.runId)) {
      persistedWorker = state!.worker;
      break;
    }
    if (attempt === 199) {
      throw new MpxError({
        code: 'PREPARATION_WORKER_HANDSHAKE_FAILED',
        message: 'The worker was not durably registered by its parent.',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const foreground = { ...request.plan, execution: 'foreground' as const };
  await runtime.engine.resume({
    key: request.key,
    runId: request.runId,
    plan: foreground,
    approval: request.approval,
    ...(request.packageAutomationApproval === undefined
      ? {}
      : { packageAutomationApproval: request.packageAutomationApproval }),
    ...(request.explicitExecutableApproval === undefined
      ? {}
      : { explicitExecutableApproval: request.explicitExecutableApproval }),
    worktreeRoot: request.worktreeRoot,
    packageManager: request.packageManager,
    environment: process.env,
    logDirectory: request.logDirectory,
    ...(persistedWorker === undefined ? {} : { worker: persistedWorker }),
  });
}
