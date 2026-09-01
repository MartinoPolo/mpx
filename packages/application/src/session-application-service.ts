import { MpxError, sha256Canonical, type Diagnostic, type JsonValue } from '@mpx/core';
import type {
  BranchRequestV1,
  ConversationBranchPlanV1,
  IdentityV1,
  LegacyImportPlanV1,
  LegacyImportReceiptV1,
  NativeBindingRecordV1,
  ResumeDependencies,
  ResumePlanV1,
  RuntimeDiscovery,
  SessionListFilter,
  SessionRecordV1,
  WorkflowStatus,
} from '@mpx/sessions';

export interface SessionMarkOptions {
  readonly priority?: number | null;
  readonly nextAction?: string | null;
  readonly note?: string | null;
  readonly relatedIssue?: string | null;
  readonly relatedReview?: string | null;
}

export interface SessionDispositionRequest {
  readonly identity: IdentityV1;
  readonly runtime?: 'claude' | 'pi';
  readonly summary: string;
  readonly nextAction: string;
  readonly disposition: 'paused' | 'unfinished' | 'completed';
}

export interface SessionDiscoveryInput {
  readonly scanner: RuntimeDiscovery;
  readonly context?: {
    readonly identity: IdentityV1;
    readonly nativeBindingRef: string;
    readonly runtime: 'claude' | 'pi';
  };
}

export interface SessionOperations {
  list(filter?: SessionListFilter): Promise<SessionRecordV1[]>;
  show(id: string): Promise<SessionRecordV1>;
  inbox(): Promise<SessionRecordV1[]>;
  mark(id: string, status: WorkflowStatus, options?: SessionMarkOptions): Promise<SessionRecordV1>;
  capture(ids?: readonly string[]): Promise<unknown>;
  handoff(
    id: string,
    request: SessionDispositionRequest & { readonly disposition: 'paused' | 'unfinished' },
  ): Promise<unknown>;
  complete(id: string, request: SessionDispositionRequest): Promise<unknown>;
  reconcile(
    discoveries: readonly SessionDiscoveryInput[],
    bindingIds: readonly string[],
  ): Promise<unknown>;
}

export interface SessionNativeBindingOperations {
  readNativeBinding(ref: string): Promise<NativeBindingRecordV1>;
  listLifecycleBindingIds(): Promise<readonly string[]>;
}

export interface SessionBranchApplyResult {
  readonly writerLease: null | Readonly<{ owner: string; workspaceDigest: string }>;
  readonly [key: string]: unknown;
}

export interface SessionBranchOperations {
  plan(request: BranchRequestV1): Promise<ConversationBranchPlanV1>;
  apply(plan: ConversationBranchPlanV1, confirmation: string): Promise<SessionBranchApplyResult>;
}

const applicationError = (code: string, message: string): MpxError =>
  new MpxError({ code, message });

export interface SessionLegacyImportRequest {
  readonly sources: readonly string[];
  readonly accountMappings: readonly Readonly<{ source: string; identity: string }>[];
  readonly piRootMappings: readonly Readonly<{ identity: string; nativeRoot: string }>[];
  readonly confirmation?: string;
}

export interface SessionLegacyImport {
  plan(request: Omit<SessionLegacyImportRequest, 'confirmation'>): Promise<LegacyImportPlanV1>;
  import(plan: LegacyImportPlanV1, confirmation: string): Promise<LegacyImportReceiptV1>;
}

export interface SessionApplicationDependencies {
  readonly sessions: SessionOperations;
  readonly nativeBindings: SessionNativeBindingOperations;
  readonly consumePending: () => Promise<number>;
  readonly planResume: (
    record: SessionRecordV1,
    dependencies: ResumeDependencies,
  ) => Promise<ResumePlanV1>;
  readonly verifyResumeConfirmation: (plan: ResumePlanV1, confirmation: string) => void;
  readonly resumeDependencies?: (record: SessionRecordV1) => Promise<ResumeDependencies>;
  readonly executeConfirmedResume?: (plan: ResumePlanV1) => Promise<unknown>;
  readonly branchService?: SessionBranchOperations;
  readonly scheduledCaptureAuthority?: {
    inspect(): Promise<Readonly<{ installed: boolean; authorityDigest: string | null }>>;
  };
  readonly discoveries?: () => Promise<readonly SessionDiscoveryInput[]>;
  readonly legacyImport?: SessionLegacyImport;
  readonly resolveIdentity?: (name: string) => Promise<IdentityV1>;
}

declare const preparedSessionReconcileBrand: unique symbol;
export interface PreparedSessionReconcile {
  readonly [preparedSessionReconcileBrand]: true;
}

declare const preparedSessionBranchBrand: unique symbol;
export interface PreparedSessionBranch {
  readonly [preparedSessionBranchBrand]: true;
}

export interface BranchSessionRequest {
  readonly workspace?: 'default' | 'isolated' | 'shared';
  readonly intent?: 'read' | 'modify';
  readonly branch?: string;
  readonly terminal?: { readonly executable?: string; readonly title?: string };
  readonly acknowledgeSharedRisk?: boolean;
  readonly confirmation?: string;
  readonly dryRun?: boolean;
}

interface PreparedBranchState {
  readonly parent: SessionRecordV1 & { launch: NonNullable<SessionRecordV1['launch']> };
  readonly binding: NativeBindingRecordV1;
}

export interface SessionApplication {
  list(request?: { filter?: SessionListFilter; limit?: number }): Promise<unknown>;
  show(id: string): Promise<unknown>;
  inbox(request?: { runtime?: string; status?: string; limit?: number }): Promise<unknown>;
  mark(id: string, status: WorkflowStatus, options: SessionMarkOptions): Promise<unknown>;
  save(ids?: readonly string[]): Promise<{ readonly captures: unknown }>;
  handoff(
    id: string,
    request: SessionDispositionRequest & { readonly disposition: 'paused' | 'unfinished' },
  ): Promise<unknown>;
  complete(id: string, request: SessionDispositionRequest): Promise<unknown>;
  prepareReconcile(request: { captureScheduled?: boolean }): Promise<PreparedSessionReconcile>;
  reconcile(
    prepared: PreparedSessionReconcile,
    request: { legacy?: SessionLegacyImportRequest },
  ): Promise<{
    readonly data: unknown;
    readonly warnings: readonly Diagnostic[];
  }>;
  prepareBranch(parentId: string): Promise<PreparedSessionBranch>;
  branch(prepared: PreparedSessionBranch, request: BranchSessionRequest): Promise<unknown>;
  resume(request: { id: string; confirmation?: string; dryRun?: boolean }): Promise<unknown>;
  resolveIdentity(name: string): Promise<IdentityV1>;
}

export class SessionApplicationService implements SessionApplication {
  readonly #dependencies: SessionApplicationDependencies;
  readonly #sessions: SessionOperations;
  readonly #preparedReconciles = new WeakSet<object>();
  readonly #preparedBranches = new WeakMap<object, PreparedBranchState>();

  constructor(dependencies: SessionApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#sessions = dependencies.sessions;
  }

  consumePending(): Promise<number> {
    return this.#dependencies.consumePending();
  }

  async resolveIdentity(name: string): Promise<IdentityV1> {
    if (!this.#dependencies.resolveIdentity) {
      throw applicationError(
        'SESSION_IDENTITY_NOT_CONFIGURED',
        'Identity resolution is unavailable.',
      );
    }
    return this.#dependencies.resolveIdentity(name);
  }

  async list(request: { filter?: SessionListFilter; limit?: number } = {}) {
    await this.consumePending();
    const records = (await this.#sessions.list(request.filter)).slice(0, request.limit);
    return { schemaVersion: 1 as const, kind: 'session-list' as const, records };
  }

  async show(id: string) {
    await this.consumePending();
    return {
      schemaVersion: 1 as const,
      kind: 'session-show' as const,
      record: await this.#sessions.show(id),
    };
  }

  async inbox(request: { runtime?: string; status?: string; limit?: number } = {}) {
    await this.consumePending();
    const records = (await this.#sessions.inbox())
      .filter(
        (record) =>
          (!request.runtime || record.runtime === request.runtime) &&
          (!request.status || record.workflow.status === request.status),
      )
      .slice(0, request.limit);
    return { schemaVersion: 1 as const, kind: 'session-inbox' as const, records };
  }

  async mark(id: string, status: WorkflowStatus, options: SessionMarkOptions) {
    const record = await this.#sessions.mark(id, status, options);
    return { schemaVersion: 1 as const, kind: 'session-mark' as const, record };
  }

  async save(ids?: readonly string[]) {
    await this.consumePending();
    return {
      schemaVersion: 1 as const,
      kind: 'session-capture' as const,
      captures: await this.#sessions.capture(ids),
    };
  }

  async handoff(
    id: string,
    request: SessionDispositionRequest & { readonly disposition: 'paused' | 'unfinished' },
  ) {
    await this.consumePending();
    return this.#sessions.handoff(id, request);
  }

  async complete(id: string, request: SessionDispositionRequest) {
    await this.consumePending();
    return this.#sessions.complete(id, request);
  }

  async prepareReconcile(request: {
    captureScheduled?: boolean;
  }): Promise<PreparedSessionReconcile> {
    if (request.captureScheduled) {
      const authority = await this.#dependencies.scheduledCaptureAuthority
        ?.inspect()
        .catch(() => undefined);
      if (
        !authority?.installed ||
        !authority.authorityDigest ||
        !/^[a-f0-9]{64}$/u.test(authority.authorityDigest)
      ) {
        throw applicationError(
          'SESSION_SCHEDULED_CAPTURE_AUTHORITY_UNAVAILABLE',
          'Installed scheduled capture has no valid immutable runner authority.',
        );
      }
    }
    const token = Object.freeze({}) as PreparedSessionReconcile;
    this.#preparedReconciles.add(token);
    return token;
  }

  async reconcile(
    prepared: PreparedSessionReconcile,
    request: { legacy?: SessionLegacyImportRequest },
  ) {
    if (!this.#preparedReconciles.delete(prepared)) {
      throw applicationError(
        'SESSION_RECONCILE_PREPARATION_INVALID',
        'Prepared reconcile token is invalid or belongs to another application service.',
      );
    }
    let legacy: unknown = null;
    if (request.legacy) {
      const adapter = this.#dependencies.legacyImport;
      if (!adapter) {
        throw applicationError(
          'SESSION_LEGACY_IMPORT_NOT_CONFIGURED',
          'Legacy session import is unavailable.',
        );
      }
      const plan = await adapter.plan(request.legacy);
      legacy = request.legacy.confirmation
        ? await adapter.import(plan, request.legacy.confirmation)
        : plan;
    }
    const diagnostics: {
      runtime: 'claude' | 'pi';
      identity: IdentityV1 | null;
      status: 'available' | 'unavailable' | 'malformed';
      diagnostic: string | null;
    }[] = [];
    const configuredDiscoveries = this.#dependencies.discoveries;
    const discoveries = configuredDiscoveries ? await configuredDiscoveries() : [];
    const instrumented = discoveries.map((item) => ({
      ...item,
      scanner: {
        runtime: item.scanner.runtime,
        scan: async () => {
          const result = await item.scanner.scan();
          diagnostics.push({
            runtime: item.scanner.runtime,
            identity: item.context?.identity ?? null,
            status: result.status,
            diagnostic: result.diagnostic,
          });
          return result;
        },
      },
    }));
    const observations = await this.#sessions.reconcile(
      instrumented,
      await this.#dependencies.nativeBindings.listLifecycleBindingIds(),
    );
    const warnings: Diagnostic[] = diagnostics
      .filter((item) => item.diagnostic !== null)
      .map((item) => ({
        code: item.diagnostic!,
        message: 'Runtime session discovery was unavailable or malformed.',
        severity: 'warning',
      }));
    if (!configuredDiscoveries) {
      warnings.push({
        code: 'SESSION_DISCOVERY_UNAVAILABLE',
        message: 'Runtime discovery scanners are not configured.',
        severity: 'warning',
      });
    }
    return {
      data: {
        schemaVersion: 1 as const,
        kind: 'session-reconcile' as const,
        observations,
        diagnostics,
        captures: [] as never[],
        legacy,
      },
      warnings,
    };
  }

  async prepareBranch(parentId: string): Promise<PreparedSessionBranch> {
    if (!this.#dependencies.branchService) {
      throw applicationError(
        'SESSION_BRANCH_NOT_CONFIGURED',
        'Conversation branching is unavailable.',
      );
    }
    const parent = await this.#sessions.show(parentId);
    if (parent.launch === null) {
      throw applicationError(
        'SESSION_BRANCH_LAUNCH_UNBOUND',
        'The parent has no immutable launch identity.',
      );
    }
    const binding = await this.#dependencies.nativeBindings.readNativeBinding(
      parent.nativeBindingRef,
    );
    const token = Object.freeze({}) as PreparedSessionBranch;
    this.#preparedBranches.set(token, {
      parent: parent as SessionRecordV1 & { launch: NonNullable<SessionRecordV1['launch']> },
      binding,
    });
    return token;
  }

  async branch(prepared: PreparedSessionBranch, request: BranchSessionRequest): Promise<unknown> {
    const state = this.#preparedBranches.get(prepared);
    if (!state) {
      throw applicationError(
        'SESSION_BRANCH_PREPARATION_INVALID',
        'Prepared branch token is invalid or belongs to another application service.',
      );
    }
    const branchService = this.#dependencies.branchService!;
    const { parent, binding } = state;
    const selected = request.workspace ?? 'default';
    const branch = request.branch ?? `mpx/session-${parent.recordId}`;
    const childId = `${parent.runtime}:pending-${sha256Canonical({ parent: parent.runtimeQualifiedId, branch } as JsonValue).slice(0, 24)}`;
    const value: BranchRequestV1 = {
      schemaVersion: 1,
      parent: {
        runtimeQualifiedId: parent.runtimeQualifiedId,
        nativeSessionRef: parent.nativeSessionRef,
      },
      child: { runtimeQualifiedId: childId, runtime: parent.runtime },
      launchIdentity: {
        identity: parent.identity,
        rootDigest: binding.recordedRootDigest,
        nativeBindingRef: binding.ref,
        mode: parent.launch.mode,
        executor: parent.launch.executor.kind,
        skillPolicy: parent.launch.skillPolicy,
        contentScope: parent.launch.contentScope,
        workspace: parent.launch.workspace,
        networkPolicy: parent.launch.networkPolicy,
        grants: parent.launch.grants,
        artifactKey: parent.launch.artifactKey,
        manifestKey: parent.launch.manifestKey,
        launchKey: parent.launch.launchKey,
        descriptorDigest: parent.launch.descriptorDigest,
      },
      workspace: {
        selection: selected,
        intent: request.intent ?? 'modify',
        cwd: parent.location.cwd,
        projectRef: parent.location.project,
        repositoryRef: parent.location.repository,
        worktreeRef: parent.location.worktree,
        branch,
      },
      files: {
        sharing: selected === 'shared' ? 'shared' : 'isolated',
        collisionDisclosure:
          selected === 'shared'
            ? ['concurrent changes share the current checkout']
            : ['repository history and configured external services may still collide'],
        duplicateWriterRiskAcknowledged: request.acknowledgeSharedRisk === true,
      },
      terminal: request.terminal
        ? {
            enabled: true,
            ...(request.terminal.executable ? { executable: request.terminal.executable } : {}),
            title: request.terminal.title ?? `MPX ${childId}`,
          }
        : { enabled: false },
    };
    const plan = await branchService.plan(value);
    if (!request.confirmation || request.dryRun) {
      return plan;
    }
    const applied = await branchService.apply(plan, request.confirmation);
    return {
      ...applied,
      writerLease:
        applied.writerLease === null
          ? null
          : {
              owner: applied.writerLease.owner,
              workspaceDigest: applied.writerLease.workspaceDigest,
            },
    };
  }

  async resume(request: { id: string; confirmation?: string; dryRun?: boolean }) {
    if (!this.#dependencies.resumeDependencies) {
      throw applicationError(
        'SESSION_RESUME_NOT_CONFIGURED',
        'Production resume dependencies are unavailable.',
      );
    }
    const initial = await this.#sessions.show(request.id);
    const planner = this.#dependencies.planResume;
    await planner(initial, await this.#dependencies.resumeDependencies(initial));
    await this.consumePending();
    const current = await this.#sessions.show(request.id);
    const replanned = await planner(current, await this.#dependencies.resumeDependencies(current));
    if (request.confirmation === undefined || request.dryRun) {
      return replanned;
    }
    this.#dependencies.verifyResumeConfirmation(replanned, request.confirmation);
    if (!this.#dependencies.executeConfirmedResume) {
      throw applicationError(
        'SESSION_RESUME_EXECUTION_UNAVAILABLE',
        'Resume execution is unavailable.',
      );
    }
    return {
      schemaVersion: 1 as const,
      kind: 'session-resume' as const,
      result: await this.#dependencies.executeConfirmedResume(replanned),
    };
  }
}
