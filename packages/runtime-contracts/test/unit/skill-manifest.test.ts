import { expect, it } from 'vitest';
import {
  RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION,
  RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION,
  createResolvedSkillManifest,
  parseResolvedSkillManifest,
} from '../../src/index.js';

it('binds resolved manifest v5 to explicit identity and location selection', () => {
  expect(RESOLVED_SKILL_MANIFEST_SCHEMA_VERSION).toBe(5);
  expect(RUNTIME_SKILL_ARTIFACT_SCHEMA_VERSION).toBe(5);
  const manifest = createResolvedSkillManifest({
    binding: {
      projectId: 'sample/app',
      repositoryId: 'sample/app',
      identity: 'personal',
      selection: {
        location: { name: 'coding', canonicalRoot: 'C:/projects' },
        packs: ['development'],
        source: 'project',
      },
    },
    decisions: [],
  });
  expect(parseResolvedSkillManifest(manifest)).toEqual(manifest);
  expect(manifest.schemaVersion).toBe(5);
});

it('rejects the removed off exposure in v5 manifests', () => {
  expect(() =>
    createResolvedSkillManifest({
      binding: {
        projectId: null,
        repositoryId: 'shell',
        identity: 'personal',
        selection: {
          location: { name: 'notes', canonicalRoot: 'C:/notes' },
          packs: ['personal'],
          source: 'user-location',
        },
      },
      decisions: [
        {
          identity: 'podcast',
          included: true,
          exclusionReasons: [],
          exposure: 'off' as never,
          permissions: { humanInvocation: true, modelInvocation: false },
          metadataHash: 'metadata',
          sourceHash: 'source',
        },
      ],
    }),
  ).toThrow(/exposure/u);
});
