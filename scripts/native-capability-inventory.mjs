#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const idPattern = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,199}$/u;
const declaredRoutePattern =
  /^(?:agent|command|extension|hook|mcp|prompt|skill|theme):[A-Za-z0-9@][A-Za-z0-9@._/-]{0,199}$/u;
const versionPattern =
  /^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|[~^]?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u;
const installedVersionPattern = /^(?:unknown|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const reviewedDispositions = new Set([
  'preserve-external',
  'canonicalized',
  'replace-at-install',
  'retire-at-install',
  'expected-after-install',
]);
const claudeManifestKeys = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcpServers',
];
const piPackageKeys = [
  'name',
  'version',
  'description',
  'author',
  'bugs',
  'bin',
  'dependencies',
  'devDependencies',
  'engines',
  'exports',
  'files',
  'homepage',
  'keywords',
  'license',
  'main',
  'module',
  'overrides',
  'peerDependencies',
  'peerDependenciesMeta',
  'publishConfig',
  'repository',
  'scripts',
  'type',
  'types',
  'pi',
];
const rootToken = (identity, runtime) => `\${${identity}.${runtime}}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function exactKeys(value, allowed, required = []) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !own(value, key))
  ) {
    fail('UNKNOWN_SCHEMA', 'Metadata does not match an allowlisted schema.');
  }
}
function safeId(value, label = 'identifier') {
  if (
    typeof value !== 'string' ||
    !idPattern.test(value) ||
    value.includes('..') ||
    value.includes('\\')
  ) {
    fail('UNKNOWN_SCHEMA', `Invalid ${label}.`);
  }
  return value;
}
function safeVersion(value) {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    fail('UNKNOWN_SCHEMA', 'A package version is not exact or supported.');
  }
  return value;
}
function safeInstalledVersion(value) {
  if (typeof value !== 'string' || !installedVersionPattern.test(value)) {
    fail('UNKNOWN_SCHEMA', 'An installed package version is not a safe exact identifier.');
  }
  return value;
}
function optionalType(value, key, type) {
  if (value[key] !== undefined && typeof value[key] !== type) {
    fail('UNKNOWN_SCHEMA', `${key} has an unsupported type.`);
  }
}
function stringMap(value, label) {
  if (!record(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    fail('UNKNOWN_SCHEMA', `${label} must be a string map.`);
  }
}
function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('UNKNOWN_SCHEMA', `${label} must be a string array.`);
  }
}
function within(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function assertPath(root, target, finalKind = 'file') {
  const absoluteRoot = path.resolve(root),
    absolute = path.resolve(target);
  if (!within(absolute, absoluteRoot)) {
    fail('PATH_ESCAPE', 'Allowlisted metadata escaped its designated root.');
  }
  const rootStat = await lstat(absoluteRoot).catch(() =>
    fail('ROOT_UNAVAILABLE', 'A designated native root is unavailable.'),
  );
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(absoluteRoot)) !== absoluteRoot
  ) {
    fail('SYMLINK_REJECTED', 'Designated roots must be real directories.');
  }
  let current = absoluteRoot;
  for (const segment of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') {
        fail('METADATA_UNAVAILABLE', 'Allowlisted metadata is unavailable.');
      }
      throw error;
    });
    if (stat.isSymbolicLink()) {
      fail('SYMLINK_REJECTED', 'Symlinks are forbidden in allowlisted metadata paths.');
    }
  }
  const final = await lstat(absolute);
  if (finalKind === 'file' ? !final.isFile() : !final.isDirectory()) {
    fail('UNKNOWN_SCHEMA', 'Allowlisted metadata has an unexpected file type.');
  }
}
async function readJson(root, file) {
  await assertPath(root, file);
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES) {
      fail('UNKNOWN_SCHEMA', 'Allowlisted metadata exceeds its size limit.');
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) {
        fail('PATH_REPLACED', 'Metadata changed while being read.');
      }
      offset += bytesRead;
    }
    const after = await handle.stat(),
      linked = await lstat(file);
    if (
      linked.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== linked.dev ||
      after.ino !== linked.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail('PATH_REPLACED', 'Metadata changed while being read.');
    }
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      fail('UNKNOWN_SCHEMA', 'Allowlisted metadata is not valid JSON.');
    }
  } finally {
    await handle.close();
  }
}
function route(kind, value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    path.isAbsolute(value) ||
    value.includes('..') ||
    value.includes('\\')
  ) {
    fail('UNKNOWN_SCHEMA', 'Capability routes must be safe relative names.');
  }
  const name = path.posix.basename(value).replace(/\.(?:md|mjs|cjs|js|ts)$/u, '');
  return `${kind}:${safeId(name, 'capability route')}`;
}
function source(root, file, identity, runtime) {
  return `${rootToken(identity, runtime)}/${path.relative(root, file).split(path.sep).join('/')}`;
}

async function collectClaude(item) {
  const indexFile = path.join(item.path, 'plugins', 'installed_plugins.json'),
    value = await readJson(item.path, indexFile);
  exactKeys(value, ['version', 'plugins'], ['version', 'plugins']);
  if (value.version !== 2 || !record(value.plugins)) {
    fail('UNKNOWN_SCHEMA', 'Unsupported Claude installed-plugin schema.');
  }
  const entries = [];
  for (const [id, installations] of Object.entries(value.plugins)) {
    safeId(id, 'plugin ID');
    if (!Array.isArray(installations)) {
      fail('UNKNOWN_SCHEMA', 'Plugin installations must be an array.');
    }
    for (const installation of installations) {
      exactKeys(
        installation,
        [
          'scope',
          'installPath',
          'version',
          'installedAt',
          'lastUpdated',
          'gitCommitSha',
          'projectPath',
        ],
        ['installPath', 'version'],
      );
      if (
        typeof installation.installPath !== 'string' ||
        !path.isAbsolute(installation.installPath)
      ) {
        fail('UNKNOWN_SCHEMA', 'Plugin installPath must be absolute.');
      }
      if (
        installation.scope !== undefined &&
        !['user', 'project', 'local'].includes(installation.scope)
      ) {
        fail('UNKNOWN_SCHEMA', 'Plugin scope is unsupported.');
      }
      for (const key of ['installedAt', 'lastUpdated', 'gitCommitSha', 'projectPath']) {
        optionalType(installation, key, 'string');
      }
      const canonicalManifest = path.join(
        installation.installPath,
        '.claude-plugin',
        'plugin.json',
      );
      const fallbackManifest = path.join(installation.installPath, 'plugin.json');
      if (
        !within(path.resolve(canonicalManifest), path.resolve(item.path)) ||
        !within(path.resolve(fallbackManifest), path.resolve(item.path))
      ) {
        fail('PATH_ESCAPE', 'Indexed plugin manifest escaped its designated root.');
      }
      const manifestFile = await lstat(canonicalManifest).then(
        () => canonicalManifest,
        (error) => {
          if (error?.code === 'ENOENT') {
            return fallbackManifest;
          }
          throw error;
        },
      );
      let manifest;
      try {
        manifest = await readJson(item.path, manifestFile);
      } catch (error) {
        if (error?.code !== 'METADATA_UNAVAILABLE') {
          throw error;
        }
        entries.push({
          identity: item.identity,
          runtime: 'claude',
          id,
          version: safeInstalledVersion(installation.version),
          capabilityRoutes: [],
          source: source(item.path, indexFile, item.identity, 'claude'),
          classification: 'unsupported',
          reason: 'METADATA_UNAVAILABLE',
        });
        continue;
      }
      exactKeys(manifest, claudeManifestKeys, ['name']);
      safeId(manifest.name, 'manifest name');
      for (const key of ['version', 'description', 'homepage', 'license']) {
        optionalType(manifest, key, 'string');
      }
      if (manifest.version !== undefined) {
        safeInstalledVersion(manifest.version);
      }
      if (manifest.author !== undefined) {
        if (typeof manifest.author !== 'string') {
          exactKeys(manifest.author, ['name', 'email'], ['name']);
          optionalType(manifest.author, 'name', 'string');
          optionalType(manifest.author, 'email', 'string');
        }
      }
      if (manifest.keywords !== undefined) {
        stringArray(manifest.keywords, 'keywords');
      }
      const routes = [];
      for (const [key, kind] of [
        ['commands', 'command'],
        ['agents', 'agent'],
        ['skills', 'skill'],
      ]) {
        if (manifest[key] === undefined) {
          continue;
        }
        stringArray(manifest[key], key);
        routes.push(...manifest[key].map((name) => route(kind, name)));
      }
      if (manifest.hooks !== undefined) {
        if (typeof manifest.hooks !== 'string' && !record(manifest.hooks)) {
          fail('UNKNOWN_SCHEMA', 'hooks must be a route or object.');
        }
        routes.push('hook:hooks');
      }
      if (manifest.mcpServers !== undefined) {
        if (!record(manifest.mcpServers)) {
          fail('UNKNOWN_SCHEMA', 'mcpServers must be an object.');
        }
        for (const [name, server] of Object.entries(manifest.mcpServers)) {
          safeId(name, 'MCP route');
          exactKeys(server, ['command', 'args'], ['command']);
          optionalType(server, 'command', 'string');
          if (server.args !== undefined) {
            stringArray(server.args, 'MCP args');
          }
        }
        routes.push(
          ...Object.keys(manifest.mcpServers).map((name) => `mcp:${safeId(name, 'MCP route')}`),
        );
      }
      entries.push({
        identity: item.identity,
        runtime: 'claude',
        id,
        version: safeInstalledVersion(installation.version),
        capabilityRoutes: [...new Set(routes)].sort(),
        source: source(item.path, manifestFile, item.identity, 'claude'),
      });
    }
  }
  return entries;
}
async function collectPi(item) {
  const rootManifest = await readJson(item.path, path.join(item.path, 'package.json'));
  exactKeys(
    rootManifest,
    ['name', 'version', 'private', 'type', 'dependencies', 'devDependencies'],
    ['name'],
  );
  safeId(rootManifest.name, 'root package name');
  optionalType(rootManifest, 'version', 'string');
  optionalType(rootManifest, 'private', 'boolean');
  optionalType(rootManifest, 'type', 'string');
  if (rootManifest.dependencies !== undefined) {
    stringMap(rootManifest.dependencies, 'dependencies');
  }
  if (rootManifest.devDependencies !== undefined) {
    stringMap(rootManifest.devDependencies, 'devDependencies');
  }
  const dependencies = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
  const entries = [];
  for (const [declaredId, declaredVersion] of Object.entries(dependencies)) {
    safeId(declaredId, 'package ID');
    safeVersion(declaredVersion);
    const segments = declaredId.startsWith('@') ? declaredId.split('/') : [declaredId];
    const manifestFile = path.join(item.path, 'node_modules', ...segments, 'package.json'),
      manifest = await readJson(item.path, manifestFile);
    exactKeys(manifest, piPackageKeys, ['name', 'version', 'pi']);
    if (manifest.name !== declaredId || !record(manifest.pi)) {
      fail('UNKNOWN_SCHEMA', 'Installed Pi package identity does not match its declaration.');
    }
    safeVersion(manifest.version);
    for (const key of [
      'description',
      'author',
      'homepage',
      'license',
      'main',
      'module',
      'type',
      'types',
    ]) {
      optionalType(manifest, key, 'string');
    }
    if (manifest.keywords !== undefined) {
      stringArray(manifest.keywords, 'keywords');
    }
    if (manifest.files !== undefined) {
      stringArray(manifest.files, 'files');
    }
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'overrides']) {
      if (manifest[key] !== undefined) {
        stringMap(manifest[key], key);
      }
    }
    exactKeys(manifest.pi, ['extensions', 'skills', 'prompts', 'themes', 'image', 'video']);
    optionalType(manifest.pi, 'image', 'string');
    optionalType(manifest.pi, 'video', 'string');
    const routes = [];
    for (const [key, kind] of [
      ['extensions', 'extension'],
      ['skills', 'skill'],
      ['prompts', 'prompt'],
      ['themes', 'theme'],
    ]) {
      if (manifest.pi[key] === undefined) {
        continue;
      }
      stringArray(manifest.pi[key], `pi.${key}`);
      routes.push(...manifest.pi[key].map((name) => route(kind, name)));
    }
    entries.push({
      identity: item.identity,
      runtime: 'pi',
      id: declaredId,
      version: safeVersion(manifest.version),
      capabilityRoutes: [...new Set(routes)].sort(),
      source: source(item.path, manifestFile, item.identity, 'pi'),
    });
  }
  return entries;
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export async function collectInventory({ roots, declarations, reviews }) {
  if (
    !Array.isArray(roots) ||
    !Array.isArray(declarations) ||
    (reviews !== undefined && !Array.isArray(reviews))
  ) {
    fail('UNKNOWN_SCHEMA', 'roots, declarations, and reviews must be arrays.');
  }
  const seen = new Set();
  for (const item of roots) {
    exactKeys(item, ['identity', 'runtime', 'path'], ['identity', 'runtime', 'path']);
    safeId(item.identity, 'identity');
    if (
      !['claude', 'pi'].includes(item.runtime) ||
      typeof item.path !== 'string' ||
      !path.isAbsolute(item.path)
    ) {
      fail('UNKNOWN_SCHEMA', 'Invalid designated root.');
    }
    const key = `${item.identity}:${item.runtime}`;
    if (seen.has(key)) {
      fail('UNKNOWN_SCHEMA', 'Duplicate designated root.');
    }
    seen.add(key);
  }
  const declared = declarations.map((item) => {
    const reviewKeys = ['disposition', 'phase', 'rationale', 'intendedMpxRoute'];
    const hasReview = reviewKeys.some((key) => own(item, key));
    exactKeys(
      item,
      ['runtime', 'id', 'version', 'capabilityRoutes', ...reviewKeys],
      ['runtime', 'id', 'version', 'capabilityRoutes', ...(hasReview ? reviewKeys : [])],
    );
    if (!['claude', 'pi'].includes(item.runtime) || !Array.isArray(item.capabilityRoutes)) {
      fail('UNKNOWN_SCHEMA', 'Invalid repository declaration.');
    }
    if (
      hasReview &&
      (!reviewedDispositions.has(item.disposition) ||
        !['Phase F1', 'Phase I'].includes(item.phase) ||
        typeof item.rationale !== 'string' ||
        !item.rationale.trim() ||
        typeof item.intendedMpxRoute !== 'string' ||
        !item.intendedMpxRoute.trim())
    ) {
      fail('UNKNOWN_SCHEMA', 'Invalid reviewed package disposition.');
    }
    return {
      runtime: item.runtime,
      id: safeId(item.id),
      version: safeInstalledVersion(item.version),
      capabilityRoutes: [...item.capabilityRoutes]
        .map((x) => {
          if (typeof x !== 'string' || !declaredRoutePattern.test(x)) {
            fail('UNKNOWN_SCHEMA', 'Invalid declared route.');
          }
          return x;
        })
        .sort(),
      ...(hasReview ? Object.fromEntries(reviewKeys.map((key) => [key, item[key]])) : {}),
    };
  });
  const reviewed = (reviews ?? []).map((item) => {
    const reviewKeys = ['disposition', 'phase', 'rationale', 'intendedMpxRoute'];
    exactKeys(item, ['runtime', 'id', ...reviewKeys], ['runtime', 'id', ...reviewKeys]);
    if (
      !['claude', 'pi'].includes(item.runtime) ||
      !reviewedDispositions.has(item.disposition) ||
      !['Phase F1', 'Phase I'].includes(item.phase) ||
      typeof item.rationale !== 'string' ||
      !item.rationale.trim() ||
      typeof item.intendedMpxRoute !== 'string' ||
      !item.intendedMpxRoute.trim()
    ) {
      fail('UNKNOWN_SCHEMA', 'Invalid reviewed package disposition.');
    }
    return { ...item, id: safeId(item.id) };
  });
  const reviewKeys = ['disposition', 'phase', 'rationale', 'intendedMpxRoute'];
  const reviewFor = (entry, expected) =>
    reviewed.find((item) => item.runtime === entry.runtime && item.id === entry.id) ??
    (expected?.disposition
      ? Object.fromEntries(reviewKeys.map((key) => [key, expected[key]]))
      : null);
  const observed = (
    await Promise.all(
      roots.map((item) => (item.runtime === 'claude' ? collectClaude(item) : collectPi(item))),
    )
  ).flat();
  const collected = [...new Map(observed.map((entry) => [JSON.stringify(entry), entry])).values()];
  const entries = collected.map((entry) => {
    const expected = declared.find(
      (item) => item.runtime === entry.runtime && item.id === entry.id,
    );
    const reviewedDisposition = reviewFor(entry, expected);
    if (reviews !== undefined && !reviewedDisposition) {
      fail('UNREVIEWED_INSTALLATION', `${entry.runtime}:${entry.id} has no reviewed disposition.`);
    }
    const review = reviewedDisposition ?? {};
    if (entry.classification === 'unsupported') {
      return { ...entry, ...review };
    }
    return {
      ...entry,
      classification: !expected
        ? 'extra'
        : expected.version === entry.version &&
            same(expected.capabilityRoutes, entry.capabilityRoutes)
          ? 'matched'
          : 'unsupported',
      ...review,
    };
  });
  for (const expected of declared) {
    if (
      !collected.some((entry) => entry.runtime === expected.runtime && entry.id === expected.id)
    ) {
      entries.push({
        identity: '<not-present>',
        ...expected,
        source: '<not-present>',
        classification: 'missing',
      });
    }
  }
  entries.sort((a, b) =>
    `${a.identity}:${a.runtime}:${a.id}`.localeCompare(`${b.identity}:${b.runtime}:${b.id}`),
  );
  const counts = { matched: 0, missing: 0, extra: 0, unsupported: 0 };
  for (const entry of entries) {
    counts[entry.classification]++;
  }
  return {
    schemaVersion: 1,
    roots: roots
      .map((item) => ({
        identity: item.identity,
        runtime: item.runtime,
        digest: digest(path.resolve(item.path).toLowerCase()),
        placeholder: rootToken(item.identity, item.runtime),
      }))
      .sort((a, b) => `${a.identity}:${a.runtime}`.localeCompare(`${b.identity}:${b.runtime}`)),
    entries,
    summary: counts,
  };
}

async function main() {
  const args = process.argv.slice(2),
    roots = [];
  let declarationsFile = path.resolve('docs/phase-f1-capability-declarations.json'),
    configFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
      const value = args[++i] ?? '',
        first = value.indexOf(':'),
        second = value.indexOf(':', first + 1);
      if (first < 1 || second < 0) {
        fail('USAGE', '--root requires identity:runtime:absolute-path');
      }
      roots.push({
        identity: value.slice(0, first),
        runtime: value.slice(first + 1, second),
        path: value.slice(second + 1),
      });
    } else if (args[i] === '--declarations') {
      declarationsFile = path.resolve(args[++i] ?? '');
    } else if (args[i] === '--config') {
      configFile = path.resolve(args[++i] ?? '');
    } else {
      fail('USAGE', `Unknown argument ${args[i]}`);
    }
  }
  if (!roots.length) {
    const file =
      configFile ??
      (process.env.APPDATA ? path.join(process.env.APPDATA, 'mpx', 'config.json') : undefined);
    if (!file) {
      fail('ROOTS_UNAVAILABLE', 'Pass --root or configure APPDATA/MPX config.');
    }
    const config = await readJson(path.dirname(file), file);
    exactKeys(
      config,
      [
        'identities',
        'domains',
        'contentScopes',
        'modes',
        'skillPolicies',
        'presets',
        'launchDefaults',
        'networkPolicies',
        'executors',
        'projects',
      ],
      ['identities'],
    );
    if (!record(config.identities)) {
      fail('UNKNOWN_SCHEMA', 'Invalid identity routes.');
    }
    for (const [identity, value] of Object.entries(config.identities)) {
      exactKeys(
        value,
        ['domain', 'runtimeRoots', 'gitAuthorRoute', 'providerRoutes', 'sshRoute', 'mcpSharing'],
        ['domain', 'runtimeRoots', 'gitAuthorRoute'],
      );
      if (!record(value.runtimeRoots)) {
        fail('UNKNOWN_SCHEMA', 'Identity runtimeRoots are required.');
      }
      exactKeys(value.runtimeRoots, ['claude', 'pi']);
      for (const runtime of ['claude', 'pi']) {
        if (value.runtimeRoots[runtime]) {
          const configured = value.runtimeRoots[runtime];
          if (typeof configured !== 'string') {
            fail('UNKNOWN_SCHEMA', 'Identity runtime roots must be strings.');
          }
          const expanded =
            configured === '~'
              ? homedir()
              : configured.startsWith(`~${path.sep}`) || configured.startsWith('~/')
                ? path.join(homedir(), configured.slice(2))
                : configured;
          roots.push({ identity, runtime, path: expanded });
        }
      }
    }
  }
  const declarations = await readJson(path.dirname(declarationsFile), declarationsFile);
  exactKeys(
    declarations,
    ['schemaVersion', 'packages', 'reviews'],
    ['schemaVersion', 'packages', 'reviews'],
  );
  if (declarations.schemaVersion !== 2) {
    fail('UNKNOWN_SCHEMA', 'Unsupported declarations schema.');
  }
  console.log(
    JSON.stringify(
      await collectInventory({
        roots,
        declarations: declarations.packages,
        reviews: declarations.reviews,
      }),
      null,
      2,
    ),
  );
}
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
