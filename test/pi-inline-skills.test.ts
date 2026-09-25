import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider, type AutocompleteProvider, type TUI } from '@earendil-works/pi-tui';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const packagePath = resolve('node_modules/@tifan/pi-inline-skills/src/index.ts');
const sourceInfo = { path: resolve('test/fixtures/skill/SKILL.md'), source: 'local', scope: 'project' as const, origin: 'top-level' as const };
const skill = (name: string) => ({ name: `skill:${name}`, source: 'skill' as const, sourceInfo });

async function setup(commands: Array<ReturnType<typeof skill> | { name: string; source: 'extension'; sourceInfo: typeof sourceInfo }> = [skill('resume'), skill('review')]) {
  const { extensions, errors, runtime } = await loadExtensions([packagePath], process.cwd());
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  assert.ok(extension);
  runtime.getCommands = () => commands;
  let factory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
  const sessionStart = extension.handlers.get('session_start')?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: 'session_start', reason: 'startup' }, {
    sessionManager: { getBranch: () => [] },
    ui: { addAutocompleteProvider: (providerFactory: typeof factory) => { factory = providerFactory; } },
  } as unknown as ExtensionContext);
  assert.ok(factory);
  const native = new CombinedAutocompleteProvider(
    commands.map(({ name }) => ({ name, description: name })), process.cwd(), null,
  );
  return { provider: factory(native), native };
}

async function suggestions(provider: AutocompleteProvider, text: string, cursorCol = text.length, signal = new AbortController().signal) {
  return provider.getSuggestions([text], 0, cursorCol, { signal });
}

function createEditor(provider: AutocompleteProvider) {
  const tui = { requestRender() {} } as TUI;
  const identity = (text: string) => text;
  const theme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity, selectedText: identity, description: identity,
      scrollInfo: identity, noMatch: identity,
    },
  };
  const editor = new CustomEditor(tui, theme, new KeybindingsManager());
  editor.setAutocompleteProvider(provider);
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  return { editor, submitted };
}

async function showCompletion(editor: CustomEditor, text: string) {
  editor.setText(text.slice(0, -1));
  editor.handleInput(text.slice(-1));
  for (let attempt = 0; attempt < 20 && !editor.isShowingAutocomplete(); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(editor.isShowingAutocomplete(), true, `no autocomplete for ${text}`);
}

test('prompt-start skills use only native canonical suggestions and prefix', async () => {
  const { provider, native } = await setup();
  for (const text of ['/rev', '  /rev']) {
    const actual = await suggestions(provider, text);
    const expected = await suggestions(native, text);
    assert.deepEqual(actual, expected);
    if (text === '/rev') {
      assert.equal(actual?.items.filter((item) => item.label === 'skill:review').length, 1);
    }
  }
  assert.deepEqual(await suggestions(provider, '/'), await suggestions(native, '/'));
  assert.deepEqual(await suggestions(provider, '/skill:'), await suggestions(native, '/skill:'));
});

test('prompt-start collision uses native suggestions and Enter behavior', async () => {
  const { provider, native } = await setup([skill('resume'), { name: 'resume', source: 'extension', sourceInfo }]);
  const choices = await suggestions(provider, '/resum');
  assert.deepEqual(choices, await suggestions(native, '/resum'));
  assert.equal(choices?.items[0]?.value, 'skill:resume');
  assert.ok(choices?.items.some((item) => item.value === 'resume'));
  const { editor, submitted } = createEditor(provider);
  await showCompletion(editor, '/resum');
  editor.handleInput('\r');
  assert.deepEqual(submitted, ['/skill:resume']);
});

test('native /skill: completion submits on Enter but Tab only completes', async () => {
  const { provider } = await setup([skill('review')]);
  const { editor, submitted } = createEditor(provider);
  await showCompletion(editor, '/skill:rev');
  editor.handleInput('\t');
  assert.equal(editor.getText(), '/skill:review ');
  assert.deepEqual(submitted, []);
  await showCompletion(editor, '/skill:rev');
  editor.handleInput('\r');
  assert.deepEqual(submitted, ['/skill:review']);
});

test('inline skill completion preserves text after cursor; Enter inserts, never submits', async () => {
  const { provider } = await setup([skill('review')]);
  const text = 'Please /rev later';
  const choice = await suggestions(provider, text, 'Please /rev'.length);
  assert.equal(choice?.prefix, 'rev');
  const item = choice?.items.find((entry) => entry.value === '/review');
  assert.ok(item);
  assert.deepEqual(provider.applyCompletion([text], 0, 'Please /rev'.length, item, choice.prefix), {
    lines: ['Please /review later'], cursorLine: 0, cursorCol: 'Please /review'.length,
  });
  const { editor, submitted } = createEditor(provider);
  await showCompletion(editor, 'Please /rev');
  editor.handleInput('\r');
  assert.equal(editor.getText(), 'Please /review ');
  assert.deepEqual(submitted, []);
  await showCompletion(editor, 'Please /rev');
  editor.handleInput('\t');
  assert.equal(editor.getText(), 'Please /review ');
  assert.deepEqual(submitted, []);
});

test('no-match and cancellation retain native suggestions', async () => {
  const { provider, native } = await setup([skill('review')]);
  assert.deepEqual(await suggestions(provider, '/zzzz'), await suggestions(native, '/zzzz'));
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await suggestions(provider, 'Please /rev', undefined, controller.signal), await suggestions(native, 'Please /rev', undefined, controller.signal));
});
