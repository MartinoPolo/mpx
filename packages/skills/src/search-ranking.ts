export interface SearchRankingCandidate {
  readonly identity: string;
  readonly publicName: string;
  readonly description: string;
  readonly triggers?: string;
}

export interface RankedSearchCandidate {
  readonly identity: string;
  readonly publicName: string;
  readonly description: string;
  readonly score: number;
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function scoreCandidate(candidate: SearchRankingCandidate, terms: readonly string[]): number {
  const haystack =
    `${candidate.identity} ${candidate.description} ${candidate.triggers ?? ''}`.toLowerCase();
  return terms.reduce(
    (total, term) =>
      total + (haystack.includes(term) ? (candidate.identity.includes(term) ? 3 : 1) : 0),
    0,
  );
}

export function rankSearchCandidates(
  candidates: readonly SearchRankingCandidate[],
  query: string,
  limit: number | undefined,
  maxResults: number,
): RankedSearchCandidate[] {
  const terms = searchTerms(query);
  const boundedLimit = Math.max(0, Math.min(maxResults, limit ?? maxResults));
  return candidates
    .map((candidate) => ({
      identity: candidate.identity,
      publicName: candidate.publicName,
      description: candidate.description,
      score: scoreCandidate(candidate, terms),
    }))
    .filter((candidate) => terms.length === 0 || candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity))
    .slice(0, boundedLimit);
}
