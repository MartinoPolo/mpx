import { sha256Canonical, type JsonValue } from '@mpx/core';
import type { ProjectConfig } from '@mpx/config';
import type { DevServiceSnapshot, ExecutorKind, StartRequest } from '@mpx/dev-services';
import type { LinkedReleaseResult } from '@mpx/ports';
import type { StatusSnapshotV1 } from '@mpx/status';
import type {
  CreateWorktreeRequest,
  LifecycleResult,
  PreparationStatus,
  RemoveWorktreeRequest,
  WorktreeInventoryEntry,
} from '@mpx/worktrees';
export type {
  CreateWorktreeRequest,
  LifecycleResult,
  RemoveWorktreeRequest,
  WorktreeInventoryEntry,
} from '@mpx/worktrees';
export type { LinkedReleaseRequest, LinkedReleaseResult } from '@mpx/ports';

export type LifecycleDevStatusResult =
  DevServiceSnapshot | readonly DevServiceSnapshot[] | undefined;
export interface LifecycleUnmanagedDevResult {
  readonly id: string;
  readonly state: 'external' | 'test-only';
  readonly managed: false;
  readonly port: number;
  readonly environment: Readonly<Record<string, string>>;
}
export type LifecycleDevResult =
  | DevServiceSnapshot
  | readonly DevServiceSnapshot[]
  | LifecycleUnmanagedDevResult
  | string
  | undefined;

export interface LifecycleDevService {
  readonly runtimeKind?: ExecutorKind;
  start(request: StartRequest): Promise<DevServiceSnapshot>;
  status(id?: string): Promise<LifecycleDevStatusResult>;
  logs(id: string, options?: { maxLines?: number; maxCharacters?: number }): Promise<string>;
  restart(id: string): Promise<DevServiceSnapshot>;
  stop(id: string): Promise<DevServiceSnapshot>;
}

export interface LifecyclePortLease {
  readonly leaseId?: string;
  readonly services: Record<string, number>;
  readonly ownerRoot?: string;
}
export interface LifecyclePortWarning {
  readonly code: string;
  readonly message: string;
  readonly port?: number;
}
export interface LifecyclePortDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'warning';
  readonly details?: { readonly port: number };
}
export interface LifecyclePortInspection {
  readonly port: number;
  readonly pid?: number;
  readonly address?: string;
  readonly processName?: string;
  readonly executable?: string;
  readonly projectPath?: string;
  readonly startedAt?: string;
}
export interface LifecyclePortReconcileResult {
  readonly removed: string[];
  readonly repaired: string[];
  readonly orphaned?: readonly unknown[];
}
export interface LifecyclePortRebuildResult {
  readonly discovered: number;
  readonly rebuilt: number;
  readonly roots: number;
}
export interface LifecyclePortService {
  resolve(
    request: LifecycleProjectRequest & { configHash: string },
  ): Promise<LifecyclePortLease | { lease: LifecyclePortLease }>;
  ensure?(request: LifecycleProjectRequest & { configHash: string }): Promise<{
    lease: LifecyclePortLease;
    warnings: readonly LifecyclePortWarning[];
  }>;
  inspect?(): Promise<readonly LifecyclePortInspection[]>;
  reconcile?(request: { cwd: string }): Promise<LifecyclePortReconcileResult>;
  rebuild?(request: { roots: string[] }): Promise<LifecyclePortRebuildResult>;
  list?(): Promise<readonly { leaseId: string }[]>;
  release?(request: { cwd: string }): Promise<void>;
  kill?(pid: number): Promise<void>;
}

export interface LifecyclePortProjects {
  discover(cwd: string): Promise<{ root: string; config: ProjectConfig }>;
  userConfig(): Promise<{ domains: Readonly<Record<string, readonly string[]>> }>;
}
export interface LifecyclePortOperationResult<Data> {
  readonly data: Data;
  readonly warnings: readonly LifecyclePortDiagnostic[];
}
export interface LifecyclePortOperationMap {
  ensure: {
    request: { cwd: string };
    result: LifecyclePortOperationResult<LifecyclePortLease>;
  };
  resolve: {
    request: { cwd: string };
    result: LifecyclePortOperationResult<LifecyclePortLease>;
  };
  inspect: {
    request: { cwd: string };
    result: LifecyclePortOperationResult<readonly LifecyclePortInspection[]>;
  };
  reconcile: {
    request: { cwd: string; rebuild?: boolean };
    result: LifecyclePortOperationResult<LifecyclePortReconcileResult | LifecyclePortRebuildResult>;
  };
}

export interface ListWorktreesRequest {
  cwd: string;
}
export interface SelectWorktreeRequest {
  cwd: string;
  path: string;
}
export interface StatusWorktreesRequest {
  cwd: string;
}
export interface PrepareWorktreeRequest {
  cwd: string;
  key: string;
  approval?: string;
}
export interface CancelWorktreeRequest {
  cwd: string;
  key: string;
}
export interface ReconcileWorktreesRequest {
  cwd: string;
  orphanApproval?: string;
}
export type CreateWorktreeResult = LifecycleResult;
export type RemoveWorktreeResult = LifecycleResult;
export type ListWorktreesResult = readonly WorktreeInventoryEntry[];
export type SelectWorktreeResult = WorktreeInventoryEntry;
export type StatusWorktreesResult = LifecycleResult;
export interface WorktreePreparationResult {
  status?: PreparationStatus | 'approval-required' | 'approved';
  expectedApproval?: string;
}
export type WorktreeReconcileResult = LifecycleResult & {
  resolutions?: readonly LinkedReleaseResult[];
};

/** Action-specific request and result contracts for worktree lifecycle operations. */
export interface LifecycleWorktreeOperationMap {
  create: { request: CreateWorktreeRequest; result: CreateWorktreeResult };
  remove: { request: RemoveWorktreeRequest; result: RemoveWorktreeResult };
  list: { request: ListWorktreesRequest; result: ListWorktreesResult };
  select: { request: SelectWorktreeRequest; result: SelectWorktreeResult };
  status: { request: StatusWorktreesRequest; result: StatusWorktreesResult };
  prepare: { request: PrepareWorktreeRequest; result: WorktreePreparationResult };
  cancel: { request: CancelWorktreeRequest; result: WorktreePreparationResult };
  reconcile: { request: ReconcileWorktreesRequest; result: WorktreeReconcileResult };
}

/** Action-specific application boundary for worktree lifecycle operations. */
export interface LifecycleWorktreeService {
  create(request: CreateWorktreeRequest): Promise<CreateWorktreeResult>;
  remove(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult>;
  list(request: ListWorktreesRequest): Promise<ListWorktreesResult>;
  select(request: SelectWorktreeRequest): Promise<SelectWorktreeResult>;
  status(request: StatusWorktreesRequest): Promise<StatusWorktreesResult>;
  prepare(request: PrepareWorktreeRequest): Promise<WorktreePreparationResult>;
  cancel(request: CancelWorktreeRequest): Promise<WorktreePreparationResult>;
  reconcile(request: ReconcileWorktreesRequest): Promise<WorktreeReconcileResult>;
}

export interface LifecycleStatusProvider {
  snapshot(request: LifecycleProjectRequest & { configHash: string }): Promise<StatusSnapshotV1>;
}
export interface LifecycleProjectRequest {
  cwd: string;
  projectRoot: string;
  config: ProjectConfig;
  configHash?: string;
}
export interface LifecyclePath {
  resolve(...parts: string[]): string;
}

export interface LifecycleApplicationDependencies {
  path: LifecyclePath;
  devService?: LifecycleDevService;
  ports?: LifecyclePortService;
  projects?: LifecyclePortProjects;
  worktrees?: LifecycleWorktreeService;
  status?: LifecycleStatusProvider;
  pause?: (milliseconds: number) => Promise<void>;
}

const safeScript = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class LifecycleApplicationService {
  constructor(private readonly dependencies: LifecycleApplicationDependencies) {}

  async dev(
    input: LifecycleProjectRequest & {
      action: string;
      id?: string;
      executor: 'host' | 'docker';
      lines?: number;
    },
  ): Promise<LifecycleDevResult> {
    const service = this.dependencies.devService;
    if (!service) {
      throw new Error('Development service management is unavailable.');
    }
    if (input.action === 'status') {
      return service.status(input.id);
    }
    if (!input.id) {
      throw new Error(`--id is required for dev ${input.action}`);
    }
    if (input.action === 'logs') {
      return service.logs(input.id, { maxLines: input.lines ?? 200, maxCharacters: 20_000 });
    }
    if (input.action === 'restart') {
      return service.restart(input.id);
    }
    if (input.action === 'stop') {
      return service.stop(input.id);
    }
    if (input.action !== 'start') {
      throw new Error('dev requires one of: start, status, logs, restart, stop');
    }
    const configured = input.config.development?.services[input.id];
    if (!configured) {
      throw new Error(`Unknown configured development service '${input.id}'.`);
    }
    let invocation: { executable: string; args: string[] } | undefined;
    if (configured.start.type === 'package-script') {
      if (!safeScript.test(configured.start.script)) {
        throw new Error('Package script must be a bounded safe label.');
      }
      const manager = input.config.tooling?.packageManager ?? 'auto';
      if (manager === 'none') {
        throw new Error('A package manager is required for package-script development services.');
      }
      invocation = {
        executable: manager === 'auto' ? 'npm' : manager,
        args: ['run', configured.start.script],
      };
    }
    if (!this.dependencies.ports) {
      throw new Error('Development service start requires the port state service.');
    }
    const resolved = await this.dependencies.ports.resolve({
      ...input,
      configHash: input.configHash ?? sha256Canonical(input.config as unknown as JsonValue),
    });
    const lease = 'lease' in resolved ? resolved.lease : resolved;
    const port = lease.services[input.id];
    if (port === undefined) {
      throw new Error(`No assigned worktree port exists for service '${input.id}'.`);
    }
    const environment: Record<string, string> = {};
    for (const [id, definition] of Object.entries(input.config.development?.services ?? {})) {
      if (!definition.environmentVariable) {
        continue;
      }
      const assigned = lease.services[id];
      if (assigned === undefined) {
        throw new Error(`No assigned worktree port exists for coupled service '${id}'.`);
      }
      if (environment[definition.environmentVariable] !== undefined) {
        throw new Error(
          `Development service environment variable '${definition.environmentVariable}' is declared more than once.`,
        );
      }
      environment[definition.environmentVariable] =
        `${definition.protocol ?? 'http'}://localhost:${assigned}`;
    }
    if (!invocation) {
      if (configured.start.type === 'package-script') {
        throw new Error('Package-script development service invocation was not constructed.');
      }
      return Object.freeze({
        id: input.id,
        state: configured.start.type,
        managed: false,
        port,
        environment: Object.freeze(environment),
      });
    }
    if (configured.scope === 'project' && !lease.ownerRoot) {
      throw new Error(
        'Project-scoped development services require the canonical main-worktree owner root.',
      );
    }
    const cwd = this.dependencies.path.resolve(
      configured.scope === 'project' ? lease.ownerRoot! : input.projectRoot,
    );
    return service.start({
      id: input.id,
      ...invocation,
      cwd,
      ports: [port],
      assignment: { worktreeRoot: cwd, ports: [port] },
      executor: input.executor,
      environment,
    });
  }

  async port<Action extends keyof LifecyclePortOperationMap>(
    action: Action,
    request: LifecyclePortOperationMap[Action]['request'],
  ): Promise<LifecyclePortOperationMap[Action]['result']> {
    const ports = this.dependencies.ports;
    if (!ports) {
      throw new Error('Port state management is unavailable.');
    }
    if (action === 'inspect') {
      if (!ports.inspect) {
        throw new Error('Port inspection is unavailable.');
      }
      return {
        data: await ports.inspect(),
        warnings: [],
      } as LifecyclePortOperationMap[Action]['result'];
    }
    if (action === 'reconcile') {
      const reconcileRequest = request as LifecyclePortOperationMap['reconcile']['request'];
      if (!reconcileRequest.rebuild) {
        if (!ports.reconcile) {
          throw new Error('Port reconciliation is unavailable.');
        }
        return {
          data: await ports.reconcile({ cwd: reconcileRequest.cwd }),
          warnings: [],
        } as LifecyclePortOperationMap[Action]['result'];
      }
      if (!ports.rebuild) {
        throw new Error('Port rebuilding is unavailable.');
      }
      const projects = this.portProjects();
      const [user, project] = await Promise.all([
        projects.userConfig(),
        projects.discover(reconcileRequest.cwd),
      ]);
      const roots = [
        ...new Set(
          [...Object.values(user.domains).flat(), project.root].map((root) =>
            this.dependencies.path.resolve(root),
          ),
        ),
      ];
      return {
        data: await ports.rebuild({ roots }),
        warnings: [],
      } as LifecyclePortOperationMap[Action]['result'];
    }
    const projectRequest = request as { cwd: string };
    const found = await this.portProjects().discover(projectRequest.cwd);
    const integrityRequest = {
      cwd: projectRequest.cwd,
      projectRoot: found.root,
      config: found.config,
      configHash: sha256Canonical(found.config as unknown as JsonValue),
    };
    if (action === 'ensure') {
      if (!ports.ensure) {
        throw new Error('Port ensuring is unavailable.');
      }
      const result = await ports.ensure(integrityRequest);
      return {
        data: result.lease,
        warnings: result.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          severity: 'warning' as const,
          ...(warning.port === undefined ? {} : { details: { port: warning.port } }),
        })),
      } as LifecyclePortOperationMap[Action]['result'];
    }
    const resolved = await ports.resolve(integrityRequest);
    return {
      data: 'lease' in resolved ? resolved.lease : resolved,
      warnings: [],
    } as LifecyclePortOperationMap[Action]['result'];
  }
  private portProjects(): LifecyclePortProjects {
    const projects = this.dependencies.projects;
    if (!projects) {
      throw new Error('Project configuration loading is unavailable.');
    }
    return projects;
  }
  async listPorts(): Promise<readonly { leaseId: string }[]> {
    if (!this.dependencies.ports?.list) {
      throw new Error('Port listing is unavailable.');
    }
    return [...(await this.dependencies.ports.list())].sort((a, b) =>
      a.leaseId.localeCompare(b.leaseId),
    );
  }
  async releasePorts(request: { cwd: string }): Promise<{ released: true }> {
    if (!this.dependencies.ports?.release) {
      throw new Error('Port release is unavailable.');
    }
    await this.dependencies.ports.release(request);
    return { released: true };
  }
  async killPortProcess(pid: number): Promise<{ killed: true; pid: number }> {
    if (!this.dependencies.ports?.kill) {
      throw new Error('Port process termination is unavailable.');
    }
    await this.dependencies.ports.kill(pid);
    return { killed: true, pid };
  }
  private worktreeService(): LifecycleWorktreeService {
    const service = this.dependencies.worktrees;
    if (!service) {
      throw new Error('Worktree lifecycle is unavailable.');
    }
    return service;
  }
  worktree<Action extends keyof LifecycleWorktreeOperationMap>(
    action: Action,
    request: LifecycleWorktreeOperationMap[Action]['request'],
  ): Promise<LifecycleWorktreeOperationMap[Action]['result']> {
    const service = this.worktreeService();
    const operation = service[action] as (
      request: LifecycleWorktreeOperationMap[Action]['request'],
    ) => Promise<LifecycleWorktreeOperationMap[Action]['result']>;
    return operation.call(service, request);
  }
  currentStatus(request: LifecycleProjectRequest): Promise<StatusSnapshotV1> {
    if (!this.dependencies.status) {
      throw new Error('Status is unavailable.');
    }
    return this.dependencies.status.snapshot({
      ...request,
      configHash: request.configHash ?? sha256Canonical(request.config as unknown as JsonValue),
    });
  }
  async watchStatus(
    request: LifecycleProjectRequest,
    options: {
      iterations?: number;
      intervalMs: number;
      emit(value: StatusSnapshotV1): void | Promise<void>;
    },
  ): Promise<void> {
    const pause =
      this.dependencies.pause ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    for (let index = 0; index < (options.iterations ?? Number.POSITIVE_INFINITY); index += 1) {
      await options.emit(await this.currentStatus(request));
      if (index + 1 < (options.iterations ?? Number.POSITIVE_INFINITY)) {
        await pause(options.intervalMs);
      }
    }
  }
}
