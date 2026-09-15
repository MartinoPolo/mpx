import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const backup = process.argv[2];
const apply = process.argv[3] === '--apply';
if (!backup || !path.isAbsolute(backup) || process.argv.slice(3).some(value => value !== '--apply')) throw new Error('Usage: rollback-personal-pilot.mjs <absolute-backup-root> [--apply]');
const record = JSON.parse(await readFile(path.join(backup, 'pilot-apply.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function original(group, relative) {
  const manifest = JSON.parse(await readFile(path.join(backup, group, 'manifest.json'), 'utf8'));
  const entry = manifest.entries.find(value => value.path === relative);
  if (!entry) return undefined;
  const bytes = await readFile(path.join(backup, group, relative));
  if (entry.type !== 'file' || hash(bytes) !== entry.sha256) throw new Error(`Backup verification failed: ${relative}`);
  return bytes;
}
async function physicalParents(file) {
  let directory = path.dirname(file);
  for (;;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Linked or invalid rollback ancestor: ${directory}`);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
const operations = [];
const restoreLinks = [];
for (const [name, keys] of [['settings.json', ['treeFilterMode']], ['subagents.json', ['showModel']], ['keybindings.json', ['tui.input.newLine']]]) {
  const file = path.join(record.account, name);
  await physicalParents(file);
  const currentBytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!currentBytes) continue;
  const originalLink = (record.originalLinks ?? []).find(link => link.path === file);
  if ((await lstat(file)).isSymbolicLink()) {
    if (originalLink && await readlink(file) === originalLink.target) continue;
    throw new Error(`Refusing a linked rollback target: ${file}`);
  }
  const beforeBytes = originalLink ? await readFile(originalLink.backupFile) : await original('personal-account', `agent/${name}`);
  if (originalLink && hash(beforeBytes) !== originalLink.sha256) throw new Error('Linked configuration backup failed verification.');
  const before = beforeBytes ? JSON.parse(beforeBytes.toString('utf8')) : {};
  const current = JSON.parse(currentBytes.toString('utf8'));
  const next = structuredClone(current);
  for (const key of keys) {
    if (Object.hasOwn(before, key)) next[key] = before[key]; else delete next[key];
  }
  if (name === 'settings.json') {
    const sameDisplay = entry => {
      const source = typeof entry === 'string' ? entry : entry?.source;
      return typeof source === 'string' && path.isAbsolute(source) && path.resolve(source).toLowerCase() === path.resolve(record.display).toLowerCase();
    };
    const oldDisplay = before.packages?.find(sameDisplay);
    next.packages = current.packages.map(entry => {
      if (!sameDisplay(entry)) return entry;
      if (JSON.stringify(entry) === JSON.stringify(oldDisplay)) return entry;
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['source', 'extensions'].includes(key)) || !Array.isArray(entry.extensions) || entry.extensions.length) throw new Error('Display settings changed since the pilot; review before rollback.');
      return oldDisplay;
    });
    const exclusion = `!${record.sharedSkills.replaceAll('\\', '/')}/**`;
    if (!(before.skills ?? []).includes(exclusion)) next.skills = (current.skills ?? []).filter(value => value !== exclusion);
    if (!next.skills?.length && before.skills === undefined) delete next.skills;
  }
  const nextBytes = beforeBytes || Object.keys(next).length ? Buffer.from(`${JSON.stringify(next, null, 2)}\n`) : undefined;
  operations.push({ file, currentBytes, next: nextBytes });
  if (originalLink && isDeepStrictEqual(next, before) && hash(await readFile(originalLink.target)) === originalLink.sha256) restoreLinks.push({ ...originalLink, expectedHash: hash(nextBytes) });
}
for (const [file, group, relative] of [[record.shellFile, 'routing', '.bashrc'], [record.projectFile, 'routing', 'mpxconfig.json'], [record.configFile, undefined, undefined], [record.runtimeFile, undefined, undefined]]) {
  const item = record.files.find(entry => entry.path === file);
  if (!item?.afterHash) continue;
  const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT' && item.beforeHash === undefined) return undefined; throw error; });
  if (!bytes || (item.beforeHash && hash(bytes) === item.beforeHash)) continue;
  await physicalParents(file);
  if ((await lstat(file)).isSymbolicLink() || hash(bytes) !== item.afterHash) throw new Error(`File changed since pilot apply; refusing overwrite: ${file}`);
  operations.push({ file, currentBytes: bytes, next: group ? await original(group, relative) : undefined });
}
for (const link of record.createdLinks) {
  const info = await lstat(link.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) continue;
  await physicalParents(link.path);
  if (info && (!info.isSymbolicLink() || await readlink(link.path) !== link.target)) throw new Error(`Owned link changed; refusing removal: ${link.path}`);
}
const restoreDirectories = [];
for (const directory of record.originalDirectories ?? []) {
  await physicalParents(directory.path);
  const preserved = await lstat(directory.preservedPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!preserved && (await lstat(directory.path)).isSymbolicLink() && await readlink(directory.path) === directory.target) continue;
  if (!preserved?.isSymbolicLink() || await readlink(directory.preservedPath) !== directory.target) throw new Error('Preserved legacy directory link changed.');
  if (await lstat(`${directory.path}.mpx2-pilot-retained`).catch(() => undefined)) throw new Error('Retained pilot directory already exists.');
  restoreDirectories.push(directory);
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', files: operations.map(operation => operation.file), links: record.createdLinks.map(link => link.path), credentialsAndConversations: 'never restored or removed', note: 'Restores pilot-owned UI keys, display filter and skill exclusion; other settings remain current.' }));
if (apply) {
  for (const operation of operations) {
    await physicalParents(operation.file);
    if (!operation.currentBytes.equals(await readFile(operation.file))) throw new Error(`Concurrent change: ${operation.file}`);
    if (operation.next) {
      const temporary = `${operation.file}.mpx2-rollback.tmp`;
      await writeFile(temporary, operation.next, { flag: 'wx' });
      try {
        await physicalParents(operation.file);
        if (!operation.currentBytes.equals(await readFile(operation.file))) throw new Error(`Concurrent change: ${operation.file}`);
        await rename(temporary, operation.file);
      } finally { await rm(temporary, { force: true }); }
    } else await rm(operation.file);
  }
  for (const link of record.createdLinks) {
    const info = await lstat(link.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) continue;
    if (!info.isSymbolicLink() || await readlink(link.path) !== link.target) throw new Error(`Concurrent link change: ${link.path}`);
    await rm(link.path);
  }
  for (const link of restoreLinks) {
    if (hash(await readFile(link.path)) !== link.expectedHash) throw new Error('Configuration changed before link restoration.');
    const temporary = `${link.path}.mpx2-restore-link`;
    await symlink(link.target, temporary, 'file');
    try { await rename(temporary, link.path); } finally { await rm(temporary, { force: true }); }
  }
  for (const directory of restoreDirectories) {
    const retained = `${directory.path}.mpx2-pilot-retained`;
    if (!(await lstat(directory.path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }))) {
      await rename(directory.preservedPath, directory.path);
      continue;
    }
    await rename(directory.path, retained);
    try { await rename(directory.preservedPath, directory.path); }
    catch (error) { await rename(retained, directory.path); throw error; }
  }
  console.log('Pilot routing and owned settings rolled back. Credentials/conversations preserved; private agent copy retained. Open a fresh shell.');
}
