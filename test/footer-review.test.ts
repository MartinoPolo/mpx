import assert from 'node:assert/strict';
import test from 'node:test';
import type { FooterRepository } from '../src/pi-footer-data.js';
import { discoverFooterReview, type FooterReviewCommand } from '../src/footer-review.js';

function repository(provider: 'github' | 'gitlab', repositoryUrl: string): FooterRepository {
  const parsed = new URL(repositoryUrl);
  const projectPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
  return {
    project: 'project', projectRoot: '/projects/project', worktree: 'project', worktreeRoot: '/projects/project',
    provider, repositoryUrl,
    reviewRepository: { provider, target: `${parsed.host}/${projectPath}`, url: repositoryUrl },
  };
}

test('discovers an open GitHub pull request with an explicit repository target', async () => {
  const calls: Parameters<FooterReviewCommand>[] = [];
  const command: FooterReviewCommand = async (...parameters) => {
    calls.push(parameters);
    return { stdout: JSON.stringify([{ number: 42, title: 'Unicode 修正', url: 'https://github.com/owner/project/pull/42', headRefName: 'feature/footer', state: 'OPEN' }]) };
  };
  const review = await discoverFooterReview(repository('github', 'https://github.com/owner/project'), 'feature/footer', command);
  assert.deepEqual(review, { provider: 'github', number: 42, title: 'Unicode 修正', url: 'https://github.com/owner/project/pull/42' });
  assert.deepEqual(calls, [['gh', ['pr', 'list', '--repo', 'github.com/owner/project', '--head', 'feature/footer', '--state', 'open', '--limit', '1', '--json', 'number,title,url,headRefName,state'], { timeout: 3000 }]]);
});

test('discovers an open GitLab merge request on the configured self-hosted repository', async () => {
  const calls: Parameters<FooterReviewCommand>[] = [];
  const command: FooterReviewCommand = async (...parameters) => {
    calls.push(parameters);
    return { stdout: JSON.stringify([{ iid: 17, title: 'Footer', web_url: 'https://gitlab.corp.example/group/sub/project/-/merge_requests/17', source_branch: 'feature/footer', state: 'opened' }]) };
  };
  const review = await discoverFooterReview(repository('gitlab', 'https://gitlab.corp.example/group/sub/project'), 'feature/footer', command);
  assert.deepEqual(review, { provider: 'gitlab', number: 17, title: 'Footer', url: 'https://gitlab.corp.example/group/sub/project/-/merge_requests/17' });
  assert.deepEqual(calls, [['glab', ['mr', 'list', '--repo', 'https://gitlab.corp.example/group/sub/project', '--source-branch', 'feature/footer', '--output', 'json', '--per-page', '1'], { timeout: 3000 }]]);
});

test('skips lookup when the repository provider was not explicitly configured', async () => {
  let calls = 0;
  const command: FooterReviewCommand = async () => { calls++; return { stdout: '[]' }; };
  const inferred: FooterRepository = {
    project: 'project', projectRoot: '/projects/project', worktree: 'project', worktreeRoot: '/projects/project',
    provider: 'github', repositoryUrl: 'https://github.com/owner/project',
  };
  assert.equal(await discoverFooterReview(inferred, 'feature/footer', command), undefined);
  assert.equal(calls, 0);
});

test('returns no review when the provider reports no open review', async () => {
  const command: FooterReviewCommand = async () => ({ stdout: '[]' });
  assert.equal(await discoverFooterReview(repository('github', 'https://github.com/owner/project'), 'feature/footer', command), undefined);
  assert.equal(await discoverFooterReview(repository('gitlab', 'https://gitlab.example/group/project'), 'feature/footer', command), undefined);
});

test('rejects malformed provider output and untrusted review URLs', async () => {
  for (const stdout of [
    'not json',
    '{}',
    '[{"number":"42","url":"https://github.com/owner/project/pull/42"}]',
    '[{"number":42,"url":"https://evil.example/pull/42","headRefName":"feature/footer","state":"OPEN"}]',
    '[{"number":42,"url":"https://github.com/owner/project/pull/99","headRefName":"feature/footer","state":"OPEN"}]',
    '[{"number":42,"url":"https://github.com/owner/project/pull/42","headRefName":"other","state":"OPEN"}]',
    '[{"number":42,"url":"https://github.com/owner/project/pull/42\\u0000","headRefName":"feature/footer","state":"OPEN"}]',
  ]) {
    const command: FooterReviewCommand = async () => ({ stdout });
    assert.equal(await discoverFooterReview(repository('github', 'https://github.com/owner/project'), 'feature/footer', command), undefined);
  }
  const malformedGitLab: FooterReviewCommand = async () => ({ stdout: JSON.stringify([
    { iid: 17, web_url: 'https://gitlab.example/group/project/-/merge_requests/18', source_branch: 'feature/footer', state: 'opened' },
  ]) });
  assert.equal(await discoverFooterReview(repository('gitlab', 'https://gitlab.example/group/project'), 'feature/footer', malformedGitLab), undefined);
});

test('silently returns no review when a provider command is unavailable or fails', async () => {
  const command: FooterReviewCommand = async () => { throw new Error('missing CLI'); };
  assert.equal(await discoverFooterReview(repository('github', 'https://github.com/owner/project'), 'feature/footer', command), undefined);
  assert.equal(await discoverFooterReview(repository('gitlab', 'https://gitlab.example/group/project'), 'feature/footer', command), undefined);
});
