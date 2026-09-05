import { MpxError, sha256Canonical, type JsonValue } from '@mpx/core';
import type { ProjectConfig } from '@mpx/config';
import type { DevServiceSnapshot, ExecutorKind, StartRequest } from '@mpx/dev-services';
import type { StatusSnapshotV1 } from '@mpx/status';
import type {
  CreateWorktreeRequest,
  LifecycleResult,
  WorktreeInventoryEntry,
} from '@mpx/worktrees';

export interface WorkspaceRequestV1 {
  readonly schemaVersion: 1;
  readonly cwd: string;
}
export interface WorkspaceShowRequestV1 extends WorkspaceRequestV1 {
  readonly path?: string;
}
export interface WorkspaceCreateRequestV1 extends WorkspaceRequestV1 {
  readonly branch: string;
  readonly base?: string;
  readonly sourceRoot?: string;
  readonly includeApproval?: string;
  readonly approval?: string;
  readonly execution?: 'foreground' | 'background' | 'none';
}
export interface WorkspaceRemoveRequestV1 extends WorkspaceRequestV1 {
  readonly path: string;
}
export interface WorkspaceServiceRequestV1 extends WorkspaceShowRequestV1 {
  readonly serviceId: string;
}
export interface WorkspaceLogsRequestV1 extends WorkspaceServiceRequestV1 {
  readonly lines?: number;
}
export interface PortKillRequestV1 {
  readonly schemaVersion: 1;
  readonly pid: number;
}

export interface WorkspaceDiagnosticV1 {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}
export interface WorkspaceSummaryV1 {
  readonly path: string;
  readonly worktreeId: string | null;
  readonly leaseId: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly role: 'main' | 'linked';
  readonly ports: Readonly<Record<string, number>>;
}
export interface WorkspaceListResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'workspace-list';
  readonly workspaces: readonly WorkspaceSummaryV1[];
  readonly diagnostics: readonly WorkspaceDiagnosticV1[];
}
export interface WorkspaceServiceV1 {
  readonly id: string;
  readonly configured: true;
  readonly managed: boolean;
  readonly scope: 'checkout' | 'project';
  readonly state: string;
  readonly port: number | null;
  readonly listening: boolean;
  readonly conflict: 'none' | 'external' | 'unknown';
  readonly pid: number | null;
}
export interface WorkspaceShowResultV1 extends WorkspaceSummaryV1 {
  readonly schemaVersion: 1;
  readonly kind: 'workspace-show';
  readonly projectId: string;
  readonly portResolution: 'valid' | 'missing' | 'invalid' | 'stale';
  readonly services: readonly WorkspaceServiceV1[];
  readonly diagnostics: readonly WorkspaceDiagnosticV1[];
}
export interface WorkspaceMutationResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'workspace-mutation';
  readonly operation: 'create' | 'remove';
  readonly status: string;
  readonly path: string | null;
}
export interface WorkspaceServiceResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'workspace-service';
  readonly path: string;
  readonly service: Pick<WorkspaceServiceV1, 'id' | 'managed' | 'state' | 'pid'>;
}

interface LeaseView {
  readonly leaseId?: string;
  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly ownerRoot?: string;
  readonly role?: 'main' | 'linked';
  readonly services: Readonly<Record<string, number>>;
}
interface WorkspaceDevService {
  readonly runtimeKind?: ExecutorKind;
  start(request: StartRequest): Promise<DevServiceSnapshot>;
  status(id?: string): Promise<DevServiceSnapshot | readonly DevServiceSnapshot[] | undefined>;
  logs(id: string, options?: { maxLines?: number; maxCharacters?: number }): Promise<string>;
  restart(id: string, replacementRequest?: StartRequest): Promise<DevServiceSnapshot>;
  stop(id: string): Promise<DevServiceSnapshot>;
}
export interface WorkspaceApplicationDependencies {
  readonly path: {
    resolve(...parts: string[]): string;
    equals(left: string, right: string): boolean;
    contains(root: string, candidate: string): boolean;
  };
  readonly worktrees: {
    reconcile(request: { cwd: string; orphanApproval?: string }): Promise<unknown>;
    list(request: { cwd: string }): Promise<readonly WorktreeInventoryEntry[]>;
    create(request: CreateWorktreeRequest): Promise<LifecycleResult>;
    remove(request: { cwd: string; worktreePath: string }): Promise<LifecycleResult>;
  };
  readonly ports: {
    list(): Promise<readonly LeaseView[]>;
    reconcile?(request: { cwd: string; orphanPolicy?: 'release' | 'report' }): Promise<unknown>;
    ensure?(request: {
      cwd: string;
      projectRoot: string;
      config: ProjectConfig;
      configHash: string;
    }): Promise<unknown>;
    resolve(request: {
      cwd: string;
      projectRoot: string;
      config: ProjectConfig;
      configHash: string;
    }): Promise<LeaseView>;
    kill(pid: number): Promise<void>;
  };
  readonly projects: { discover(cwd: string): Promise<{ root: string; config: ProjectConfig }> };
  readonly status: {
    snapshot(request: {
      cwd: string;
      projectRoot: string;
      config: ProjectConfig;
      configHash: string;
    }): Promise<StatusSnapshotV1>;
  };
  readonly services: {
    forWorkspace(root: string): Promise<WorkspaceDevService> | WorkspaceDevService;
  };
  readonly executor: ExecutorKind;
  readonly resolvePackageInvocation?: (
    manager: 'auto' | 'pnpm' | 'yarn' | 'npm' | 'bun',
    cwd: string,
  ) => Promise<{
    readonly executable: string;
    readonly prefixArguments: readonly string[];
    /** Node composition sets this only after fixed-candidate executable resolution. */
    readonly trustedAbsoluteExecutable?: true;
  }>;
}

const secret =
  /(?:[A-Za-z]:[\\/][^\s,;]+|\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+|\b[A-Za-z_][A-Za-z0-9_]{0,63}\s*=\s*[^\s]+)/giu;
function diagnostic(error: unknown): WorkspaceDiagnosticV1 {
  return {
    code: error instanceof MpxError ? error.code : 'WORKSPACE_RECOVERY_FAILED',
    severity: 'warning',
    message: (error instanceof Error ? error.message : String(error))
      .replace(secret, '[redacted]')
      .replace(/[\r\n\t]+/gu, ' ')
      .slice(0, 256),
  };
}
function assertSchema(request: { readonly schemaVersion: number }): void {
  if (request.schemaVersion !== 1) {
    throw new MpxError({
      code: 'SCHEMA_VERSION_UNSUPPORTED',
      message: 'Only workspace application schema version 1 is supported.',
    });
  }
}
function recoveryInvalid(): MpxError {
  return new MpxError({
    code: 'WORKSPACE_RECOVERY_INVALID',
    message: 'Workspace orphan recovery returned an invalid or unbounded result.',
  });
}
function orphanApproval(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const value = result as { orphaned?: unknown; expectedApproval?: unknown };
  if (value.orphaned === undefined) {
    return undefined;
  }
  if (!Array.isArray(value.orphaned)) {
    throw recoveryInvalid();
  }
  if (value.orphaned.length === 0) {
    return undefined;
  }
  if (value.orphaned.length > 128 || typeof value.expectedApproval !== 'string') {
    throw recoveryInvalid();
  }
  let encoded: string;
  let generated: string;
  try {
    encoded = JSON.stringify(value.orphaned);
    generated = `APPROVE WORKTREE ORPHAN RELEASE ${sha256Canonical(value.orphaned as JsonValue)}`;
  } catch {
    throw recoveryInvalid();
  }
  if (encoded.length > 65_536 || value.expectedApproval !== generated) {
    throw recoveryInvalid();
  }
  return value.expectedApproval;
}
function assertOrphansResolved(result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw recoveryInvalid();
  }
  const orphaned = (result as { orphaned?: unknown }).orphaned;
  if (orphaned !== undefined && (!Array.isArray(orphaned) || orphaned.length !== 0)) {
    throw recoveryInvalid();
  }
}
function blocked(error: unknown): never {
  throw new MpxError({
    code: 'WORKSPACE_RECOVERY_BLOCKED',
    message: 'Workspace recovery must succeed before mutation.',
    details: { recoveryCode: error instanceof MpxError ? error.code : 'WORKSPACE_RECOVERY_FAILED' },
  });
}
function singleStatus(
  value: DevServiceSnapshot | readonly DevServiceSnapshot[] | undefined,
): DevServiceSnapshot | undefined {
  return Array.isArray(value) ? undefined : (value as DevServiceSnapshot | undefined);
}
function publicSnapshot(
  snapshot: Partial<DevServiceSnapshot> & { id: string; state: string },
): Pick<WorkspaceServiceV1, 'id' | 'managed' | 'state' | 'pid'> {
  return { id: snapshot.id, managed: true, state: snapshot.state, pid: snapshot.pid ?? null };
}

/** Provider-neutral orchestration boundary for all public workspace operations. */
export class WorkspaceApplicationService {
  constructor(private readonly dependencies: WorkspaceApplicationDependencies) {}

  private async recover(
    cwd: string,
    tolerate: boolean,
    resolvePorts = true,
    statusPass = true,
  ): Promise<readonly WorkspaceDiagnosticV1[]> {
    const diagnostics: WorkspaceDiagnosticV1[] = [];
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch (error) {
        if (!tolerate) {
          blocked(error);
        }
        diagnostics.push(diagnostic(error));
        return undefined;
      }
    };
    await attempt(async () => {
      const first = await this.dependencies.worktrees.reconcile({ cwd });
      const approval = orphanApproval(first);
      if (approval !== undefined) {
        const second = await this.dependencies.worktrees.reconcile({
          cwd,
          orphanApproval: approval,
        });
        assertOrphansResolved(second);
      }
    });
    if (this.dependencies.ports.reconcile) {
      await attempt(() => this.dependencies.ports.reconcile!({ cwd, orphanPolicy: 'report' }));
    }
    const found = await attempt(() => this.dependencies.projects.discover(cwd));
    if (found && typeof found === 'object' && 'root' in found && 'config' in found) {
      const project = found as { root: string; config: ProjectConfig };
      const configHash = sha256Canonical(project.config as unknown as JsonValue);
      await attempt(async () => {
        if (resolvePorts) {
          await this.dependencies.ports.resolve({
            cwd,
            projectRoot: project.root,
            config: project.config,
            configHash,
          });
        }
        if (statusPass) {
          await this.dependencies.status.snapshot({
            cwd,
            projectRoot: project.root,
            config: project.config,
            configHash,
          });
        }
      });
    }
    return diagnostics.slice(0, 32);
  }

  private async inventory(cwd: string) {
    const [worktrees, leases] = await Promise.all([
      this.dependencies.worktrees.list({ cwd }),
      this.dependencies.ports.list(),
    ]);
    return worktrees.map((item, index): WorkspaceSummaryV1 => {
      const lease = leases.find(
        (candidate) =>
          candidate.worktreePath !== undefined &&
          this.dependencies.path.equals(candidate.worktreePath, item.path),
      );
      return {
        path: item.path,
        worktreeId: lease?.worktreeId ?? null,
        leaseId: lease?.leaseId ?? null,
        branch: item.branch ?? null,
        head: item.head ?? null,
        role: lease?.role ?? (index === 0 ? 'main' : 'linked'),
        ports: Object.freeze({ ...lease?.services }),
      };
    });
  }

  async list(request: WorkspaceRequestV1): Promise<WorkspaceListResultV1> {
    assertSchema(request);
    const diagnostics = await this.recover(request.cwd, true);
    return {
      schemaVersion: 1,
      kind: 'workspace-list',
      workspaces: await this.inventory(request.cwd),
      diagnostics,
    };
  }

  async show(request: WorkspaceShowRequestV1): Promise<WorkspaceShowResultV1> {
    assertSchema(request);
    const diagnostics = [...(await this.recover(request.cwd, true, false, false))];
    const inventory = await this.inventory(request.cwd);
    const requested = this.dependencies.path.resolve(request.path ?? request.cwd);
    const workspace = request.path
      ? inventory.find((item) => this.dependencies.path.equals(item.path, requested))
      : inventory
          .filter((item) =>
            this.dependencies.path.contains(this.dependencies.path.resolve(item.path), requested),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];
    if (!workspace) {
      throw new MpxError({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'The requested path is not a reported Git worktree.',
      });
    }
    const found = await this.dependencies.projects.discover(workspace.path);
    let snapshot: StatusSnapshotV1;
    try {
      snapshot = await this.dependencies.status.snapshot({
        cwd: workspace.path,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
    } catch (error) {
      diagnostics.push(diagnostic(error));
      snapshot = {
        schemaVersion: 1,
        project: { id: found.config.project.id, cwd: workspace.path },
        worktree: {
          id: null,
          path: workspace.path,
          role: workspace.role,
          branch: workspace.branch,
        },
        portResolution: 'invalid',
        services: [],
        diagnostics: [],
      };
    }
    let lease: LeaseView | undefined;
    try {
      lease = await this.dependencies.ports.resolve({
        cwd: workspace.path,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
    } catch (error) {
      diagnostics.push(diagnostic(error));
    }
    const managerGroups: Array<{
      root: string;
      serviceIds: string[];
      snapshots: readonly DevServiceSnapshot[];
    }> = [];
    for (const [id, definition] of Object.entries(found.config.development?.services ?? {})) {
      if (definition.start.type !== 'package-script') {
        continue;
      }
      const root = definition.scope === 'project' ? lease?.ownerRoot : workspace.path;
      if (!root) {
        diagnostics.push(
          diagnostic(
            new MpxError({
              code: 'WORKSPACE_OWNER_ROOT_REQUIRED',
              message: 'Project-scoped service owner is unavailable.',
            }),
          ),
        );
        continue;
      }
      const existing = managerGroups.find((group) =>
        this.dependencies.path.equals(group.root, root),
      );
      if (existing) {
        existing.serviceIds.push(id);
      } else {
        managerGroups.push({ root, serviceIds: [id], snapshots: [] });
      }
    }
    for (const group of managerGroups) {
      try {
        const manager = await this.dependencies.services.forWorkspace(group.root);
        const value = await manager.status();
        group.snapshots = Array.isArray(value) ? value : value ? [value as DevServiceSnapshot] : [];
      } catch (error) {
        diagnostics.push(diagnostic(error));
      }
    }
    const services = Object.entries(found.config.development?.services ?? {}).map(
      ([id, definition]): WorkspaceServiceV1 => {
        const status = snapshot.services.find((item) => item.id === id);
        const process = managerGroups
          .find((group) => group.serviceIds.includes(id))
          ?.snapshots.find((item) => item.id === id);
        const isManaged = definition.start.type === 'package-script';
        return {
          id,
          configured: true,
          managed: isManaged,
          scope: definition.scope,
          state: isManaged ? (process?.state ?? 'stopped') : definition.start.type,
          port: status?.port ?? workspace.ports[id] ?? null,
          listening: status?.listening ?? false,
          conflict: status?.conflict ?? 'unknown',
          pid: isManaged ? (process?.pid ?? null) : (status?.pid ?? null),
        };
      },
    );
    diagnostics.push(
      ...snapshot.diagnostics.slice(0, 32).map((item) => ({
        code: item.code,
        severity: item.severity === 'error' ? ('error' as const) : ('warning' as const),
        message: item.message.replace(secret, '[redacted]').slice(0, 256),
      })),
    );
    return {
      schemaVersion: 1,
      kind: 'workspace-show',
      ...workspace,
      projectId: found.config.project.id,
      portResolution: snapshot.portResolution,
      services,
      diagnostics: diagnostics.slice(0, 32),
    };
  }

  async create(request: WorkspaceCreateRequestV1): Promise<WorkspaceMutationResultV1> {
    assertSchema(request);
    await this.recover(request.cwd, false, false);
    if (this.dependencies.ports.ensure) {
      const found = await this.dependencies.projects.discover(request.cwd);
      await this.dependencies.ports.ensure({
        cwd: request.cwd,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
    }
    const { schemaVersion: _schemaVersion, ...lifecycle } = request;
    const result = await this.dependencies.worktrees.create(lifecycle);
    return {
      schemaVersion: 1,
      kind: 'workspace-mutation',
      operation: 'create',
      status: result.status,
      path: result.worktreePath ?? null,
    };
  }

  async remove(request: WorkspaceRemoveRequestV1): Promise<WorkspaceMutationResultV1> {
    assertSchema(request);
    await this.recover(request.cwd, false);
    const target = this.dependencies.path.resolve(request.path);
    const inventory = await this.inventory(request.cwd);
    const workspace = inventory.find(
      (item) => this.dependencies.path.equals(item.path, target) && item.role === 'linked',
    );
    if (!workspace) {
      throw new MpxError({
        code: 'WORKSPACE_REMOVE_TARGET_INVALID',
        message: 'Removal requires an exact linked worktree from repository inventory.',
      });
    }
    const found = await this.dependencies.projects.discover(workspace.path);
    const manager = await this.dependencies.services.forWorkspace(workspace.path);
    if (!manager.runtimeKind || manager.runtimeKind !== this.dependencies.executor) {
      throw new MpxError({
        code: manager.runtimeKind ? 'DEV_EXECUTOR_BINDING_INVALID' : 'DEV_EXECUTOR_UNSUPPORTED',
        message: 'Development-service manager does not match the runtime executor binding.',
      });
    }
    const status = await manager.status();
    const active = Array.isArray(status) ? status : status ? [status as DevServiceSnapshot] : [];
    for (const [id, definition] of Object.entries(found.config.development?.services ?? {})) {
      if (
        definition.scope === 'checkout' &&
        definition.start.type === 'package-script' &&
        active.some(
          (item) => item.id === id && item.state !== 'stopped' && item.state !== 'crashed',
        )
      ) {
        await manager.stop(id);
      }
    }
    const result = await this.dependencies.worktrees.remove({
      cwd: request.cwd,
      worktreePath: workspace.path,
    });
    return {
      schemaVersion: 1,
      kind: 'workspace-mutation',
      operation: 'remove',
      status: result.status,
      path: workspace.path,
    };
  }

  private async serviceContext(request: WorkspaceServiceRequestV1, tolerateRecovery = false) {
    assertSchema(request);
    await this.recover(request.cwd, tolerateRecovery);
    const inventory = await this.inventory(request.cwd);
    const requested = this.dependencies.path.resolve(request.path ?? request.cwd);
    const workspace = request.path
      ? inventory.find((item) => this.dependencies.path.equals(item.path, requested))
      : inventory
          .filter((item) =>
            this.dependencies.path.contains(this.dependencies.path.resolve(item.path), requested),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];
    if (!workspace) {
      throw new MpxError({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'Service path must exactly select a reported Git worktree.',
      });
    }
    const found = await this.dependencies.projects.discover(workspace.path);
    const configured = found.config.development?.services[request.serviceId];
    if (!configured) {
      throw new MpxError({
        code: 'WORKSPACE_SERVICE_UNKNOWN',
        message: `Unknown configured service '${request.serviceId}'.`,
      });
    }
    if (configured.start.type !== 'package-script') {
      throw new MpxError({
        code: 'WORKSPACE_SERVICE_UNMANAGED',
        message: `Service '${request.serviceId}' is not managed by MPX.`,
      });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(configured.start.script)) {
      throw new MpxError({
        code: 'WORKSPACE_SERVICE_INVALID',
        message: 'The configured package script is invalid.',
      });
    }
    let lease: LeaseView | undefined;
    if (configured.scope === 'project') {
      lease = await this.dependencies.ports.resolve({
        cwd: workspace.path,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      });
      if (!lease.ownerRoot) {
        throw new MpxError({
          code: 'WORKSPACE_OWNER_ROOT_REQUIRED',
          message: 'Project-scoped service owner is unavailable.',
        });
      }
    }
    const managerRoot = configured.scope === 'project' ? lease!.ownerRoot! : workspace.path;
    const manager = await this.dependencies.services.forWorkspace(managerRoot);
    if (!manager.runtimeKind) {
      throw new MpxError({
        code: 'DEV_EXECUTOR_UNSUPPORTED',
        message: 'No development-service manager is bound to the selected executor.',
      });
    }
    if (manager.runtimeKind !== this.dependencies.executor) {
      throw new MpxError({
        code: 'DEV_EXECUTOR_BINDING_INVALID',
        message: 'Development-service manager does not match the runtime executor binding.',
      });
    }
    return { found, workspace, configured, script: configured.start.script, manager, lease };
  }

  async start(request: WorkspaceServiceRequestV1): Promise<WorkspaceServiceResultV1> {
    const {
      found,
      workspace,
      configured,
      script,
      manager,
      lease: contextLease,
    } = await this.serviceContext(request);
    const current = singleStatus(await manager.status(request.serviceId));
    if (current && (current.state === 'ready' || current.state === 'starting')) {
      return {
        schemaVersion: 1,
        kind: 'workspace-service',
        path: workspace.path,
        service: publicSnapshot(current),
      };
    }
    const lease =
      contextLease ??
      (await this.dependencies.ports.resolve({
        cwd: workspace.path,
        projectRoot: found.root,
        config: found.config,
        configHash: sha256Canonical(found.config as unknown as JsonValue),
      }));
    const port = lease.services[request.serviceId];
    if (port === undefined) {
      throw new MpxError({
        code: 'WORKSPACE_PORT_UNASSIGNED',
        message: 'The configured service has no assigned port.',
      });
    }
    const managerName = found.config.tooling?.packageManager ?? 'auto';
    if (managerName === 'none') {
      throw new MpxError({
        code: 'WORKSPACE_PACKAGE_MANAGER_REQUIRED',
        message: 'A package manager is required.',
      });
    }
    const environment: Record<string, string> = {};
    for (const [id, service] of Object.entries(found.config.development?.services ?? {})) {
      if (service.environmentVariable && lease.services[id] !== undefined) {
        environment[service.environmentVariable] =
          `${service.protocol ?? 'http'}://localhost:${lease.services[id]}`;
      }
    }
    const cwd = configured.scope === 'project' ? lease.ownerRoot : workspace.path;
    if (!cwd) {
      throw new MpxError({
        code: 'WORKSPACE_OWNER_ROOT_REQUIRED',
        message: 'Project-scoped service owner is unavailable.',
      });
    }
    const invocation = this.dependencies.resolvePackageInvocation
      ? await this.dependencies.resolvePackageInvocation(managerName, cwd)
      : {
          executable: managerName === 'auto' ? 'npm' : managerName,
          prefixArguments: [] as readonly string[],
        };
    const startRequest: StartRequest = {
      id: request.serviceId,
      executable: invocation.executable,
      ...(invocation.trustedAbsoluteExecutable === true
        ? { trustedAbsoluteExecutable: true as const }
        : {}),
      args: [...invocation.prefixArguments, 'run', script],
      cwd,
      ports: [port],
      assignment: { worktreeRoot: cwd, ports: [port] },
      executor: this.dependencies.executor,
      environment,
    };
    const next = current
      ? await manager.restart(request.serviceId, startRequest)
      : await manager.start(startRequest);
    return {
      schemaVersion: 1,
      kind: 'workspace-service',
      path: workspace.path,
      service: publicSnapshot(next),
    };
  }

  async stop(request: WorkspaceServiceRequestV1): Promise<WorkspaceServiceResultV1> {
    const { workspace, manager } = await this.serviceContext(request, true);
    const current = singleStatus(await manager.status(request.serviceId));
    if (!current || current.state === 'stopped' || current.state === 'crashed') {
      return {
        schemaVersion: 1,
        kind: 'workspace-service',
        path: workspace.path,
        service: { id: request.serviceId, managed: true, state: 'stopped', pid: null },
      };
    }
    return {
      schemaVersion: 1,
      kind: 'workspace-service',
      path: workspace.path,
      service: publicSnapshot(await manager.stop(request.serviceId)),
    };
  }

  async logs(request: WorkspaceLogsRequestV1): Promise<{
    schemaVersion: 1;
    kind: 'workspace-service-logs';
    path: string;
    serviceId: string;
    text: string;
  }> {
    const { workspace, manager } = await this.serviceContext(request, true);
    const lines = Math.min(500, Math.max(1, request.lines ?? 200));
    const current = singleStatus(await manager.status(request.serviceId));
    return {
      schemaVersion: 1,
      kind: 'workspace-service-logs',
      path: workspace.path,
      serviceId: request.serviceId,
      text: current
        ? await manager.logs(request.serviceId, { maxLines: lines, maxCharacters: 20_000 })
        : '',
    };
  }

  async killPort(
    request: PortKillRequestV1,
  ): Promise<{ schemaVersion: 1; kind: 'port-killed'; killed: true; pid: number }> {
    assertSchema(request);
    await this.dependencies.ports.kill(request.pid);
    return { schemaVersion: 1, kind: 'port-killed', killed: true, pid: request.pid };
  }
}
