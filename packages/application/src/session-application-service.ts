import { MpxError } from '@mpx/core';
import type {
  IdentityV1,
  ResumeDependencies,
  ResumePlanV1,
  RuntimeDiscovery,
  SessionListFilter,
  SessionRecordV1,
  SessionResurrectionExportV1,
} from '@mpx/sessions';

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
  reconcile(
    discoveries: readonly SessionDiscoveryInput[],
    bindingIds: readonly string[],
  ): Promise<unknown>;
}

export interface SessionNativeBindingOperations {
  listLifecycleBindingIds(): Promise<readonly string[]>;
}

export interface SessionListDiagnostic {
  readonly runtime: 'claude' | 'pi' | null;
  readonly identity: IdentityV1 | null;
  readonly status: 'unavailable' | 'malformed';
  readonly code: 'SESSION_DISCOVERY_UNAVAILABLE' | 'SESSION_DISCOVERY_MALFORMED';
}

export interface SessionApplicationDependencies {
  readonly sessions: SessionOperations;
  readonly nativeBindings: SessionNativeBindingOperations;
  readonly consumePending: () => Promise<number>;
  readonly projectResurrectionRecord: (
    record: SessionRecordV1 & { readonly launch: NonNullable<SessionRecordV1['launch']> },
  ) => SessionResurrectionExportV1['records'][number];
  readonly planResume: (
    record: SessionRecordV1,
    dependencies: ResumeDependencies,
  ) => Promise<ResumePlanV1>;
  readonly verifyResumeConfirmation: (plan: ResumePlanV1, confirmation: string) => void;
  readonly resumeDependencies?: (record: SessionRecordV1) => Promise<ResumeDependencies>;
  readonly executeConfirmedResume?: (
    plan: ResumePlanV1,
    execution: { readonly approveHost?: boolean },
  ) => Promise<unknown>;
  readonly discoveries?: () => Promise<readonly SessionDiscoveryInput[]>;
}

export interface SessionApplication {
  list(request?: { filter?: SessionListFilter; limit?: number }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: 'session-list';
    readonly records: readonly SessionRecordV1[];
    readonly diagnostics: readonly SessionListDiagnostic[];
  }>;
  resurrectionExport(): Promise<SessionResurrectionExportV1>;
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
    await this.#dependencies.consumePending();
    const diagnostics: SessionListDiagnostic[] = [];
    let discoveries: readonly SessionDiscoveryInput[] = [];
    if (!this.#dependencies.discoveries) {
      diagnostics.push({
        runtime: null,
        identity: null,
        status: 'unavailable',
        code: 'SESSION_DISCOVERY_UNAVAILABLE',
      });
    } else {
      try {
        discoveries = await this.#dependencies.discoveries();
      } catch {
        diagnostics.push({
          runtime: null,
          identity: null,
          status: 'unavailable',
          code: 'SESSION_DISCOVERY_UNAVAILABLE',
        });
      }
    }
    const instrumented: SessionDiscoveryInput[] = [];
    for (const item of discoveries) {
      let result;
      try {
        result = await item.scanner.scan();
        if (result.status !== 'available') {
          diagnostics.push({
            runtime: item.scanner.runtime,
            identity: item.context?.identity ?? null,
            status: result.status,
            code:
              result.status === 'malformed'
                ? 'SESSION_DISCOVERY_MALFORMED'
                : 'SESSION_DISCOVERY_UNAVAILABLE',
          });
        }
      } catch {
        diagnostics.push({
          runtime: item.scanner.runtime,
          identity: item.context?.identity ?? null,
          status: 'unavailable',
          code: 'SESSION_DISCOVERY_UNAVAILABLE',
        });
        result = {
          status: 'unavailable' as const,
          sessions: [],
          diagnostic: 'SESSION_DISCOVERY_UNAVAILABLE',
        };
      }
      instrumented.push({
        ...item,
        scanner: { runtime: item.scanner.runtime, scan: async () => result },
      });
    }
    await this.#sessions.reconcile(
      instrumented,
      await this.#dependencies.nativeBindings.listLifecycleBindingIds(),
    );
    const records = (await this.#sessions.list(request.filter))
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .slice(0, request.limit);
    return {
      schemaVersion: 1 as const,
      kind: 'session-list' as const,
      records,
      diagnostics: diagnostics.slice(0, 128),
    };
  }

  async resurrectionExport(): Promise<SessionResurrectionExportV1> {
    await this.#dependencies.consumePending();
    const records = (await this.#sessions.list())
      .filter(
        (record): record is SessionRecordV1 & { launch: NonNullable<SessionRecordV1['launch']> } =>
          record.launch !== null &&
          record.workflow.status !== 'completed' &&
          record.workflow.status !== 'abandoned',
      )
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .map(this.#dependencies.projectResurrectionRecord);
    return { schemaVersion: 1, kind: 'session-resurrection-export', records };
  }

  async resume(request: {
    id: string;
    confirmation?: string;
    dryRun?: boolean;
    approveResurrection?: boolean;
  }) {
    if (!this.#dependencies.resumeDependencies) {
      throw applicationError(
        'SESSION_RESUME_NOT_CONFIGURED',
        'Production resume dependencies are unavailable.',
      );
    }
    const initial = await this.#sessions.show(request.id);
    const planner = this.#dependencies.planResume;
    await planner(initial, await this.#dependencies.resumeDependencies(initial));
    await this.#dependencies.consumePending();
    const current = await this.#sessions.show(request.id);
    const replanned = await planner(current, await this.#dependencies.resumeDependencies(current));
    const confirmation = request.approveResurrection
      ? replanned.confirmationDigest
      : request.confirmation;
    if (confirmation === undefined || request.dryRun) {
      return replanned;
    }
    this.#dependencies.verifyResumeConfirmation(replanned, confirmation);
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
        request.approveResurrection ? { approveHost: true } : {},
      ),
    };
  }
}
