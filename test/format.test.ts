import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatEditedFile } from '../src/safeguards/format.js';

test('formatting is explicit, local, trusted, awaited, one-file and reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-format-'));
  try {
    await mkdir(join(root, '.git'));
    const file = join(root, 'source.js'); await writeFile(file, 'const x=1');
    let runs = 0;
    const options = { isTrusted: () => true, run: async (_exe: string, args: string[]) => {
      runs++; assert.ok(args.includes('--write')); assert.ok(!args.includes('lint')); assert.equal(args.at(-1), file);
      await writeFile(file, 'const x = 1;\n'); return { code: 0, stdout: '' };
    } };
    assert.deepEqual(await formatEditedFile(file, root, options), { changed: false, diagnostics: [] });
    await writeFile(join(root, '.prettierrc'), '{}');
    assert.match((await formatEditedFile(file, root, options)).diagnostics[0]!, /no project-local/);
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true }); await writeFile(join(root, 'node_modules/.bin/prettier'), '#!/bin/sh\n');
    assert.match((await formatEditedFile(file, root, { ...options, isTrusted: () => false })).diagnostics[0]!, /not natively trusted/);
    assert.equal(runs, 0);
    const result = await formatEditedFile(file, root, options);
    assert.equal(result.changed, true); assert.match(result.diagnostics[0]!, /formatted/); assert.equal(runs, 1);
    const failed = await formatEditedFile(file, root, { ...options, run: async () => ({ code: null, stdout: '', incomplete: 'deadline exceeded' }) });
    assert.match(failed.diagnostics[0]!, /deadline/); assert.equal(await readFile(file, 'utf8'), 'const x = 1;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
