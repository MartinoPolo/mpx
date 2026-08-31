import {
  catalogError,
  type CatalogSkill,
  type RuntimeSkillArtifact,
  type RuntimeSkillEntry,
} from './contracts.js';
import { isProjectSkill } from './inventory.js';
import { validateArtifact } from './artifact.js';
import { rankSearchCandidates } from './search-ranking.js';

export const MAX_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_SKILL_SEARCH_RESULTS = 20;
export const MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH = 200;
export const MAX_HUMAN_SKILL_SEARCH_RESULTS = 20;

type SearchResult = {
  identity: string;
  publicName: string;
  description: string;
  score: number;
};

interface SearchPipelineOptions {
  artifactKey?: string;
  limit?: number;
  maxQueryLength: number;
  maxResults: number;
  queryDescription: string;
  allowsEntry(entry: RuntimeSkillEntry): boolean;
}

function runSearchPipeline(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: SearchPipelineOptions,
): SearchResult[] {
  if (query.length > options.maxQueryLength) {
    catalogError(
      'QUERY_TOO_LONG',
      `${options.queryDescription} are limited to ${options.maxQueryLength} characters`,
    );
  }
  validateArtifact(artifact, catalog, options.artifactKey);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  const candidates = artifact.entries.filter(options.allowsEntry).flatMap((entry) => {
    const skill = source.get(entry.identity);
    if (!skill) {
      return [];
    }
    return [
      {
        identity: skill.identity,
        publicName: entry.publicName,
        description: skill.description,
        ...(isProjectSkill(skill) || !skill.triggers ? {} : { triggers: skill.triggers }),
      },
    ];
  });
  return rankSearchCandidates(candidates, query, options.limit, options.maxResults);
}

export function searchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { artifactKey?: string; runtime?: boolean; limit?: number } = {},
): SearchResult[] {
  return runSearchPipeline(artifact, catalog, query, {
    maxQueryLength: MAX_SKILL_SEARCH_QUERY_LENGTH,
    maxResults: MAX_SKILL_SEARCH_RESULTS,
    queryDescription: 'skill search queries',
    allowsEntry: (entry) =>
      (entry.exposure === 'full' || entry.exposure === 'name-only') &&
      entry.permissions.modelInvocation,
    ...(options.runtime ? { artifactKey: options.artifactKey } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export function modelSearchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { artifactKey: string; limit?: number },
): SearchResult[] {
  return searchSkills(artifact, catalog, query, {
    runtime: true,
    artifactKey: options.artifactKey,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export function humanSearchSkills(
  artifact: RuntimeSkillArtifact,
  catalog: readonly CatalogSkill[],
  query: string,
  options: { limit?: number } = {},
): SearchResult[] {
  return runSearchPipeline(artifact, catalog, query, {
    maxQueryLength: MAX_HUMAN_SKILL_SEARCH_QUERY_LENGTH,
    maxResults: MAX_HUMAN_SKILL_SEARCH_RESULTS,
    queryDescription: 'human skill search queries',
    allowsEntry: (entry) => entry.permissions.humanInvocation,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}
