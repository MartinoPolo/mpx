import { describe, expect, it } from 'vitest';
import {
  parseSessionResurrectionExport,
  projectSessionResurrectionRecord,
  type SessionRecord,
} from '../../src/index.js';

const exportedRecord = {
  id: 'opaque-record',
  runtime: 'claude',
  nativeSessionId: 'private-native-id',
  nativeSessionRef: 'private-native-id',
  identity: { name: 'me', domain: 'personal' },
  title: null,
  hostCwd: 'C:/repo',
  executor: 'host',
  workspace: 'direct',
  sandboxCwd: null,
  nativePathTranslation: null,
  liveness: 'active',
  route: {
    kind: 'mpx-session-resume',
    executable: 'mpx',
    argv: ['session', 'resume', 'opaque-record', '--approve-resurrection'],
  },
} as const;

const sourceRecord = {
  schemaVersion: 2,
  recordId: 'opaque-record',
  runtimeQualifiedId: 'claude:private-native-id',
  runtime: 'claude',
  identity: { name: 'me', domain: 'personal' },
  nativeBindingRef: 'private-binding',
  nativeSessionRef: { kind: 'native-id', value: 'private-native-id' },
  launch: {
    launchKey: 'private-launch',
    descriptorDigest: 'a'.repeat(64),
    mode: 'interactive',
    selection: {
      location: { name: 'repo', canonicalRoot: 'C:/repo' },
      packs: ['development'],
      source: 'project',
    },
    executor: { kind: 'host' },
    workspace: 'direct',
    networkPolicy: 'restricted',
    artifactKey: 'private-artifact',
    manifestKey: 'private-manifest',
  },
  location: { cwd: 'C:/repo', project: 'project', repository: 'repo', worktree: 'tree' },
  metadata: { title: null, model: 'secret-model', effort: null },
  liveness: 'active',
  process: { pid: 42, startFingerprint: 'private-process' },
  workflow: {
    status: 'unfinished',
    inbox: true,
    nextAction: 'secret prompt',
    note: 'secret note',
    relatedIssue: null,
    relatedReview: null,
    priority: null,
  },
  resume: { state: 'resumable', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
  timestamps: {
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastActivityAt: null,
  },
  lifecycle: { bindingId: 'private-lifecycle', sequence: 1, timestamp: null },
} as unknown as SessionRecord & { readonly launch: NonNullable<SessionRecord['launch']> };

const diagnostic = {
  runtime: 'pi',
  identity: { name: 'work', domain: 'work' },
  status: 'unknown',
  code: 'SESSION_PROCESS_INSPECTION_UNKNOWN',
} as const;

const envelope = {
  schemaVersion: 2,
  kind: 'session-resurrection-export',
  records: [exportedRecord],
  diagnostics: [diagnostic],
} as const;

describe('session resurrection export v2 protocol', () => {
  it('round-trips exact native session fields and sanitized inventory diagnostics', () => {
    expect(parseSessionResurrectionExport(envelope)).toEqual(envelope);
  });

  it('strictly rejects unknown fields, old versions, malformed diagnostics, and forged routes', () => {
    for (const malicious of [
      { ...envelope, credentials: 'secret' },
      { ...envelope, schemaVersion: 1 },
      { ...envelope, records: [{ ...exportedRecord, title: 'bad\u0000title' }] },
      { ...envelope, records: [{ ...exportedRecord, nativeSessionId: '' }] },
      { ...envelope, diagnostics: [{ ...diagnostic, detail: 'private' }] },
      { ...envelope, diagnostics: [{ ...diagnostic, status: 'active' }] },
      { ...envelope, diagnostics: [{ ...diagnostic, code: 'bad\u0000code' }] },
      { ...envelope, records: [{ ...exportedRecord, identity: { name: 'me', domain: 'other' } }] },
      { ...envelope, records: [{ ...exportedRecord, workspace: 'unbounded' }] },
      {
        ...envelope,
        records: [
          { ...exportedRecord, route: { ...exportedRecord.route, argv: ['sh', '-c', 'evil'] } },
        ],
      },
    ]) {
      expect(() => parseSessionResurrectionExport(malicious)).toThrow();
    }
  });

  it('projects only approved public fields while retaining native resume diagnostics', () => {
    const projected = projectSessionResurrectionRecord(sourceRecord);
    expect(projected).toEqual(exportedRecord);
    const serialized = JSON.stringify(projected);
    for (const secret of [
      'private-binding',
      'private-token',
      'secret-model',
      'secret prompt',
      'secret note',
      'private-process',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
