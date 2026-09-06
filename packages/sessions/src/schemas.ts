import { createHash } from 'node:crypto';
import { MpxError } from '@mpx/core';
import {
  parseNativeSessionRefV1,
  parseSessionLifecycleBindingV1,
  type NativeSessionRefV1,
  type RuntimeName,
  type SessionLifecycleBindingV1,
} from '@mpx/runtime-contracts';

export class SessionError extends MpxError {
  constructor(
    code: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    super({ code, message, ...(details === undefined ? {} : { details }) });
    this.name = 'SessionError';
  }
}

export type IdentityV1 = Readonly<{ domain: string; name: string }>;
export type WorkflowStatus = 'unfinished' | 'needs-review' | 'completed' | 'abandoned' | 'paused';
export type SessionLiveness = 'active' | 'inactive' | 'unknown';
export type LaunchSnapshotV1 = Readonly<{
  launchKey: string;
  descriptorDigest: string;
  mode: string;
  skillPolicy: string;
  contentScope: string;
  executor: Readonly<{ kind: 'host' | 'docker' }>;
  workspace: string;
  networkPolicy: string;
  grants: readonly Readonly<{ access: string; resource: string }>[];
  artifactKey: string;
  manifestKey: string;
}>;
export type SessionLocationV1 = Readonly<{
  cwd: string;
  project: string | null;
  repository: string | null;
  worktree: string | null;
}>;
export interface SessionRecordV1 {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly runtimeQualifiedId: string;
  readonly runtime: RuntimeName;
  readonly identity: IdentityV1;
  readonly nativeBindingRef: string;
  readonly nativeSessionRef: NativeSessionRefV1;
  readonly launch: LaunchSnapshotV1 | null;
  readonly location: SessionLocationV1;
  readonly metadata: Readonly<{
    title: string | null;
    model: string | null;
    effort: string | null;
  }>;
  readonly liveness: SessionLiveness;
  readonly process: Readonly<{ pid: number; startFingerprint: string }> | null;
  readonly workflow: Readonly<{
    status: WorkflowStatus;
    inbox: boolean;
    nextAction: string | null;
    note: string | null;
    relatedIssue: string | null;
    relatedReview: string | null;
    priority: number | null;
    summary?: string | null;
    dispositionAt?: string | null;
    handedOffAt?: string | null;
    completedAt?: string | null;
    observationId?: string | null;
    operation?: 'handoff' | 'completion' | null;
  }>;
  readonly resume: Readonly<{
    state: 'resumable' | 'blocked' | 'unavailable' | 'unknown';
    diagnostic: string | null;
    lastVerifiedAt: string | null;
    lastPlanDigest: string | null;
  }>;
  readonly timestamps: Readonly<{
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string | null;
  }>;
  readonly lifecycle: Readonly<{
    bindingId: string | null;
    sequence: number;
    timestamp: string | null;
  }>;
}
export interface SessionRegistryV1 {
  readonly schemaVersion: 1;
  readonly identity: IdentityV1;
  readonly runtime: RuntimeName;
  readonly records: readonly SessionRecordV1[];
  readonly recentEventIds: readonly string[];
}
export interface NativeBindingRecordV1 {
  readonly schemaVersion: 1;
  readonly ref: string;
  readonly identity: IdentityV1;
  readonly runtime: RuntimeName;
  readonly recordedRootDigest: string;
  readonly accountBindingRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SessionLifecycleBindingRecordV1 {
  readonly schemaVersion: 1;
  readonly binding: SessionLifecycleBindingV1;
  readonly nativeBindingRef: string;
  readonly nativeSessionRef: NativeSessionRefV1 | null;
  readonly launch: LaunchSnapshotV1;
  readonly location: SessionLocationV1;
}
const control = /[\u0000-\u001f\u007f-\u009f]/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const forbiddenKey =
  /^(?:nativeRoot|root|accountId|providerAccountId|verifier|auth|token|prompt|transcript)$/iu;
function fail(code: string, message: string): never {
  throw new SessionError(code, message);
}
function obj(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SESSION_INVALID_SCHEMA', `${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).find((key) => !expected.includes(key) || forbiddenKey.test(key));
  if (extra) {
    fail('SESSION_UNKNOWN_FIELD', `${label} contains forbidden or unknown field '${extra}'`);
  }
  const missing = expected.find((key) => !Object.hasOwn(item, key));
  if (missing) {
    fail('SESSION_INVALID_SCHEMA', `${label} is missing '${missing}'`);
  }
  return item;
}
function objOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SESSION_INVALID_SCHEMA', `${label} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).find(
    (key) => (!required.includes(key) && !optional.includes(key)) || forbiddenKey.test(key),
  );
  if (extra) {
    fail('SESSION_UNKNOWN_FIELD', `${label} contains forbidden or unknown field '${extra}'`);
  }
  const missing = required.find((key) => !Object.hasOwn(item, key));
  if (missing) {
    fail('SESSION_INVALID_SCHEMA', `${label} is missing '${missing}'`);
  }
  return item;
}
function text(value: unknown, label: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    control.test(value) ||
    value !== value.normalize('NFC')
  ) {
    fail('SESSION_INVALID_SCHEMA', `${label} is invalid`);
  }
  return value;
}
function nullableText(value: unknown, label: string, max = 512): string | null {
  return value === null ? null : text(value, label, max);
}
export function canonicalTimestamp(value: unknown, label = 'timestamp'): string {
  const result = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    fail('SESSION_INVALID_TIMESTAMP', `${label} is not canonical UTC`);
  }
  try {
    if (new Date(result).toISOString() !== result) {
      fail('SESSION_INVALID_TIMESTAMP', `${label} is not a real canonical UTC instant`);
    }
  } catch {
    fail('SESSION_INVALID_TIMESTAMP', `${label} is not a real canonical UTC instant`);
  }
  return result;
}
function runtime(value: unknown): RuntimeName {
  if (value !== 'claude' && value !== 'pi') {
    fail('SESSION_INVALID_RUNTIME', 'runtime must be claude or pi');
  }
  return value;
}
function identity(value: unknown): IdentityV1 {
  const item = obj(value, ['domain', 'name'], 'identity');
  return {
    domain: text(item.domain, 'identity.domain', 128),
    name: text(item.name, 'identity.name', 128),
  };
}
function sha(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!digestPattern.test(result)) {
    fail('SESSION_INVALID_DIGEST', `${label} must be a lowercase SHA-256 digest`);
  }
  return result;
}
function location(value: unknown): SessionLocationV1 {
  const item = obj(value, ['cwd', 'project', 'repository', 'worktree'], 'location');
  return {
    cwd: text(item.cwd, 'location.cwd', 4096),
    project: nullableText(item.project, 'location.project'),
    repository: nullableText(item.repository, 'location.repository'),
    worktree: nullableText(item.worktree, 'location.worktree'),
  };
}
export function parseLaunchSnapshotV1(value: unknown): LaunchSnapshotV1 {
  const item = obj(
    value,
    [
      'launchKey',
      'descriptorDigest',
      'mode',
      'skillPolicy',
      'contentScope',
      'executor',
      'workspace',
      'networkPolicy',
      'grants',
      'artifactKey',
      'manifestKey',
    ],
    'launch',
  );
  const executor = obj(item.executor, ['kind'], 'launch.executor');
  if (executor.kind !== 'host' && executor.kind !== 'docker') {
    fail('SESSION_INVALID_SCHEMA', 'launch.executor.kind is invalid');
  }
  if (!Array.isArray(item.grants) || item.grants.length > 128) {
    fail('SESSION_INVALID_SCHEMA', 'launch.grants is invalid');
  }
  const grants = item.grants.map((raw, index) => {
    const grant = obj(raw, ['access', 'resource'], `launch.grants[${index}]`);
    return {
      access: text(grant.access, 'grant.access', 64),
      resource: text(grant.resource, 'grant.resource', 1024),
    };
  });
  return {
    launchKey: text(item.launchKey, 'launch.launchKey'),
    descriptorDigest: sha(item.descriptorDigest, 'launch.descriptorDigest'),
    mode: text(item.mode, 'launch.mode', 64),
    skillPolicy: text(item.skillPolicy, 'launch.skillPolicy', 128),
    contentScope: text(item.contentScope, 'launch.contentScope', 256),
    executor: { kind: executor.kind },
    workspace: text(item.workspace, 'launch.workspace', 1024),
    networkPolicy: text(item.networkPolicy, 'launch.networkPolicy', 128),
    grants,
    artifactKey: text(item.artifactKey, 'launch.artifactKey'),
    manifestKey: text(item.manifestKey, 'launch.manifestKey'),
  };
}
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail('SESSION_INVALID_SCHEMA', `${label} is invalid`);
  }
  return value as number;
}
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) {
    fail('SESSION_INVALID_SCHEMA', `${label} is invalid`);
  }
  return value as T;
}
export function parseSessionRecordV1(value: unknown): SessionRecordV1 {
  const item = obj(
    value,
    [
      'schemaVersion',
      'recordId',
      'runtimeQualifiedId',
      'runtime',
      'identity',
      'nativeBindingRef',
      'nativeSessionRef',
      'launch',
      'location',
      'metadata',
      'liveness',
      'process',
      'workflow',
      'resume',
      'timestamps',
      'lifecycle',
    ],
    'session record',
  );
  if (item.schemaVersion !== 1) {
    fail('SESSION_SCHEMA_VERSION', 'unsupported session record schema version');
  }
  const rt = runtime(item.runtime);
  const nativeRef = parseNativeSessionRefV1(item.nativeSessionRef);
  const qualified = text(item.runtimeQualifiedId, 'runtimeQualifiedId');
  if (!qualified.startsWith(`${rt}:`)) {
    fail('SESSION_BINDING_MISMATCH', 'runtimeQualifiedId does not match runtime');
  }
  const metadata = obj(item.metadata, ['title', 'model', 'effort'], 'metadata');
  const process =
    item.process === null ? null : obj(item.process, ['pid', 'startFingerprint'], 'process');
  const workflow = objOptional(
    item.workflow,
    ['status', 'inbox', 'nextAction', 'note', 'relatedIssue', 'relatedReview', 'priority'],
    ['summary', 'dispositionAt', 'handedOffAt', 'completedAt', 'observationId', 'operation'],
    'workflow',
  );
  if (typeof workflow.inbox !== 'boolean') {
    fail('SESSION_INVALID_SCHEMA', 'workflow.inbox must be boolean');
  }
  const status = enumValue(
    workflow.status,
    ['unfinished', 'needs-review', 'completed', 'abandoned', 'paused'] as const,
    'workflow.status',
  );
  if ((status === 'unfinished' || status === 'needs-review') !== workflow.inbox) {
    fail('SESSION_INBOX_INVARIANT', 'workflow inbox does not match status');
  }
  const priority =
    workflow.priority === null ? null : integer(workflow.priority, 'workflow.priority', 9);
  const resume = obj(
    item.resume,
    ['state', 'diagnostic', 'lastVerifiedAt', 'lastPlanDigest'],
    'resume',
  );
  const timestamps = obj(
    item.timestamps,
    ['createdAt', 'updatedAt', 'lastActivityAt'],
    'timestamps',
  );
  const lifecycle = obj(item.lifecycle, ['bindingId', 'sequence', 'timestamp'], 'lifecycle');
  const createdAt = canonicalTimestamp(timestamps.createdAt, 'timestamps.createdAt'),
    updatedAt = canonicalTimestamp(timestamps.updatedAt, 'timestamps.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('SESSION_INVALID_TIMESTAMP', 'updatedAt precedes createdAt');
  }
  return {
    schemaVersion: 1,
    recordId: text(item.recordId, 'recordId'),
    runtimeQualifiedId: qualified,
    runtime: rt,
    identity: identity(item.identity),
    nativeBindingRef: text(item.nativeBindingRef, 'nativeBindingRef'),
    nativeSessionRef: nativeRef,
    launch: item.launch === null ? null : parseLaunchSnapshotV1(item.launch),
    location: location(item.location),
    metadata: {
      title: nullableText(metadata.title, 'metadata.title'),
      model: nullableText(metadata.model, 'metadata.model', 128),
      effort: nullableText(metadata.effort, 'metadata.effort', 128),
    },
    liveness: enumValue(item.liveness, ['active', 'inactive', 'unknown'] as const, 'liveness'),
    process:
      process === null
        ? null
        : {
            pid: integer(process.pid, 'process.pid'),
            startFingerprint: text(process.startFingerprint, 'process.startFingerprint', 256),
          },
    workflow: {
      status,
      inbox: workflow.inbox,
      nextAction: nullableText(workflow.nextAction, 'workflow.nextAction', 2048),
      note: nullableText(workflow.note, 'workflow.note', 2048),
      relatedIssue: nullableText(workflow.relatedIssue, 'workflow.relatedIssue', 512),
      relatedReview: nullableText(workflow.relatedReview, 'workflow.relatedReview', 512),
      priority,
      ...(Object.hasOwn(workflow, 'summary')
        ? { summary: nullableText(workflow.summary, 'workflow.summary', 512) }
        : {}),
      ...(Object.hasOwn(workflow, 'dispositionAt')
        ? {
            dispositionAt:
              workflow.dispositionAt == null
                ? null
                : canonicalTimestamp(workflow.dispositionAt, 'workflow.dispositionAt'),
          }
        : {}),
      ...(Object.hasOwn(workflow, 'handedOffAt')
        ? {
            handedOffAt:
              workflow.handedOffAt == null
                ? null
                : canonicalTimestamp(workflow.handedOffAt, 'workflow.handedOffAt'),
          }
        : {}),
      ...(Object.hasOwn(workflow, 'completedAt')
        ? {
            completedAt:
              workflow.completedAt == null
                ? null
                : canonicalTimestamp(workflow.completedAt, 'workflow.completedAt'),
          }
        : {}),
      ...(Object.hasOwn(workflow, 'observationId')
        ? { observationId: nullableText(workflow.observationId, 'workflow.observationId', 64) }
        : {}),
      ...(Object.hasOwn(workflow, 'operation')
        ? {
            operation:
              workflow.operation == null
                ? null
                : enumValue(
                    workflow.operation,
                    ['handoff', 'completion'] as const,
                    'workflow.operation',
                  ),
          }
        : {}),
    },
    resume: {
      state: enumValue(
        resume.state,
        ['resumable', 'blocked', 'unavailable', 'unknown'] as const,
        'resume.state',
      ),
      diagnostic: nullableText(resume.diagnostic, 'resume.diagnostic', 1024),
      lastVerifiedAt:
        resume.lastVerifiedAt === null
          ? null
          : canonicalTimestamp(resume.lastVerifiedAt, 'resume.lastVerifiedAt'),
      lastPlanDigest:
        resume.lastPlanDigest === null ? null : sha(resume.lastPlanDigest, 'resume.lastPlanDigest'),
    },
    timestamps: {
      createdAt,
      updatedAt,
      lastActivityAt:
        timestamps.lastActivityAt === null
          ? null
          : canonicalTimestamp(timestamps.lastActivityAt, 'timestamps.lastActivityAt'),
    },
    lifecycle: {
      bindingId: nullableText(lifecycle.bindingId, 'lifecycle.bindingId'),
      sequence: integer(lifecycle.sequence, 'lifecycle.sequence'),
      timestamp:
        lifecycle.timestamp === null
          ? null
          : canonicalTimestamp(lifecycle.timestamp, 'lifecycle.timestamp'),
    },
  };
}
export function parseSessionRegistryV1(value: unknown): SessionRegistryV1 {
  const item = obj(
    value,
    ['schemaVersion', 'identity', 'runtime', 'records', 'recentEventIds'],
    'registry',
  );
  if (
    item.schemaVersion !== 1 ||
    !Array.isArray(item.records) ||
    item.records.length > 10_000 ||
    !Array.isArray(item.recentEventIds) ||
    item.recentEventIds.length > 512
  ) {
    fail('SESSION_INVALID_REGISTRY', 'registry limits or version are invalid');
  }
  const id = identity(item.identity),
    rt = runtime(item.runtime),
    records = item.records.map(parseSessionRecordV1),
    ids = item.recentEventIds.map((v, i) => text(v, `recentEventIds[${i}]`));
  if (
    new Set(ids).size !== ids.length ||
    records.some(
      (record) =>
        record.runtime !== rt ||
        record.identity.domain !== id.domain ||
        record.identity.name !== id.name,
    )
  ) {
    fail('SESSION_PARTITION_MISMATCH', 'registry content does not match partition');
  }
  return {
    schemaVersion: 1,
    identity: id,
    runtime: rt,
    records,
    recentEventIds: ids,
  };
}
export function parseNativeBindingRecordV1(value: unknown): NativeBindingRecordV1 {
  const item = obj(
    value,
    [
      'schemaVersion',
      'ref',
      'identity',
      'runtime',
      'recordedRootDigest',
      'accountBindingRef',
      'createdAt',
      'updatedAt',
    ],
    'native binding',
  );
  if (item.schemaVersion !== 1) {
    fail('SESSION_SCHEMA_VERSION', 'unsupported native binding version');
  }
  const createdAt = canonicalTimestamp(item.createdAt, 'createdAt');
  const updatedAt = canonicalTimestamp(item.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('SESSION_INVALID_TIMESTAMP', 'native binding updatedAt precedes createdAt');
  }
  return {
    schemaVersion: 1,
    ref: text(item.ref, 'binding.ref'),
    identity: identity(item.identity),
    runtime: runtime(item.runtime),
    recordedRootDigest: sha(item.recordedRootDigest, 'recordedRootDigest'),
    accountBindingRef: nullableText(item.accountBindingRef, 'accountBindingRef'),
    createdAt,
    updatedAt,
  };
}
export function parseLifecycleBindingRecordV1(value: unknown): SessionLifecycleBindingRecordV1 {
  const item = obj(
    value,
    ['schemaVersion', 'binding', 'nativeBindingRef', 'nativeSessionRef', 'launch', 'location'],
    'lifecycle binding record',
  );
  if (item.schemaVersion !== 1) {
    fail('SESSION_SCHEMA_VERSION', 'unsupported lifecycle binding record version');
  }
  const binding = parseSessionLifecycleBindingV1(item.binding);
  const launch = parseLaunchSnapshotV1(item.launch);
  if (
    launch.launchKey !== binding.launchKey ||
    launch.descriptorDigest !== binding.launchDescriptorDigest ||
    launch.artifactKey !== binding.artifactKey ||
    launch.manifestKey !== binding.manifestKey
  ) {
    fail(
      'SESSION_BINDING_MISMATCH',
      'private launch snapshot does not match its runtime lifecycle binding',
    );
  }
  return {
    schemaVersion: 1,
    binding,
    nativeBindingRef: text(item.nativeBindingRef, 'nativeBindingRef'),
    nativeSessionRef:
      item.nativeSessionRef === null ? null : parseNativeSessionRefV1(item.nativeSessionRef),
    launch,
    location: location(item.location),
  };
}
export function stableDigest(value: unknown): string {
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : v !== null && typeof v === 'object'
        ? `{${Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
            .join(',')}}`
        : JSON.stringify(v);
  return createHash('sha256').update(stable(value)).digest('hex');
}
