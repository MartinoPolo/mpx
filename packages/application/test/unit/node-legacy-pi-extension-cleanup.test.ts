import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LegacyPiExtensionCleanupService } from '../../src/node/legacy-pi-extension-cleanup.js';

const roots: string[] = [];
const missing = async (target: string) => {
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mpx-legacy-pi-cleanup-'));
  roots.push(root);
  const projectsRoot = path.join(root, 'projects');
  const sourceExtensions = path.join(projectsRoot, 'mpx-pi', 'extensions');
  await mkdir(path.join(sourceExtensions, 'worktree'), { recursive: true });
  await writeFile(path.join(sourceExtensions, 'mp-namespace-commands.ts'), 'source');
  return { root, projectsRoot, sourceExtensions };
}

async function makeLegacyLinks(nativeRoot: string, sourceExtensions: string) {
  const extensions = path.join(nativeRoot, 'extensions');
  await mkdir(extensions, { recursive: true });
  const worktreeTarget = path.join(sourceExtensions, 'worktree');
  const commandsTarget = path.join(sourceExtensions, 'mp-namespace-commands.ts');
  await symlink(
    process.platform === 'win32' ? worktreeTarget.toUpperCase() : worktreeTarget,
    path.join(extensions, 'worktree'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await symlink(
    process.platform === 'win32' ? commandsTarget.toUpperCase() : commandsTarget,
    path.join(extensions, 'mp-namespace-commands.ts'),
    'file',
  );
  return extensions;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('unlinks both exact MPX-owned legacy extension links without deleting their sources', async () => {
  const value = await fixture();
  const nativeRoot = path.join(value.root, 'pi-personal');
  const extensions = await makeLegacyLinks(nativeRoot, value.sourceExtensions);

  await new LegacyPiExtensionCleanupService({
    piRoots: [nativeRoot],
    projectsRoot: value.projectsRoot,
  }).run();

  await missing(path.join(extensions, 'worktree'));
  await missing(path.join(extensions, 'mp-namespace-commands.ts'));
  expect((await lstat(path.join(value.sourceExtensions, 'worktree'))).isDirectory()).toBe(true);
  expect(
    (await lstat(path.join(value.sourceExtensions, 'mp-namespace-commands.ts'))).isFile(),
  ).toBe(true);
});

it('deduplicates configured Pi roots and remains idempotent', async () => {
  const value = await fixture();
  const nativeRoot = path.join(value.root, 'pi-personal');
  const extensions = await makeLegacyLinks(nativeRoot, value.sourceExtensions);
  const service = new LegacyPiExtensionCleanupService({
    piRoots: [nativeRoot, nativeRoot],
    projectsRoot: value.projectsRoot,
  });

  await service.run();
  await service.run();

  await missing(path.join(extensions, 'worktree'));
  await missing(path.join(extensions, 'mp-namespace-commands.ts'));
});

it('cleans every configured Pi native root', async () => {
  const value = await fixture();
  const nativeRoots = [path.join(value.root, 'pi-personal'), path.join(value.root, 'pi-work')];
  await Promise.all(nativeRoots.map((root) => makeLegacyLinks(root, value.sourceExtensions)));

  await new LegacyPiExtensionCleanupService({
    piRoots: nativeRoots,
    projectsRoot: value.projectsRoot,
  }).run();

  await Promise.all(
    nativeRoots.flatMap((root) =>
      ['worktree', 'mp-namespace-commands.ts'].map((name) =>
        missing(path.join(root, 'extensions', name)),
      ),
    ),
  );
});

it('preserves missing paths, regular entries, and links to foreign targets', async () => {
  const value = await fixture();
  const regularRoot = path.join(value.root, 'pi-regular');
  const foreignRoot = path.join(value.root, 'pi-foreign');
  const missingRoot = path.join(value.root, 'pi-missing');
  const regularExtensions = path.join(regularRoot, 'extensions');
  const foreignExtensions = path.join(foreignRoot, 'extensions');
  const foreignDirectory = path.join(value.root, 'foreign-worktree');
  const foreignFile = path.join(value.root, 'foreign-commands.ts');
  await Promise.all([
    mkdir(path.join(regularExtensions, 'worktree'), { recursive: true }),
    mkdir(foreignExtensions, { recursive: true }),
    mkdir(foreignDirectory),
    writeFile(foreignFile, 'foreign'),
  ]);
  await writeFile(path.join(regularExtensions, 'mp-namespace-commands.ts'), 'user');
  await symlink(
    foreignDirectory,
    path.join(foreignExtensions, 'worktree'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await symlink(foreignFile, path.join(foreignExtensions, 'mp-namespace-commands.ts'), 'file');

  await new LegacyPiExtensionCleanupService({
    piRoots: [regularRoot, foreignRoot, missingRoot],
    projectsRoot: value.projectsRoot,
  }).run();

  expect((await lstat(path.join(regularExtensions, 'worktree'))).isDirectory()).toBe(true);
  expect((await lstat(path.join(regularExtensions, 'mp-namespace-commands.ts'))).isFile()).toBe(
    true,
  );
  expect(await readlink(path.join(foreignExtensions, 'worktree'))).toBeTruthy();
  expect(await readlink(path.join(foreignExtensions, 'mp-namespace-commands.ts'))).toBeTruthy();
});

it('fails closed when a deletion candidate changes identity after inspection', async () => {
  const value = await fixture();
  const nativeRoot = path.join(value.root, 'pi-personal');
  const extensions = path.join(nativeRoot, 'extensions');
  await mkdir(extensions, { recursive: true });
  const candidate = path.join(extensions, 'worktree');
  await symlink(
    path.join(value.sourceExtensions, 'worktree'),
    candidate,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  let candidateStats = 0;
  const changingLstat = vi.fn(async (target: Parameters<typeof lstat>[0]) => {
    const info = await lstat(target);
    if (target === candidate && ++candidateStats === 3) {
      Object.defineProperty(info, 'birthtimeMs', { value: info.birthtimeMs + 1 });
    }
    return info;
  });

  await expect(
    new LegacyPiExtensionCleanupService({
      piRoots: [nativeRoot],
      projectsRoot: value.projectsRoot,
      fileSystem: { lstat: changingLstat, readlink, realpath, unlink },
    }).run(),
  ).rejects.toMatchObject({ code: 'SETUP_LEGACY_PI_EXTENSION_INVALID' });
  expect((await lstat(candidate)).isSymbolicLink()).toBe(true);
});

it('fails closed when an extensions parent traverses a symlink', async () => {
  const value = await fixture();
  const nativeRoot = path.join(value.root, 'pi-personal');
  const foreignExtensions = path.join(value.root, 'foreign-extensions');
  await mkdir(nativeRoot);
  await mkdir(foreignExtensions);
  await symlink(
    foreignExtensions,
    path.join(nativeRoot, 'extensions'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const candidate = path.join(foreignExtensions, 'worktree');
  await symlink(
    path.join(value.sourceExtensions, 'worktree'),
    candidate,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await expect(
    new LegacyPiExtensionCleanupService({
      piRoots: [nativeRoot],
      projectsRoot: value.projectsRoot,
    }).run(),
  ).rejects.toMatchObject({ code: 'SETUP_LEGACY_PI_EXTENSION_INVALID' });
  expect((await lstat(candidate)).isSymbolicLink()).toBe(true);
});
