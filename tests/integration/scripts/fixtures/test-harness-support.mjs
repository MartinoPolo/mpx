import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PNPM_OUTPUT_BYTES = 1024 * 1024;

const SUPPORTED_SCRIPT_EXTENSION = String.raw`[cm]?[jt]sx?`;
const selectedCategoryTestPattern = new RegExp(
  String.raw`\.(?:test|spec)\.${SUPPORTED_SCRIPT_EXTENSION}$`,
  'u',
);
const testLikePattern = new RegExp(
  String.raw`\.(?:test|spec)\.${SUPPORTED_SCRIPT_EXTENSION}$`,
  'u',
);

export function selectedCategoryTestFile(file) {
  return selectedCategoryTestPattern.test(file);
}

export function testLikeFile(file) {
  return testLikePattern.test(file);
}

export function workspaceTestLayoutViolations(workspace, files) {
  return files
    .filter(
      (file) =>
        file.startsWith(`${workspace}/`) &&
        testLikeFile(file) &&
        (!file.startsWith(`${workspace}/test/unit/`) ||
          file.startsWith(`${workspace}/src/`) ||
          /(?:^|\/)(?:fixture|fixtures|__fixtures__|test-fixtures)(?:\/|$)/u.test(file)),
    )
    .sort();
}

const PRUNED_DIRECTORY_NAMES = new Set([
  '.git',
  '.fallow',
  'node_modules',
  'dist',
  'coverage',
  'generated',
  'projection',
  'projections',
  'vendor',
]);

export async function filesBelow(repositoryRoot, directory = '.') {
  const absolute = path.join(repositoryRoot, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) {
        return PRUNED_DIRECTORY_NAMES.has(entry.name) ? [] : filesBelow(repositoryRoot, relative);
      }
      return [relative.replace(/^\.\//, '')];
    }),
  );
  return files.flat().sort();
}

export function workspaceRootsFromPnpmList(repositoryRoot, source) {
  const packages = JSON.parse(source);
  if (!Array.isArray(packages)) {
    throw new TypeError('pnpm workspace list output must be an array');
  }
  const workspaceRoots = [
    ...new Set(
      packages.map((workspacePackage) => {
        if (typeof workspacePackage?.path !== 'string') {
          throw new TypeError('pnpm workspace list entries must have a path');
        }
        return path.relative(repositoryRoot, workspacePackage.path).replaceAll('\\', '/');
      }),
    ),
  ]
    .filter((workspace) => workspace !== '')
    .sort();
  if (workspaceRoots.length === 0) {
    throw new Error('pnpm workspace list must include at least one non-root workspace');
  }
  return workspaceRoots;
}

export async function runPnpm(repositoryRoot, args) {
  const { stdout } = await execFileAsync('pnpm', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: MAX_PNPM_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

export async function requireReadableWorkspaceManifests(repositoryRoot, workspaceRoots) {
  await Promise.all(
    workspaceRoots.map((workspace) =>
      readFile(path.join(repositoryRoot, workspace, 'package.json'), 'utf8'),
    ),
  );
  return workspaceRoots;
}

export async function discoverWorkspaceRoots(repositoryRoot) {
  const source = await runPnpm(repositoryRoot, ['--recursive', 'list', '--depth', '-1', '--json']);
  const workspaceRoots = workspaceRootsFromPnpmList(repositoryRoot, source);
  return requireReadableWorkspaceManifests(repositoryRoot, workspaceRoots);
}
