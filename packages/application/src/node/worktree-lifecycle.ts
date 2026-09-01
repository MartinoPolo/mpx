import { access } from 'node:fs/promises';
import path from 'node:path';
import { preparationPlan } from '@mpx/config';
import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import {
  FileMruStore,
  WorktreeLifecycleService,
  createNodeLifecycleFoundation,
  executeWorktreeIncludePlan,
  listWorktrees,
  planWorktreeIncludes,
  resolveRepository,
  selectWorktree,
  type ConfiguredPackageManager,
  type CreateWorktreeRequest,
  type FileSystemAdapter,
  type GitAdapter,
  type LifecyclePortAdapter,
  type ProcessIdentityInspector,
  type RemoveWorktreeRequest,
  type WorktreeIncludeDependencies,
} from '@mpx/worktrees';
import type { LinkedReleaseRequest, LinkedReleaseResult } from '@mpx/ports';
import type {
  LifecycleWorktreeService,
  WorktreePreparationResult,
} from '../lifecycle-application-service.js';
import {
  requireRepositoryBoundLifecycleState,
  type CliPreparationRuntime,
  type PreparationRuntime,
  type PreparationRuntimeResult,
} from './preparation-lifecycle.js';
import { projectPreparationStatus, type PublicPreparationStatus } from './preparation-status.js';

export interface NodeWorktreePortService extends LifecyclePortAdapter {
  resolveOrphan(request: LinkedReleaseRequest): Promise<LinkedReleaseResult>;
}

function isLinkedReleaseIdentity(value: unknown): value is LinkedReleaseRequest['identity'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'leaseId' in value &&
    typeof value.leaseId === 'string' &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'repositoryId' in value &&
    typeof value.repositoryId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'worktreePath' in value &&
    typeof value.worktreePath === 'string' &&
    'role' in value &&
    value.role === 'linked' &&
    'configHash' in value &&
    typeof value.configHash === 'string'
  );
}

function applyPreparationStatus(
  state: Awaited<ReturnType<typeof requireRepositoryBoundLifecycleState>>['state'],
  status: PublicPreparationStatus,
): void {
  const projection = projectPreparationStatus(status);
  state.preparationStatus = projection.preparationStatus;
  state.status = projection.lifecycleStatus;
  if (projection.failure === undefined) {
    delete state.failure;
  } else {
    state.failure = projection.failure;
  }
}

function isPreparationRuntime(runtime: CliPreparationRuntime): runtime is PreparationRuntime {
  return 'adapters' in runtime && 'engine' in runtime;
}

export interface NodeWorktreeLifecycleDependencies {
  readonly stateRoot: string;
  readonly operationCwd: string;
  readonly ports: NodeWorktreePortService;
  readonly preparation: CliPreparationRuntime;
  readonly includes: WorktreeIncludeDependencies;
  readonly fileSystem: FileSystemAdapter;
  readonly processIdentityInspector: ProcessIdentityInspector;
}

/** Application-owned worktree lifecycle workflow with injected Node/package adapters. */
export function createNodeWorktreeLifecycleService(
  dependencies: NodeWorktreeLifecycleDependencies,
): LifecycleWorktreeService {
  const productionPreparation = isPreparationRuntime(dependencies.preparation)
    ? dependencies.preparation
    : undefined;
  const foundation = createNodeLifecycleFoundation(
    path.join(dependencies.stateRoot, 'worktrees'),
    'git',
    {
      operationCwd: dependencies.operationCwd,
      processIdentityInspector: dependencies.processIdentityInspector,
      ...(productionPreparation === undefined
        ? {}
        : {
            isPreparationWorkerActive: async (state) => {
              const preparationState = await productionPreparation.adapters.store.load(state.key);
              if (
                !preparationState ||
                !['preparing', 'cancelling'].includes(preparationState.status) ||
                !preparationState.worker
              ) {
                return false;
              }
              try {
                const inspected = await productionPreparation.adapters.process.inspect(
                  preparationState.worker.pid,
                );
                return (
                  inspected?.owner === 'mpx' &&
                  inspected.startFingerprint === preparationState.worker.startFingerprint &&
                  inspected.ownerToken === preparationState.worker.ownerToken
                );
              } catch {
                return true;
              }
            },
          }),
    },
  );
  const lifecycle = new WorktreeLifecycleService({
    ...foundation,
    ports: dependencies.ports,
    includes: {
      inspect: async (request) => {
        try {
          await access(path.join(request.mainRoot, '.worktreeinclude'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
              status: 'absent' as const,
              manifestSha256: sha256Canonical({ absent: true } as JsonValue),
            };
          }
          throw error;
        }
        const plan = await planWorktreeIncludes(request, dependencies.includes);
        return {
          status:
            request.exactHumanApproval === plan.approval
              ? ('approved' as const)
              : ('approval-required' as const),
          manifestSha256: plan.manifestSha256,
          expectedApproval: plan.approval,
        };
      },
      copy: async (request) => {
        try {
          await access(path.join(request.mainRoot, '.worktreeinclude'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { manifestSha256: sha256Canonical({ absent: true } as JsonValue) };
          }
          throw error;
        }
        const plan = await planWorktreeIncludes(request, dependencies.includes);
        if (
          request.expectedManifestSha256 !== undefined &&
          request.expectedManifestSha256 !== plan.manifestSha256
        ) {
          throw new MpxError({
            code: 'WORKTREE_INCLUDE_APPROVAL_STALE',
            message: 'The durable include manifest no longer matches current files.',
          });
        }
        return executeWorktreeIncludePlan(
          plan,
          request.exactHumanApproval ?? '',
          dependencies.includes,
          request.allowExistingRecovery ?? false,
        );
      },
    },
    preparation: {
      prepare: (request) => dependencies.preparation.run(request),
      cancel: (key) => dependencies.preparation.cancel(key),
      reconcile: (key) => dependencies.preparation.reconcile(key),
    },
    configHash: (config) => sha256Canonical(config as unknown as JsonValue),
  });
  const git = foundation.git as GitAdapter;
  const mru = new FileMruStore(
    path.join(dependencies.stateRoot, 'worktrees', 'mru.json'),
    dependencies.fileSystem,
  );
  return {
    create: (request: CreateWorktreeRequest) => lifecycle.create(request),
    remove: (request: RemoveWorktreeRequest) => lifecycle.remove(request),
    list: async ({ cwd }) => {
      const repository = await resolveRepository(cwd, { git, fs: dependencies.fileSystem });
      return listWorktrees(git, repository.mainRoot);
    },
    status: (request) => lifecycle.status(request),
    reconcile: async (request) => {
      const result = await lifecycle.reconcile({ cwd: request.cwd });
      const orphaned = [...(result.orphaned ?? [])];
      if (orphaned.length === 0) {
        return result;
      }
      const expectedApproval = `APPROVE WORKTREE ORPHAN RELEASE ${sha256Canonical(orphaned as unknown as JsonValue)}`;
      if (request.orphanApproval === undefined) {
        return { ...result, expectedApproval };
      }
      if (request.orphanApproval !== expectedApproval) {
        throw new MpxError({
          code: 'WORKTREE_ORPHAN_APPROVAL_STALE',
          message: 'Exact trusted approval for the current orphan set is required.',
          details: { expectedApproval },
        });
      }
      const resolutions = [];
      for (const identity of orphaned) {
        if (!isLinkedReleaseIdentity(identity)) {
          throw new MpxError({
            code: 'WORKTREE_ORPHAN_IDENTITY_INVALID',
            message: 'Port reconciliation returned an invalid linked release identity.',
          });
        }
        resolutions.push(
          await dependencies.ports.resolveOrphan({
            repositoryCwd: request.cwd,
            identity,
          }),
        );
      }
      return { ...result, status: 'resolved', orphaned: [], resolutions };
    },
    select: async ({ cwd, path: requested }) => {
      const repository = await resolveRepository(cwd, { git, fs: dependencies.fileSystem });
      return selectWorktree({
        repository: repository.commonGitDirectory,
        path: requested,
        inventory: await listWorktrees(git, repository.mainRoot),
        store: mru,
      });
    },
    prepare: async (request) => {
      const { key, cwd } = request;
      const bound = await requireRepositoryBoundLifecycleState(key, cwd, foundation);
      const release = await foundation.lock.acquire(bound.repository.commonGitDirectory);
      try {
        const { state, repository } = await requireRepositoryBoundLifecycleState(
          key,
          cwd,
          foundation,
        );
        const currentConfigHash = sha256Canonical(repository.config as unknown as JsonValue);
        if (state.configHash !== currentConfigHash) {
          throw new MpxError({
            code: 'WORKTREE_CONFIG_HASH_MISMATCH',
            message:
              'The durable creation configuration does not match the current configuration evidence.',
          });
        }
        const configuredPlan = preparationPlan(repository.config);
        const plan =
          state.preparationExecution === undefined
            ? configuredPlan
            : { ...configuredPlan, execution: state.preparationExecution };
        const packageManager = (repository.config.tooling?.packageManager ??
          'auto') as ConfiguredPackageManager;
        const result: WorktreePreparationResult = await dependencies.preparation.retry({
          key,
          plan,
          worktreeRoot: state.worktreePath,
          packageManager,
          ...(typeof request.approval === 'string' ? { exactApproval: request.approval } : {}),
        });
        if (result.status) {
          applyPreparationStatus(state, result.status);
          state.updatedAt = Date.now();
          await foundation.state.writeAtomic(key, state);
        }
        return result;
      } finally {
        await release();
      }
    },
    cancel: async (request) => {
      const { key, cwd } = request;
      const repository = await foundation.repository.resolve(cwd);
      const release = await foundation.lock.acquire(repository.commonGitDirectory);
      try {
        const bound = await requireRepositoryBoundLifecycleState(key, cwd, foundation);
        let cancellation: PreparationRuntimeResult;
        try {
          cancellation = await dependencies.preparation.cancel(key);
        } catch (error) {
          const current = await foundation.state.load(key);
          if (current) {
            current.preparationStatus = 'unknown';
            current.status = 'unknown';
            current.failure = {
              phase: 'preparation',
              code: 'PREPARATION_UNKNOWN',
              message: 'Preparation cancellation could not be verified.',
            };
            current.updatedAt = Date.now();
            await foundation.state.writeAtomic(key, current);
          }
          throw error;
        }
        applyPreparationStatus(bound.state, cancellation.status);
        bound.state.updatedAt = Date.now();
        await foundation.state.writeAtomic(key, bound.state);
        return cancellation;
      } finally {
        await release();
      }
    },
  };
}
