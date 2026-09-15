import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { footerCompactions, footerSessionCost, parseFooterQuota, resolveFooterRepository, repositoryFooterLocation } from '../src/pi-footer-data.js';

test('quota uses response headers only and validates percentages and reset units', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(parseFooterQuota({
    'X-Codex-Primary-Used-Percent': '42.5',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': '120',
    'x-codex-secondary-used-percent': '18',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': String(now + 500_000),
  }, now), [
    { label: '5h', usedPercent: 42.5, resetAt: now + 120_000 },
    { label: '7d', usedPercent: 18, resetAt: now + 500_000 },
  ]);
  for (const value of ['', 'NaN', '-1', 'Infinity', '101']) {
    assert.equal(parseFooterQuota({ 'x-codex-primary-used-percent': value }, now), undefined);
  }
  assert.deepEqual(parseFooterQuota({ 'x-codex-primary-used-percent': '0', 'x-codex-primary-reset-at': '1800000120' }, now), [
    { label: '5h', usedPercent: 0, resetAt: now + 120_000 },
  ]);
  assert.deepEqual(parseFooterQuota({ 'x-codex-primary-used-percent': '5', 'x-codex-primary-reset-after-seconds': '-3' }, now), [
    { label: '5h', usedPercent: 5 },
  ]);
  assert.equal(parseFooterQuota({ authorization: 'not exposed' }, now), undefined);
});

test('cost includes native assistant, tool and summary usage without double counting retained tails', () => {
  const usage = (total: number) => ({ cost: { total } });
  assert.equal(footerSessionCost([
    { type: 'message', message: { role: 'assistant', usage: usage(0.2) } },
    { type: 'message', message: { role: 'toolResult', usage: usage(0.3) } },
    { type: 'compaction', usage: usage(0.4), retainedTail: [{ usage: usage(100) }] },
    { type: 'branch_summary', usage: usage(0.1) },
  ]), 1);
  assert.equal(footerSessionCost([]), 0);
  assert.equal(footerSessionCost([{ type: 'message', message: { role: 'assistant' } }]), undefined);
  assert.equal(footerSessionCost([{ type: 'compaction', usage: usage(NaN) }]), undefined);
});

test('compaction history preserves native pre-compaction tokens, reasons and links without summaries', () => {
  const rows = footerCompactions([
    { type: 'compaction', id: 'one', timestamp: '2026-09-14T10:00:00Z', tokensBefore: 123456, summary: 'private context' },
    { type: 'message', id: 'two' },
  ], new Map([['one', 'threshold']]), 'file:///C:/sessions/example.jsonl');
  assert.deepEqual(rows, [{ id: 'one', timestamp: '2026-09-14T10:00:00Z', reason: 'threshold', url: 'file:///C:/sessions/example.jsonl', tokensBefore: 123456 }]);
  assert.doesNotMatch(JSON.stringify(rows), /private context/);
  for (const tokensBefore of [undefined, null, -1, NaN, Infinity]) {
    assert.equal(footerCompactions([{ type: 'compaction', id: 'unknown', tokensBefore }], new Map())[0]?.tokensBefore, undefined);
  }
});

test('repository identity distinguishes project, actual checkout root and branch even from nested cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-footer-'));
  const project = path.join(root, 'project');
  const checkout = path.join(root, 'feature-checkout');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'pipe' });
  try {
    await mkdir(project);
    git(project, 'init', '-b', 'main');
    git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture');
    await writeFile(path.join(project, 'mpxconfig.json'), JSON.stringify({ projectId: 'owner/project', repository: { provider: 'github', remote: 'origin' }, issues: { provider: 'github' } }));
    git(project, 'remote', 'add', 'origin', 'git@github.com:owner/example.git');
    git(project, 'worktree', 'add', '-b', 'feature/footer', checkout);
    const nested = path.join(checkout, 'src');
    await mkdir(nested);
    const identity = await resolveFooterRepository(nested);
    const location = repositoryFooterLocation(identity, 'feature/footer');
    assert.equal(location.project, 'project');
    assert.equal(location.worktree, 'feature-checkout');
    assert.equal(location.branch, 'feature/footer');
    assert.equal(location.projectUrl, pathToFileURL(project).href);
    assert.equal(location.worktreeUrl, pathToFileURL(checkout).href);
    assert.equal(location.branchUrl, 'https://github.com/owner/example/tree/feature%2Ffooter');
    const renamed = repositoryFooterLocation(identity, 'fix/new');
    assert.equal(renamed.branchUrl, 'https://github.com/owner/example/tree/fix%2Fnew');
    const main = repositoryFooterLocation(await resolveFooterRepository(project), 'main');
    assert.equal(main.worktree, undefined);
    assert.equal(main.worktreeUrl, undefined);
    const sameBasename = repositoryFooterLocation({ ...identity, worktree: 'project', worktreeRoot: path.join(root, 'linked', 'project') }, 'feature/footer');
    assert.equal(sameBasename.worktree, 'project', 'a distinct linked checkout is not hidden just because its basename matches');
    const nongit = repositoryFooterLocation(await resolveFooterRepository(root), null);
    assert.equal(nongit.project, path.basename(root));
    assert.equal(nongit.worktree, undefined);
    assert.equal(nongit.branchUrl, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
