import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  MACHINE_ROOT_CUSTOM_TYPE,
  NO_MACHINE_ROOTS_CONTEXT,
  STYLE_REINFORCEMENT,
  appendStyleReinforcement,
  machineRootContext,
  machineRootMessageToInject,
  mergeCompactionInstructions,
  withoutDeletedHeaders,
} from '../src/context.js';
import {
  createPiContextExtension,
  type PiContextDependencies,
} from '../extensions/pi-context.js';

test('pure compaction helpers preserve manual-first ordering and request headers', () => {
  assert.equal(mergeCompactionInstructions('focus on auth', '  canonical guidance\n'), 'focus on auth\n\ncanonical guidance');
  assert.equal(mergeCompactionInstructions(undefined, 'canonical'), 'canonical');
  assert.throws(() => mergeCompactionInstructions('manual', '  '), /empty/);
  assert.deepEqual(withoutDeletedHeaders({ keep: 'yes', remove: null }), { keep: 'yes' });
});

test('machineRootContext emits only the exact root allowlist and skips unset values', () => {
  const context = machineRootContext({
    MPX_PROJECTS: ' C:/projects ',
    MPX_WORK: '',
    MPX_CLONED: 'C:/cloned',
    MPX_APPS: 'C:/apps',
    MPX_ONEDRIVE: 'C:/one',
    MPX_AI_GENERATED: 'C:/generated',
    MPX_AI_DUMP: 'C:/dump',
    MPX_TEMP: 'C:/temp',
    MPX_OBSIDIAN_VAULT: 'C:/vault',
    MPX_SECRET: 'must-not-leak',
  });
  assert.equal(context, [
    'Machine roots (from MPX_* env vars — use these instead of guessing paths):',
    '- MPX_PROJECTS = C:/projects — personal projects',
    '- MPX_CLONED = C:/cloned — cloned OSS repositories',
    '- MPX_APPS = C:/apps — local apps',
    '- MPX_ONEDRIVE = C:/one — OneDrive root',
    '- MPX_AI_GENERATED = C:/generated — saved AI-generated media and durable tutorials',
    '- MPX_AI_DUMP = C:/dump — general AI scratchpad worth keeping (plans, reports, artifacts)',
    '- MPX_TEMP = C:/temp — disposable temporary files',
    '- MPX_OBSIDIAN_VAULT = C:/vault — Obsidian vault',
    'This snapshot supersedes earlier machine-root messages.',
    'Paths outside the working directory should be resolved from these variables.',
  ].join('\n'));
  assert.equal(machineRootContext({}), undefined);
  assert.equal(machineRootMessageToInject([], context), context);
  assert.equal(machineRootMessageToInject([
    { type: 'custom_message', customType: MACHINE_ROOT_CUSTOM_TYPE, content: context },
  ], context), undefined);
});

test('machine-root updates compare only the latest snapshot and clear stale roots once', () => {
  const a = machineRootContext({ MPX_PROJECTS: 'C:/a' })!;
  const b = machineRootContext({ MPX_PROJECTS: 'C:/b' })!;
  const entry = (content: string) => ({
    type: 'custom_message', customType: MACHINE_ROOT_CUSTOM_TYPE, content,
  });

  assert.equal(machineRootMessageToInject([entry(a), entry(b)], a), a, 'A -> B -> A must reinject A');
  assert.equal(machineRootMessageToInject([entry(a), entry(b), entry(a)], a), undefined);
  assert.equal(machineRootMessageToInject([], undefined), undefined, 'fresh zero-root sessions stay silent');
  assert.equal(machineRootMessageToInject([entry(a)], undefined), NO_MACHINE_ROOTS_CONTEXT);
  assert.equal(
    machineRootMessageToInject([entry(a), entry(NO_MACHINE_ROOTS_CONTEXT)], undefined),
    undefined,
    'the clearing message is not duplicated',
  );

  const fewerRoots = machineRootContext({ MPX_PROJECTS: 'C:/a', MPX_WORK: undefined })!;
  const moreRoots = machineRootContext({ MPX_PROJECTS: 'C:/a', MPX_WORK: 'C:/work' })!;
  assert.equal(machineRootMessageToInject([entry(moreRoots)], fewerRoots), fewerRoots);
});

type Handler = (event: never, ctx: ExtensionContext) => unknown;

function harness(options: Parameters<typeof createPiContextExtension>[0]) {
  const handlers = new Map<string, Handler>();
  const entries: Array<{ type: string; customType: string; content: string }> = [];
  const sent: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    sendMessage(message: { customType: string; content: string; display: boolean }) {
      sent.push(message);
      entries.push({ type: 'custom_message', customType: message.customType, content: message.content });
    },
  } as unknown as ExtensionAPI;
  createPiContextExtension(options)(pi);
  return { handlers, entries, sent };
}

function context(entries: unknown[], overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    hasUI: true,
    ui: { notify() {} },
    sessionManager: { buildContextEntries: () => entries },
    ...overrides,
  } as unknown as ExtensionContext;
}

test('root transport avoids duplicates, notices environment changes, and reinjects after compaction', async () => {
  const env: NodeJS.ProcessEnv = { MPX_PROJECTS: 'C:/one' };
  const h = harness({ env });
  const ctx = context(h.entries);
  const start = h.handlers.get('session_start')!;
  await start({ type: 'session_start', reason: 'startup' } as never, ctx);
  await start({ type: 'session_start', reason: 'reload' } as never, ctx);
  assert.equal(h.sent.length, 1);

  env.MPX_PROJECTS = 'C:/two';
  const before = h.handlers.get('before_agent_start')!;
  const changed = await before({ type: 'before_agent_start', systemPrompt: 'base' } as never, ctx) as {
    message?: { content: string };
    systemPrompt: string;
  };
  assert.match(changed.message!.content, /C:\/two/);

  h.entries.length = 0;
  const compacted = h.handlers.get('session_compact')!;
  await compacted({ type: 'session_compact' } as never, ctx);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!.content, /C:\/two/);
});

test('all-unset roots supersede a stale native snapshot once', async () => {
  const h = harness({ env: {} });
  const stale = machineRootContext({ MPX_PROJECTS: 'C:/old' })!;
  h.entries.push({ type: 'custom_message', customType: MACHINE_ROOT_CUSTOM_TYPE, content: stale });
  const ctx = context(h.entries);
  const start = h.handlers.get('session_start')!;

  await start({ type: 'session_start', reason: 'resume' } as never, ctx);
  await start({ type: 'session_start', reason: 'reload' } as never, ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.content, NO_MACHINE_ROOTS_CONTEXT);
});

test('before_agent_start chains style reinforcement onto the existing prompt', async () => {
  const h = harness({ env: {} });
  const result = await h.handlers.get('before_agent_start')!(
    { type: 'before_agent_start', systemPrompt: 'earlier extension prompt' } as never,
    context([]),
  ) as { systemPrompt: string; message?: unknown };
  assert.equal(result.systemPrompt, appendStyleReinforcement('earlier extension prompt'));
  assert.ok(result.systemPrompt.endsWith(STYLE_REINFORCEMENT));
  assert.equal(result.message, undefined);
});

test('compaction transport preserves native request shaping, signal, thinking, usage and result', async () => {
  const controller = new AbortController();
  const nativeResult = {
    summary: 'native summary', firstKeptEntryId: 'kept', tokensBefore: 42,
    usage: { input: 1 }, details: { readFiles: ['a.ts'] }, estimatedTokensAfter: 7,
  };
  let requestArgs: unknown[] | undefined;
  const compactRequest = async (...args: unknown[]) => {
    requestArgs = args;
    return nativeResult;
  };
  const h = harness({
    env: {},
    readCompactInstructions: async () => 'canonical guidance\n',
    compactRequest: compactRequest as NonNullable<PiContextDependencies['compactRequest']>,
  });
  const model = { provider: 'test', id: 'model', baseUrl: 'old' };
  const preparation = { firstKeptEntryId: 'kept', tokensBefore: 42 };
  const ctx = context([], {
    model: model as ExtensionContext['model'],
    thinkingLevel: 'high',
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true as const, apiKey: 'key', baseUrl: 'https://proxy',
        headers: { keep: 'yes', deleted: null }, env: { ROUTE: 'work' },
      }),
    } as unknown as ExtensionContext['modelRegistry'],
  });
  const result = await h.handlers.get('session_before_compact')!({
    type: 'session_before_compact', preparation, customInstructions: 'manual', signal: controller.signal,
  } as never, ctx) as { compaction: unknown };

  assert.equal(result.compaction, nativeResult);
  assert.equal(requestArgs![0], preparation);
  assert.deepEqual(requestArgs![1], { ...model, baseUrl: 'https://proxy' });
  assert.equal(requestArgs![2], 'key');
  assert.deepEqual(requestArgs![3], { keep: 'yes' });
  assert.equal(requestArgs![4], 'manual\n\ncanonical guidance');
  assert.equal(requestArgs![5], controller.signal);
  assert.equal(requestArgs![6], 'high');
  assert.equal(requestArgs![7], undefined);
  assert.deepEqual(requestArgs![8], { ROUTE: 'work' });
  assert.equal(requestArgs!.length, 9);
});

test('headless injection and compaction failures emit bounded stderr warnings', async () => {
  const output: string[] = [];
  const h = harness({
    env: { MPX_PROJECTS: 'C:/private-path' },
    readCompactInstructions: async () => { throw new Error('secret error details'); },
    writeWarning: (message) => { output.push(message); },
  });
  const brokenContext = context([], {
    hasUI: false,
    sessionManager: { buildContextEntries: () => { throw new Error('private path'); } } as unknown as ExtensionContext['sessionManager'],
  });
  await h.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' } as never, brokenContext);

  const compactContext = context([], {
    hasUI: false,
    model: { provider: 'test', id: 'model' } as ExtensionContext['model'],
  });
  await h.handlers.get('session_before_compact')!({
    type: 'session_before_compact', preparation: {}, signal: new AbortController().signal,
  } as never, compactContext);

  assert.deepEqual(output, [
    'machine roots unavailable; continuing without them\n',
    'compaction guidance unavailable; using native compaction\n',
  ]);
  assert.ok(!output.join('').includes('private-path'));
  assert.ok(!output.join('').includes('secret error details'));
});

test('guidance, auth, and request failures use native fallback; cancellation is quiet', async () => {
  const warnings: string[] = [];
  const ctxFor = (auth: () => Promise<never>) => context([], {
    model: { provider: 'test', id: 'model' } as ExtensionContext['model'],
    modelRegistry: { getApiKeyAndHeaders: auth } as unknown as ExtensionContext['modelRegistry'],
    ui: { notify: (message: string) => { warnings.push(message); } } as unknown as ExtensionContext['ui'],
  });
  const event = (signal: AbortSignal) => ({
    type: 'session_before_compact', preparation: {}, signal,
  } as never);

  const guidanceHarness = harness({
    env: {}, readCompactInstructions: async () => { throw new Error('missing guidance'); },
  });
  assert.equal(await guidanceHarness.handlers.get('session_before_compact')!(
    event(new AbortController().signal),
    ctxFor(async () => { throw new Error('auth must not run'); }),
  ), undefined);
  assert.equal(warnings.length, 1);

  const authHarness = harness({ env: {}, readCompactInstructions: async () => 'canonical' });
  const authFallback = await authHarness.handlers.get('session_before_compact')!(
    event(new AbortController().signal),
    ctxFor(async () => { throw new Error('auth rejected'); }),
  );
  assert.equal(authFallback, undefined);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1]!, /using native compaction/);

  const failedRequestHarness = harness({
    env: {}, readCompactInstructions: async () => 'canonical',
    compactRequest: (async () => { throw new Error('request failed'); }) as NonNullable<PiContextDependencies['compactRequest']>,
  });
  const requestContext = context([], {
    model: { provider: 'test', id: 'model' } as ExtensionContext['model'],
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) } as unknown as ExtensionContext['modelRegistry'],
    ui: { notify: (message: string) => { warnings.push(message); } } as unknown as ExtensionContext['ui'],
  });
  assert.equal(await failedRequestHarness.handlers.get('session_before_compact')!(
    event(new AbortController().signal), requestContext,
  ), undefined);
  assert.equal(warnings.length, 3);

  const controller = new AbortController();
  const requestHarness = harness({
    env: {}, readCompactInstructions: async () => 'canonical',
    compactRequest: (async () => { controller.abort(); throw new Error('cancelled'); }) as NonNullable<PiContextDependencies['compactRequest']>,
  });
  const cancelledContext = context([], {
    model: { provider: 'test', id: 'model' } as ExtensionContext['model'],
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) } as unknown as ExtensionContext['modelRegistry'],
    ui: { notify: (message: string) => { warnings.push(message); } } as unknown as ExtensionContext['ui'],
  });
  assert.equal(await requestHarness.handlers.get('session_before_compact')!(event(controller.signal), cancelledContext), undefined);
  assert.equal(warnings.length, 3);
});
