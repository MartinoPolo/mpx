import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type CiLogV1,
  type CiRetryV1,
  type CiStatusV1,
  type IssueCommentV1,
  type IssueV1,
  type ProviderDataV1,
  type ReviewCommentV1,
  type ReviewV1,
} from '@mpx/providers';

describe('versioned provider-neutral DTOs', () => {
  it('normalizes issue, review, comment, and CI records at schema version 1', () => {
    const providerData: ProviderDataV1 = { github: { nodeId: 'I_kwDO' } };
    const issue: IssueV1 = {
      schemaVersion: 1,
      id: '42',
      title: 'Ship',
      body: 'Details',
      state: 'open',
      labels: ['phase-e'],
      providerData,
    };
    const comment: IssueCommentV1 = {
      schemaVersion: 1,
      id: 'c1',
      issueId: issue.id,
      body: 'Working',
      author: 'octo',
      createdAt: '2026-01-02T03:04:05Z',
      providerData,
    };
    const commentWithoutUnavailableMetadata: IssueCommentV1 = {
      schemaVersion: 1,
      id: 'c2',
      issueId: issue.id,
      body: 'Working',
      providerData,
    };
    const review: ReviewV1 = {
      schemaVersion: 1,
      id: '7',
      title: 'Ship',
      state: 'draft',
      sourceBranch: 'feature',
      targetBranch: 'main',
      providerData,
    };
    const reviewComment: ReviewCommentV1 = {
      schemaVersion: 1,
      id: 'rc1',
      reviewId: review.id,
      body: 'Ready',
      author: 'octo',
      createdAt: '2026-01-02T03:04:05Z',
      providerData,
    };
    const ci: CiStatusV1 = {
      schemaVersion: 1,
      state: 'running',
      checks: [{ id: 'build', name: 'build', state: 'running', providerData }],
      providerData,
    };
    const ciLog: CiLogV1 = { schemaVersion: 1, id: 'run-1', content: 'safe log', providerData };
    const ciRetry: CiRetryV1 = { schemaVersion: 1, id: 'run-1', providerData };
    expect(commentWithoutUnavailableMetadata).not.toHaveProperty('author');
    expect(commentWithoutUnavailableMetadata).not.toHaveProperty('createdAt');
    expect({ issue, comment, review, reviewComment, ci, ciLog, ciRetry }).toMatchObject({
      issue: { schemaVersion: 1, state: 'open', providerData: { github: { nodeId: 'I_kwDO' } } },
      comment: { schemaVersion: 1, issueId: '42' },
      review: { schemaVersion: 1, state: 'draft' },
      reviewComment: { schemaVersion: 1, reviewId: '7' },
      ci: { schemaVersion: 1, checks: [{ state: 'running' }] },
      ciLog: { schemaVersion: 1, id: 'run-1', content: 'safe log' },
      ciRetry: { schemaVersion: 1, id: 'run-1' },
    });
    expectTypeOf(issue.providerData).toEqualTypeOf<ProviderDataV1 | undefined>();
  });
});
