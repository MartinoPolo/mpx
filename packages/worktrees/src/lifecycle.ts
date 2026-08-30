import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PreparationPlan, ProjectConfig } from '@mpx/config';
import type { ConfiguredPackageManager, PreparationApproval } from './preparation-engine.js';
import { preparationPlan } from '@mpx/config';
import { MpxError } from '@mpx/core';
import {
  deriveWorktreePath,
  discoverRemoteHead,
  resolveBaseBranch,
  withRepositoryLock,
  type RepositoryContext,
  type RepositoryLock,
  type WorktreeInventoryEntry,
} from './index.js';

export type LifecycleStatus =
  | 'creating'
  | 'created'
  | 'including'
  | 'included'
  | 'allocating'
  | 'leased'
  | 'preparation-pending'
  | 'preparing'
  | 'approval-required'
  | 'ready'
  | 'failed'
  | 'unknown'
  | 'removing'
  | 'git-removed-awaiting-lease-release'
  | 'removed'
  | 'orphaned';
export type LifecyclePhase = 'git' | 'includes' | 'ports' | 'preparation' | 'remove' | 'release';
export interface LifecycleFailure {
  phase: LifecyclePhase;
  code: string;
  message: string;
}
export interface LifecycleReleaseIdentity {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly role: 'linked';
  readonly configHash: string;
  readonly gitAdminPath?: string;
  readonly commonGitPath?: string;
}
export interface LifecycleState {
  schemaVersion: 1;
  owner: 'mpx';
  key: string;
  repositoryId: string;
  repositoryIdentity: string;
  mainRoot: string;
  worktreePath: string;
  branch: string;
  base: string;
  status: LifecycleStatus;
  createdAt: number;
  updatedAt: number;
  configHash: string;
  leaseId?: string;
  releaseIdentity?: LifecycleReleaseIdentity;
  preparationStatus?: string;
  expectedApproval?: string;
  approval?: PreparationApproval;
  failure?: LifecycleFailure;
  externalDeletion?: boolean;
  sourceRoot?: string;
  preparationExecution?: PreparationPlan['execution'];
  includeEvidence?: {
    manifestSha256: string;
    expectedApproval?: string;
    copyStarted?: boolean;
    completed?: boolean;
  };
  preparationEvidence?: {
    planDigest: string;
    expectedApproval?: string;
    approval?: PreparationApproval;
  };
}
export interface LifecycleResult {
  schemaVersion: 1;
  owner: 'mpx';
  operation: 'create' | 'remove' | 'status' | 'reconcile';
  status: string;
  repositoryId: string;
  worktreePath?: string;
  leaseId?: string;
  released?: boolean;
  expectedApproval?: string;
  approval?: PreparationApproval;
  state?: LifecycleState;
  inventory?: readonly WorktreeInventoryEntry[];
  orphaned?: readonly unknown[];
}
export interface LifecycleStateStore {
  load(key: string): Promise<LifecycleState | undefined>;
  writeAtomic(key: string, state: LifecycleState): Promise<void>;
  list?(repositoryIdentity: string): Promise<readonly LifecycleState[]>;
}
export interface LifecycleGitAdapter {
  run(args: readonly string[], cwd: string): Promise<Buffer>;
  list(cwd: string): Promise<WorktreeInventoryEntry[]>;
  isDirty(worktreePath: string): Promise<boolean>;
  isInUse(worktreePath: string, state?: LifecycleState): Promise<boolean>;
}
export interface LifecyclePortAdapter {
  ensure(request: {
    cwd: string;
    projectRoot: string;
    config: ProjectConfig;
    configHash: string;
  }): Promise<{ lease?: { leaseId?: string } }>;
  captureReleaseIdentity(request: {
    cwd: string;
    projectRoot: string;
    config: ProjectConfig;
    configHash: string;
  }): Promise<LifecycleReleaseIdentity>;
  releaseLinkedAfterRemoval(request: {
    repositoryCwd: string;
    identity: LifecycleReleaseIdentity;
  }): Promise<{ released?: boolean }>;
  reconcile(request: {
    cwd: string;
    orphanPolicy: 'report';
  }): Promise<{ orphaned?: readonly unknown[] }>;
}
export interface LifecyclePreparationAdapter {
  prepare(request: {
    key: string;
    plan: PreparationPlan;
    worktreeRoot: string;
    packageManager: ConfiguredPackageManager;
    config: ProjectConfig;
    exactApproval?: string;
    validateOnly?: boolean;
  }): Promise<{ status: string; expectedApproval?: string; approval?: PreparationApproval }>;
  cancel(key: string): Promise<{ status: string }>;
  reconcile(key: string): Promise<{ status: string }>;
}
export interface LifecycleIncludeRequest {
  repositoryId: string;
  sourceRoot: string;
  mainRoot: string;
  destinationRoot: string;
  exactHumanApproval?: string;
  expectedManifestSha256?: string;
  allowExistingRecovery?: boolean;
}
export interface LifecycleIncludeInspection {
  status: 'absent' | 'approval-required' | 'approved';
  manifestSha256: string;
  expectedApproval?: string;
}
export interface LifecycleIncludeAdapter {
  inspect?(request: LifecycleIncludeRequest): Promise<LifecycleIncludeInspection>;
  copy(request: LifecycleIncludeRequest): Promise<{ manifestSha256?: string } | void>;
}
export interface LifecycleDependencies {
  repository: { resolve(cwd: string): Promise<RepositoryContext> };
  git: LifecycleGitAdapter;
  lock: RepositoryLock;
  state: LifecycleStateStore;
  ports: LifecyclePortAdapter;
  preparation: LifecyclePreparationAdapter;
  includes?: LifecycleIncludeAdapter;
  configHash(config: ProjectConfig): string;
  now?: () => number;
}
export interface CreateWorktreeRequest {
  cwd: string;
  branch: string;
  base?: string;
  sourceRoot?: string;
  includeApproval?: string;
  approval?: string;
  execution?: PreparationPlan['execution'];
}
export interface RemoveWorktreeRequest {
  cwd: string;
  worktreePath: string;
}

function lifecycleError(code: string, message: string): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function errorFact(phase: LifecyclePhase, error: unknown): LifecycleFailure {
  return {
    phase,
    code: error instanceof MpxError ? error.code : 'WORKTREE_DEPENDENCY_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}
export function sameLifecyclePath(left: string, right: string): boolean {
  const win = /^[A-Za-z]:[\\/]/u.test(left) || /^[A-Za-z]:[\\/]/u.test(right);
  const implementation = win ? path.win32 : path.posix;
  const normalize = (value: string) =>
    win ? implementation.resolve(value).toLowerCase() : implementation.resolve(value);
  return normalize(left) === normalize(right);
}
function manager(config: ProjectConfig): ConfiguredPackageManager {
  return config.tooling?.packageManager ?? 'auto';
}

export function deriveLifecycleKey(repositoryIdentity: string, branch: string): string {
  return `lifecycle-${createHash('sha256')
    .update(JSON.stringify([repositoryIdentity, branch]), 'utf8')
    .digest('hex')}`;
}

/** Enforces the durable identity invariant before any lifecycle state can drive side effects. */
export function assertLifecycleStateIdentity(state: LifecycleState): void {
  if (state.key !== deriveLifecycleKey(state.repositoryIdentity, state.branch)) {
    throw lifecycleError(
      'WORKTREE_LIFECYCLE_STATE_INVALID',
      'The lifecycle key is not derived from its canonical repository identity and branch.',
    );
  }
}

/** Coordinates all mutating worktree resources under one repository-scoped lock. */
export class WorktreeLifecycleService {
  private readonly now: () => number;
  constructor(private readonly dependencies: LifecycleDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async create(request: CreateWorktreeRequest): Promise<LifecycleResult> {
    const repository = await this.dependencies.repository.resolve(request.cwd);
    const repositoryId = repository.config.project.id;
    return withRepositoryLock(this.dependencies.lock, repository.commonGitDirectory, async () => {
      const inventory = await this.dependencies.git.list(repository.mainRoot);
      const usableInventory = inventory.filter((entry) => !entry.prunable);
      const key = deriveLifecycleKey(repository.commonGitDirectory, request.branch);
      const existing = await this.dependencies.state.load(key);
      const configHash = this.dependencies.configHash(repository.config);
      const inventoryEntry =
        existing &&
        usableInventory.find((item) => sameLifecyclePath(item.path, existing.worktreePath));
      const matchingInventoryEntry =
        existing && inventoryEntry?.branch === existing.branch ? inventoryEntry : undefined;
      if (existing) {
        assertLifecycleStateIdentity(existing);
        if (
          existing.repositoryId !== repositoryId ||
          !sameLifecyclePath(existing.repositoryIdentity, repository.commonGitDirectory) ||
          !sameLifecyclePath(existing.mainRoot, repository.mainRoot) ||
          existing.branch !== request.branch
        ) {
          throw lifecycleError(
            'WORKTREE_REPOSITORY_MISMATCH',
            'The durable lifecycle state does not belong to the current repository and branch.',
          );
        }
        if (existing.configHash !== configHash) {
          throw lifecycleError(
            'WORKTREE_CONFIG_HASH_MISMATCH',
            'The durable creation configuration does not match the current configuration evidence.',
          );
        }
        if (inventoryEntry && inventoryEntry.branch !== existing.branch) {
          throw lifecycleError(
            'WORKTREE_RESUME_BRANCH_MISMATCH',
            'The inventory branch does not match the durable lifecycle branch.',
          );
        }
        if (existing.status === 'ready') {
          if (!matchingInventoryEntry) {
            throw lifecycleError(
              'WORKTREE_LIFECYCLE_INVENTORY_MISMATCH',
              'The durable lifecycle state has no matching worktree inventory entry.',
            );
          }
          return this.result('create', existing.status, repositoryId, existing);
        }
      }
      const resumable =
        existing !== undefined &&
        matchingInventoryEntry !== undefined &&
        existing.status !== 'removed';
      const worktreePath =
        resumable || existing?.status === 'creating' || existing?.status === 'removed'
          ? existing.worktreePath
          : deriveWorktreePath(repository.mainRoot, request.branch, {
              occupiedPaths: usableInventory.map((item) => item.path),
            });
      const base =
        existing?.base ??
        (await resolveBaseBranch({
          ...(request.base === undefined ? {} : { explicit: request.base }),
          ...(repository.config.workflow?.branch?.base === undefined
            ? {}
            : { configured: repository.config.workflow.branch.base }),
          discoverRemoteHead: () =>
            discoverRemoteHead(
              this.dependencies.git,
              repository.mainRoot,
              repository.config.repository.remote,
            ),
        }));
      let state: LifecycleState;
      if (resumable) {
        state = { ...existing, updatedAt: this.now() };
        delete state.externalDeletion;
        if (state.status === 'creating') {
          state.status = 'created';
          await this.dependencies.state.writeAtomic(key, state);
        }
      } else {
        const timestamp = this.now();
        const configuredPlan = preparationPlan(repository.config);
        const execution = request.execution ?? configuredPlan.execution;
        const creating: LifecycleState = {
          schemaVersion: 1,
          owner: 'mpx',
          key,
          repositoryId,
          repositoryIdentity: repository.commonGitDirectory,
          mainRoot: repository.mainRoot,
          worktreePath,
          branch: request.branch,
          base,
          configHash,
          status: 'creating',
          createdAt: timestamp,
          updatedAt: timestamp,
          sourceRoot: request.sourceRoot ?? repository.currentRoot ?? repository.mainRoot,
          preparationExecution: execution,
        };
        await this.dependencies.state.writeAtomic(key, creating);
        const gitArgs =
          existing?.status === 'removed'
            ? ['worktree', 'add', '--', worktreePath, request.branch]
            : ['worktree', 'add', '-b', request.branch, '--', worktreePath, base];
        try {
          await this.dependencies.git.run(gitArgs, repository.mainRoot);
        } catch (error) {
          state = {
            ...creating,
            status: 'failed',
            failure: errorFact('git', error),
            updatedAt: this.now(),
          };
          await this.dependencies.state.writeAtomic(key, state);
          throw lifecycleError(
            'WORKTREE_CREATE_GIT_FAILED',
            `Git did not create the worktree: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        state = { ...creating, status: 'created', updatedAt: this.now() };
        await this.dependencies.state.writeAtomic(key, state);
      }
      return this.continueCreate(repository, state, {
        ...(request.includeApproval === undefined
          ? {}
          : { includeApproval: request.includeApproval }),
        ...(request.approval === undefined ? {} : { preparationApproval: request.approval }),
      });
    });
  }

  async remove(request: RemoveWorktreeRequest): Promise<LifecycleResult> {
    const repository = await this.dependencies.repository.resolve(request.cwd);
    const repositoryId = repository.config.project.id;
    return withRepositoryLock(this.dependencies.lock, repository.commonGitDirectory, async () => {
      if (sameLifecyclePath(request.worktreePath, repository.mainRoot)) {
        throw lifecycleError(
          'WORKTREE_REMOVE_MAIN_REFUSED',
          'The canonical main worktree cannot be removed.',
        );
      }
      const entry = (await this.dependencies.git.list(repository.mainRoot)).find((item) =>
        sameLifecyclePath(item.path, request.worktreePath),
      );
      if (!entry) {
        throw lifecycleError('WORKTREE_NOT_FOUND', 'Git does not report the requested worktree.');
      }
      const key = entry.branch
        ? deriveLifecycleKey(repository.commonGitDirectory, entry.branch)
        : undefined;
      const state = key
        ? await this.dependencies.state.load(key)
        : (await this.dependencies.state.list?.(repository.commonGitDirectory))?.find((candidate) =>
            sameLifecyclePath(candidate.worktreePath, entry.path),
          );
      if (!key && !state) {
        throw lifecycleError(
          'WORKTREE_LIFECYCLE_IDENTITY_REQUIRED',
          'Detached worktrees require durable repository-and-branch lifecycle identity.',
        );
      }
      if (state) {
        assertLifecycleStateIdentity(state);
      }
      if (
        state &&
        (state.repositoryId !== repositoryId ||
          !sameLifecyclePath(state.repositoryIdentity, repository.commonGitDirectory) ||
          !sameLifecyclePath(state.mainRoot, repository.mainRoot) ||
          !sameLifecyclePath(state.worktreePath, entry.path) ||
          (entry.branch !== undefined && state.branch !== entry.branch))
      ) {
        throw lifecycleError(
          'WORKTREE_REPOSITORY_MISMATCH',
          'The durable lifecycle state does not belong to the current repository and worktree.',
        );
      }
      if (entry.locked) {
        throw lifecycleError(
          'WORKTREE_REMOVE_LOCKED',
          'Locked worktrees are not removed by default.',
        );
      }
      if (entry.prunable) {
        throw lifecycleError(
          'WORKTREE_REMOVE_PRUNABLE',
          'Prunable worktrees require reconciliation, not removal.',
        );
      }
      if (await this.dependencies.git.isDirty(entry.path)) {
        throw lifecycleError(
          'WORKTREE_REMOVE_DIRTY',
          'Dirty worktrees are not removed by default.',
        );
      }
      if (
        state &&
        (state.status === 'preparing' ||
          state.status === 'unknown' ||
          state.preparationStatus === 'preparing' ||
          state.preparationStatus === 'unknown')
      ) {
        let cancellation: { status: string };
        try {
          cancellation = await this.dependencies.preparation.cancel(state.key);
        } catch (error) {
          state.preparationStatus = 'unknown';
          state.status = 'unknown';
          state.failure = errorFact('remove', error);
          await this.persist(state);
          throw lifecycleError(
            'WORKTREE_REMOVE_PREPARATION_UNKNOWN',
            'Preparation could not be cancelled safely; the worktree was preserved.',
          );
        }
        if (!['cancelled', 'ready', 'failed'].includes(cancellation.status)) {
          state.preparationStatus = cancellation.status;
          state.failure = {
            phase: 'remove',
            code: 'WORKTREE_REMOVE_PREPARATION_UNKNOWN',
            message:
              'Preparation state could not be reconciled to a safe terminal status before removal.',
          };
          await this.persist(state);
          throw lifecycleError(
            'WORKTREE_REMOVE_PREPARATION_UNKNOWN',
            'Preparation must reach a safe terminal status before removal.',
          );
        }
        state.preparationStatus = cancellation.status;
        await this.persist(state);
      }
      if (await this.dependencies.git.isInUse(entry.path, state)) {
        throw lifecycleError(
          'WORKTREE_REMOVE_IN_USE',
          'The worktree is still in use outside its owned preparation worker.',
        );
      }
      if (!state) {
        throw lifecycleError(
          'WORKTREE_LIFECYCLE_IDENTITY_REQUIRED',
          'Removal requires durable lifecycle state.',
        );
      }
      const configHash = state.configHash;
      const identity =
        state.releaseIdentity ??
        (await this.dependencies.ports.captureReleaseIdentity({
          cwd: entry.path,
          projectRoot: entry.path,
          config: repository.config,
          configHash,
        }));
      state.configHash = configHash;
      state.releaseIdentity = identity;
      state.status = 'removing';
      delete state.failure;
      await this.persist(state);
      try {
        await this.dependencies.git.run(['worktree', 'remove', entry.path], repository.mainRoot);
      } catch (error) {
        state.failure = errorFact('remove', error);
        await this.persist(state);
        throw lifecycleError(
          'WORKTREE_REMOVE_GIT_FAILED',
          'Git did not remove the worktree; its lease was preserved.',
        );
      }
      state.status = 'git-removed-awaiting-lease-release';
      await this.persist(state);
      let released = false;
      try {
        released =
          (
            await this.dependencies.ports.releaseLinkedAfterRemoval({
              repositoryCwd: repository.mainRoot,
              identity,
            })
          ).released ?? false;
      } catch (error) {
        state.failure = errorFact('release', error);
        try {
          await this.persist(state);
        } catch {
          /* The awaiting-release state is already durable. */
        }
        throw lifecycleError(
          'WORKTREE_REMOVE_RELEASE_FAILED',
          'The worktree was removed but its identity-bound lease release remains pending.',
        );
      }
      state.status = 'removed';
      delete state.failure;
      await this.persist(state);
      return { ...this.result('remove', 'removed', repositoryId, state), released };
    });
  }

  async status(request: { cwd: string }): Promise<LifecycleResult> {
    const repository = await this.dependencies.repository.resolve(request.cwd);
    return {
      schemaVersion: 1,
      owner: 'mpx',
      operation: 'status',
      status: 'ok',
      repositoryId: repository.config.project.id,
      inventory: await this.dependencies.git.list(repository.mainRoot),
    };
  }

  async reconcile(request: { cwd: string }): Promise<LifecycleResult> {
    const repository = await this.dependencies.repository.resolve(request.cwd);
    const repositoryId = repository.config.project.id;
    return withRepositoryLock(this.dependencies.lock, repository.commonGitDirectory, async () => {
      const inventory = await this.dependencies.git.list(repository.mainRoot);
      const states = (await this.dependencies.state.list?.(repository.commonGitDirectory)) ?? [];
      for (const state of states) {
        assertLifecycleStateIdentity(state);
        if (
          state.repositoryId !== repositoryId ||
          !sameLifecyclePath(state.repositoryIdentity, repository.commonGitDirectory) ||
          !sameLifecyclePath(state.mainRoot, repository.mainRoot)
        ) {
          throw lifecycleError(
            'WORKTREE_REPOSITORY_MISMATCH',
            'The durable lifecycle state does not belong to the current repository.',
          );
        }
        const inventoryEntry = inventory.find((entry) =>
          sameLifecyclePath(entry.path, state.worktreePath),
        );
        const present = inventoryEntry !== undefined && !inventoryEntry.prunable;
        if (
          present &&
          inventoryEntry.branch !== undefined &&
          inventoryEntry.branch !== state.branch
        ) {
          throw lifecycleError(
            'WORKTREE_REPOSITORY_MISMATCH',
            'The durable lifecycle branch does not match its canonical inventory path.',
          );
        }
        if (state.status === 'removed') {
          continue;
        }
        if (state.status === 'removing' || state.status === 'git-removed-awaiting-lease-release') {
          if (present) {
            continue;
          }
          if (!state.releaseIdentity) {
            throw lifecycleError(
              'WORKTREE_RELEASE_IDENTITY_REQUIRED',
              'Pending removal has no durable release identity.',
            );
          }
          if (state.status === 'removing') {
            state.status = 'git-removed-awaiting-lease-release';
            await this.persist(state);
          }
          try {
            await this.dependencies.ports.releaseLinkedAfterRemoval({
              repositoryCwd: repository.mainRoot,
              identity: state.releaseIdentity,
            });
          } catch (error) {
            state.failure = errorFact('release', error);
            try {
              await this.persist(state);
            } catch {
              /* The awaiting-release state remains durable. */
            }
            throw lifecycleError(
              'WORKTREE_REMOVE_RELEASE_FAILED',
              'The pending identity-bound lease release failed during reconciliation.',
            );
          }
          state.status = 'removed';
          delete state.failure;
          await this.persist(state);
          continue;
        }
        if (state.status === 'creating') {
          if (!present) {
            continue;
          }
          state.status = 'created';
          delete state.externalDeletion;
          await this.persist(state);
        }
        const creationStatus = [
          'created',
          'including',
          'included',
          'allocating',
          'leased',
          'preparation-pending',
          'preparing',
          'approval-required',
          'failed',
          'unknown',
        ].includes(state.status);
        if (present && creationStatus) {
          const currentHash = this.dependencies.configHash(repository.config);
          if (state.configHash !== currentHash) {
            throw lifecycleError(
              'WORKTREE_CONFIG_HASH_MISMATCH',
              'The durable creation intent does not match current configuration evidence.',
            );
          }
          await this.continueCreate(repository, state, {});
          continue;
        }
        if (!present) {
          state.externalDeletion = true;
          if (
            state.status === 'preparing' ||
            state.status === 'unknown' ||
            state.preparationStatus === 'preparing' ||
            state.preparationStatus === 'unknown'
          ) {
            try {
              const cancellation = await this.dependencies.preparation.cancel(state.key);
              state.preparationStatus = cancellation.status;
              if (cancellation.status === 'unknown') {
                state.status = 'unknown';
              } else if (cancellation.status === 'cancelled') {
                state.status = 'orphaned';
              } else if (!state.failure) {
                state.status = 'orphaned';
              }
            } catch (error) {
              state.preparationStatus = 'unknown';
              state.status = 'unknown';
              state.failure = errorFact('remove', error);
            }
          } else if (!state.failure) {
            state.status = 'orphaned';
          }
          await this.persist(state);
        } else if (
          state.status === 'preparing' ||
          state.status === 'unknown' ||
          state.preparationStatus === 'preparing' ||
          state.preparationStatus === 'unknown'
        ) {
          const prepared = await this.dependencies.preparation.reconcile(state.key);
          state.preparationStatus = prepared.status;
          if (
            prepared.status === 'ready' ||
            prepared.status === 'failed' ||
            prepared.status === 'cancelled' ||
            prepared.status === 'unknown'
          ) {
            state.status = prepared.status === 'cancelled' ? 'failed' : prepared.status;
          }
          await this.persist(state);
        }
      }
      const ports = await this.dependencies.ports.reconcile({
        cwd: repository.mainRoot,
        orphanPolicy: 'report',
      });
      return {
        schemaVersion: 1,
        owner: 'mpx',
        operation: 'reconcile',
        status: 'reconciled',
        repositoryId,
        inventory,
        orphaned: ports.orphaned ?? [],
      };
    });
  }

  private async continueCreate(
    repository: RepositoryContext,
    state: LifecycleState,
    supplied: { includeApproval?: string; preparationApproval?: string },
  ): Promise<LifecycleResult> {
    const repositoryId = repository.config.project.id;
    const configuredPlan = preparationPlan(repository.config);
    const plan =
      state.preparationExecution === undefined
        ? configuredPlan
        : { ...configuredPlan, execution: state.preparationExecution };
    const planDigest = createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');

    if (
      (state.status === 'failed' &&
        state.failure?.phase === 'preparation' &&
        (state.preparationStatus === 'failed' || state.preparationStatus === 'cancelled')) ||
      (state.status === 'unknown' &&
        (state.failure?.phase === 'preparation' || state.preparationStatus === 'unknown'))
    ) {
      return this.result('create', state.status, repositoryId, state);
    }

    if (state.status === 'preparation-pending' || state.status === 'preparing') {
      try {
        const recovered = await this.dependencies.preparation.reconcile(state.key);
        state.preparationStatus = recovered.status;
        if (recovered.status === 'preparing') {
          state.status = 'preparing';
        } else if (recovered.status === 'ready') {
          state.status = 'ready';
          delete state.failure;
        } else if (recovered.status === 'unknown') {
          state.status = 'unknown';
          state.failure = {
            phase: 'preparation',
            code: 'PREPARATION_UNKNOWN',
            message: 'Preparation ownership or completion could not be verified.',
          };
        } else if (recovered.status === 'failed' || recovered.status === 'cancelled') {
          state.status = 'failed';
          state.failure = {
            phase: 'preparation',
            code: recovered.status === 'cancelled' ? 'PREPARATION_CANCELLED' : 'PREPARATION_FAILED',
            message: `Preparation ended with status ${recovered.status}.`,
          };
        } else {
          state.status = 'unknown';
          state.preparationStatus = 'unknown';
          state.failure = {
            phase: 'preparation',
            code: 'PREPARATION_STATUS_INVALID',
            message: 'Preparation returned an unsupported persisted status.',
          };
        }
        await this.persist(state);
        return this.result('create', state.status, repositoryId, state);
      } catch (error) {
        if (!(error instanceof MpxError) || error.code !== 'PREPARATION_STATE_MISSING') {
          throw error;
        }
      }
      state.status = 'preparation-pending';
      state.preparationStatus = 'pending';
      await this.persist(state);
    }

    const durablePreparationApproval =
      supplied.preparationApproval ?? state.preparationEvidence?.expectedApproval;
    if (plan.execution !== 'none') {
      let validation: Awaited<ReturnType<LifecyclePreparationAdapter['prepare']>>;
      try {
        validation = await this.dependencies.preparation.prepare({
          key: state.key,
          plan,
          worktreeRoot: state.worktreePath,
          packageManager: manager(repository.config),
          config: repository.config,
          validateOnly: true,
          ...(durablePreparationApproval === undefined
            ? {}
            : { exactApproval: durablePreparationApproval }),
        });
      } catch (error) {
        if (error instanceof MpxError && error.code === 'PREPARATION_APPROVAL_STALE') {
          // A stale approval is a recoverable review boundary, not a failed execution.
          // Re-capture without the old exact approval so the durable evidence is replaced.
          try {
            validation = await this.dependencies.preparation.prepare({
              key: state.key,
              plan,
              worktreeRoot: state.worktreePath,
              packageManager: manager(repository.config),
              config: repository.config,
              validateOnly: true,
            });
          } catch (refreshError) {
            return this.failAndThrow(state, 'preparation', refreshError);
          }
          state.preparationEvidence = {
            planDigest,
            ...(validation.expectedApproval === undefined
              ? {}
              : { expectedApproval: validation.expectedApproval }),
            ...(validation.approval === undefined ? {} : { approval: validation.approval }),
          };
          state.status = 'approval-required';
          state.preparationStatus = 'approval-required';
          delete state.failure;
          if (validation.expectedApproval === undefined) {
            delete state.expectedApproval;
          } else {
            state.expectedApproval = validation.expectedApproval;
          }
          if (validation.approval === undefined) {
            delete state.approval;
          } else {
            state.approval = validation.approval;
          }
          await this.persist(state);
          return this.result('create', state.status, repositoryId, state);
        }
        // Validation has not started preparation. Persist a retryable lifecycle
        // failure rather than attempting reconciliation or manufacturing unknown.
        return this.failAndThrow(state, 'preparation', error);
      }
      state.preparationEvidence = {
        planDigest,
        ...(validation.expectedApproval === undefined
          ? {}
          : { expectedApproval: validation.expectedApproval }),
        ...(validation.approval === undefined ? {} : { approval: validation.approval }),
      };
      if (validation.status === 'approval-required') {
        state.status = 'approval-required';
        state.preparationStatus = validation.status;
        if (validation.expectedApproval === undefined) {
          delete state.expectedApproval;
        } else {
          state.expectedApproval = validation.expectedApproval;
        }
        if (validation.approval === undefined) {
          delete state.approval;
        } else {
          state.approval = validation.approval;
        }
        await this.persist(state);
        return this.result('create', state.status, repositoryId, state);
      }
    }

    if (!state.includeEvidence?.completed) {
      const sourceRoot = state.sourceRoot ?? repository.mainRoot;
      const exactApproval = supplied.includeApproval ?? state.includeEvidence?.expectedApproval;
      const priorIncludeEvidence = state.includeEvidence;
      let inspection: LifecycleIncludeInspection = {
        status: 'absent',
        manifestSha256: createHash('sha256')
          .update(
            JSON.stringify([repositoryId, sourceRoot, repository.mainRoot, state.worktreePath]),
          )
          .digest('hex'),
      };
      try {
        if (this.dependencies.includes?.inspect) {
          inspection = await this.dependencies.includes.inspect({
            repositoryId,
            sourceRoot,
            mainRoot: repository.mainRoot,
            destinationRoot: state.worktreePath,
            ...(exactApproval === undefined ? {} : { exactHumanApproval: exactApproval }),
          });
        }
        if (inspection.status === 'approval-required') {
          state.includeEvidence = {
            manifestSha256: inspection.manifestSha256,
            ...(inspection.expectedApproval === undefined
              ? {}
              : { expectedApproval: inspection.expectedApproval }),
          };
          state.status = 'failed';
          state.failure = {
            phase: 'includes',
            code: 'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
            message: 'Exact approval for the current include manifest is required.',
          };
          await this.persist(state);
          throw lifecycleError(
            'WORKTREE_INCLUDE_APPROVAL_REQUIRED',
            'Exact approval for the current include manifest is required.',
          );
        }
        const allowExistingRecovery =
          priorIncludeEvidence?.copyStarted === true &&
          priorIncludeEvidence.manifestSha256 === inspection.manifestSha256 &&
          priorIncludeEvidence.expectedApproval === inspection.expectedApproval &&
          exactApproval === inspection.expectedApproval;
        state.includeEvidence = {
          manifestSha256: inspection.manifestSha256,
          ...(inspection.expectedApproval === undefined
            ? {}
            : { expectedApproval: inspection.expectedApproval }),
          ...(this.dependencies.includes === undefined ? {} : { copyStarted: true }),
        };
        state.status = 'including';
        delete state.failure;
        await this.persist(state);
        if (this.dependencies.includes) {
          const copied = await this.dependencies.includes.copy({
            repositoryId,
            sourceRoot,
            mainRoot: repository.mainRoot,
            destinationRoot: state.worktreePath,
            expectedManifestSha256: inspection.manifestSha256,
            allowExistingRecovery,
            ...(exactApproval === undefined ? {} : { exactHumanApproval: exactApproval }),
          });
          if (
            copied?.manifestSha256 !== undefined &&
            copied.manifestSha256 !== inspection.manifestSha256
          ) {
            throw lifecycleError(
              'WORKTREE_INCLUDE_APPROVAL_STALE',
              'The copied include manifest differs from durable approval evidence.',
            );
          }
        }
        state.includeEvidence = { ...state.includeEvidence, completed: true };
        state.status = 'included';
        await this.persist(state);
      } catch (error) {
        if (error instanceof MpxError && error.code === 'WORKTREE_INCLUDE_APPROVAL_REQUIRED') {
          throw error;
        }
        return this.failAndThrow(state, 'includes', error);
      }
    }

    if (
      !['leased', 'preparation-pending', 'preparing', 'ready'].includes(state.status) &&
      state.failure?.phase !== 'preparation'
    ) {
      state.status = 'allocating';
      delete state.failure;
      await this.persist(state);
      let allocated: Awaited<ReturnType<LifecyclePortAdapter['ensure']>>;
      try {
        allocated = await this.dependencies.ports.ensure({
          cwd: state.worktreePath,
          projectRoot: state.worktreePath,
          config: repository.config,
          configHash: state.configHash,
        });
      } catch (error) {
        return this.failAndThrow(state, 'ports', error);
      }
      if (allocated.lease?.leaseId !== undefined) {
        state.leaseId = allocated.lease.leaseId;
      }
      state.status = 'leased';
      await this.persist(state);
    }

    if (state.status !== 'ready') {
      state.preparationEvidence ??= { planDigest };
      if (state.preparationEvidence.planDigest !== planDigest) {
        throw lifecycleError(
          'WORKTREE_PREPARATION_EVIDENCE_STALE',
          'The durable preparation request no longer matches the configured plan.',
        );
      }
      state.status = 'preparation-pending';
      state.preparationStatus = 'pending';
      delete state.failure;
      await this.persist(state);
      try {
        const exactApproval =
          state.preparationEvidence.expectedApproval ?? durablePreparationApproval;
        const prepared = await this.dependencies.preparation.prepare({
          key: state.key,
          plan,
          worktreeRoot: state.worktreePath,
          packageManager: manager(repository.config),
          config: repository.config,
          ...(exactApproval === undefined ? {} : { exactApproval }),
        });
        state.preparationStatus = prepared.status;
        if (prepared.expectedApproval === undefined) {
          delete state.expectedApproval;
        } else {
          state.expectedApproval = prepared.expectedApproval;
        }
        if (prepared.approval === undefined) {
          delete state.approval;
        } else {
          state.approval = prepared.approval;
        }
        state.status =
          prepared.status === 'ready'
            ? 'ready'
            : prepared.status === 'preparing'
              ? 'preparing'
              : 'failed';
        if (state.status === 'failed') {
          state.failure = {
            phase: 'preparation',
            code: 'PREPARATION_FAILED',
            message: `Preparation ended with status ${prepared.status}.`,
          };
        }
        await this.persist(state);
      } catch (error) {
        return this.recoverPreparationFailure(state, error);
      }
    }
    return this.result('create', state.status, repositoryId, state);
  }

  private async recoverPreparationFailure(state: LifecycleState, error: unknown): Promise<never> {
    let recovered: { status: string };
    try {
      recovered = await this.dependencies.preparation.reconcile(state.key);
    } catch (reconcileError) {
      state.preparationStatus = 'unknown';
      state.status = 'unknown';
      state.failure = {
        phase: 'preparation',
        code: 'PREPARATION_UNKNOWN',
        message: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      };
      await this.persist(state);
      throw lifecycleError(
        'WORKTREE_CREATE_INCOMPLETE',
        `The worktree remains available after preparation failed: ${state.failure.message}`,
      );
    }
    state.preparationStatus = recovered.status;
    if (recovered.status === 'unknown') {
      state.status = 'unknown';
      state.failure = {
        phase: 'preparation',
        code: 'PREPARATION_UNKNOWN',
        message: 'Preparation ownership or completion could not be verified.',
      };
    } else if (recovered.status === 'failed' || recovered.status === 'cancelled') {
      state.status = 'failed';
      state.failure = {
        phase: 'preparation',
        code: recovered.status === 'cancelled' ? 'PREPARATION_CANCELLED' : 'PREPARATION_FAILED',
        message: `Preparation ended with status ${recovered.status}.`,
      };
    } else if (recovered.status === 'ready') {
      state.status = 'ready';
      delete state.failure;
    } else {
      state.status = 'unknown';
      state.preparationStatus = 'unknown';
      state.failure = {
        phase: 'preparation',
        code: 'PREPARATION_UNKNOWN',
        message: `Preparation returned status ${recovered.status} after an execution error.`,
      };
    }
    await this.persist(state);
    const message = error instanceof Error ? error.message : String(error);
    throw lifecycleError(
      'WORKTREE_CREATE_INCOMPLETE',
      `The worktree remains available after preparation failed: ${message}`,
    );
  }

  private async persist(state: LifecycleState): Promise<void> {
    assertLifecycleStateIdentity(state);
    state.updatedAt = this.now();
    await this.dependencies.state.writeAtomic(state.key, state);
  }
  private async failAndThrow(
    state: LifecycleState,
    phase: LifecyclePhase,
    error: unknown,
  ): Promise<never> {
    state.status = 'failed';
    state.failure = errorFact(phase, error);
    await this.persist(state);
    throw lifecycleError(
      'WORKTREE_CREATE_INCOMPLETE',
      `The worktree remains available after ${phase} failed: ${state.failure.message}`,
    );
  }
  private result(
    operation: LifecycleResult['operation'],
    status: string,
    repositoryId: string,
    state: LifecycleState,
  ): LifecycleResult {
    return {
      schemaVersion: 1,
      owner: 'mpx',
      operation,
      status,
      repositoryId,
      worktreePath: state.worktreePath,
      ...(state.leaseId === undefined ? {} : { leaseId: state.leaseId }),
      ...(state.expectedApproval === undefined ? {} : { expectedApproval: state.expectedApproval }),
      ...(state.approval === undefined ? {} : { approval: state.approval }),
      state,
    };
  }
}
