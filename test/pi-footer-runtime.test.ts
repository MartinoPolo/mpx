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
  assert.ok(component.render(100)[4]!.startsWith('\x1b[38;5;208m50.0k (40%)'), 'color uses the loaded compaction reserve, not the window percentage');
  testContext.mock.timers.tick(1001);
  component.update(context);
  await flush();
  assert.equal(settingsLoads, 2);
  assert.ok(component.render(100)[4]!.startsWith('\x1b[38;5;208m'), 'transient settings failure preserves the last valid threshold');
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

test('runtime uses structured glyph targets for independent history and model controls and preserves expansion', () => {
  let renders = 0;
  let agents = [
    { id: 'a', type: 'reviewer', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 1000, cost: 0 },
    { id: 'b', type: 'planner', status: 'done', model: 'gpt-6-terra', effort: 'low', peakInputTokens: 500, cost: 1 },
  ];
  const context = {
    cwd: process.cwd(), model: undefined, thinkingLevel: 'high',
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => 'mouse-session', getLeafId: () => null },
    getContextUsage: () => ({ tokens: 1000, percent: 1, contextWindow: 100_000 }),
  } as unknown as ExtensionContext;
  const component = createPiFooterComponent(
    { getSessionName: () => undefined } as unknown as ExtensionAPI, context, { requestRender: () => { renders++; } },
    { fg: (_color, text) => text, bold: text => text },
    { getGitBranch: () => 'main', getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
    {}, () => agents,
    async cwd => fallbackFooterRepository(cwd), async () => undefined, async () => undefined,
  );
  const click = (x: number, y: number): TuiMouseEvent => ({ type: 'click', button: 'left', x, y, screenX: x + 20, screenY: y + 10, width: 120, height: 20, shift: false, alt: false, ctrl: false });
  let text = component.render(120).map(stripTerminalSequences);
  let historyRow = text.indexOf('▾ History (2)');
  assert.ok(historyRow > 1);
  assert.equal(text[0], '─'.repeat(120));
  assert.equal(component.handleMouse?.(click(0, 0)), undefined, 'the rule has no disclosure target');
  assert.equal(text.filter(line => /^  ▸ /.test(line)).length, 2, 'details are closed by default');
  assert.equal(component.handleMouse?.(click(1, historyRow)), undefined);
  component.handleMouse?.(click(0, historyRow));
  text = component.render(120).map(stripTerminalSequences);
  assert.ok(text.length > 1, 'history collapse does not collapse the operational footer');
  assert.equal(text.filter(line => line.includes('History')).length, 1);
  assert.match(text.at(-1)!, /^▸ History \(2\).*Luna 6 ×1.*Terra 6 ×1/);

  historyRow = text.length - 1;
  component.handleMouse?.(click(0, historyRow));
  text = component.render(120).map(stripTerminalSequences);
  const lunaRow = text.findIndex(line => /^  ▸ Luna/.test(line));
  assert.ok(lunaRow > historyRow);
  assert.equal(component.handleMouse?.(click(0, lunaRow)), undefined, 'row text outside the indented glyph is inert');
  component.handleMouse?.(click(2, lunaRow));
  text = component.render(120).map(stripTerminalSequences);
  assert.ok(text.some(line => /^    ✓ reviewer/.test(line)));
  assert.ok(text.some(line => /^  ▸ Terra/.test(line)));
  assert.doesNotMatch(text.join('\n'), /✓ planner/);
  component.update(context);
  assert.ok(component.render(120).map(stripTerminalSequences).some(line => /^    ✓ reviewer/.test(line)), 'normal data updates preserve model expansion');

  component.toggleView();
  assert.equal(component.render(120).length, 2);
  component.toggleView();
  assert.ok(component.render(120).map(stripTerminalSequences).some(line => /^    ✓ reviewer/.test(line)), 'full collapse preserves model expansion');

  component.setView('details');
  text = component.render(120).map(stripTerminalSequences);
  assert.ok(text.some(line => /^    ✓ reviewer/.test(line)) && text.some(line => /^    ✓ planner/.test(line)));
  component.setView('summary');
  text = component.render(120).map(stripTerminalSequences);
  assert.doesNotMatch(text.join('\n'), /^    [✓■×] /m, 'summary restores closed model groups');

  const priorLunaRow = text.findIndex(line => /^  ▸ Luna/.test(line));
  agents = [];
  component.update(context);
  assert.equal(component.handleMouse?.(click(2, priorLunaRow)), undefined, 'data refresh clears stale targets before rerender');
  agents = [
    { id: 'a', type: 'reviewer', status: 'done', model: 'gpt-6-luna', effort: 'high', peakInputTokens: 1000, cost: 0 },
    { id: 'b', type: 'planner', status: 'done', model: 'gpt-6-terra', effort: 'low', peakInputTokens: 500, cost: 1 },
  ];
  component.render(2);
  assert.equal(component.handleMouse?.(click(2, priorLunaRow)), undefined, 'a glyph clipped by narrow width has no active target');
  component.dispose();
  const before = renders;
  component.toggleView();
  assert.equal(renders, before);
});
