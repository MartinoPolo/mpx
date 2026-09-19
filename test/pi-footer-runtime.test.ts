import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TuiMouseEvent } from '@earendil-works/pi-tui';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { createPiFooterComponent } from '../src/pi-footer-runtime.js';
import { fallbackFooterRepository, type FooterRepository } from '../src/pi-footer-data.js';
import type { FooterReview } from '../src/pi-footer.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('review refreshes at startup, branch changes, and the clock without render or update lookups or stale branch data', async (testContext) => {
  testContext.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  let branch = 'main';
  let branchChanged = () => {};
  const reviewRequests: Array<{ branch: string | null; resolve: (review: FooterReview | undefined) => void }> = [];
  const repository: FooterRepository = {
    project: 'project', projectRoot: '/project', worktree: 'project', worktreeRoot: '/project',
    provider: 'github', repositoryUrl: 'https://github.com/owner/project',
    reviewRepository: { provider: 'github', target: 'github.com/owner/project', url: 'https://github.com/owner/project' },
  };
  const context = {
    cwd: process.cwd(), model: undefined,
    sessionManager: {
      getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined,
      getSessionId: () => 'review-session', getLeafId: () => null,
    },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;
  const component = createPiFooterComponent(
    { getSessionName: () => undefined } as unknown as ExtensionAPI,
    context, { requestRender: () => {} },
    { fg: (_color, text) => text, bold: text => text },
    {
      getGitBranch: () => branch, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
      onBranchChange: callback => { branchChanged = callback; return () => {}; },
    }, {}, () => [], async () => repository, async () => undefined, async () => undefined,
    async (_repository, requestedBranch) => new Promise(resolve => reviewRequests.push({ branch: requestedBranch, resolve })),
  );
  component.setView('summary');
  await flush();
  assert.deepEqual(reviewRequests.map(request => request.branch), ['main']);
  component.render(100);
  component.update(context);
  component.render(100);
  assert.equal(reviewRequests.length, 1, 'render and ordinary updates perform no network lookup');

  branch = 'feature/next';
  branchChanged();
  await flush();
  reviewRequests[0]!.resolve({ provider: 'github', number: 1, url: 'https://github.com/owner/project/pull/1' });
  await flush();
  assert.equal(component.render(100).some(line => line.includes('PR #1')), false, 'prior-branch review is never shown');
  assert.deepEqual(reviewRequests.map(request => request.branch), ['main', 'feature/next']);
  reviewRequests[1]!.resolve({ provider: 'github', number: 2, url: 'https://github.com/owner/project/pull/2' });
  await flush();
  assert.ok(component.render(100).some(line => line.includes('PR #2')));

  testContext.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(reviewRequests.map(request => request.branch), ['main', 'feature/next', 'feature/next']);
  component.dispose();
});

test('footer refreshes coalesce, retain valid settings on failure, and fence disposal', async (testContext) => {
  testContext.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const pending: Array<(repository: FooterRepository) => void> = [];
  let loads = 0;
  let settingsLoads = 0;
  let renders = 0;
  let branchChanged = () => {};
  let unsubscribed = 0;
  const context = {
    cwd: process.cwd(),
    model: undefined,
    sessionManager: {
      getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined,
      getSessionId: () => 'footer-session', getLeafId: () => null,
    },
    getContextUsage: () => ({ tokens: 50_000, percent: 40, contextWindow: 100_000 }),
  } as unknown as ExtensionContext;
  const component = createPiFooterComponent(
    { getSessionName: () => undefined } as unknown as ExtensionAPI,
    context, { requestRender: () => { renders++; } },
    { fg: (_color, text) => text, bold: text => text },
    {
      getGitBranch: () => 'main', getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
      onBranchChange: callback => { branchChanged = callback; return () => { unsubscribed++; }; },
    }, {}, () => [],
    () => { loads++; return new Promise(resolve => pending.push(resolve)); },
    async () => settingsLoads++ === 0 ? { enabled: true, reserveTokens: 40_000 } : undefined,
  );
  component.setView('summary');
  for (let index = 0; index < 20; index++) branchChanged();
  assert.equal(loads, 1);
  pending.shift()!(fallbackFooterRepository(context.cwd));
  await flush();
  assert.equal(loads, 2, 'one coalesced refresh, not one process group per watcher event');
  assert.ok(component.render(100)[3]!.startsWith('\x1b[38;5;208m50.0k (40%)'), 'color uses the loaded compaction reserve, not the window percentage');
  testContext.mock.timers.tick(1001);
  component.update(context);
  await flush();
  assert.equal(settingsLoads, 2);
  assert.ok(component.render(100)[3]!.startsWith('\x1b[38;5;208m'), 'transient settings failure preserves the last valid threshold');
  const rendersBeforeDisposal = renders;
  component.dispose();
  branchChanged();
  pending.shift()!(fallbackFooterRepository(context.cwd));
  await flush();
  assert.equal(loads, 2);
  assert.equal(renders, rendersBeforeDisposal);
  assert.equal(unsubscribed, 1);
  assert.deepEqual(component.render(100), []);
});

test('runtime defaults to expanded footer with collapsed history and mouse controls toggle only on glyph cells', () => {
  let renders = 0;
  const context = {
    cwd: process.cwd(), model: undefined, thinkingLevel: 'high',
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => 'mouse-session', getLeafId: () => null },
    getContextUsage: () => ({ tokens: 1000, percent: 1, contextWindow: 100_000 }),
  } as unknown as ExtensionContext;
  const component = createPiFooterComponent(
    { getSessionName: () => undefined } as unknown as ExtensionAPI, context, { requestRender: () => { renders++; } },
    { fg: (_color, text) => text, bold: text => text },
    { getGitBranch: () => 'main', getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
    {}, () => [{ id: 'a', type: 'reviewer', status: 'done', model: 'gpt-5.6-luna', effort: 'high', tokens: 1000, cost: 0 }],
    async cwd => fallbackFooterRepository(cwd), async () => undefined, async () => undefined,
  );
  const click = (x: number, y: number): TuiMouseEvent => ({ type: 'click', button: 'left', x, y, screenX: x, screenY: y, width: 120, height: 20, shift: false, alt: false, ctrl: false });
  const summary = component.render(120).map(stripTerminalSequences);
  const historyRow = summary.indexOf('▸ History (1)');
  assert.ok(historyRow > 0);
  assert.equal(component.handleMouse?.(click(1, historyRow)), undefined);
  component.handleMouse?.(click(0, historyRow));
  assert.ok(component.render(120).map(stripTerminalSequences).includes('▾ History (1)'));
  assert.equal(component.handleMouse?.(click(1, 0)), undefined);
  component.handleMouse?.(click(0, 0));
  assert.equal(component.render(120).length, 1);
  component.dispose();
  const before = renders;
  component.toggleView();
  assert.equal(renders, before);
});
