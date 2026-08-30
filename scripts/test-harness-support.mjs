import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  return files.flat();
}

function parseWorkspacePatterns(source) {
  const packagesBlock = source.match(/^packages:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1] ?? '';
  return [...packagesBlock.matchAll(/^\s*-\s*([^#\r\n]+?)\s*$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, ''),
  );
}

function patternDepth(pattern) {
  return pattern.split('/').length;
}

function workspacePatternMatches(candidate, pattern) {
  const candidateParts = candidate.split('/');
  const patternParts = pattern.split('/');
  return (
    candidateParts.length === patternParts.length &&
    patternParts.every((part, index) => part === '*' || part === candidateParts[index])
  );
}

async function directoriesAtDepth(repositoryRoot, depth, directory = '.') {
  if (depth === 0) {
    return [directory.replace(/^\.\//, '')];
  }
  const entries = await readdir(path.join(repositoryRoot, directory), { withFileTypes: true });
  const directories = entries.filter(
    (entry) => entry.isDirectory() && !PRUNED_DIRECTORY_NAMES.has(entry.name),
  );
  return (
    await Promise.all(
      directories.map((entry) =>
        directoriesAtDepth(repositoryRoot, depth - 1, path.posix.join(directory, entry.name)),
      ),
    )
  ).flat();
}

export async function discoverWorkspaceRoots(repositoryRoot) {
  const source = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = parseWorkspacePatterns(source);
  const depths = [...new Set(patterns.map(patternDepth))];
  const candidates = (
    await Promise.all(depths.map((depth) => directoriesAtDepth(repositoryRoot, depth)))
  ).flat();
  const matches = candidates.filter((candidate) =>
    patterns.some((pattern) => workspacePatternMatches(candidate, pattern)),
  );
  const manifests = await Promise.all(
    matches.map(async (candidate) => {
      try {
        await readFile(path.join(repositoryRoot, candidate, 'package.json'), 'utf8');
        return candidate;
      } catch {
        return undefined;
      }
    }),
  );
  return manifests.filter((candidate) => candidate !== undefined).sort();
}
