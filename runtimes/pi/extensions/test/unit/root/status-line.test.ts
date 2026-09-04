import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildBranchUrl,
  buildCiUrl,
  buildCompareUrl,
  humanAge,
  parseDefaultBranch,
  parsePorcelainV2,
  parseWorktreePaths,
  resolveProjectLocation,
  timeUntil,
  toFileUrl,
  type MrFields,
} from '../../../lib/status-line.js';

function mergeRequest(provider: string, url: string): MrFields {
  return {
    timestamp: '',
    provider,
    iid: '',
    draft: '',
    conflicts: '',
    approved: '',
    approvalsRequired: '',
    approvalsLeft: '',
    status: '',
    notes: '',
    pipeline: '',
    url,
    fetchEpoch: '',
  };
}

test('builds provider-specific branch, compare, and CI URLs', () => {
  assert.equal(
    buildBranchUrl('git@github.com:owner/repo.git', 'feature/a b'),
    'https://github.com/owner/repo/tree/feature/a%20b',
  );
  assert.equal(
    buildCompareUrl('ssh://git@gitlab.example.com:2222/owner/repo.git', 'main', 'feature/x'),
    'https://gitlab.example.com/owner/repo/-/compare/main...feature/x',
  );
  assert.equal(buildCompareUrl('https://github.com/owner/repo.git', 'main', 'main'), '');
  assert.equal(buildBranchUrl('not-a-remote', 'main'), '');
  assert.equal(
    buildCiUrl(mergeRequest('github', 'https://host/pull/42')),
    'https://host/pull/42/checks',
  );
  assert.equal(
    buildCiUrl(mergeRequest('gitlab', 'https://host/merge_requests/42')),
    'https://host/merge_requests/42/pipelines',
  );
});

test('parses porcelain v2 branch and all working tree counters', () => {
  const status = parsePorcelainV2(
    [
      '# branch.head feature/test',
      '# branch.upstream origin/feature/test',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 abc abc staged.txt',
      '1 .M N... 100644 100644 100644 abc abc modified.txt',
      '2 MM N... 100644 100644 100644 abc abc R100 renamed.txt\told.txt',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflict.txt',
      '? untracked.txt',
      '',
    ].join('\n'),
  );

  assert.deepEqual(status, {
    branch: 'feature/test',
    hasUpstream: true,
    hasAheadBehind: true,
    ahead: 2,
    behind: 3,
    staged: 2,
    unstaged: 2,
    conflicts: 1,
    untracked: 1,
  });
  assert.equal(parsePorcelainV2('# branch.head (detached)\n').branch, 'detached');
});

test('parses default branch and resolves main checkout and linked worktree locations', () => {
  assert.equal(parseDefaultBranch('origin/HEAD\torigin/trunk\norigin/main\t\n'), 'trunk');
  assert.equal(parseWorktreePaths('C:/repo/.git\n'), undefined);

  const mainPaths = parseWorktreePaths('C:/repo/.git\nC:/repo\n');
  assert.ok(mainPaths);
  assert.deepEqual(resolveProjectLocation('C:/repo', mainPaths), {
    projectName: 'repo',
    projectUrl: 'file:///C:/repo/',
    worktreeName: '',
    worktreeUrl: '',
    projectDir: 'C:/repo',
  });

  const worktreePaths = parseWorktreePaths('C:/repo/.git\nC:/repo.worktrees/topic\n');
  assert.ok(worktreePaths);
  assert.deepEqual(resolveProjectLocation('C:/repo.worktrees/topic', worktreePaths), {
    projectName: 'repo',
    projectUrl: 'file:///C:/repo/',
    worktreeName: 'topic',
    worktreeUrl: 'file:///C:/repo.worktrees/topic/',
    projectDir: 'C:/repo',
  });
});

test('formats reset distances and compact ages', () => {
  assert.equal(timeUntil('91061', 1000), '1d 1h');
  assert.equal(
    timeUntil('2024-01-01T01:30:00.000Z', Date.parse('2024-01-01T00:00:00.000Z') / 1000),
    '1h 30m',
  );
  assert.equal(timeUntil('999', 1000), '');
  assert.equal(timeUntil('invalid', 1000), '');
  assert.equal(humanAge(45), '45s');
  assert.equal(humanAge('120'), '2m');
  assert.equal(humanAge(7200), '2h');
  assert.equal(humanAge(172800), '2d');
  assert.equal(humanAge('-1'), '?');
});

test('creates escaped file URLs without a trailing slash', () => {
  assert.equal(toFileUrl('C:\\repo\\a b\\x#y?.txt\\'), 'file:///C:/repo/a%20b/x%23y%3F.txt');
  assert.equal(toFileUrl('/home/user/repo/'), 'file:///home/user/repo');
});
