import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createPiFooterComponent } from '../src/pi-footer-runtime.js';
import { fallbackFooterRepository, type FooterRepository } from '../src/pi-footer-data.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

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
