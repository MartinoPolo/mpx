import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, expectTypeOf, it } from 'vitest';
import * as skills from '../../src/index.js';
import type {
  CanonicalSkill,
  CatalogSkill,
  Diagnostic,
  Exposure,
  ExposureSettings,
  HumanSkillName,
  LoadedSkillBody,
  ProjectSkill,
  ProjectSkillDirectory,
  ProjectSkillDirectoryEntry,
  ProjectSkillFileSystem,
  ResolveOptions,
  ResolvedManifest,
  Runtime,
  RuntimeSkillArtifact,
  RuntimeSkillEntry,
  SkillBodyRequest,
  SkillDirectoryFile,
  SkillInvocation,
  SkillPack,
  SkillPolicyConfig,
} from '../../src/index.js';

type EstablishedPublicTypes = [
  CanonicalSkill,
  CatalogSkill,
  Diagnostic,
  Exposure,
  ExposureSettings,
  HumanSkillName,
  LoadedSkillBody,
  ProjectSkill,
  ProjectSkillDirectory,
  ProjectSkillDirectoryEntry,
  ProjectSkillFileSystem,
  ResolveOptions,
  ResolvedManifest,
  Runtime,
  RuntimeSkillArtifact,
  RuntimeSkillEntry,
  SkillBodyRequest,
  SkillDirectoryFile,
  SkillInvocation,
  SkillPack,
  SkillPolicyConfig,
];

it('keeps the root runtime facade limited to the established export names', () => {
  expect(Object.keys(skills).sort()).toEqual([
    'EXPOSURES',
    'MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH',
    'MAX_HUMAN_SKILL_SEARCH_RESULTS',
    'MAX_PROJECT_SKILL_CANDIDATES',
    'MAX_PROJECT_SKILL_DIRECTORY_ENTRIES',
    'MAX_PROJECT_SKILL_INVENTORY_BYTES',
    'MAX_SKILL_BODY_BYTES',
    'MAX_SKILL_DIRECTORY_BYTES',
    'MAX_SKILL_DIRECTORY_DEPTH',
    'MAX_SKILL_DIRECTORY_DIRECTORIES',
    'MAX_SKILL_DIRECTORY_FILES',
    'MAX_SKILL_SEARCH_QUERY_LENGTH',
    'MAX_SKILL_SEARCH_RESULTS',
    'SKILL_MANIFEST_SCHEMA_VERSION',
    'SKILL_PACKS',
    'SkillCatalogError',
    'createRuntimeSkillArtifact',
    'doctor',
    'enumerateSkillDirectory',
    'explainSkill',
    'humanCompleteSkills',
    'humanListSkills',
    'humanSearchSkills',
    'humanSkillDetail',
    'initialModelContext',
    'inventoryCanonical',
    'inventoryProjectSkills',
    'loadSkillBody',
    'modelSearchSkills',
    'resolveManifest',
    'searchSkills',
    'verifyRuntimeSkillArtifact',
  ]);
});

it('preserves every established root type-level consumer contract', () => {
  expectTypeOf<EstablishedPublicTypes>().toEqualTypeOf<EstablishedPublicTypes>();
  expectTypeOf<Exposure>().toEqualTypeOf<'full' | 'name-only' | 'explicit-only' | 'off'>();
  expectTypeOf<SkillPack>().toEqualTypeOf<'core' | 'work' | 'personal'>();
  expectTypeOf<ExposureSettings>().toMatchTypeOf<{
    default?: Exposure;
    skills?: Record<string, Exposure>;
  }>();
  expectTypeOf<SkillPolicyConfig>().toMatchTypeOf<{
    skillPacks?: SkillPack[];
    skillExposure: ExposureSettings & { default: Exposure };
  }>();
  expectTypeOf<CanonicalSkill>().toMatchTypeOf<{
    identity: string;
    skillPacks: SkillPack[];
    defaultExposure: Exposure;
  }>();
  expectTypeOf<ResolveOptions['skillPolicyConfig']>().toEqualTypeOf<SkillPolicyConfig>();
});

it('keeps production skills source independent from config and runtime adapters', async () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../../src');
  const source = await Promise.all(
    (await readdir(sourceRoot, { recursive: true }))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => readFile(path.join(sourceRoot, entry), 'utf8')),
  );
  expect(source.join('\n')).not.toMatch(/@mpx\/config|runtime[-/]adapter/iu);
});
