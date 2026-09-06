import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build as esbuild, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(packageRoot, 'dist');
const artifactRoot = path.join(distRoot, 'package');
const stagingRoot = path.join(distRoot, '.package-staging');
const backupRoot = path.join(distRoot, '.package-backup');
const verificationRoot = path.join(distRoot, '.package-verify');

export const HOST_EXTERNALS = Object.freeze([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@sinclair/typebox',
]);

export const GUARD_ASSETS = Object.freeze([
  'guards/dangerous-command-guard.mjs',
  'guards/enforce-pkg-mgr.mjs',
  'guards/fallow-gate.mjs',
  'guards/format-lint-file.mjs',
  'guards/machine-paths.mjs',
  'guards/notify-flash-beep.ps1',
  'guards/post-bash-context.mjs',
  'guards/pre-commit-gate.mjs',
  'guards/shared.mjs',
]);

export const CONFIG_ASSETS = Object.freeze([
  'config/COMPACT.md',
  'config/keybindings.json',
  'config/settings.json',
  'config/subagents.json',
]);

export const THEME_ASSETS = Object.freeze(['themes/amber.json', 'themes/green.json']);
export const VENDORED_LICENSE_ASSETS = Object.freeze(['subagents/LICENSE']);
export const PACKAGE_ASSETS = Object.freeze([
  ...CONFIG_ASSETS,
  ...THEME_ASSETS,
  ...GUARD_ASSETS,
  ...VENDORED_LICENSE_ASSETS,
]);

const dependencyLicenses = Object.freeze([
  { packageName: 'croner', output: 'licenses/croner.LICENSE' },
  { packageName: 'nanoid', output: 'licenses/nanoid.LICENSE' },
]);
const generatedPayloadFiles = Object.freeze([
  'index.mjs',
  'package.json',
  ...PACKAGE_ASSETS,
  ...dependencyLicenses.map(({ output }) => output),
]);
const completeArtifactFiles = Object.freeze(
  [...generatedPayloadFiles, 'build-metadata.json'].sort(),
);
const nestedLockfiles = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const sourceIgnoredDirectories = new Set(['dist', 'node_modules', 'scripts', 'test']);
const require = createRequire(import.meta.url);
const nodeBuiltinSpecifiers = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith('node:') ? specifier : `node:${specifier}`,
  ),
);
const fileSystem = { lstat, readdir };
let verifiedReleaseFingerprint;

export const BUNDLER_OPTIONS = Object.freeze({
  bundle: true,
  conditions: ['mpx-source'],
  external: HOST_EXTERNALS,
  format: 'esm',
  legalComments: 'none',
  minifyWhitespace: true,
  platform: 'node',
  sourcemap: false,
  target: 'node22',
});
export const BUNDLER_CONFIG = Object.freeze({
  entryPoint: 'index.ts',
  outputFile: 'index.mjs',
  esbuildVersion,
  options: BUNDLER_OPTIONS,
});
const releaseManifest = {
  name: '@mpx/pi-extensions',
  private: true,
  type: 'module',
  pi: {
    extensions: ['./index.mjs'],
    themes: ['./themes/amber.json', './themes/green.json'],
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isApprovedImportSpecifier(specifier) {
  return nodeBuiltinSpecifiers.has(specifier) || HOST_EXTERNALS.includes(specifier);
}

export function analyzeImportSpecifiers(source) {
  const sourceFile = ts.createSourceFile(
    'index.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error('Import analysis failed because the JavaScript is invalid');
  }

  const staticSpecifiers = [];
  const dynamicSpecifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error('Non-literal static import or export is forbidden');
      }
      staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (
        !specifier ||
        (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier))
      ) {
        throw new Error('Non-literal dynamic import is forbidden');
      }
      dynamicSpecifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { staticSpecifiers, dynamicSpecifiers };
}

export function assertAllowedImportSpecifiers(source) {
  const analysis = analyzeImportSpecifiers(source);
  for (const specifier of [...analysis.staticSpecifiers, ...analysis.dynamicSpecifiers]) {
    if (!isApprovedImportSpecifier(specifier)) {
      throw new Error('Unapproved import specifier is forbidden');
    }
  }
  return analysis;
}

function assertAllowedArtifactPath(relativePath) {
  const segments = relativePath.toLowerCase().split('/');
  const basename = segments.at(-1);
  if (segments.includes('node_modules')) {
    throw new Error(`Forbidden release path: ${relativePath}`);
  }
  if (basename && nestedLockfiles.has(basename)) {
    throw new Error(`Forbidden release path: ${relativePath}`);
  }
  if (basename?.endsWith('.map')) {
    throw new Error(`Forbidden release path: ${relativePath}`);
  }
}

export async function walkRegularFiles(
  directory,
  {
    currentPrefix = '',
    ignoredTopLevelDirectories = new Set(),
    inspectPath = () => undefined,
    operations = fileSystem,
  } = {},
) {
  const files = [];
  const names = [...(await operations.readdir(directory))].sort();
  for (const name of names) {
    const absolutePath = path.join(directory, name);
    const relativePath = currentPrefix ? `${currentPrefix}/${name}` : name;
    const entryStat = await operations.lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Symbolic link, junction, or reparse point is forbidden: ${relativePath}`);
    }
    inspectPath(relativePath);
    if (entryStat.isDirectory()) {
      if (!currentPrefix && ignoredTopLevelDirectories.has(name)) {
        continue;
      }
      files.push(
        ...(await walkRegularFiles(absolutePath, {
          currentPrefix: relativePath,
          ignoredTopLevelDirectories,
          inspectPath,
          operations,
        })),
      );
    } else if (entryStat.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported filesystem entry is forbidden: ${relativePath}`);
    }
  }
  return files;
}

async function readRequiredFile(root, relativePath) {
  const segments = relativePath.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entryStat = await lstat(current).catch(() => null);
    if (!entryStat) {
      throw new Error(`Required release asset is missing: ${relativePath}`);
    }
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Required release asset is symlinked: ${relativePath}`);
    }
    const isLast = index === segments.length - 1;
    if ((!isLast && !entryStat.isDirectory()) || (isLast && !entryStat.isFile())) {
      throw new Error(`Required release asset is not a regular file: ${relativePath}`);
    }
  }
  return readFile(current);
}

async function productionInputs() {
  const sourceFiles = (
    await walkRegularFiles(packageRoot, {
      ignoredTopLevelDirectories: sourceIgnoredDirectories,
    })
  ).filter((file) => file.endsWith('.ts'));
  const workspaceInputs = [];
  for (const packageName of ['@mpx/content-compiler', '@mpx/runtime-contracts']) {
    const dependencyRoot = await dependencyPackageRoot(packageName);
    const prefix = path.relative(packageRoot, dependencyRoot).replaceAll('\\', '/');
    workspaceInputs.push(
      `${prefix}/package.json`,
      ...(await walkRegularFiles(path.join(dependencyRoot, 'src')))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => `${prefix}/src/${file}`),
    );
  }
  return [
    ...new Set([
      ...sourceFiles,
      ...workspaceInputs,
      'package.json',
      'scripts/release.mjs',
      ...PACKAGE_ASSETS,
    ]),
  ].sort();
}

async function treeDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readRequiredFile(root, file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function dependencyPackageRoot(packageName) {
  let current = path.dirname(require.resolve(packageName));
  while (true) {
    const manifestPath = path.join(current, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === packageName) {
        return current;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate ${packageName} package root`);
    }
    current = parent;
  }
}

async function dependencyLicense(packageName) {
  const root = await dependencyPackageRoot(packageName);
  return readRequiredFile(root, 'LICENSE');
}

async function artifactFiles(root) {
  return walkRegularFiles(root, { inspectPath: assertAllowedArtifactPath });
}

async function inventory(root, files) {
  const result = {};
  for (const file of [...files].sort()) {
    result[file] = sha256(await readFile(path.join(root, file)));
  }
  return result;
}

function assertExactFiles(actual, expected, context) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} has missing or extra files`);
  }
}

async function createArtifact(destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  await esbuild({
    ...BUNDLER_OPTIONS,
    absWorkingDir: packageRoot,
    entryPoints: [path.join(packageRoot, BUNDLER_CONFIG.entryPoint)],
    outfile: path.join(destination, BUNDLER_CONFIG.outputFile),
  });

  for (const asset of PACKAGE_ASSETS) {
    const output = path.join(destination, asset);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, await readRequiredFile(packageRoot, asset));
  }

  for (const { packageName, output } of dependencyLicenses) {
    const outputPath = path.join(destination, output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await dependencyLicense(packageName));
  }
  await writeFile(path.join(destination, 'package.json'), canonicalJson(releaseManifest));

  const payloadFiles = await artifactFiles(destination);
  assertExactFiles(payloadFiles, generatedPayloadFiles, 'Generated release payload');
  const sourceFiles = await productionInputs();
  const metadata = {
    schemaVersion: 1,
    sourceTreeDigest: await treeDigest(packageRoot, sourceFiles),
    bundlerConfigDigest: sha256(canonicalJson(BUNDLER_CONFIG)),
    files: await inventory(destination, payloadFiles),
  };
  await writeFile(path.join(destination, 'build-metadata.json'), canonicalJson(metadata));
}

async function assertPortable(root) {
  const files = await artifactFiles(root);
  assertExactFiles(files, completeArtifactFiles, 'Release artifact');
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8');
    if (/(?:^|[^a-z])[a-z]:[\\/]/i.test(content) || /mpx-(?:pi|claude-code)/i.test(content)) {
      throw new Error(`Machine or repository path leaked into ${file}`);
    }
  }
}

async function assertArtifactImportPolicy(root) {
  assertAllowedImportSpecifiers(await readFile(path.join(root, 'index.mjs'), 'utf8'));
}

async function assertMetadataInventory(root) {
  const metadataPath = path.join(root, 'build-metadata.json');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    throw new Error('Release metadata is missing or invalid');
  }
  if (
    metadata?.schemaVersion !== 1 ||
    Object.keys(metadata).join('\0') !==
      ['schemaVersion', 'sourceTreeDigest', 'bundlerConfigDigest', 'files'].join('\0') ||
    typeof metadata.sourceTreeDigest !== 'string' ||
    typeof metadata.bundlerConfigDigest !== 'string' ||
    !metadata.files ||
    typeof metadata.files !== 'object' ||
    Array.isArray(metadata.files)
  ) {
    throw new Error('Release metadata has an invalid shape');
  }
  const sourceTreeDigest = await treeDigest(packageRoot, await productionInputs());
  if (metadata.sourceTreeDigest !== sourceTreeDigest) {
    throw new Error('Release metadata source tree digest mismatch');
  }
  const bundlerConfigDigest = sha256(canonicalJson(BUNDLER_CONFIG));
  if (metadata.bundlerConfigDigest !== bundlerConfigDigest) {
    throw new Error('Release metadata bundler config digest mismatch');
  }
  assertExactFiles(
    Object.keys(metadata.files),
    generatedPayloadFiles,
    'Release metadata inventory',
  );
  for (const file of generatedPayloadFiles) {
    const digest = sha256(await readFile(path.join(root, file)));
    if (metadata.files[file] !== digest) {
      throw new Error(`Release metadata digest mismatch: ${file}`);
    }
  }
}

async function pathKind(target) {
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Symbolic link, junction, or reparse point is forbidden: ${target}`);
    }
    if (targetStat.isDirectory()) {
      return 'directory';
    }
    throw new Error(`Expected directory: ${target}`);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

export async function publishArtifact(
  staging,
  target,
  backup,
  { renamePath = rename, removePath = rm } = {},
) {
  let previousMoved = false;
  let published = false;
  try {
    if ((await pathKind(target)) === 'directory') {
      await removePath(backup, { recursive: true, force: true });
      await renamePath(target, backup);
      previousMoved = true;
    }
    await renamePath(staging, target);
    published = true;
    if (previousMoved) {
      await removePath(backup, { recursive: true, force: true });
      previousMoved = false;
    }
  } catch (publishError) {
    if (previousMoved && !published) {
      await removePath(target, { recursive: true, force: true });
      await renamePath(backup, target);
      previousMoved = false;
    }
    throw publishError;
  } finally {
    await removePath(staging, { recursive: true, force: true });
    if (!previousMoved) {
      await removePath(backup, { recursive: true, force: true });
    }
  }
}

async function recoverInterruptedPublish() {
  const artifactKind = await pathKind(artifactRoot);
  const backupKind = await pathKind(backupRoot);
  if (backupKind === 'directory' && artifactKind === 'missing') {
    await rename(backupRoot, artifactRoot);
  } else if (backupKind === 'directory') {
    await rm(backupRoot, { recursive: true, force: true });
  }
  await rm(stagingRoot, { recursive: true, force: true });
}

export async function buildRelease() {
  await mkdir(distRoot, { recursive: true });
  await recoverInterruptedPublish();
  try {
    await createArtifact(stagingRoot);
    await assertPortable(stagingRoot);
    await assertArtifactImportPolicy(stagingRoot);
    await assertMetadataInventory(stagingRoot);
    await publishArtifact(stagingRoot, artifactRoot, backupRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function verifyRelease() {
  if ((await pathKind(artifactRoot)) !== 'directory') {
    throw new Error('Release artifact is missing; run build:release');
  }
  await assertPortable(artifactRoot);
  await assertArtifactImportPolicy(artifactRoot);
  await assertMetadataInventory(artifactRoot);
  const files = await artifactFiles(artifactRoot);
  const fingerprint = sha256(
    canonicalJson({
      artifactDigest: await treeDigest(artifactRoot, files),
      bundlerConfigDigest: sha256(canonicalJson(BUNDLER_CONFIG)),
      sourceTreeDigest: await treeDigest(packageRoot, await productionInputs()),
    }),
  );
  if (fingerprint === verifiedReleaseFingerprint) {
    return;
  }
  try {
    await createArtifact(verificationRoot);
    await assertPortable(verificationRoot);
    await assertArtifactImportPolicy(verificationRoot);
    await assertMetadataInventory(verificationRoot);
    const expectedFiles = await artifactFiles(verificationRoot);
    const actualFiles = await artifactFiles(artifactRoot);
    assertExactFiles(actualFiles, expectedFiles, 'Release artifact');
    for (const file of expectedFiles) {
      const expectedBytes = await readFile(path.join(verificationRoot, file));
      const actualBytes = await readFile(path.join(artifactRoot, file));
      if (!expectedBytes.equals(actualBytes)) {
        throw new Error(`Release artifact is stale or tampered: ${file}`);
      }
    }
    verifiedReleaseFingerprint = fingerprint;
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectInvocation) {
  const action = process.argv[2];
  if (action === 'build') {
    await buildRelease();
  } else if (action === 'verify') {
    await verifyRelease();
  } else {
    throw new Error(`Expected build or verify, received ${String(action)}`);
  }
}
