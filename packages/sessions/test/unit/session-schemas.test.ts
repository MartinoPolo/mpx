import { expect, it } from 'vitest';
import { parseSessionRecord, stableDigest, type LaunchSnapshot } from '../../src/index.js';

const launch: LaunchSnapshot = {
  launchKey: 'launch',
  descriptorDigest: 'a'.repeat(64),
  mode: 'project',
  selection: {
    location: { name: 'coding', canonicalRoot: 'C:/projects' },
    packs: ['development'],
    source: 'project',
  },
  executor: { kind: 'docker' },
  workspace: 'clone',
  networkPolicy: 'implementation',
  artifactKey: 'artifact',
  manifestKey: 'manifest',
};
const record = {
  schemaVersion: 2,
  recordId: 'record',
  runtimeQualifiedId: 'claude:native',
  runtime: 'claude',
  identity: { domain: 'personal', name: 'personal' },
  nativeBindingRef: 'binding',
  nativeSessionRef: { kind: 'native-id', value: 'native' },
  launch,
  location: {
    cwd: 'C:/projects/repo',
    project: 'sample/app',
    repository: 'sample/app',
    worktree: null,
  },
  metadata: { title: null, model: null, effort: null },
  liveness: 'inactive',
  process: null,
  workflow: {
    status: 'paused',
    inbox: false,
    nextAction: null,
    note: null,
    relatedIssue: null,
    relatedReview: null,
    priority: null,
  },
  resume: { state: 'blocked', diagnostic: null, lastVerifiedAt: null, lastPlanDigest: null },
  timestamps: {
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastActivityAt: null,
  },
  lifecycle: { bindingId: null, sequence: 0, timestamp: null },
} as const;

it('accepts session record schema v2 selection and rejects retired launch rights', () => {
  expect(parseSessionRecord(record).launch).toEqual(launch);
  expect(() =>
    parseSessionRecord({
      ...record,
      launch: { ...launch, skillPolicy: 'clean', contentScope: 'coding', grants: [] },
    }),
  ).toThrowError(expect.objectContaining({ code: 'SESSION_UNKNOWN_FIELD' }));
});

it('normalizes equivalent pack ordering to the same session launch binding', () => {
  const personalFirst = parseSessionRecord({
    ...record,
    launch: { ...launch, selection: { ...launch.selection, packs: ['personal', 'development'] } },
  });
  const developmentFirst = parseSessionRecord({
    ...record,
    launch: { ...launch, selection: { ...launch.selection, packs: ['development', 'personal'] } },
  });

  expect(stableDigest(personalFirst.launch)).toBe(stableDigest(developmentFirst.launch));
});

it('rejects unknown fields in a session skill selection', () => {
  expect(() =>
    parseSessionRecord({
      ...record,
      launch: {
        ...launch,
        selection: {
          ...launch.selection,
          location: { ...launch.selection.location, unexpected: true },
        },
      },
    }),
  ).toThrowError(expect.objectContaining({ code: 'SESSION_UNKNOWN_FIELD' }));
});
