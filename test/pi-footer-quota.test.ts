import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseFooterQuotaResponse, requestFooterQuota } from '../src/pi-footer-quota.js';

function token(account = 'acct-1'): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
  })).toString('base64url');
  return `header.${payload}.signature`;
}

function context(getter: (provider: string) => Promise<string | undefined>) {
  return { modelRegistry: { getApiKeyForProvider: getter } } as Pick<ExtensionContext, 'modelRegistry'>;
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

const usage = {
  rate_limit: {
    primary_window: { used_percent: 12.5, limit_window_seconds: 18_000, reset_after_seconds: 30 },
    secondary_window: { used_percent: 75, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
  },
};

test('parses usage response units, reset values, and defaults', () => {
  assert.deepEqual(parseFooterQuotaResponse(usage, 1_000), [
    { label: '5h', usedPercent: 12.5, resetAt: 31_000 },
    { label: '7d', usedPercent: 75, resetAt: 1_800_000_000_000 },
  ]);
  assert.deepEqual(parseFooterQuotaResponse({ rate_limit: {
    primary_window: { used_percent: 1 }, secondary_window: { used_percent: 2 },
  } }, 0), [
    { label: '5h', usedPercent: 1 }, { label: '7d', usedPercent: 2 },
  ]);
});

test('ignores invalid windows and unrelated response data', () => {
  assert.equal(parseFooterQuotaResponse(null, 0), undefined);
  assert.equal(parseFooterQuotaResponse({ plan_type: 'pro', rate_limit: {
    primary_window: { used_percent: -1 }, secondary_window: { used_percent: 101 },
  } }, 0), undefined);
  assert.deepEqual(parseFooterQuotaResponse({ rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: Number.NaN },
    secondary_window: { used_percent: 30, limit_window_seconds: 3600 },
  } }, 0), [{ label: '1h', usedPercent: 30 }]);
});

test('uses native provider getter and exact fixed request', async () => {
  const calls: unknown[][] = [];
  const fetcher: typeof fetch = async (...args) => {
    calls.push(args);
    return response(usage);
  };
  const result = await requestFooterQuota(context(async provider => {
    assert.equal(provider, 'openai-codex');
    return token('account-xyz');
  }), new AbortController().signal, fetcher);
  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'https://chatgpt.com/backend-api/wham/usage');
  const init = calls[0]![1] as RequestInit;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${token('account-xyz')}`, 'chatgpt-account-id': 'account-xyz' });
  assert.ok(init.signal instanceof AbortSignal);
});

test('missing and invalid JWT credentials do not request', async () => {
  for (const value of [undefined, '', 'not-a-jwt', token('bad\naccount')]) {
    let called = false;
    const result = await requestFooterQuota(context(async () => value), new AbortController().signal,
      async () => { called = true; throw new Error('must not request'); });
    assert.equal(result, undefined);
    assert.equal(called, false);
  }
});

test('network, non-OK, oversized, and malformed responses produce no observation', async () => {
  const ctx = context(async () => token());
  const signal = new AbortController().signal;
  assert.equal(await requestFooterQuota(ctx, signal, async () => { throw new Error('offline'); }), undefined);
  assert.equal(await requestFooterQuota(ctx, signal, async () => response({}, { status: 500 })), undefined);
  assert.equal(await requestFooterQuota(ctx, signal, async () => new Response('x'.repeat(65 * 1024))), undefined);
  assert.equal(await requestFooterQuota(ctx, signal, async () => new Response('{bad json')), undefined);
});

test('caller abort while auth is pending prevents a late request', async () => {
  let resolveAuth!: (value: string) => void;
  const auth = new Promise<string>(resolve => { resolveAuth = resolve; });
  let requested = false;
  const controller = new AbortController();
  const pending = requestFooterQuota(context(async () => auth), controller.signal, async () => {
    requested = true;
    return response(usage);
  });
  controller.abort();
  assert.equal(await pending, undefined);
  resolveAuth(token());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, false);
});

test('an already cancelled refresh never resolves native auth', async () => {
  const controller = new AbortController();
  controller.abort();
  let authCalls = 0;
  assert.equal(await requestFooterQuota(context(async () => { authCalls++; return token(); }), controller.signal,
    async () => { throw new Error('must not request'); }), undefined);
  assert.equal(authCalls, 0);
});

test('deadline bounds native auth and non-OK response cleanup', async (testContext) => {
  testContext.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveAuth!: (value: string) => void;
  let requests = 0;
  const pendingAuth = requestFooterQuota(context(() => new Promise(resolve => { resolveAuth = resolve; })),
    new AbortController().signal, async () => { requests++; return response(usage); });
  testContext.mock.timers.tick(5000);
  assert.equal(await pendingAuth, undefined);
  resolveAuth(token());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);

  const pendingCleanup = requestFooterQuota(context(async () => token()), new AbortController().signal,
    async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 500 }));
  await new Promise(resolve => setImmediate(resolve));
  testContext.mock.timers.tick(5000);
  assert.equal(await pendingCleanup, undefined);
});

test('caller abort propagates to the fetch request signal', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const pending = requestFooterQuota(context(async () => token()), controller.signal, async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
    });
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('stop'));
  assert.equal(await pending, undefined);
  assert.equal(requestSignal?.aborted, true);
});
