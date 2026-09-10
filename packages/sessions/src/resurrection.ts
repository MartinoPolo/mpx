import type { RuntimeName } from '@mpx/runtime-contracts';
import {
  SessionError,
  type Identity,
  type SessionLiveness,
  type SessionRecord,
} from './schemas.js';

export interface SessionResurrectionRoute {
  readonly kind: 'mpx-session-resume';
  readonly executable: 'mpx';
  readonly argv: readonly ['session', 'resume', string, '--approve-resurrection'];
}

export interface SessionResurrectionRecord {
  readonly id: string;
  readonly runtime: RuntimeName;
  readonly nativeSessionId: string;
  readonly nativeSessionRef: string | null;
  readonly identity: Identity;
  readonly title: string | null;
  readonly hostCwd: string;
  readonly executor: 'host' | 'docker';
  readonly workspace: 'clone' | 'host-worktree' | 'direct';
  readonly sandboxCwd: string | null;
  readonly nativePathTranslation: null;
  readonly liveness: SessionLiveness;
  readonly route: SessionResurrectionRoute;
}

export interface SessionInventoryDiagnostic {
  readonly runtime: RuntimeName | null;
  readonly identity: Identity | null;
  readonly status: 'unavailable' | 'malformed' | 'unknown';
  readonly code: string;
}

export interface SessionResurrectionExport {
  readonly schemaVersion: 2;
  readonly kind: 'session-resurrection-export';
  readonly records: readonly SessionResurrectionRecord[];
  readonly diagnostics: readonly SessionInventoryDiagnostic[];
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

function parseRecord(value: unknown, index: number): SessionResurrectionRecord {
  const label = `records[${index}]`;
  const item = exactObject(
    value,
    [
      'id',
      'runtime',
      'nativeSessionId',
      'nativeSessionRef',
      'identity',
      'title',
      'hostCwd',
      'executor',
      'workspace',
      'sandboxCwd',
      'nativePathTranslation',
      'liveness',
      'route',
    ],
    label,
  );
  const id = safeText(item.id, `${label}.id`, 512);
  if (item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('SESSION_INVALID_RUNTIME', `${label}.runtime is invalid`);
  }
  const nativeSessionId = safeText(item.nativeSessionId, `${label}.nativeSessionId`, 512);
  const nativeSessionRef = nullableText(item.nativeSessionRef, `${label}.nativeSessionRef`);
  const identity = exactObject(item.identity, ['name', 'domain'], `${label}.identity`);
  if (identity.domain !== 'personal' && identity.domain !== 'work') {
    fail('SESSION_INVALID_SCHEMA', `${label}.identity.domain is invalid`);
  }
  if (item.executor !== 'host' && item.executor !== 'docker') {
    fail('SESSION_INVALID_SCHEMA', `${label}.executor is invalid`);
  }
  if (
    item.workspace !== 'clone' &&
    item.workspace !== 'host-worktree' &&
    item.workspace !== 'direct'
  ) {
    fail('SESSION_INVALID_SCHEMA', `${label}.workspace is invalid`);
  }
  if (item.nativePathTranslation !== null) {
    fail('SESSION_INVALID_SCHEMA', `${label}.nativePathTranslation is unsupported in version 1`);
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
    route.argv[2] !== id ||
    route.argv[3] !== '--approve-resurrection'
  ) {
    fail('SESSION_INVALID_SCHEMA', `${label}.route is invalid`);
  }
  return {
    id,
    runtime: item.runtime,
    nativeSessionId,
    nativeSessionRef,
    identity: {
      name: safeText(identity.name, `${label}.identity.name`, 128),
      domain: identity.domain,
    },
    title: nullableText(item.title, `${label}.title`),
    hostCwd: safeText(item.hostCwd, `${label}.hostCwd`),
    executor: item.executor,
    workspace: item.workspace,
    sandboxCwd: nullableText(item.sandboxCwd, `${label}.sandboxCwd`),
    nativePathTranslation: null,
    liveness: item.liveness,
    route: {
      kind: 'mpx-session-resume',
      executable: 'mpx',
      argv: ['session', 'resume', id, '--approve-resurrection'],
    },
  };
}

function parseDiagnostic(value: unknown, index: number): SessionInventoryDiagnostic {
  const label = `diagnostics[${index}]`;
  const item = exactObject(value, ['runtime', 'identity', 'status', 'code'], label);
  if (item.runtime !== null && item.runtime !== 'claude' && item.runtime !== 'pi') {
    fail('SESSION_INVALID_RUNTIME', `${label}.runtime is invalid`);
  }
  if (item.status !== 'unavailable' && item.status !== 'malformed' && item.status !== 'unknown') {
    fail('SESSION_INVALID_SCHEMA', `${label}.status is invalid`);
  }
  let identity: Identity | null = null;
  if (item.identity !== null) {
    const parsed = exactObject(item.identity, ['name', 'domain'], `${label}.identity`);
    if (parsed.domain !== 'personal' && parsed.domain !== 'work') {
      fail('SESSION_INVALID_SCHEMA', `${label}.identity.domain is invalid`);
    }
    identity = {
      name: safeText(parsed.name, `${label}.identity.name`, 128),
      domain: parsed.domain,
    };
  }
  return {
    runtime: item.runtime,
    identity,
    status: item.status,
    code: safeText(item.code, `${label}.code`, 128),
  };
}

export function parseSessionResurrectionExport(value: unknown): SessionResurrectionExport {
  const item = exactObject(
    value,
    ['schemaVersion', 'kind', 'records', 'diagnostics'],
    'resurrection export',
  );
  if (item.schemaVersion !== 2) {
    fail('SESSION_SCHEMA_VERSION', 'unsupported session resurrection export version');
  }
  if (
    item.kind !== 'session-resurrection-export' ||
    !Array.isArray(item.records) ||
    !Array.isArray(item.diagnostics) ||
    item.records.length > 10_000 ||
    item.diagnostics.length > 128
  ) {
    fail('SESSION_INVALID_SCHEMA', 'session resurrection export is invalid');
  }
  const records = item.records.map(parseRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    fail('SESSION_INVALID_SCHEMA', 'session resurrection record IDs must be unique');
  }
  return {
    schemaVersion: 2,
    kind: 'session-resurrection-export',
    records,
    diagnostics: item.diagnostics.map(parseDiagnostic),
  };
}

export function projectSessionResurrectionRecord(
  record: SessionRecord & { readonly launch: NonNullable<SessionRecord['launch']> },
): SessionResurrectionRecord {
  const projected = {
    id: record.recordId,
    runtime: record.runtime,
    nativeSessionId: record.runtimeQualifiedId.slice(record.runtime.length + 1),
    nativeSessionRef: record.nativeSessionRef.value,
    identity: record.identity,
    title: record.metadata.title,
    hostCwd: record.location.cwd,
    executor: record.launch.executor.kind,
    workspace: record.launch.workspace,
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
