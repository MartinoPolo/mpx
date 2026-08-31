import {
  catalogError,
  type CatalogSkill,
  type RuntimeSkillArtifact,
  type RuntimeSkillEntry,
} from './contracts.js';
import { isProjectSkill } from './inventory.js';
import { validateArtifact } from './artifact.js';

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
  const limit = Math.max(0, Math.min(options.maxResults, options.limit ?? options.maxResults));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const source = new Map(catalog.map((skill) => [skill.identity, skill]));
  return artifact.entries
    .filter(options.allowsEntry)
    .flatMap((entry) => {
      const skill = source.get(entry.identity);
      if (!skill) {
        return [];
      }
      const haystack =
        `${skill.identity} ${skill.description} ${isProjectSkill(skill) ? '' : (skill.triggers ?? '')}`.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total + (haystack.includes(term) ? (skill.identity.includes(term) ? 3 : 1) : 0),
        0,
      );
      return [
        {
          identity: skill.identity,
          publicName: entry.publicName,
          description: skill.description,
          score,
        },
      ];
    })
    .filter((result) => terms.length === 0 || result.score > 0)
    .sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity))
    .slice(0, limit);
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
