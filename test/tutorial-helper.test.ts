import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('projected tutorial helper uses MPX dependencies and validates its adapted placeholders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-tutorial-'));
  try {
    const directory = join(root, '_TUTORIALS/fixture'); await mkdir(directory, { recursive: true });
    const file = join(directory, 'fixture.source.md');
    const source = '---\ntitle: Native helper fixture\ntype: code-showcase\nformat: brief\ncategory: fixture\nslug: fixture\ndate: 2026-09-13\n---\n# start | Start here\n\n```js\nconst answer = 42;\n```\n';
    await writeFile(file, source);
    const helper = resolve('dist/packs/personal/pi/skills/mpx-tutorial-create/scripts/compile.js');
    const options = { env: { ...process.env, MPX_AI_GENERATED: root }, timeout: 20_000 };
    await exec(process.execPath, [helper, file, '--no-index'], options);
    const html = await readFile(join(directory, 'fixture.html'), 'utf8');
    assert.match(html, /Native helper fixture/);
    assert.match(html, /answer/);
    assert.doesNotMatch(html, /\{\{tutorial_[a-z_]+\}\}/);
    await writeFile(file, source + '\n{{tutorial_unknown}}\n');
    await assert.rejects(exec(process.execPath, [helper, file, '--no-index'], options), /unfilled template placeholder/);
    assert.equal(await readFile(join(directory, 'fixture.html'), 'utf8'), html, 'failed compilation preserves earlier output');
  } finally { await rm(root, { recursive: true, force: true }); }
});
