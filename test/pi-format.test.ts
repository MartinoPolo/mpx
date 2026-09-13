import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createPiFormatExtension } from '../extensions/pi-format.js';

test('native edit/write queue includes formatting and reports errors without undoing edits', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mpx-native-format-'));
  try {
    const tools = new Map<string, any>();
    const api = { registerTool: (definition: any) => tools.set(definition.name, definition) } as unknown as ExtensionAPI;
    const ctx = { cwd, isProjectTrusted: () => true } as ExtensionContext;
    let enter!: () => void; const entered = new Promise<void>(done => { enter = done; });
    let release!: () => void; const hold = new Promise<void>(done => { release = done; });
    let calls = 0;
    createPiFormatExtension(async file => {
      if (++calls === 1) { enter(); await hold; await writeFile(file, 'one formatted'); return { changed: true, diagnostics: ['formatted'] }; }
      throw new Error('formatter unavailable');
    })(api);
    const file = join(cwd, 'source.txt');
    const first = tools.get('write').execute('one', { path: file, content: 'one' }, undefined, undefined, ctx);
    await entered;
    const second = tools.get('edit').execute('two', { path: file, edits: [{ oldText: 'one formatted', newText: 'two' }] }, undefined, undefined, ctx);
    release();
    assert.match(JSON.stringify((await first).content), /formatted/);
    assert.match(JSON.stringify((await second).content), /Formatter failed/);
    assert.equal(await readFile(file, 'utf8'), 'two');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
