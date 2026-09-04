import { STANDALONE_RELEASE_MANIFEST_VALIDATION_SOURCE } from './stable-manifest-validation-source.js';
import WINDOWS_OWNED_PATHS from './windows-owned-paths.json' with { type: 'json' };

export function buildStableNodeEntryBody(): string {
  return `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

${STANDALONE_RELEASE_MANIFEST_VALIDATION_SOURCE}

const WINDOWS_OWNED_PATHS = Object.freeze(${JSON.stringify(WINDOWS_OWNED_PATHS)});
const REGISTRY_TIMEOUT_MS = 1000;
const REGISTRY_MAX_BUFFER = 64 * 1024;

function trustedRegExecutable() {
  const systemRoot = process.env.SystemRoot;
  if (
    !systemRoot ||
    /[\\u0000-\\u001f\\u007f]/u.test(systemRoot) ||
    !/^[A-Za-z]:\\\\/u.test(systemRoot) ||
    !path.win32.isAbsolute(systemRoot) ||
    path.win32.normalize(systemRoot) !== systemRoot
  ) return undefined;
  const executable = path.win32.join(systemRoot, 'System32', 'reg.exe');
  return path.win32.isAbsolute(executable) ? executable : undefined;
}

function registryPathValue(executable, name) {
  const result = spawnSync(executable, ['query', 'HKCU\\\\Environment', '/v', name], {
    encoding: 'utf8',
    maxBuffer: REGISTRY_MAX_BUFFER,
    shell: false,
    timeout: REGISTRY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }
  const matches = result.stdout
    .split(/\\r?\\n/u)
    .map((line) => /^ {4}([A-Z0-9_]+) {4}(REG_SZ|REG_EXPAND_SZ) {4}(.+)$/u.exec(line))
    .filter((match) => match?.[1] === name);
  if (matches.length !== 1) return undefined;
  const value = matches[0][3];
  if (
    !value ||
    value.trim() !== value ||
    /[\\u0000-\\u001f\\u007f]/u.test(value) ||
    !path.win32.isAbsolute(value)
  ) return undefined;
  return path.win32.normalize(value);
}

function hydrateOwnedPaths() {
  const executable = trustedRegExecutable();
  if (!executable) return;
  for (const name of WINDOWS_OWNED_PATHS) {
    if (process.env[name] !== undefined) continue;
    const value = registryPathValue(executable, name);
    if (value !== undefined) process.env[name] = value;
  }
}

function fail() {
  throw new Error('stable entry validation failed');
}

async function openRegularFile(target) {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) fail();
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail();
    const after = await lstat(target);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) fail();
    return { handle, identity: opened };
  } catch (failure) {
    await handle.close();
    throw failure;
  }
}

async function captureRegularFile(target) {
  const opened = await openRegularFile(target);
  try {
    const body = await opened.handle.readFile();
    const after = await lstat(target);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.identity.dev || after.ino !== opened.identity.ino) fail();
    return { ...opened, body };
  } catch (failure) {
    await opened.handle.close();
    throw failure;
  }
}

async function readRegularFile(target) {
  const captured = await captureRegularFile(target);
  try {
    return captured.body.toString('utf8');
  } finally {
    await captured.handle.close();
  }
}

async function assertSafeAncestors(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail();
  let current = root;
  const segments = relative.split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
  }
}

function authenticate(manifestBody, selectedReleaseKey, captured) {
  const manifest = manifestValidation.parseReleaseManifest(manifestValidation.parseStrictJson(manifestBody));
  const convergenceHash = createHash('sha256').update(manifestValidation.canonicalJson(manifest.files)).digest('hex');
  if (
    manifestBody !== manifestValidation.canonicalJson(manifest) + '\\n' ||
    manifest.releaseKey !== selectedReleaseKey ||
    manifest.releaseKey !== convergenceHash ||
    manifest.convergenceHash !== convergenceHash
  ) fail();
  const evidence = manifest.files.find((file) => file.path === 'bin/mpx.mjs');
  if (
    !evidence ||
    evidence.bytes !== captured.byteLength ||
    evidence.sha256 !== createHash('sha256').update(captured).digest('hex')
  ) fail();
}

async function main() {
  hydrateOwnedPaths();
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) fail();
  const selector = path.resolve(localAppData, 'mpx', 'active-release');
  await assertSafeAncestors(path.parse(selector).root, selector);
  const match = /^([a-f0-9]{64})(?:\\r?\\n)?$/u.exec(await readRegularFile(selector));
  if (!match) fail();
  const releaseKey = match[1];
  const installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const releaseRoot = path.resolve(installationRoot, 'releases', releaseKey);
  const selected = path.resolve(releaseRoot, 'bin', 'mpx.mjs');
  const manifestPath = path.resolve(releaseRoot, 'release-manifest.json');
  await assertSafeAncestors(installationRoot, selected);
  await assertSafeAncestors(installationRoot, manifestPath);
  const captured = await captureRegularFile(selected);
  try {
    authenticate(await readRegularFile(manifestPath), releaseKey, captured.body);
    const selectedUrl = pathToFileURL(selected).href;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === selectedUrl
          ? { url: selectedUrl, format: 'module', shortCircuit: true }
          : nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        return url === selectedUrl
          ? { format: 'module', source: captured.body, shortCircuit: true }
          : nextLoad(url, context);
      },
    });
    try {
      process.argv[1] = selected;
      await import(selectedUrl);
    } finally {
      hooks.deregister();
    }
  } finally {
    await captured.handle.close();
  }
}

await main().catch(() => {
  process.exitCode = 2;
});
`;
}
