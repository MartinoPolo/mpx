import { MpxError } from '@mpx/core';
import type {
  Identity,
  NativeVerifiedResumeSeed,
  ResumeDependencies,
  ResumePlan,
  SessionInventoryResult,
  SessionListFilter,
  SessionRecord,
  SessionReconcileScope,
  SessionResurrectionExport,
} from '@mpx/sessions';

export type SessionDiscoveryScope = SessionReconcileScope;

export interface SessionOperations {
  list(filter?: SessionListFilter): Promise<SessionRecord[]>;
  show(id: string): Promise<SessionRecord>;
  reconcile(
    bindingIds: readonly string[],
    scope?: SessionReconcileScope,
  ): Promise<SessionInventoryResult>;
}

export interface SessionNativeBindingOperations {
  listLifecycleBindingIds(): Promise<readonly string[]>;
}

export interface SessionListDiagnostic {
  readonly runtime: 'claude' | 'pi' | null;
  readonly identity: Identity | null;
  readonly status: 'unavailable' | 'malformed' | 'unknown';
  readonly code: string;
}

export interface SessionApplicationDependencies {
  readonly sessions: SessionOperations;
  readonly nativeBindings: SessionNativeBindingOperations;
  readonly projectResurrectionRecord: (
    record: SessionRecord & { readonly launch: NonNullable<SessionRecord['launch']> },
  ) => SessionResurrectionExport['records'][number];
  readonly planResume: (
    record: SessionRecord,
    dependencies: ResumeDependencies,
  ) => Promise<NativeVerifiedResumeSeed>;
  readonly planCurrentResume: (seed: NativeVerifiedResumeSeed) => Promise<ResumePlan>;
  readonly verifyResumeConfirmation: (plan: ResumePlan, confirmation: string) => void;
  readonly resumeDependencies?: (record: SessionRecord) => Promise<ResumeDependencies>;
  readonly executeConfirmedResume?: (
    plan: ResumePlan,
    execution: { readonly approveHost?: boolean },
  ) => Promise<unknown>;
}

export interface SessionApplication {
  list(request?: { filter?: SessionListFilter; limit?: number }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: 'session-list';
    readonly records: readonly SessionRecord[];
    readonly diagnostics: readonly SessionListDiagnostic[];
  }>;
  resurrectionExport(): Promise<SessionResurrectionExport>;
  resume(request: {
    id: string;
    confirmation?: string;
    dryRun?: boolean;
    approveResurrection?: boolean;
  }): Promise<unknown>;
}

const applicationError = (code: string, message: string): MpxError =>
  new MpxError({ code, message });

export class SessionApplicationService implements SessionApplication {
  readonly #dependencies: SessionApplicationDependencies;
  readonly #sessions: SessionOperations;

  constructor(dependencies: SessionApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#sessions = dependencies.sessions;
  }

  async list(request: { filter?: SessionListFilter; limit?: number } = {}) {
    const diagnostics: SessionListDiagnostic[] = [];
    const scope: SessionDiscoveryScope | undefined = request.filter
      ? {
          ...(request.filter.runtime !== undefined ? { runtime: request.filter.runtime } : {}),
          ...(request.filter.identity !== undefined ? { identity: request.filter.identity } : {}),
        }
      : undefined;
    let bindingIds: readonly string[] = [];
    try {
      bindingIds = await this.#dependencies.nativeBindings.listLifecycleBindingIds();
    } catch {
      diagnostics.push({
        runtime: scope?.runtime ?? null,
        identity: scope?.identity ?? null,
        status: 'unavailable',
        code: 'SESSION_LIFECYCLE_ENUMERATION_UNAVAILABLE',
      });
    }
    let inventory: SessionInventoryResult;
    try {
      inventory = await this.#sessions.reconcile(bindingIds, scope);
      diagnostics.push(...inventory.diagnostics);
    } catch {
      inventory = { records: [], diagnostics: [] };
      diagnostics.push({
        runtime: scope?.runtime ?? null,
        identity: scope?.identity ?? null,
        status: 'unknown',
        code: 'SESSION_INVENTORY_SOURCE_UNKNOWN',
      });
    }
    const records = inventory.records
      .filter(
        (record) =>
          request.filter?.liveness === undefined || record.liveness === request.filter.liveness,
      )
      .filter(
        (record) =>
          request.filter?.workflowStatus === undefined ||
          record.workflow.status === request.filter.workflowStatus,
      )
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .slice(0, request.limit);
    return {
      schemaVersion: 1 as const,
      kind: 'session-list' as const,
      records,
      diagnostics: diagnostics.slice(0, 128),
    };
  }

  async resurrectionExport(): Promise<SessionResurrectionExport> {
    const diagnostics: SessionListDiagnostic[] = [];
    let bindingIds: readonly string[] = [];
    try {
      bindingIds = await this.#dependencies.nativeBindings.listLifecycleBindingIds();
    } catch {
      diagnostics.push({
        runtime: null,
        identity: null,
        status: 'unavailable',
        code: 'SESSION_LIFECYCLE_ENUMERATION_UNAVAILABLE',
      });
    }
    let inventory: SessionInventoryResult;
    try {
      inventory = await this.#sessions.reconcile(bindingIds);
      diagnostics.push(...inventory.diagnostics);
    } catch {
      inventory = { records: [], diagnostics: [] };
      diagnostics.push({
        runtime: null,
        identity: null,
        status: 'unknown',
        code: 'SESSION_INVENTORY_SOURCE_UNKNOWN',
      });
    }
    const records = inventory.records
      .filter(
        (record): record is SessionRecord & { launch: NonNullable<SessionRecord['launch']> } =>
          record.launch !== null &&
          record.workflow.status !== 'completed' &&
          record.workflow.status !== 'abandoned',
      )
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .map(this.#dependencies.projectResurrectionRecord);
    return {
      schemaVersion: 2,
      kind: 'session-resurrection-export',
      records,
      diagnostics: diagnostics.slice(0, 128),
    };
  }

  async resume(request: {
    id: string;
    confirmation?: string;
    dryRun?: boolean;
    approveResurrection?: boolean;
  }) {
    if (!this.#dependencies.resumeDependencies || !this.#dependencies.planCurrentResume) {
      throw applicationError(
        'SESSION_RESUME_NOT_CONFIGURED',
        'Production resume dependencies are unavailable.',
      );
    }
    const initial = await this.#sessions.show(request.id);
    const planner = this.#dependencies.planResume;
    const lifecycleBindingId = initial.lifecycle?.bindingId ?? null;
    const inventory = await this.#sessions.reconcile(
      lifecycleBindingId === null ? [] : [lifecycleBindingId],
      {
        runtime: initial.runtime,
        identity: initial.identity,
        recordId: initial.recordId,
        ...(lifecycleBindingId === null ? {} : { lifecycleBindingId }),
      },
    );
    const current = inventory.records.find((record) => record.recordId === initial.recordId);
    if (!current) {
      throw applicationError('SESSION_NOT_FOUND', 'Session was not found after reconciliation.');
    }
    if (current.liveness === 'unknown') {
      throw applicationError(
        'SESSION_RESUME_LIVENESS_UNKNOWN',
        'Session liveness is unknown and cannot be resumed automatically.',
      );
    }
    const seed = await planner(current, await this.#dependencies.resumeDependencies(current));
    const replanned = await this.#dependencies.planCurrentResume(seed);
    if (request.confirmation !== undefined) {
      this.#dependencies.verifyResumeConfirmation(replanned, request.confirmation);
    }
    if (request.dryRun || (!request.approveResurrection && request.confirmation === undefined)) {
      return replanned;
    }
    if (
      request.approveResurrection &&
      request.confirmation === undefined &&
      replanned.approval.resurrection !== 'unchanged'
    ) {
      throw applicationError(
        'SESSION_RESUME_CONFIRMATION_REQUIRED',
        'Current launch evidence requires a fresh dry-run and explicit --confirm-plan confirmation.',
      );
    }
    this.#dependencies.verifyResumeConfirmation(
      replanned,
      request.confirmation ?? replanned.confirmationDigest,
    );
    if (!this.#dependencies.executeConfirmedResume) {
      throw applicationError(
        'SESSION_RESUME_EXECUTION_UNAVAILABLE',
        'Resume execution is unavailable.',
      );
    }
    return {
      schemaVersion: 1 as const,
      kind: 'session-resume' as const,
      result: await this.#dependencies.executeConfirmedResume(
        replanned,
        replanned.launch.executor.kind === 'host' ? { approveHost: true } : {},
      ),
    };
  }
}
