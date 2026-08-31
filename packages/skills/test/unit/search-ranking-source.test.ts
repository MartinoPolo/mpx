import { expect, it } from 'vitest';
import { rankSearchCandidatesSource } from '../../src/index.js';
import { rankSearchCandidates } from '../../src/search-ranking.js';

const candidates = [
  {
    identity: 'alpha-deploy',
    publicName: '/mpx:alpha-deploy',
    description: 'Release planner orange',
    triggers: 'ship beta',
  },
  {
    identity: 'beta-review',
    publicName: '/mpx:beta-review',
    description: 'Alpha release checklist',
    triggers: 'deploy audit',
  },
  {
    identity: 'gamma-tools',
    publicName: '/mpx:gamma-tools',
    description: 'Gamma helper',
    triggers: 'alpha release',
  },
  {
    identity: 'delta-empty',
    publicName: '/mpx:delta-empty',
    description: 'No relevant words',
  },
  {
    identity: 'aardvark-tie',
    publicName: '/mpx:aardvark-tie',
    description: 'Common task',
  },
  {
    identity: 'zebra-tie',
    publicName: '/mpx:zebra-tie',
    description: 'Common task',
  },
] as const;

const alpha = {
  identity: 'alpha-deploy',
  publicName: '/mpx:alpha-deploy',
  description: 'Release planner orange',
  score: 3,
};
const beta = {
  identity: 'beta-review',
  publicName: '/mpx:beta-review',
  description: 'Alpha release checklist',
  score: 1,
};
const gamma = {
  identity: 'gamma-tools',
  publicName: '/mpx:gamma-tools',
  description: 'Gamma helper',
  score: 1,
};
const zeroScoreResults = [
  {
    identity: 'aardvark-tie',
    publicName: '/mpx:aardvark-tie',
    description: 'Common task',
    score: 0,
  },
  { ...alpha, score: 0 },
  { ...beta, score: 0 },
  {
    identity: 'delta-empty',
    publicName: '/mpx:delta-empty',
    description: 'No relevant words',
    score: 0,
  },
  { ...gamma, score: 0 },
  {
    identity: 'zebra-tie',
    publicName: '/mpx:zebra-tie',
    description: 'Common task',
    score: 0,
  },
];
const rankingOracle = [
  { query: 'alpha', limit: undefined, maxResults: 20, expected: [alpha, beta, gamma] },
  {
    query: '  AlPhA   ReLeAsE  ',
    limit: undefined,
    maxResults: 20,
    expected: [
      { ...alpha, score: 4 },
      { ...beta, score: 2 },
      { ...gamma, score: 2 },
    ],
  },
  { query: '', limit: undefined, maxResults: 20, expected: zeroScoreResults },
  { query: 'missing', limit: undefined, maxResults: 20, expected: [] },
  {
    query: 'common',
    limit: undefined,
    maxResults: 20,
    expected: [
      {
        identity: 'aardvark-tie',
        publicName: '/mpx:aardvark-tie',
        description: 'Common task',
        score: 1,
      },
      {
        identity: 'zebra-tie',
        publicName: '/mpx:zebra-tie',
        description: 'Common task',
        score: 1,
      },
    ],
  },
  { query: 'common', limit: -1, maxResults: 20, expected: [] },
  { query: 'common', limit: 0, maxResults: 20, expected: [] },
  { query: '', limit: 99, maxResults: 3, expected: zeroScoreResults.slice(0, 3) },
] as const;

type Ranker = typeof rankSearchCandidates;

function expectRankingOracle(ranker: Ranker): void {
  for (const { query, limit, maxResults, expected } of rankingOracle) {
    expect(
      ranker(candidates, query, limit, maxResults),
      `${JSON.stringify(query)}:${limit}`,
    ).toEqual(expected);
  }
}

it('ranks candidates with the exact canonical weighting, accumulation, ordering, shape, and limits', () => {
  expectRankingOracle(rankSearchCandidates);
});

it('emits self-contained JavaScript with the exact search ranking behavior', async () => {
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export default ${rankSearchCandidatesSource}`)}`;
  const emitted = (await import(moduleUrl)).default as Ranker;

  expectRankingOracle(emitted);
  expect(rankSearchCandidatesSource).not.toMatch(/searchTerms|scoreCandidate/u);
});
