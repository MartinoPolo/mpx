import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const backup = process.argv[2];
if (!backup || !path.isAbsolute(backup) || process.argv.length !== 3) throw new Error('Usage: verify-personal-pilot.mjs <absolute-backup-root>');
const record = JSON.parse(await readFile(path.join(backup, 'pilot-apply.json'), 'utf8'));
assert.equal(record.complete, true, 'Pilot apply did not complete.');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
for (const file of record.files) assert.equal(await digest(file.path), file.afterHash, `Installed file differs from recorded apply: ${file.path}`);
for (const link of record.createdLinks) assert.equal(await readlink(link.path), link.target, `Installed specialist link differs: ${link.path}`);
for (const link of record.originalLinks) {
  assert.equal((await lstat(link.path)).isSymbolicLink(), false);
  assert.equal(await digest(link.target), link.sha256, `Original legacy configuration changed: ${link.target}`);
}
const manifest = JSON.parse(await readFile(path.join(backup, 'legacy-resources/manifest.json'), 'utf8'));
for (const directory of record.originalDirectories) {
  assert.equal((await lstat(directory.path)).isSymbolicLink(), false);
  assert.equal(await readlink(directory.preservedPath), directory.target);
  for (const entry of manifest.entries.filter(value => value.type === 'file' && value.path.startsWith('mpx-pi/agents/'))) {
    const relative = entry.path.slice('mpx-pi/agents/'.length);
    assert.equal(await digest(path.join(directory.target, relative)), entry.sha256, `Original legacy agent changed: ${relative}`);
  }
}
const launchers = JSON.parse(await readFile(path.join(backup, 'installed-mpx-launchers/manifest.json'), 'utf8'));
for (const entry of launchers.entries.filter(value => value.type === 'file')) {
  const source = Object.entries(launchers.sourceMap).find(([, label]) => entry.path === label || entry.path.startsWith(`${label}/`));
  assert.ok(source, 'Launcher source mapping is missing.');
  const [original, label] = source;
  assert.equal(await digest(path.join(original, entry.path.slice(label.length))), entry.sha256, 'Installed MPX launcher changed.');
}
console.log(JSON.stringify({ appliedFileHashes: 'match', specialistLinks: 'match', originalLegacyConfigurationsAndAgents: 'match backup', originalDirectoryJunction: 'retained', installedMpxLaunchers: 'match backup', scope: 'No provider calls, native startup, physical UI, or complete source-tree integrity claim.' }));
