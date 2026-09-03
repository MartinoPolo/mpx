import type { RuntimeName } from '@mpx/runtime-contracts';
import {
  SessionError,
  type IdentityV1,
  type SessionLiveness,
  type SessionRecordV1,
} from './schemas.js';

export interface SessionResurrectionRouteV1 {
  readonly kind: 'mpx-session-resume';
  readonly executable: 'mpx';
  readonly argv: readonly ['session', 'resume', string, '--approve-resurrection'];
}

export interface SessionResurrectionRecordV1 {
  readonly recordId: string;
  readonly runtime: RuntimeName;
  readonly identity: IdentityV1;
  readonly title: string | null;
  readonly hostCwd: string;
  readonly executorKind: 'host' | 'docker';
  readonly workspaceStrategy: string;
  readonly sandboxCwd: string | null;
  readonly nativePathTranslation: string | null;
  readonly liveness: SessionLiveness;
  readonly route: SessionResurrectionRouteV1;
}

export interface SessionResurrectionExportV1 {
  readonly schemaVersion: 1;
  readonly kind: 'session-resurrection-export';
  readonly records: readonly SessionResurrectionRecordV1[];
}

const control = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(code: string, message: string): never {
  throw new SessionError(code, message);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SESSION_INVALID_SCHEMA', `${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const extra = Object.keys(object).find((key) => !keys.includes(key));
  if (extra !== undefined) {
    fail('SESSION_UNKNOWN_FIELD', `${label} contains unknown field '${extra}'`);
  }
  const missing = keys.find((key) => !Object.hasOwn(object, key));
  if (missing !== undefined) {
    fail('SESSION_INVALID_SCHEMA', `${label} is missing '${missing}'`);
  }
  return object;
}

function safeText(value: unknown, label: string, max = 4096): string {
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

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : safeText(value, label);
}

function parseRecord(value: unknown, index: number): SessionResurrectionRecordV1 {
  const label = `records[${index}]`;
  const item = exactObject(
    value,
    [
      'recordId',
      'runtime',
      'identity',
      'title',
      'hostCwd',
      'executorKind',
      'workspaceStrategy',
      'sandboxCwd',
      'nativePathTranslation',
      'liveness',
      'route',
    ],
    label,
  );
  const recordId = safeText(item.recordId, `${label}.recordId`, 512);
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('SESSION_INVALID_RUNTIME', `${label}.runtime is invalid`);
  }
  const identity = exactObject(item.identity, ['name', 'domain'], `${label}.identity`);
  if (item.executorKind !== 'host' && item.executorKind !== 'docker') {
    fail('SESSION_INVALID_SCHEMA', `${label}.executorKind is invalid`);
  }
  if (item.liveness !== 'active' && item.liveness !== 'inactive' && item.liveness !== 'unknown') {
    fail('SESSION_INVALID_SCHEMA', `${label}.liveness is invalid`);
  }
  const route = exactObject(item.route, ['kind', 'executable', 'argv'], `${label}.route`);
  if (
    route.kind !== 'mpx-session-resume' ||
    route.executable !== 'mpx' ||
    !Array.isArray(route.argv) ||
    route.argv.length !== 4 ||
    route.argv[0] !== 'session' ||
    route.argv[1] !== 'resume' ||
    route.argv[2] !== recordId ||
    route.argv[3] !== '--approve-resurrection'
  ) {
    fail('SESSION_INVALID_SCHEMA', `${label}.route is invalid`);
  }
  return {
    recordId,
    runtime: item.runtime,
    identity: {
      name: safeText(identity.name, `${label}.identity.name`, 128),
      domain: safeText(identity.domain, `${label}.identity.domain`, 128),
    },
    title: nullableText(item.title, `${label}.title`),
    hostCwd: safeText(item.hostCwd, `${label}.hostCwd`),
    executorKind: item.executorKind,
    workspaceStrategy: safeText(item.workspaceStrategy, `${label}.workspaceStrategy`, 1024),
    sandboxCwd: nullableText(item.sandboxCwd, `${label}.sandboxCwd`),
    nativePathTranslation: nullableText(
      item.nativePathTranslation,
      `${label}.nativePathTranslation`,
    ),
    liveness: item.liveness,
    route: {
      kind: 'mpx-session-resume',
      executable: 'mpx',
      argv: ['session', 'resume', recordId, '--approve-resurrection'],
    },
  };
}

export function parseSessionResurrectionExportV1(value: unknown): SessionResurrectionExportV1 {
  const item = exactObject(value, ['schemaVersion', 'kind', 'records'], 'resurrection export');
  if (item.schemaVersion !== 1) {
    fail('SESSION_SCHEMA_VERSION', 'unsupported session resurrection export version');
  }
  if (
    item.kind !== 'session-resurrection-export' ||
    !Array.isArray(item.records) ||
    item.records.length > 10_000
  ) {
    fail('SESSION_INVALID_SCHEMA', 'session resurrection export is invalid');
  }
  const records = item.records.map(parseRecord);
  if (new Set(records.map((record) => record.recordId)).size !== records.length) {
    fail('SESSION_INVALID_SCHEMA', 'session resurrection record IDs must be unique');
  }
  return { schemaVersion: 1, kind: 'session-resurrection-export', records };
}

export function projectSessionResurrectionRecordV1(
  record: SessionRecordV1 & { readonly launch: NonNullable<SessionRecordV1['launch']> },
): SessionResurrectionRecordV1 {
  const projected = {
    recordId: record.recordId,
    runtime: record.runtime,
    identity: record.identity,
    title: record.metadata.title,
    hostCwd: record.location.cwd,
    executorKind: record.launch.executor.kind,
    workspaceStrategy: record.launch.workspace,
    sandboxCwd: null,
    nativePathTranslation: null,
    liveness: record.liveness,
    route: {
      kind: 'mpx-session-resume' as const,
      executable: 'mpx' as const,
      argv: ['session', 'resume', record.recordId, '--approve-resurrection'] as const,
    },
  };
  return parseRecord(projected, 0);
}
