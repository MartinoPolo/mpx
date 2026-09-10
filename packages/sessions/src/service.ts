import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  parseSessionLifecycleEvent,
  type RuntimeName,
  type SessionLifecycleEvent,
} from '@mpx/runtime-contracts';
import { SessionStore } from './store.js';
import {
  SessionError,
  parseSessionRecord,
  stableDigest,
  type Identity,
  type SessionLiveness,
  type SessionRecord,
  type WorkflowStatus,
} from './schemas.js';

export interface SessionListFilter {
  readonly identity?: Identity;
  readonly runtime?: RuntimeName;
  readonly liveness?: SessionLiveness;
  readonly workflowStatus?: WorkflowStatus;
}
export type SessionReconcileScope = Pick<SessionListFilter, 'identity' | 'runtime'> & {
  readonly recordId?: string;
  readonly lifecycleBindingId?: string;
};
export interface SessionInventoryResult {
  readonly records: readonly SessionRecord[];
  readonly diagnostics: readonly {
    runtime: RuntimeName | null;
    identity: Identity | null;
    status: 'unavailable' | 'malformed' | 'unknown';
    code: string;
  }[];
}

export type ProcessInspection =
  | Readonly<{ status: 'present'; pid: number; startFingerprint: string }>
  | Readonly<{ status: 'absent' | 'unknown' }>;
export interface SessionProcessInspector {
  inspect(pid: number): Promise<ProcessInspection>;
  inspectMany?(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessInspection>>;
}

async function inspectProcesses(
  inspector: SessionProcessInspector,
  pids: readonly number[],
): Promise<ReadonlyMap<number, ProcessInspection>> {
  if (pids.length === 0) {
    return new Map();
  }
  if (inspector.inspectMany) {
    try {
      return await inspector.inspectMany(pids);
    } catch {
      return new Map();
    }
  }
  const results = new Map<number, ProcessInspection>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, pids.length) }, async () => {
      while (next < pids.length) {
        const pid = pids[next++]!;
        try {
          results.set(pid, await inspector.inspect(pid));
        } catch {
          results.set(pid, { status: 'unknown' });
        }
      }
    }),
  );
  return results;
}

const now = (): string => new Date().toISOString();
const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.domain === right.domain && left.name === right.name;
function idFor(identity: Identity, runtime: RuntimeName, nativeId: string): string {
  return `${runtime}-${stableDigest({ identity, nativeId }).slice(0, 24)}`;
}
function activityLiveness(type: SessionLifecycleEvent['type']): SessionLiveness {
  return type === 'shutdown' ? 'inactive' : 'active';
}

function monotonicUpdatedAt(candidate: string, current?: SessionRecord): string {
  const parsed = new Date(candidate);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== candidate ||
    current === undefined
  ) {
    return candidate;
  }
  return [candidate, current.timestamps.createdAt, current.timestamps.updatedAt].reduce(
    (latest, timestamp) => (timestamp > latest ? timestamp : latest),
  );
}

function monotonicActivityAt(candidate: string, current?: SessionRecord): string {
  const previous = current?.timestamps.lastActivityAt;
  return previous !== null && previous !== undefined && previous > candidate ? previous : candidate;
}

export class SessionService {
  constructor(
    readonly store: SessionStore,
    private readonly clock: () => string = now,
    private readonly processInspector?: SessionProcessInspector,
  ) {}
  async list(filter: SessionListFilter = {}): Promise<SessionRecord[]> {
    return (await this.store.partitions())
      .flatMap((partition) => partition.records)
      .filter(
        (record) => filter.identity === undefined || sameIdentity(record.identity, filter.identity),
      )
      .filter((record) => filter.runtime === undefined || record.runtime === filter.runtime)
      .filter((record) => filter.liveness === undefined || record.liveness === filter.liveness)
      .filter(
        (record) =>
          filter.workflowStatus === undefined || record.workflow.status === filter.workflowStatus,
      );
  }
  async show(query: string): Promise<SessionRecord> {
    const loaded = await this.store.loadPartitions();
    const records = loaded.partitions.flatMap((partition) => partition.records);
    const exactRecordId = records.filter((record) => record.recordId === query);
    if (exactRecordId.length === 1) {
      return exactRecordId[0]!;
    }
    if (exactRecordId.length > 1 || loaded.diagnostics.length > 0) {
      throw new SessionError(
        'SESSION_AMBIGUOUS',
        'session lookup cannot be resolved uniquely while a partition is unreadable',
      );
    }
    const exactNativeId = records.filter((record) => record.runtimeQualifiedId === query);
    if (exactNativeId.length === 1) {
      return exactNativeId[0]!;
    }
    const abbreviated = records.filter(
      (record) => record.recordId.startsWith(query) || record.runtimeQualifiedId.startsWith(query),
    );
    if (abbreviated.length === 0) {
      throw new SessionError('SESSION_NOT_FOUND', 'session was not found');
    }
    if (exactNativeId.length > 1 || abbreviated.length > 1) {
      throw new SessionError('SESSION_AMBIGUOUS', 'session abbreviation is ambiguous');
    }
    return abbreviated[0]!;
  }
  async ingest(input: SessionLifecycleEvent): Promise<SessionRecord> {
    const event = parseSessionLifecycleEvent(input);
    const privateBinding = await this.store.readLifecycleBinding(event.bindingId);
    if (Date.parse(this.clock()) >= Date.parse(privateBinding.binding.expiresAt)) {
      throw new SessionError(
        'SESSION_LIFECYCLE_BINDING_EXPIRED',
        'private lifecycle binding has expired',
      );
    }
    if (
      privateBinding.binding.bindingId !== event.bindingId ||
      privateBinding.binding.runtime === undefined
    ) {
      throw new SessionError(
        'SESSION_BINDING_MISMATCH',
        'event and private lifecycle binding differ',
      );
    }
    const nativeBinding = await this.store.readNativeBinding(privateBinding.nativeBindingRef);
    if (
      nativeBinding.runtime !== privateBinding.binding.runtime ||
      privateBinding.binding.identityRef !==
        `${nativeBinding.identity.domain}:${nativeBinding.identity.name}`
    ) {
      throw new SessionError(
        'SESSION_BINDING_MISMATCH',
        'recorded lifecycle and native bindings differ',
      );
    }
    if (
      privateBinding.nativeSessionRef !== null &&
      (event.nativeSessionRef.kind !== privateBinding.nativeSessionRef.kind ||
        event.nativeSessionRef.value !== privateBinding.nativeSessionRef.value)
    ) {
      throw new SessionError(
        'SESSION_BINDING_MISMATCH',
        'event native session does not match recorded binding',
      );
    }
    const identity = nativeBinding.identity,
      runtime = nativeBinding.runtime,
      qualified = `${runtime}:${event.nativeSessionId}`,
      preboundRef = privateBinding.nativeSessionRef;
    return this.store.transaction(identity, runtime, (registry) => {
      const lifecycleBound = registry.records.find(
          (record) => record.lifecycle.bindingId === event.bindingId,
        ),
        resumeBound =
          preboundRef === null
            ? undefined
            : registry.records.find(
                (record) =>
                  record.nativeSessionRef.kind === preboundRef.kind &&
                  record.nativeSessionRef.value === preboundRef.value,
              ),
        initialRecordId = idFor(identity, runtime, event.nativeSessionId),
        current =
          lifecycleBound ??
          resumeBound ??
          registry.records.find((record) => record.recordId === initialRecordId),
        recordId = current?.recordId ?? initialRecordId;
      if (
        current &&
        (current.runtimeQualifiedId !== qualified ||
          current.nativeSessionRef.kind !== event.nativeSessionRef.kind ||
          current.nativeSessionRef.value !== event.nativeSessionRef.value)
      ) {
        throw new SessionError(
          'SESSION_BINDING_MISMATCH',
          'event native session does not match the session already bound to this lifecycle',
        );
      }
      if (registry.recentEventIds.includes(event.eventId)) {
        if (!current) {
          throw new SessionError(
            'SESSION_REGISTRY_CORRUPT',
            'event receipt exists without its record',
          );
        }
        return { registry, result: current };
      }
      const recentEventIds = [...registry.recentEventIds, event.eventId].slice(-512);
      const sameOrderingDomain = current?.lifecycle.bindingId === event.bindingId;
      if (
        current &&
        sameOrderingDomain &&
        (event.sequence <= current.lifecycle.sequence ||
          (current.lifecycle.timestamp !== null && event.timestamp < current.lifecycle.timestamp))
      ) {
        return { registry: { ...registry, recentEventIds }, result: current };
      }
      const createdAt = current?.timestamps.createdAt ?? event.timestamp;
      const record = parseSessionRecord({
        schemaVersion: 2,
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
          status: 'unfinished',
          inbox: true,
          nextAction: null,
          priority: null,
          note: null,
          relatedIssue: null,
          relatedReview: null,
        },
        resume: current?.resume ?? {
          state: 'unknown',
          diagnostic: null,
          lastVerifiedAt: null,
          lastPlanDigest: null,
        },
        timestamps: {
          createdAt,
          updatedAt: monotonicUpdatedAt(event.timestamp, current),
          lastActivityAt:
            event.type === 'shutdown'
              ? (current?.timestamps.lastActivityAt ?? null)
              : monotonicActivityAt(event.timestamp, current),
        },
        lifecycle: {
          bindingId: event.bindingId,
          sequence: event.sequence,
          timestamp: event.timestamp,
        },
      });
      const records = current
        ? registry.records.map((value) => (value.recordId === recordId ? record : value))
        : [...registry.records, record];
      return {
        registry: { ...registry, records, recentEventIds },
        result: record,
      };
    });
  }
  async reconcile(
    lifecycleBindingIds: readonly string[] = [],
    scope: SessionReconcileScope = {},
  ): Promise<SessionInventoryResult> {
    const consumer = new LifecycleEventDirectoryConsumer(this.store, this);
    const bindings = scope.lifecycleBindingId
      ? lifecycleBindingIds.filter((id) => id === scope.lifecycleBindingId)
      : lifecycleBindingIds;
    for (const bindingId of [...bindings].sort()) {
      await consumer.consume(bindingId, scope);
    }

    const capturedAt = this.clock();
    const recovered = await this.store.loadPartitions(scope);
    const partitions = recovered.partitions;
    const managed = partitions.flatMap((partition) =>
      partition.records.filter(
        (record) =>
          record.launch !== null &&
          (scope.recordId === undefined || record.recordId === scope.recordId),
      ),
    );
    const candidates = managed.filter(
      (record) =>
        (record.liveness === 'active' || record.liveness === 'unknown') && record.process !== null,
    );
    const inspections = this.processInspector
      ? await inspectProcesses(this.processInspector, [
          ...new Set(candidates.map((record) => record.process!.pid)),
        ])
      : new Map<number, ProcessInspection>();
    const final = new Map(managed.map((record) => [record.recordId, record]));

    for (const partition of partitions) {
      const sampled = new Map(
        candidates
          .filter(
            (record) =>
              record.runtime === partition.runtime &&
              sameIdentity(record.identity, partition.identity),
          )
          .map((record) => [
            record.recordId,
            {
              pid: record.process!.pid,
              fingerprint: record.process!.startFingerprint,
              inspection: inspections.get(record.process!.pid) ?? ({ status: 'unknown' } as const),
            },
          ]),
      );
      const desired = (record: SessionRecord): SessionRecord => {
        if (
          record.launch === null ||
          (scope.recordId !== undefined && record.recordId !== scope.recordId)
        ) {
          return record;
        }
        if (
          (record.liveness === 'active' || record.liveness === 'unknown') &&
          record.process === null
        ) {
          if (record.liveness === 'unknown') {
            return record;
          }
          return parseSessionRecord({
            ...record,
            liveness: 'unknown',
            timestamps: { ...record.timestamps, updatedAt: monotonicUpdatedAt(capturedAt, record) },
          });
        }
        const sample = sampled.get(record.recordId);
        if (!sample || record.process === null) {
          return record;
        }
        const exact =
          sample.inspection.status === 'present' &&
          sample.inspection.pid === sample.pid &&
          sample.inspection.startFingerprint === sample.fingerprint;
        const liveness: SessionLiveness = exact
          ? 'active'
          : sample.inspection.status === 'absent'
            ? 'inactive'
            : 'unknown';
        const process = liveness === 'inactive' ? null : record.process;
        if (record.liveness === liveness && record.process === process) {
          return record;
        }
        return parseSessionRecord({
          ...record,
          liveness,
          process,
          timestamps: { ...record.timestamps, updatedAt: monotonicUpdatedAt(capturedAt, record) },
        });
      };
      if (!partition.records.some((record) => desired(record) !== record)) {
        continue;
      }
      const result = await this.store.transaction(
        partition.identity,
        partition.runtime,
        (registry) => {
          const records = registry.records.map((record) => {
            const sample = sampled.get(record.recordId);
            const originally = partition.records.find((item) => item.recordId === record.recordId);
            if (
              sample &&
              (!originally ||
                record.process?.pid !== sample.pid ||
                record.process.startFingerprint !== sample.fingerprint)
            ) {
              return record;
            }
            return desired(record);
          });
          return { registry: { ...registry, records }, result: records };
        },
      );
      for (const record of result) {
        if (
          record.launch !== null &&
          (scope.recordId === undefined || record.recordId === scope.recordId)
        ) {
          final.set(record.recordId, record);
        }
      }
    }
    return {
      records: [...final.values()].sort((a, b) => a.recordId.localeCompare(b.recordId)),
      diagnostics: recovered.diagnostics.slice(0, 128),
    };
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
  async consume(bindingId: string, scope: SessionReconcileScope = {}): Promise<number> {
    if (scope.runtime !== undefined || scope.identity !== undefined) {
      const { binding } = await this.store.readLifecycleBinding(bindingId);
      if (
        (scope.runtime !== undefined && binding.runtime !== scope.runtime) ||
        (scope.identity !== undefined &&
          binding.identityRef !== `${scope.identity.domain}:${scope.identity.name}`)
      ) {
        return 0;
      }
    }
    const key = this.store.eventDirectory(bindingId);
    const prior = lifecycleConsumption.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => turn);
    lifecycleConsumption.set(key, tail);
    await prior;
    try {
      return await this.consumeUnlocked(bindingId);
    } finally {
      release();
      if (lifecycleConsumption.get(key) === tail) {
        lifecycleConsumption.delete(key);
      }
    }
  }
  private async consumeUnlocked(bindingId: string): Promise<number> {
    const directory = this.store.eventDirectory(bindingId);
    let names: string[];
    try {
      await this.beforeDirectoryEnumeration?.();
      if (!(await this.store.validateEventDirectory(bindingId))) {
        return 0;
      }
      names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
    if (names.length > this.maxFiles) {
      throw new SessionError('SESSION_EVENT_LIMIT', 'event directory contains too many files');
    }
    let consumed = 0;
    for (const name of names) {
      if (!(await this.store.validateEventDirectory(bindingId))) {
        return consumed;
      }
      const file = path.join(directory, name);
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile() || info.size > this.maxBytes) {
        await this.quarantine(file, name, 'SESSION_UNSAFE_EVENT');
        continue;
      }
      let raw: unknown;
      try {
        raw = await this.store.readBoundedRegularJson(file, this.maxBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        if (error instanceof SyntaxError) {
          await this.quarantine(file, name, 'SESSION_EVENT_JSON_PARSE_FAILED');
          continue;
        }
        throw error;
      }
      let event: SessionLifecycleEvent;
      try {
        event = parseSessionLifecycleEvent(raw);
      } catch (error) {
        await this.quarantine(
          file,
          name,
          error !== null &&
            typeof error === 'object' &&
            typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'SESSION_EVENT_SCHEMA_INVALID',
        );
        continue;
      }
      if (event.bindingId !== bindingId) {
        await this.quarantine(file, name, 'SESSION_BINDING_MISMATCH');
        continue;
      }
      try {
        await this.service.ingest(event);
      } catch (error) {
        if (
          error instanceof SessionError &&
          (error.code === 'SESSION_LIFECYCLE_BINDING_EXPIRED' ||
            error.code === 'SESSION_BINDING_MISMATCH')
        ) {
          await this.quarantine(file, name, error.code);
          continue;
        }
        throw error;
      }
      try {
        await rm(file);
        consumed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return consumed;
  }
  private async quarantine(file: string, originalName: string, code: string): Promise<void> {
    const sanitizedCode = code.replace(/[^A-Za-z0-9_-]/gu, '_');
    try {
      await rename(
        file,
        path.join(
          path.dirname(file),
          `${originalName}.quarantined-${sanitizedCode}-${randomUUID()}`,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
