import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceDirectoryLink, replaceVerifiedLink } from '../migration/pilot-link-copy.js';

test('personal agent directory gets a private copy while its legacy junction is retained', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-pilot-agents-'));
  try {
    const original = path.join(root, 'legacy');
    const snapshot = path.join(root, 'snapshot');
    const link = path.join(root, 'agents');
    await mkdir(original); await mkdir(snapshot);
    await writeFile(path.join(original, 'agent.md'), 'old');
    await writeFile(path.join(snapshot, 'agent.md'), 'old');
    await symlink(original, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = await readlink(link);
    const preserved = await replaceDirectoryLink(link, target, snapshot);
    assert.equal((await lstat(link)).isSymbolicLink(), false);
    assert.equal(await readlink(preserved), target);
    await writeFile(path.join(link, 'agent.md'), 'new');
    assert.equal(await readFile(path.join(original, 'agent.md'), 'utf8'), 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('personal configuration can become a private copy without writing through its legacy link', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mpx-pilot-link-'));
  try {
    const original = path.join(directory, 'legacy.json');
    const link = path.join(directory, 'personal.json');
    const bytes = Buffer.from('{"showModel":false}\n');
    await writeFile(original, bytes);
    await symlink(original, link, 'file');
    const target = await readlink(link);
    await assert.rejects(replaceVerifiedLink(link, 'unexpected', bytes), /changed/);
    await replaceVerifiedLink(link, target, bytes);
    assert.equal((await lstat(link)).isSymbolicLink(), false);
    await writeFile(link, '{"showModel":true}\n');
    assert.deepEqual(await readFile(original), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
