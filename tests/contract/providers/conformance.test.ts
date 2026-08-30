import { describe } from 'vitest';
import {
  ISSUE_CAPABILITIES,
  ProviderError,
  type IssueCapability,
  type IssueCommentV1,
  type IssueV1,
} from '@mpx/providers';
import { defineIssueAdapterConformance, type IssueConformanceDriver } from '@mpx/providers/testing';

const withoutMove = ISSUE_CAPABILITIES.filter((capability) => capability !== 'issue.move');

function fakeBackend(
  providerId: string,
  capabilities: readonly IssueCapability[],
): () => IssueConformanceDriver {
  return () => {
    let nextId = 2;
    const issues = new Map<string, IssueV1>([
      [
        '1',
        {
          schemaVersion: 1,
          id: '1',
          title: 'Seed',
          body: 'Initial',
          state: 'open',
          labels: [],
          providerData: { [providerId]: { nativeId: 'native-1' } },
        },
      ],
    ]);
    const invoke = async (
      capability: IssueCapability,
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!capabilities.includes(capability)) {
        throw new ProviderError('CAPABILITY_UNSUPPORTED', `${capability} is unsupported.`, {
          capability,
        });
      }
      const id = String(input.id ?? '');
      switch (capability) {
        case 'issue.list':
          return [...issues.values()];
        case 'issue.view':
          return issues.get(id);
        case 'issue.create': {
          const created: IssueV1 = {
            schemaVersion: 1,
            id: String(nextId++),
            title: String(input.title),
            body: String(input.body),
            state: 'open',
            labels: [],
            providerData: { [providerId]: { nativeId: `native-${nextId - 1}` } },
          };
          issues.set(created.id, created);
          return created;
        }
        case 'issue.edit':
          return replace(id, { title: String(input.title), body: String(input.body) });
        case 'issue.comment': {
          const comment: IssueCommentV1 = {
            schemaVersion: 1,
            id: 'comment-1',
            issueId: id,
            body: String(input.body),
            author: 'fake',
            createdAt: '2026-01-02T03:04:05Z',
            providerData: { [providerId]: { nativeId: 'note-1' } },
          };
          return comment;
        }
        case 'issue.label':
          return replace(id, { labels: [...(issues.get(id)?.labels ?? []), String(input.label)] });
        case 'issue.move':
          return replace(id, {
            providerData: { [providerId]: { column: String(input.destination) } },
          });
        case 'issue.finish':
          return replace(id, { state: 'finished' });
      }
    };
    const replace = (id: string, patch: Partial<IssueV1>): IssueV1 => {
      const current = issues.get(id);
      if (!current) {
        throw new Error(`missing fake issue ${id}`);
      }
      const changed = { ...current, ...patch };
      issues.set(id, changed);
      return changed;
    };
    return { capabilities, invoke };
  };
}

describe('issue conformance driver', () => {
  defineIssueAdapterConformance('move-capable fake', fakeBackend('fake', ISSUE_CAPABILITIES));
  defineIssueAdapterConformance('move-limited fake', fakeBackend('fake', withoutMove));
});
