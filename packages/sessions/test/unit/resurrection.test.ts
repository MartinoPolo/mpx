import { describe, expect, it } from 'vitest';
import {
  parseSessionResurrectionExportV1,
  projectSessionResurrectionRecordV1,
  type SessionRecordV1,
} from '../../src/index.js';

const exportedRecord = {
  id: 'opaque-record',
  runtime: 'claude',
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
  schemaVersion: 1,
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
    skillPolicy: 'standard',
    contentScope: 'repo',
    executor: { kind: 'host' },
    workspace: 'direct',
    networkPolicy: 'restricted',
    grants: [{ access: 'credential', resource: 'private-token' }],
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
} as unknown as SessionRecordV1 & {
  readonly launch: NonNullable<SessionRecordV1['launch']>;
};

describe('session resurrection export protocol', () => {
  it('parses the exact versioned public DTO including liveness', () => {
    expect(
      parseSessionResurrectionExportV1({
        schemaVersion: 1,
        kind: 'session-resurrection-export',
        records: [exportedRecord],
      }),
    ).toEqual({ schemaVersion: 1, kind: 'session-resurrection-export', records: [exportedRecord] });
  });

  it('rejects unknown fields, versions, control characters, and forged routes', () => {
    const envelope = {
      schemaVersion: 1,
      kind: 'session-resurrection-export',
      records: [exportedRecord],
    };
    for (const malicious of [
      { ...envelope, credentials: 'secret' },
      { ...envelope, schemaVersion: 2 },
      { ...envelope, records: [{ ...exportedRecord, title: 'bad\u0000title' }] },
      { ...envelope, records: [{ ...exportedRecord, nativeSessionId: 'secret' }] },
      {
        ...envelope,
        records: [{ ...exportedRecord, identity: { name: 'me', domain: 'other' } }],
      },
      { ...envelope, records: [{ ...exportedRecord, workspace: 'unbounded' }] },
      { ...envelope, records: [{ ...exportedRecord, nativePathTranslation: 'private-path' }] },
      {
        ...envelope,
        records: [
          { ...exportedRecord, route: { ...exportedRecord.route, argv: ['sh', '-c', 'evil'] } },
        ],
      },
    ]) {
      expect(() => parseSessionResurrectionExportV1(malicious)).toThrow();
    }
  });

  it('projects only approved public fields and emits argv as data', () => {
    const projected = projectSessionResurrectionRecordV1(sourceRecord);
    expect(projected).toEqual(exportedRecord);
    const serialized = JSON.stringify(projected);
    for (const secret of [
      'private-native-id',
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
