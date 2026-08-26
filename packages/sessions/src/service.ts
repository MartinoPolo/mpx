import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  createRuntimeSessionObservationV1,
  parseSessionLifecycleEventV1,
  type RuntimeName,
  type RuntimeSessionObservationV1,
  type SessionLifecycleEventV1,
} from "@mpx/runtime-contracts";
import { SessionStore } from "./store.js";
import {
  SessionError,
  parseSessionRecordV1,
  stableDigest,
  type IdentityV1,
  type SessionCaptureV1,
  type SessionDispositionObservationV1,
  type SessionLiveness,
  type SessionRecordV1,
  type WorkflowStatus,
} from "./schemas.js";

export interface SessionListFilter {
  readonly identity?: IdentityV1;
  readonly runtime?: RuntimeName;
  readonly liveness?: SessionLiveness;
  readonly workflowStatus?: WorkflowStatus;
  readonly inbox?: boolean;
}
export interface DiscoveryResult {
  readonly status: "available" | "unavailable" | "malformed";
  readonly sessions: readonly DiscoveredSession[];
  readonly diagnostic: string | null;
}
export interface DiscoveredSession {
  readonly nativeSessionId: string;
  readonly nativeSessionRef: SessionRecordV1["nativeSessionRef"];
  readonly cwd: string;
  readonly title: string | null;
  readonly pid: number;
  readonly startFingerprint: string;
}
export interface RuntimeDiscovery {
  readonly runtime: RuntimeName;
  scan(): Promise<DiscoveryResult>;
}
export interface DiscoveryContext {
  readonly identity: IdentityV1;
  readonly nativeBindingRef: string;
  readonly runtime: RuntimeName;
}
export type ProcessInspection =
  | Readonly<{ status: "present"; pid: number; startFingerprint: string }>
  | Readonly<{ status: "absent" | "unknown" }>;
export interface SessionProcessInspector {
  inspect(pid: number): Promise<ProcessInspection>;
}

const now = (): string => new Date().toISOString();
const sameIdentity = (left: IdentityV1, right: IdentityV1): boolean =>
  left.domain === right.domain && left.name === right.name;
function idFor(
  identity: IdentityV1,
  runtime: RuntimeName,
  nativeId: string,
): string {
  return `${runtime}-${stableDigest({ identity, nativeId }).slice(0, 24)}`;
}
function activityLiveness(
  type: SessionLifecycleEventV1["type"],
): SessionLiveness {
  return type === "shutdown" ? "inactive" : "active";
}

export class SessionService {
  constructor(
    readonly store: SessionStore,
    private readonly clock: () => string = now,
    private readonly processInspector?: SessionProcessInspector,
  ) {}
  async save(record: SessionRecordV1): Promise<SessionRecordV1> {
    return this.store.put(parseSessionRecordV1(record));
  }
  async list(filter: SessionListFilter = {}): Promise<SessionRecordV1[]> {
    return (await this.store.partitions())
      .flatMap((partition) => partition.records)
      .filter(
        (record) =>
          filter.identity === undefined ||
          sameIdentity(record.identity, filter.identity),
      )
      .filter(
        (record) =>
          filter.runtime === undefined || record.runtime === filter.runtime,
      )
      .filter(
        (record) =>
          filter.liveness === undefined || record.liveness === filter.liveness,
      )
      .filter(
        (record) =>
          filter.workflowStatus === undefined ||
          record.workflow.status === filter.workflowStatus,
      )
      .filter(
        (record) =>
          filter.inbox === undefined || record.workflow.inbox === filter.inbox,
      );
  }
  async show(query: string): Promise<SessionRecordV1> {
    const records = await this.list();
    const exact = records.filter(
      (record) =>
        record.recordId === query || record.runtimeQualifiedId === query,
    );
    if (exact.length === 1) return exact[0]!;
    const abbreviated = records.filter(
      (record) =>
        record.recordId.startsWith(query) ||
        record.runtimeQualifiedId.startsWith(query),
    );
    if (abbreviated.length === 0)
      throw new SessionError("SESSION_NOT_FOUND", "session was not found");
    if (abbreviated.length > 1)
      throw new SessionError(
        "SESSION_AMBIGUOUS",
        "session abbreviation is ambiguous",
      );
    return abbreviated[0]!;
  }
  private async disposition(
    operation: "handoff" | "completion",
    query: string,
    input: Readonly<{
      identity: IdentityV1;
      runtime?: RuntimeName;
      summary: string;
      nextAction: string;
      disposition: "paused" | "unfinished" | "completed";
    }>,
  ): Promise<SessionDispositionObservationV1> {
    const records = await this.list({ identity: input.identity, ...(input.runtime ? { runtime: input.runtime } : {}) });
    const matches = records.filter(record =>
        record.recordId === query || record.runtimeQualifiedId === query ||
        record.recordId.startsWith(query) || record.runtimeQualifiedId.startsWith(query));
      if (matches.length === 0) {
        const outside = (await this.list()).some(record => record.recordId === query || record.runtimeQualifiedId === query || record.recordId.startsWith(query) || record.runtimeQualifiedId.startsWith(query));
        throw new SessionError(outside ? "SESSION_IDENTITY_MISMATCH" : "SESSION_NOT_FOUND", outside ? "session belongs to a different identity or runtime" : "session was not found");
      }
      if (matches.length > 1) throw new SessionError("SESSION_AMBIGUOUS", "session abbreviation is ambiguous");
      const found = matches[0]!;
      const eventId = stableDigest({
        operation,
        recordId: found.recordId,
        identity: found.identity,
        runtime: found.runtime,
        summary: input.summary,
        nextAction: input.nextAction,
        disposition: input.disposition,
      });
    return this.store.transaction(found.identity, found.runtime, registry => {
        const current = registry.records.find(record => record.recordId === found.recordId);
        if (!current) throw new SessionError("SESSION_NOT_FOUND", "session disappeared during disposition transaction");
        if (current.workflow.observationId === eventId && current.workflow.operation === operation && current.workflow.dispositionAt) {
          return { registry, result: {
            schemaVersion: 1 as const, kind: "session-disposition" as const, eventId, operation,
            disposition: input.disposition, occurredAt: current.workflow.dispositionAt,
            identity: current.identity, runtime: current.runtime, record: current,
          } };
        }
        const changedAt = this.clock();
        const changed = parseSessionRecordV1({
          ...current,
          workflow: {
            ...current.workflow,
            status: input.disposition,
            inbox: input.disposition === "unfinished",
            summary: input.summary,
            nextAction: input.nextAction,
            dispositionAt: changedAt,
            handedOffAt: operation === "handoff" ? changedAt : current.workflow.handedOffAt,
            completedAt: operation === "completion" && input.disposition === "completed" ? changedAt : current.workflow.completedAt,
            observationId: eventId,
            operation,
          },
          timestamps: { ...current.timestamps, updatedAt: changedAt },
        });
        return {
          registry: { ...registry, records: registry.records.map(record => record.recordId === changed.recordId ? changed : record) },
          result: {
            schemaVersion: 1 as const, kind: "session-disposition" as const, eventId, operation,
            disposition: input.disposition, occurredAt: changedAt,
            identity: changed.identity, runtime: changed.runtime, record: changed,
          },
        };
    });
  }
  async handoff(query: string, input: Readonly<{ identity: IdentityV1; runtime?: RuntimeName; summary: string; nextAction: string; disposition: "paused" | "unfinished" }>): Promise<SessionDispositionObservationV1> {
    return this.disposition("handoff", query, input);
  }
  async complete(query: string, input: Readonly<{ identity: IdentityV1; runtime?: RuntimeName; summary: string; nextAction: string; disposition: "paused" | "unfinished" | "completed" }>): Promise<SessionDispositionObservationV1> {
    return this.disposition("completion", query, input);
  }
  async mark(
    query: string,
    status: WorkflowStatus,
    options: { priority?: number | null; nextAction?: string | null; note?: string | null; relatedIssue?: string | null; relatedReview?: string | null } = {},
  ): Promise<SessionRecordV1> {
    const found = await this.show(query),
      changedAt = this.clock();
    return this.store.transaction(found.identity, found.runtime, (registry) => {
      const current = registry.records.find(
        (record) => record.recordId === found.recordId,
      );
      if (!current)
        throw new SessionError(
          "SESSION_NOT_FOUND",
          "session disappeared during mark transaction",
        );
      const inbox = status === "unfinished" || status === "needs-review";
      const changed = parseSessionRecordV1({
        ...current,
        workflow: {
          status,
          inbox,
          priority:
            options.priority === undefined
              ? current.workflow.priority
              : options.priority,
          nextAction: options.nextAction === undefined ? current.workflow.nextAction : options.nextAction,
          note: options.note === undefined ? current.workflow.note : options.note,
          relatedIssue: options.relatedIssue === undefined ? current.workflow.relatedIssue : options.relatedIssue,
          relatedReview: options.relatedReview === undefined ? current.workflow.relatedReview : options.relatedReview,
        },
        timestamps: { ...current.timestamps, updatedAt: changedAt },
      });
      return {
        registry: {
          ...registry,
          records: registry.records.map((record) =>
            record.recordId === changed.recordId ? changed : record,
          ),
        },
        result: changed,
      };
    });
  }
  async inbox(): Promise<SessionRecordV1[]> {
    return (await this.list({ inbox: true })).sort(
      (a, b) =>
        (a.workflow.priority ?? 9) - (b.workflow.priority ?? 9) ||
        b.timestamps.updatedAt.localeCompare(a.timestamps.updatedAt) ||
        a.recordId.localeCompare(b.recordId),
    );
  }
  async capture(selected?: readonly string[]): Promise<SessionCaptureV1[]> {
    const records = selected
      ? await Promise.all(selected.map((query) => this.show(query)))
      : await this.list({ liveness: "active" });
    const groups = new Map<string, SessionRecordV1[]>();
    for (const record of records) {
      const key = JSON.stringify([
        record.identity.domain,
        record.identity.name,
        record.runtime,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const result: SessionCaptureV1[] = [];
    for (const group of groups.values()) {
      const first = group[0]!;
      const capture: SessionCaptureV1 = {
        schemaVersion: 1,
        captureId: randomUUID(),
        identity: first.identity,
        runtime: first.runtime,
        recordIds: group.map((record) => record.recordId).sort(),
        createdAt: this.clock(),
      };
      await this.store.saveCapture(capture);
      result.push(capture);
    }
    return result;
  }
  async ingest(input: SessionLifecycleEventV1): Promise<SessionRecordV1> {
    const event = parseSessionLifecycleEventV1(input);
    const privateBinding = await this.store.readLifecycleBinding(
      event.bindingId,
    );
    if (Date.parse(this.clock()) >= Date.parse(privateBinding.binding.expiresAt))
      throw new SessionError(
        "SESSION_LIFECYCLE_BINDING_EXPIRED",
        "private lifecycle binding has expired",
      );
    if (
      privateBinding.binding.bindingId !== event.bindingId ||
      privateBinding.binding.runtime === undefined
    )
      throw new SessionError(
        "SESSION_BINDING_MISMATCH",
        "event and private lifecycle binding differ",
      );
    const nativeBinding = await this.store.readNativeBinding(
      privateBinding.nativeBindingRef,
    );
    if (
      nativeBinding.runtime !== privateBinding.binding.runtime ||
      privateBinding.binding.identityRef !==
        `${nativeBinding.identity.domain}:${nativeBinding.identity.name}`
    )
      throw new SessionError(
        "SESSION_BINDING_MISMATCH",
        "recorded lifecycle and native bindings differ",
      );
    if (
      privateBinding.nativeSessionRef !== null &&
      (event.nativeSessionRef.kind !== privateBinding.nativeSessionRef.kind ||
        event.nativeSessionRef.value !== privateBinding.nativeSessionRef.value)
    )
      throw new SessionError(
        "SESSION_BINDING_MISMATCH",
        "event native session does not match recorded binding",
      );
    const identity = nativeBinding.identity,
      runtime = nativeBinding.runtime,
      qualified = `${runtime}:${event.nativeSessionId}`,
      preboundRef = privateBinding.nativeSessionRef;
    return this.store.transaction(identity, runtime, (registry) => {
      const lifecycleBound = registry.records.find(
          (record) => record.lifecycle.bindingId === event.bindingId,
        ),
        resumeBound = preboundRef === null
          ? undefined
          : registry.records.find(
              (record) =>
                record.nativeSessionRef.kind === preboundRef.kind &&
                record.nativeSessionRef.value === preboundRef.value,
            ),
        initialRecordId = idFor(identity, runtime, event.nativeSessionId),
        current = lifecycleBound ?? resumeBound ?? registry.records.find(
          (record) => record.recordId === initialRecordId,
        ),
        recordId = current?.recordId ?? initialRecordId;
      if (
        current &&
        (current.runtimeQualifiedId !== qualified ||
          current.nativeSessionRef.kind !== event.nativeSessionRef.kind ||
          current.nativeSessionRef.value !== event.nativeSessionRef.value)
      )
        throw new SessionError(
          "SESSION_BINDING_MISMATCH",
          "event native session does not match the session already bound to this lifecycle",
        );
      if (registry.recentEventIds.includes(event.eventId)) {
        if (!current)
          throw new SessionError(
            "SESSION_REGISTRY_CORRUPT",
            "event receipt exists without its record",
          );
        return { registry, result: current };
      }
      const recentEventIds = [...registry.recentEventIds, event.eventId].slice(
        -512,
      );
      const sameOrderingDomain = current?.lifecycle.bindingId === event.bindingId;
      if (
        current &&
        sameOrderingDomain &&
        (event.sequence <= current.lifecycle.sequence ||
          (current.lifecycle.timestamp !== null &&
            event.timestamp < current.lifecycle.timestamp))
      )
        return { registry: { ...registry, recentEventIds }, result: current };
      const createdAt = current?.timestamps.createdAt ?? event.timestamp;
      const record = parseSessionRecordV1({
        schemaVersion: 1,
        recordId,
        runtimeQualifiedId: qualified,
        runtime,
        identity,
        nativeBindingRef: nativeBinding.ref,
        nativeSessionRef: current?.nativeSessionRef ?? event.nativeSessionRef,
        launch: privateBinding.launch,
        location: privateBinding.location,
        metadata: {
          title: event.title ?? current?.metadata.title ?? null,
          model: event.model ?? current?.metadata.model ?? null,
          effort: event.effort ?? current?.metadata.effort ?? null,
        },
        liveness: activityLiveness(event.type),
        process: {
          pid: event.pid,
          startFingerprint: event.startFingerprint,
        },
        workflow: current?.workflow ?? {
          status: "unfinished",
          inbox: true,
          nextAction: null,
          priority: null,
          note: null,
          relatedIssue: null,
          relatedReview: null,
        },
        resume: current?.resume ?? {
          state: "unknown",
          diagnostic: null,
          lastVerifiedAt: null,
          lastPlanDigest: null,
        },
        timestamps: {
          createdAt,
          updatedAt: event.timestamp,
          lastActivityAt:
            event.type === "shutdown"
              ? (current?.timestamps.lastActivityAt ?? null)
              : event.timestamp,
        },
        lifecycle: {
          bindingId: event.bindingId,
          sequence: event.sequence,
          timestamp: event.timestamp,
        },
      });
      const records = current
        ? registry.records.map((value) =>
            value.recordId === recordId ? record : value,
          )
        : [...registry.records, record];
      return {
        registry: { ...registry, records, recentEventIds },
        result: record,
      };
    });
  }
  async reconcile(
    discoveries: readonly {
      scanner: RuntimeDiscovery;
      context?: DiscoveryContext;
    }[],
    lifecycleBindingIds: readonly string[] = [],
  ): Promise<RuntimeSessionObservationV1[]> {
    const consumer = new LifecycleEventDirectoryConsumer(this.store, this);
    for (const bindingId of [...lifecycleBindingIds].sort())
      await consumer.consume(bindingId);
    const capturedAt = this.clock(),
      observations: RuntimeSessionObservationV1[] = [],
      observed = new Set<string>(),
      processVerified = new Set<string>(),
      lifecycleFactTimes = new Map<string, string>();
    if (this.processInspector) {
      for (const partition of (await this.store.partitions()).filter(
        (candidate) => candidate.runtime === "pi",
      )) {
        const inspections = new Map<string, Readonly<{ sampledPid: number; sampledStartFingerprint: string; inspection: ProcessInspection }>>();
        for (const record of partition.records) {
          if (
            (record.liveness !== "active" && record.liveness !== "unknown") ||
            record.process === null
          )
            continue;
          const key = `${record.identity.domain}\0${record.identity.name}\0${record.runtime}\0${record.recordId}`;
          lifecycleFactTimes.set(
            key,
            record.lifecycle.timestamp ?? record.timestamps.updatedAt,
          );
          inspections.set(record.recordId, {
            sampledPid: record.process.pid,
            sampledStartFingerprint: record.process.startFingerprint,
            inspection: await this.processInspector.inspect(record.process.pid),
          });
        }
        if (inspections.size === 0) continue;
        await this.store.transaction(partition.identity, "pi", (registry) => ({
          registry: {
            ...registry,
            records: registry.records.map((record) => {
              const sampled = inspections.get(record.recordId);
              if (
                !sampled ||
                record.process === null ||
                record.process.pid !== sampled.sampledPid ||
                record.process.startFingerprint !== sampled.sampledStartFingerprint
              ) return record;
              const inspection = sampled.inspection;
              const exact =
                inspection.status === "present" &&
                inspection.pid === sampled.sampledPid &&
                inspection.startFingerprint === sampled.sampledStartFingerprint;
              if (exact) {
                processVerified.add(
                  `${record.identity.domain}\0${record.identity.name}\0${record.runtime}\0${record.recordId}`,
                );
                return record.liveness === "active"
                  ? record
                  : parseSessionRecordV1({
                      ...record,
                      liveness: "active",
                      timestamps: { ...record.timestamps, updatedAt: capturedAt },
                    });
              }
              if (inspection.status === "absent") {
                processVerified.add(
                  `${record.identity.domain}\0${record.identity.name}\0${record.runtime}\0${record.recordId}`,
                );
                return parseSessionRecordV1({
                  ...record,
                  liveness: "inactive",
                  process: null,
                  timestamps: { ...record.timestamps, updatedAt: capturedAt },
                });
              }
              return parseSessionRecordV1({
                ...record,
                liveness: "unknown",
                timestamps: { ...record.timestamps, updatedAt: capturedAt },
              });
            }),
          },
          result: undefined,
        }));
      }
    }
    for (const item of discoveries) {
      const discovered = await item.scanner.scan();
      if (discovered.status === "available" && item.context) {
        if (item.context.runtime !== item.scanner.runtime)
          throw new SessionError(
            "SESSION_BINDING_MISMATCH",
            "discovery context runtime differs from scanner",
          );
        for (const session of discovered.sessions)
          await this.upsertDiscovery(session, item.context, capturedAt);
        const activeRefs = new Set(discovered.sessions.map(session => `${session.nativeSessionRef.kind}\0${session.nativeSessionRef.value}`));
        if (item.context.runtime === "claude") await this.store.transaction(item.context.identity, item.context.runtime, registry => ({
          registry: {
            ...registry,
            records: registry.records.map(record => record.nativeBindingRef === item.context!.nativeBindingRef && record.liveness === "active" && !activeRefs.has(`${record.nativeSessionRef.kind}\0${record.nativeSessionRef.value}`)
              ? parseSessionRecordV1({ ...record, liveness: "inactive", process: null, timestamps: { ...record.timestamps, updatedAt: capturedAt } })
              : record),
          },
          result: undefined,
        }));
      }
      const records = await this.list({
        runtime: item.scanner.runtime,
        ...(item.context ? { identity: item.context.identity } : {}),
      });
      for (const record of records) {
        const observationKey = `${record.identity.domain}\0${record.identity.name}\0${record.runtime}\0${record.recordId}`;
        if (observed.has(observationKey)) continue;
        observed.add(observationKey);
        observations.push(
          createRuntimeSessionObservationV1({
            runtime: record.runtime,
            identityRef: `${record.identity.domain}:${record.identity.name}`,
            runtimeQualifiedId: record.runtimeQualifiedId,
            displayId: record.recordId,
            title: record.metadata.title,
            resumeState:
              record.resume.state === "resumable"
                ? "resumable"
                : record.resume.state === "unavailable"
                  ? "not-resumable"
                  : "unknown",
            lifecycleState:
              record.liveness === "inactive" ? "shutdown" : record.liveness,
            workflowStatus: record.workflow.status,
            inbox: record.workflow.inbox,
            dispositionAt: record.workflow.dispositionAt ?? null,
            capturedAt:
              record.runtime === "pi" && !processVerified.has(observationKey)
                ? (lifecycleFactTimes.get(observationKey) ??
                  record.lifecycle.timestamp ??
                  record.timestamps.updatedAt)
                : capturedAt,
            freshUntil:
              record.runtime === "pi" && !processVerified.has(observationKey)
                ? (lifecycleFactTimes.get(observationKey) ??
                  record.lifecycle.timestamp ??
                  record.timestamps.updatedAt)
                : capturedAt,
            source: `sessions:${item.scanner.runtime}`,
            diagnostic: discovered.diagnostic,
          }),
        );
      }
    }
    for (const record of await this.list({ runtime: "pi" })) {
      const observationKey = `${record.identity.domain}\0${record.identity.name}\0${record.runtime}\0${record.recordId}`;
      if (observed.has(observationKey)) continue;
      observed.add(observationKey);
      observations.push(
        createRuntimeSessionObservationV1({
          runtime: record.runtime,
          identityRef: `${record.identity.domain}:${record.identity.name}`,
          runtimeQualifiedId: record.runtimeQualifiedId,
          displayId: record.recordId,
          title: record.metadata.title,
          resumeState:
            record.resume.state === "resumable"
              ? "resumable"
              : record.resume.state === "unavailable"
                ? "not-resumable"
                : "unknown",
          lifecycleState:
            record.liveness === "inactive" ? "shutdown" : record.liveness,
          workflowStatus: record.workflow.status,
          inbox: record.workflow.inbox,
          dispositionAt: record.workflow.dispositionAt ?? null,
          capturedAt: processVerified.has(observationKey)
            ? capturedAt
            : (lifecycleFactTimes.get(observationKey) ??
              record.lifecycle.timestamp ??
              record.timestamps.updatedAt),
          freshUntil: processVerified.has(observationKey)
            ? capturedAt
            : (lifecycleFactTimes.get(observationKey) ??
              record.lifecycle.timestamp ??
              record.timestamps.updatedAt),
          source: "sessions:lifecycle",
          diagnostic: record.resume.diagnostic,
        }),
      );
    }
    return observations;
  }
  private async upsertDiscovery(
    session: DiscoveredSession,
    context: DiscoveryContext,
    timestamp: string,
  ): Promise<void> {
    const nativeBinding = await this.store.readNativeBinding(
      context.nativeBindingRef,
    );
    if (
      nativeBinding.runtime !== context.runtime ||
      !sameIdentity(nativeBinding.identity, context.identity)
    )
      throw new SessionError(
        "SESSION_BINDING_MISMATCH",
        "discovery context does not match recorded native binding",
      );
    const recordId = idFor(
      context.identity,
      context.runtime,
      session.nativeSessionId,
    );
    await this.store.transaction(
      context.identity,
      context.runtime,
      (registry) => {
        const current = registry.records.find(
          (record) => record.recordId === recordId,
        );
        const record = parseSessionRecordV1({
          schemaVersion: 1,
          recordId,
          runtimeQualifiedId: `${context.runtime}:${session.nativeSessionId}`,
          runtime: context.runtime,
          identity: context.identity,
          nativeBindingRef: context.nativeBindingRef,
          nativeSessionRef: session.nativeSessionRef,
          launch: current?.launch ?? null,
          location: current?.location ?? {
            cwd: session.cwd,
            project: null,
            repository: null,
            worktree: null,
          },
          metadata: {
            title: session.title ?? current?.metadata.title ?? null,
            model: current?.metadata.model ?? null,
            effort: current?.metadata.effort ?? null,
          },
          liveness: "active",
          process: { pid: session.pid, startFingerprint: session.startFingerprint },
          workflow: current?.workflow ?? {
            status: "unfinished",
            inbox: true,
            nextAction: null,
            priority: null,
            note: null,
            relatedIssue: null,
            relatedReview: null,
          },
          resume: current?.resume ?? {
            state: "blocked",
            diagnostic: "SESSION_DISCOVERED_UNBOUND",
            lastVerifiedAt: null,
            lastPlanDigest: null,
          },
          timestamps: {
            createdAt: current?.timestamps.createdAt ?? timestamp,
            updatedAt: timestamp,
            lastActivityAt: timestamp,
          },
          lifecycle: current?.lifecycle ?? {
            bindingId: null,
            sequence: 0,
            timestamp: null,
          },
        });
        return {
          registry: {
            ...registry,
            records: current
              ? registry.records.map((value) =>
                  value.recordId === recordId ? record : value,
                )
              : [...registry.records, record],
          },
          result: undefined,
        };
      },
    );
  }
}

const lifecycleConsumption = new Map<string, Promise<void>>();
export class LifecycleEventDirectoryConsumer {
  constructor(
    private readonly store: SessionStore,
    private readonly service: SessionService,
    private readonly maxFiles = 1_000,
    private readonly maxBytes = 1024 * 1024,
    private readonly beforeDirectoryEnumeration?: () => Promise<void>,
  ) {}
  async consume(bindingId: string): Promise<number> {
    const key = this.store.eventDirectory(bindingId);
    const prior = lifecycleConsumption.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => turn);
    lifecycleConsumption.set(key, tail);
    await prior;
    try { return await this.consumeUnlocked(bindingId); }
    finally { release(); if (lifecycleConsumption.get(key) === tail) lifecycleConsumption.delete(key); }
  }
  private async consumeUnlocked(bindingId: string): Promise<number> {
    const directory = this.store.eventDirectory(bindingId);
    let names: string[];
    try {
      await this.beforeDirectoryEnumeration?.();
      if (!await this.store.validateEventDirectory(bindingId)) return 0;
      names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    if (names.length > this.maxFiles)
      throw new SessionError(
        "SESSION_EVENT_LIMIT",
        "event directory contains too many files",
      );
    let consumed = 0;
    for (const name of names) {
      if (!await this.store.validateEventDirectory(bindingId)) return consumed;
      const file = path.join(directory, name);
      let info;
      try { info = await lstat(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (info.isSymbolicLink() || !info.isFile() || info.size > this.maxBytes) {
        await this.quarantine(file, name, "SESSION_UNSAFE_EVENT");
        continue;
      }
      let raw: unknown;
      try { raw = await this.store.readBoundedRegularJson(file, this.maxBytes); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof SyntaxError) {
          await this.quarantine(file, name, "SESSION_EVENT_JSON_PARSE_FAILED");
          continue;
        }
        throw error;
      }
      let event: SessionLifecycleEventV1;
      try { event = parseSessionLifecycleEventV1(raw); }
      catch (error) {
        await this.quarantine(
          file,
          name,
          error !== null &&
            typeof error === "object" &&
            typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "SESSION_EVENT_SCHEMA_INVALID",
        );
        continue;
      }
      if (event.bindingId !== bindingId) {
        await this.quarantine(file, name, "SESSION_BINDING_MISMATCH");
        continue;
      }
      try { await this.service.ingest(event); }
      catch (error) {
        if (
          error instanceof SessionError &&
          (error.code === "SESSION_LIFECYCLE_BINDING_EXPIRED" ||
            error.code === "SESSION_BINDING_MISMATCH")
        ) {
          await this.quarantine(file, name, error.code);
          continue;
        }
        throw error;
      }
      try { await rm(file); consumed += 1; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return consumed;
  }
  private async quarantine(
    file: string,
    originalName: string,
    code: string,
  ): Promise<void> {
    const sanitizedCode = code.replace(/[^A-Za-z0-9_-]/gu, "_");
    try {
      await rename(
        file,
        path.join(
          path.dirname(file),
          `${originalName}.quarantined-${sanitizedCode}-${randomUUID()}`,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
