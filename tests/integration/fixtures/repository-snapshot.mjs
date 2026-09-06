import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { discoverWorkspaceRoots } from '../scripts/fixtures/test-harness-support.mjs';

const snapshotDirectories = ['apps', 'packages', 'runtimes', 'scripts', 'content', 'bin'];
const snapshotRootFiles = [
  '.editorconfig',
  '.oxlintrc.json',
  '.prettierrc.json',
  'mpxconfig.json',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.test.json',
];
const excludedSnapshotDirectories = new Set([
  '.git',
  'node_modules',
  '.package-staging',
  '.package-backup',
  '.package-verify',
]);

async function linkDirectory(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

async function provisionDependencies(repositoryRoot, snapshotRoot) {
  const workspaces = ['', ...(await discoverWorkspaceRoots(snapshotRoot))];
  const manifests = await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace,
      manifest: JSON.parse(
        await readFile(path.join(snapshotRoot, workspace, 'package.json'), 'utf8'),
      ),
    })),
  );
  const workspaceByName = new Map(
    manifests.map(({ workspace, manifest }) => [manifest.name, workspace]),
  );
  for (const { workspace, manifest } of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    for (const [dependency, version] of Object.entries(dependencies)) {
      let source;
      if (workspaceByName.has(dependency)) {
        source = path.join(snapshotRoot, workspaceByName.get(dependency));
      } else {
        if (version.startsWith('workspace:')) {
          throw new Error(`Missing snapshot workspace: ${dependency}`);
        }
        source = await realpath(
          path.join(repositoryRoot, workspace, 'node_modules', dependency),
        ).catch(() => realpath(path.join(repositoryRoot, 'node_modules', dependency)));
        const relativeSource = path.relative(repositoryRoot, source);
        if (!relativeSource.split(path.sep).includes('node_modules')) {
          throw new Error(`External dependency is not installed package bytes: ${dependency}`);
        }
      }
      await linkDirectory(source, path.join(snapshotRoot, workspace, 'node_modules', dependency));
    }
  }
  await linkDirectory(
    await realpath(path.join(repositoryRoot, 'node_modules', '.bin')),
    path.join(snapshotRoot, 'node_modules', '.bin'),
  );
}

export async function createRepositorySnapshot(repositoryRoot, prefix) {
  const snapshotRoot = await mkdtemp(path.join(repositoryRoot, 'node_modules', prefix));
  try {
    const filter = (source) => !excludedSnapshotDirectories.has(path.basename(source));
    // Cleanup must not race a copy that is still writing after another copy fails.
    const copies = await Promise.allSettled([
      ...snapshotDirectories.map((directory) =>
        cp(path.join(repositoryRoot, directory), path.join(snapshotRoot, directory), {
          recursive: true,
          filter,
        }),
      ),
      ...snapshotRootFiles.map((file) =>
        cp(path.join(repositoryRoot, file), path.join(snapshotRoot, file)),
      ),
    ]);
    const failure = copies.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
    await provisionDependencies(repositoryRoot, snapshotRoot);
    return snapshotRoot;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function repositoryOutputDigests(repositoryRoot) {
  const result = {};
  async function visit(relative) {
    const absolute = path.join(repositoryRoot, relative);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else {
        result[file] = createHash('sha256')
          .update(await readFile(path.join(repositoryRoot, file)))
          .digest('hex');
      }
    }
  }
  await visit('bin');
  for (const workspace of await discoverWorkspaceRoots(repositoryRoot)) {
    await visit(`${workspace}/dist`);
  }
  return result;
}
