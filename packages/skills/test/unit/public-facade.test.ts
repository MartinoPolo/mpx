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
  ModelSearchSkillProjectionOptions,
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
  SkillProjectionBodyRequest,
  SkillProjectionDisclosure,
  SkillProjectionFile,
  SkillProjectionPlan,
  SkillProjectionPlanEntry,
  SkillProjectionPlanInput,
  SkillProjectionSearchResult,
} from '../../src/index.js';

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
    'createSkillProjectionPlan',
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
    'loadSkillProjectionBody',
    'modelSearchSkillProjection',
    'modelSearchSkills',
    'rankSearchCandidatesSource',
    'resolveManifest',
    'searchSkills',
    'verifyRuntimeSkillArtifact',
    'verifySkillProjectionPlan',
  ]);
});

it('preserves established root type-level consumer contracts', () => {
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

it('exposes consumer-shaped established API types from the root', () => {
  expectTypeOf(skills.inventoryCanonical).returns.resolves.items.toMatchTypeOf<CatalogSkill>();
  expectTypeOf<
    InstanceType<typeof skills.SkillCatalogError>['diagnostics'][number]
  >().toEqualTypeOf<Diagnostic>();
  expectTypeOf(skills.resolveManifest).returns.toEqualTypeOf<ResolvedManifest>();
  expectTypeOf(skills.createRuntimeSkillArtifact).returns.toEqualTypeOf<RuntimeSkillArtifact>();
  expectTypeOf<RuntimeSkillArtifact['runtime']>().toEqualTypeOf<Runtime>();
  expectTypeOf<RuntimeSkillArtifact['entries'][number]>().toEqualTypeOf<RuntimeSkillEntry>();
  expectTypeOf(
    skills.enumerateSkillDirectory,
  ).returns.resolves.items.toEqualTypeOf<SkillDirectoryFile>();
  expectTypeOf(skills.loadSkillBody).parameter(0).toEqualTypeOf<SkillBodyRequest>();
  expectTypeOf(skills.loadSkillBody).returns.resolves.toEqualTypeOf<LoadedSkillBody>();
  expectTypeOf<SkillBodyRequest['invocation']>().toEqualTypeOf<SkillInvocation>();
  expectTypeOf(skills.humanListSkills).returns.items.toEqualTypeOf<HumanSkillName>();
});

it('exposes consumer-shaped projection plan API types from the root', () => {
  expectTypeOf(skills.createSkillProjectionPlan)
    .parameter(0)
    .toEqualTypeOf<SkillProjectionPlanInput>();
  expectTypeOf(skills.createSkillProjectionPlan).returns.toEqualTypeOf<
    Promise<SkillProjectionPlan>
  >();
  expectTypeOf<SkillProjectionPlan['entries'][number]>().toEqualTypeOf<SkillProjectionPlanEntry>();
  expectTypeOf<SkillProjectionPlanEntry['skillFile']>().toEqualTypeOf<SkillProjectionFile>();
  expectTypeOf<
    SkillProjectionPlan['initialModelContext'][number]
  >().toEqualTypeOf<SkillProjectionDisclosure>();
  expectTypeOf(skills.verifySkillProjectionPlan).parameter(0).toEqualTypeOf<SkillProjectionPlan>();
  expectTypeOf(skills.verifySkillProjectionPlan).returns.toEqualTypeOf<SkillProjectionPlan>();
  expectTypeOf(skills.loadSkillProjectionBody)
    .parameter(1)
    .toEqualTypeOf<SkillProjectionBodyRequest>();
  expectTypeOf(skills.modelSearchSkillProjection)
    .parameter(2)
    .toEqualTypeOf<ModelSearchSkillProjectionOptions>();
  expectTypeOf(
    skills.modelSearchSkillProjection,
  ).returns.items.toEqualTypeOf<SkillProjectionSearchResult>();
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
