import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function existingAncestor(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  for (;;) {
    try { return { real: await realpath(current), suffix }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function rejectLinkAncestors(destination) {
  let current = path.resolve(destination);
  const parts = [];
  while (path.dirname(current) !== current) { parts.push(current); current = path.dirname(current); }
  parts.push(current);
  for (const entry of parts.reverse()) {
    try {
      if ((await lstat(entry)).isSymbolicLink()) throw new Error(`Destination has a link ancestor: ${entry}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function quotePowerShellLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

/** Establish and verify a private Windows DACL (current user and SYSTEM only). */
export async function protectWindowsRoot(root) {
  if (process.platform !== 'win32') throw new Error('Windows ACL protection is unavailable on this platform.');
  const literal = quotePowerShellLiteral(root);
  const script = `$ErrorActionPreference='Stop'; $p=${literal}; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($r)}; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $sys=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); $inherit=if((Get-Item -LiteralPath $p).PSIsContainer){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}; $prop=[System.Security.AccessControl.PropagationFlags]::None; foreach($sid in @($me,$sys)){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,$prop,'Allow'); [void]$acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl; $v=Get-Acl -LiteralPath $p; if(-not $v.AreAccessRulesProtected){throw 'ACL inheritance remains enabled'}; $ids=@($v.Access|? AccessControlType -eq Allow|% {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}|sort -Unique); $want=@($me.Value,$sys.Value|sort -Unique); if(Compare-Object $ids $want){throw 'Unexpected ACL principal'}; if(@($v.Access|? AccessControlType -eq Deny).Count){throw 'Unexpected deny ACL'}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
}

function metadata(info) {
  return { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs };
}
function stable(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode; }
async function verifyCopiedBytes(file, expectedBytes, expectedHash) {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expectedBytes) throw new Error('Backup verification exceeded expected file size.');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  if (total !== expectedBytes || hash.digest('hex') !== expectedHash) throw new Error('Backup byte verification failed.');
}

/**
 * Back up only the explicitly supplied absolute sources into a new protected root.
 * Each file is stabilized independently; active sessions mean the complete backup is
 * not a globally point-in-time snapshot.
 */
export async function backupPilot({ sources, destinationRoot, protectRoot = protectWindowsRoot, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES, stableRetries = 2 }) {
  if (!Array.isArray(sources) || !sources.length || !sources.every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('sources must be a non-empty list of absolute paths.');
  if (typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot)) throw new Error('destinationRoot must be absolute.');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(stableRetries) || stableRetries < 0) throw new Error('Invalid snapshot bounds.');
  await rejectLinkAncestors(destinationRoot);
  try { await lstat(destinationRoot); throw new Error('Destination root already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const destinationProjection = await existingAncestor(destinationRoot);
  const destinationReal = path.join(destinationProjection.real, ...destinationProjection.suffix);
  const uniqueSources = [...new Set(sources.map(value => path.resolve(value)))];
  const sourceInfos = [];
  const sourceMap = {};
  const used = new Set();
  for (const source of uniqueSources) {
    const label = path.basename(source);
    const collisionKey = process.platform === 'win32' ? label.toLowerCase() : label;
    if (collisionKey === 'manifest.json') throw new Error('Source label collides with reserved manifest.json.');
    if (used.has(collisionKey)) throw new Error(`Source basename collision: ${label}`);
    used.add(collisionKey); sourceMap[source] = label;
    const info = await lstat(source);
    const sourceReal = info.isSymbolicLink() ? source : await realpath(source);
    if (inside(sourceReal, destinationReal) || inside(destinationReal, sourceReal)) throw new Error(`Source and destination contain one another: ${source}`);
    sourceInfos.push({ source, label });
  }
  await mkdir(destinationRoot, { recursive: false });
  try { await protectRoot(destinationRoot); }
  catch (error) { throw new Error(`Destination protection failed before snapshot: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }

  const manifestPath = path.join(destinationRoot, 'manifest.json');
  const manifest = { version: 1, complete: false, createdAt: new Date().toISOString(), destinationRoot, sourceMap, limits: { maxFiles, maxBytes }, entries: [], error: null };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  let fileCount = 0; let totalBytes = 0;
  const reserveEntry = () => { if (++fileCount > maxFiles) throw new Error(`Snapshot exceeds file-count limit (${maxFiles}).`); };
  const copyEntry = async (source, destination, logicalPath) => {
    const info = await lstat(source); // Never trust an earlier traversal observation.
    reserveEntry();
    if (info.isSymbolicLink()) {
      const target = await readlink(source);
      manifest.entries.push({ path: logicalPath, type: 'link', target, materialized: false, metadata: metadata(info) }); return;
    }
    if (info.isDirectory()) {
      await mkdir(destination); manifest.entries.push({ path: logicalPath, type: 'directory', metadata: metadata(info) });
      const names = await readdir(source);
      for (const name of names.sort()) await copyEntry(path.join(source, name), path.join(destination, name), path.posix.join(logicalPath, name));
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported source entry: ${source}`);
    for (let attempt = 0; ; attempt++) {
      const before = await lstat(source);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Source changed type before copy: ${source}`);
      const sourceHandle = await open(source, 'r');
      let destinationHandle; let copied = 0; const hash = createHash('sha256');
      try {
        destinationHandle = await open(destination, 'wx');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          if (totalBytes + copied + bytesRead > maxBytes) throw new Error(`Snapshot exceeds byte limit (${maxBytes}).`);
          const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await destinationHandle.write(chunk, offset, bytesRead - offset);
            if (!bytesWritten) throw new Error('Backup write made no progress.');
            offset += bytesWritten;
          }
          copied += bytesRead;
        }
      } catch (error) {
        await rm(destination, { force: true }).catch(() => {});
        throw error;
      } finally {
        await sourceHandle.close();
        if (destinationHandle) await destinationHandle.close();
      }
      const after = await lstat(source);
      if (!after.isFile() || after.isSymbolicLink()) { await rm(destination, { force: true }); throw new Error(`Source changed type during copy: ${source}`); }
      if (stable(before, after) && copied === after.size) {
        const digest = hash.digest('hex');
        await verifyCopiedBytes(destination, copied, digest);
        totalBytes += copied;
        manifest.entries.push({ path: logicalPath, type: 'file', metadata: metadata(after), sha256: digest }); return;
      }
      await rm(destination, { force: true });
      if (attempt >= stableRetries) throw new Error(`Source did not remain stable: ${source}`);
    }
  };
  try {
    for (const { source, label } of sourceInfos) await copyEntry(source, path.join(destinationRoot, label), label);
    manifest.complete = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { destinationRoot, manifestPath, manifest };
  } catch (error) {
    manifest.error = error instanceof Error ? error.message : String(error);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`).catch(() => {});
    throw new Error(`Incomplete pilot backup: ${manifest.error}`, { cause: error });
  }
}

async function cli() {
  const descriptorPath = process.argv[2];
  if (!descriptorPath || !path.isAbsolute(descriptorPath)) throw new Error('Usage: pilot-backup.mjs <absolute-descriptor.json>');
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (inside(repository, path.resolve(descriptorPath))) throw new Error('Descriptor must be outside the tracked repository.');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const apps = process.env.MPX_APPS;
  if (!apps || !path.isAbsolute(apps) || !inside(path.resolve(apps), path.resolve(descriptor.destinationRoot))) throw new Error('Destination must be under absolute MPX_APPS.');
  if (path.resolve(descriptor.destinationRoot).toLowerCase().includes('onedrive')) throw new Error('OneDrive destinations are prohibited.');
  await backupPilot(descriptor);
  process.stdout.write('Pilot backup completed.\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
