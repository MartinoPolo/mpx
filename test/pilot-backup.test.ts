import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
// Migration scripts are intentionally outside the runtime TypeScript compilation.
// @ts-expect-error JavaScript migration helper has no declaration file.
import { backupPilot, protectWindowsRoot } from '../migration/pilot-backup.mjs';

const execFileAsync = promisify(execFile);

const permit = async () => {};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `mpx-pilot-${name}-`));
  return { root, source: path.join(root, 'source'), destination: path.join(root, 'backup') };
}

test('copies opaque file bytes and records complete hashes and metadata', async () => {
  const f = await fixture('copy');
  try {
    await mkdir(f.source);
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
    await writeFile(path.join(f.source, 'opaque.bin'), bytes);
    const result = await backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: permit });
    assert.deepEqual(await readFile(path.join(f.destination, 'source', 'opaque.bin')), bytes);
    assert.equal(result.manifest.complete, true);
    const entry = result.manifest.entries.find((item: { path: string }) => item.path === 'source/opaque.bin');
    assert.equal(entry.sha256, digest(bytes));
    assert.equal(entry.type, 'file');
    assert.equal(typeof entry.metadata.mode, 'number');
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('records a relative symbolic link without materializing it or copying its target', async (t) => {
  const f = await fixture('link');
  try {
    await mkdir(f.source);
    await writeFile(path.join(f.root, 'outside.txt'), 'secret target');
    try { await symlink('../outside.txt', path.join(f.source, 'relative-link')); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') { t.skip(`symbolic links unavailable: ${code}`); return; }
      throw error;
    }
    const result = await backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: permit });
    const copied = path.join(f.destination, 'source', 'relative-link');
    await assert.rejects(lstat(copied), { code: 'ENOENT' });
    const entry = result.manifest.entries.find((item: { path: string }) => item.path.endsWith('relative-link'));
    assert.equal(entry.target, path.join('..', 'outside.txt'));
    assert.equal(entry.materialized, false);
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('maps full source paths to backup labels', async () => {
  const f = await fixture('source-map');
  try {
    await mkdir(f.source); await writeFile(path.join(f.source, 'a'), 'a');
    const result = await backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: permit });
    assert.equal(result.manifest.sourceMap[path.resolve(f.source)], 'source');
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('rejects reserved manifest and duplicate source labels before creating destination', async () => {
  const f = await fixture('collisions');
  try {
    const left = path.join(f.root, 'left'); const right = path.join(f.root, 'right');
    await mkdir(left); await mkdir(right);
    const a = path.join(left, 'same'); const b = path.join(right, 'same');
    await mkdir(a); await mkdir(b);
    await assert.rejects(backupPilot({ sources: [a, b], destinationRoot: f.destination, protectRoot: permit }), /basename collision/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    const reserved = path.join(f.root, 'manifest.json'); await writeFile(reserved, 'x');
    await assert.rejects(backupPilot({ sources: [reserved], destinationRoot: f.destination, protectRoot: permit }), /reserved manifest/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('enforces file-count and streamed byte bounds', async () => {
  for (const [name, options, pattern] of [
    ['files', { maxFiles: 1 }, /file-count limit/],
    ['bytes', { maxBytes: 3 }, /byte limit/],
  ] as const) {
    const f = await fixture(`bounds-${name}`);
    try {
      await mkdir(f.source); await writeFile(path.join(f.source, 'payload'), 'four');
      await assert.rejects(backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: permit, ...options }), pattern);
      const manifest = JSON.parse(await readFile(path.join(f.destination, 'manifest.json'), 'utf8'));
      assert.equal(manifest.complete, false);
    } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
});

test('rejects existing, contained, containing, and link-ancestor destinations', async (t) => {
  const f = await fixture('unsafe');
  try {
    await mkdir(f.source); await writeFile(path.join(f.source, 'a'), 'a'); await mkdir(f.destination);
    await assert.rejects(backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: permit }), /already exists/);
    await assert.rejects(backupPilot({ sources: [f.source], destinationRoot: path.join(f.source, 'backup'), protectRoot: permit }), /contain/);
    const parentSource = path.join(f.root, 'parent-source'); await mkdir(parentSource);
    await assert.rejects(backupPilot({ sources: [parentSource], destinationRoot: path.join(parentSource, 'child'), protectRoot: permit }), /contain/);
    const link = path.join(f.root, 'linked-parent');
    try { await symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') { t.diagnostic(`link-ancestor assertion skipped: symbolic links unavailable (${code})`); return; }
      throw error;
    }
    await assert.rejects(backupPilot({ sources: [f.source], destinationRoot: path.join(link, 'new-backup'), protectRoot: permit }), /link ancestor/);
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('protection failure occurs before any source bytes are copied', async () => {
  const f = await fixture('protect');
  try {
    await mkdir(f.source); await writeFile(path.join(f.source, 'sensitive'), 'do-not-copy');
    await assert.rejects(backupPilot({ sources: [f.source], destinationRoot: f.destination, protectRoot: async () => { throw new Error('denied'); } }), /protection failed/);
    await assert.rejects(lstat(path.join(f.destination, 'source')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(f.destination, 'manifest.json')), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('protectWindowsRoot applies and verifies a protected private DACL', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mpx-pilot-acl-'quote-"));
  try {
    await protectWindowsRoot(root);
    const literal = `'${root.replaceAll("'", "''")}'`;
    const script = `$p=${literal};$a=Get-Acl -LiteralPath $p;if(-not $a.AreAccessRulesProtected){exit 2};$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$ids=@($a.Access|? AccessControlType -eq Allow|% {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}|sort -Unique);$want=@($me,'S-1-5-18'|sort -Unique);if(Compare-Object $ids $want){exit 3}`;
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('source failure leaves a visible incomplete manifest and does not claim success', async () => {
  const f = await fixture('incomplete');
  try {
    await mkdir(f.source); await writeFile(path.join(f.source, 'vanishes'), 'temporary');
    await assert.rejects(backupPilot({
      sources: [f.source], destinationRoot: f.destination,
      protectRoot: async () => { await rm(f.source, { recursive: true }); },
    }), /Incomplete pilot backup/);
    const manifest = JSON.parse(await readFile(path.join(f.destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.complete, false);
    assert.match(manifest.error, /ENOENT/);
  } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
