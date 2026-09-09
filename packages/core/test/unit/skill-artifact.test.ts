import { describe, expect, it } from 'vitest';
import {
  createSkillArtifactReference,
  isValidSkillArtifactReference,
  SKILL_ARTIFACT_SCHEMA_VERSION,
  type SkillArtifactFacts,
  type SkillArtifactReference,
} from '../../src/skill-artifact.js';
import { sha256Canonical } from '../../src/json.js';

const facts: SkillArtifactFacts = {
  runtime: 'pi',
  identity: 'personal',
  projectId: 'sample/app',
  repositoryId: 'sample/app',
  catalogHash: 'a'.repeat(64),
  selection: {
    location: { name: 'coding', canonicalRoot: 'C:/projects' },
    packs: ['development'],
    source: 'project',
  },
};

const cases: Array<
  [
    string,
    (value: SkillArtifactFacts) => SkillArtifactFacts,
    (value: SkillArtifactReference) => SkillArtifactReference,
  ]
> = [
  [
    'identity',
    (value) => ({ ...value, identity: 'work' }),
    (value) => ({ ...value, identity: 'work' }),
  ],
  [
    'repository',
    (value) => ({ ...value, repositoryId: 'sample/other' }),
    (value) => ({ ...value, repositoryId: 'sample/other' }),
  ],
  [
    'location name',
    (value) => ({
      ...value,
      selection: { ...value.selection, location: { ...value.selection.location, name: 'notes' } },
    }),
    (value) => ({ ...value, location: { ...value.location, name: 'notes' } }),
  ],
  [
    'location root',
    (value) => ({
      ...value,
      selection: {
        ...value.selection,
        location: { ...value.selection.location, canonicalRoot: 'C:/notes' },
      },
    }),
    (value) => ({ ...value, location: { ...value.location, canonicalRoot: 'C:/notes' } }),
  ],
  [
    'packs',
    (value) => ({ ...value, selection: { ...value.selection, packs: ['personal'] } }),
    (value) => ({ ...value, packs: ['personal'] }),
  ],
  [
    'selection source',
    (value) => ({ ...value, selection: { ...value.selection, source: 'user-project' } }),
    (value) => ({ ...value, selectionSource: 'user-project' }),
  ],
];

describe('skill artifact references', () => {
  it.each(cases)(
    'binds %s into selection and artifact integrity',
    (_label, changeFacts, tamper) => {
      const current = createSkillArtifactReference(facts);
      const changed = createSkillArtifactReference(changeFacts(facts));
      expect(SKILL_ARTIFACT_SCHEMA_VERSION).toBe(4);
      expect(changed.artifactKey).not.toBe(current.artifactKey);
      expect(isValidSkillArtifactReference(tamper(current))).toBe(false);
    },
  );

  it('rejects malformed untrusted references without throwing', () => {
    const current = createSkillArtifactReference(facts);
    const malformed: unknown[] = [
      null,
      {},
      { ...current, unexpected: true },
      { ...current, runtime: 'other' },
      { ...current, identity: '' },
      { ...current, projectId: 42 },
      { ...current, projectId: 'not-canonical' },
      { ...current, repositoryId: '' },
      { ...current, catalogHash: 'not-a-digest' },
      { ...current, location: null },
      { ...current, location: { ...current.location, unexpected: true } },
      { ...current, location: { ...current.location, canonicalRoot: 'relative' } },
      { ...current, packs: null },
      { ...current, packs: ['personal', 'development'] },
      { ...current, selectionSource: 'directory' },
      { ...current, selectionHash: 'not-a-digest' },
    ];

    expect(malformed.map((value) => isValidSkillArtifactReference(value))).toEqual(
      malformed.map(() => false),
    );
  });

  it('rejects a type-invalid reference even when an attacker recomputes both integrity hashes', () => {
    const current = createSkillArtifactReference(facts);
    const selectionTuple = {
      identity: 42,
      projectId: current.projectId,
      repositoryId: current.repositoryId,
      location: current.location,
      packs: [...current.packs],
      source: current.selectionSource,
    };
    const selectionHash = sha256Canonical(selectionTuple);
    const forgedTuple = {
      schemaVersion: current.schemaVersion,
      runtime: current.runtime,
      identity: 42,
      projectId: current.projectId,
      repositoryId: current.repositoryId,
      catalogHash: current.catalogHash,
      location: current.location,
      packs: [...current.packs],
      selectionSource: current.selectionSource,
      selectionHash,
    };
    const forged = { ...forgedTuple, artifactKey: sha256Canonical(forgedTuple) };

    expect(isValidSkillArtifactReference(forged)).toBe(false);
  });

  it('rejects references from the previous schema', () => {
    const current = createSkillArtifactReference(facts);
    const old = { ...current, schemaVersion: 3 } as unknown as SkillArtifactReference;
    expect(isValidSkillArtifactReference(old)).toBe(false);
  });
});
