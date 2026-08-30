import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureDirectoryCandidate,
  captureFileCandidate,
  inventoriesEqual,
  inventoryDirectory,
} from './capture-baseline-files.mjs';
import { buildDirectoryCandidates, buildFileCandidates } from './capture-baseline-candidates.mjs';

const roots = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpx-baseline-test-'));
  roots.push(root);
  return root;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('migration baseline candidate policy', () => {
  const requiredRoots = {
    localAppData: path.resolve('local'),
    projectRoot: path.resolve('projects'),
  };

  it('omits every absent or empty optional directory root without creating CWD-relative paths', () => {
    expect(buildDirectoryCandidates(requiredRoots)).toEqual([
      path.join(
        requiredRoots.localAppData,
        'Packages',
        'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
        'LocalState',
        'icons',
      ),
      path.join(requiredRoots.projectRoot, 'agent-resurrect', 'saves'),
    ]);
    expect(
      buildDirectoryCandidates({
        ...requiredRoots,
        aiGenerated: '',
        obsidianVault: '',
        appData: '',
      }),
    ).toEqual(buildDirectoryCandidates(requiredRoots));
  });

  it('preserves the exact directory candidate set at the supplied absolute roots', () => {
    const aiGenerated = path.resolve('generated'),
      obsidianVault = path.resolve('vault'),
      appData = path.resolve('roaming');
    expect(
      buildDirectoryCandidates({ ...requiredRoots, aiGenerated, obsidianVault, appData }),
    ).toEqual([
      path.join(
        requiredRoots.localAppData,
        'Packages',
        'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
        'LocalState',
        'icons',
      ),
      path.join(aiGenerated, '_RAYCAST'),
      path.join(obsidianVault, '_Projekty', 'MpxClaudeCode'),
      path.join(requiredRoots.projectRoot, 'agent-resurrect', 'saves'),
      path.join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Resurrect Agent Sessions.lnk',
      ),
      path.join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Save Agent Sessions.lnk',
      ),
    ]);
  });

  it.each([
    ['aiGenerated', 'AI-generated assets root must be an absolute path'],
    ['obsidianVault', 'Obsidian vault root must be an absolute path'],
    ['appData', 'Application data root must be an absolute path'],
  ])('rejects a relative %s directory root without disclosing it', (rootName, message) => {
    const privateValue = 'relative-private-root';
    expect(() => buildDirectoryCandidates({ ...requiredRoots, [rootName]: privateValue })).toThrow(
      new RegExp(`^${message}$`, 'u'),
    );
    try {
      buildDirectoryCandidates({ ...requiredRoots, [rootName]: privateValue });
    } catch (error) {
      expect(String(error)).not.toContain(privateValue);
    }
  });
});

describe('migration baseline file capture', () => {
  it('allowlists only personal and work settings against the symbolic project root', () => {
    const candidates = buildFileCandidates({
      userHome: path.join('root', 'home'),
      localAppData: path.join('root', 'local'),
      projectRoot: path.join('root', 'projects'),
      obsidianVault: path.resolve('root', 'vault'),
    });
    const allowed = candidates.filter((candidate) => candidate.allowedTargetRoots.length > 0);
    expect(allowed.map((candidate) => candidate.sourcePath)).toEqual([
      path.join('root', 'home', '.claude', 'settings.json'),
      path.join('root', 'home', '.claude-work', 'settings.json'),
    ]);
    expect(
      allowed.every(
        (candidate) =>
          candidate.allowedTargetRoots.length === 1 &&
          candidate.allowedTargetRoots[0] === path.join('root', 'projects', 'mpx-claude-code'),
      ),
    ).toBe(true);
    expect(
      candidates
        .filter((candidate) => !allowed.includes(candidate))
        .every((candidate) => candidate.allowedTargetRoots.length === 0),
    ).toBe(true);
  });
  it('omits Obsidian candidates when no vault root is provided', () => {
    const candidates = buildFileCandidates({
      userHome: path.resolve('home'),
      localAppData: path.resolve('local'),
      projectRoot: path.resolve('projects'),
    });
    expect(candidates).toHaveLength(12);
    expect(candidates.some((candidate) => candidate.sourcePath.includes('_Projekty'))).toBe(false);
  });

  it('roots Obsidian candidates exactly at the provided absolute vault', () => {
    const obsidianVault = path.resolve('vault-root');
    const candidates = buildFileCandidates({
      userHome: path.resolve('home'),
      localAppData: path.resolve('local'),
      projectRoot: path.resolve('projects'),
      obsidianVault,
    });
    expect(candidates.slice(-2).map((candidate) => candidate.sourcePath)).toEqual([
      path.join(obsidianVault, '_Projekty', 'Mini Projekty', 'Issues', 'Active', 'mpx-ports.md'),
      path.join(
        obsidianVault,
        '_Projekty',
        'Mini Projekty',
        'Issues',
        'Active',
        'claude-resurrect.md',
      ),
    ]);
  });

  it('rejects a relative Obsidian vault root without disclosing its value', () => {
    expect(() =>
      buildFileCandidates({
        userHome: path.resolve('home'),
        localAppData: path.resolve('local'),
        projectRoot: path.resolve('projects'),
        obsidianVault: 'relative-private-root',
      }),
    ).toThrow(/^Obsidian vault root must be an absolute path$/u);
  });

  it('captures a regular candidate as verified regular-file bytes', async () => {
    const root = await fixture(),
      source = path.join(root, 'source.txt'),
      destination = path.join(root, 'snapshot', 'source.txt');
    await writeFile(source, 'baseline');
    const record = await captureFileCandidate({
      sourcePath: source,
      destinationPath: destination,
      allowedTargetRoots: [],
    });
    expect(record).toMatchObject({
      originalNodeType: 'regular-file',
      capturedNodeType: 'regular-file',
      sha256: digest('baseline'),
    });
    expect(await readFile(destination, 'utf8')).toBe('baseline');
  });

  it('materializes allowed symlink bytes and topology before later target mutation', async () => {
    const root = await fixture(),
      allowed = path.join(root, 'allowed'),
      target = path.join(allowed, 'shared.json'),
      source = path.join(root, 'settings.json'),
      destination = path.join(root, 'snapshot', 'settings.json');
    await mkdir(allowed);
    await writeFile(target, 'before');
    await symlink(target, source, 'file');
    const record = await captureFileCandidate({
      sourcePath: source,
      destinationPath: destination,
      allowedTargetRoots: [allowed],
    });
    await writeFile(target, 'after');
    expect(record).toMatchObject({
      originalNodeType: 'symbolic-link',
      capturedNodeType: 'regular-file',
      rawTarget: target,
      resolvedTarget: target,
      sha256: digest('before'),
    });
    expect(await readFile(destination, 'utf8')).toBe('before');
  });

  it('rejects a symlink target outside its candidate-specific allowlist', async () => {
    const root = await fixture(),
      allowed = path.join(root, 'allowed'),
      outside = path.join(root, 'outside.txt'),
      source = path.join(root, 'candidate.txt');
    await mkdir(allowed);
    await writeFile(outside, 'private');
    await symlink(outside, source, 'file');
    await expect(
      captureFileCandidate({
        sourcePath: source,
        destinationPath: path.join(root, 'snapshot'),
        allowedTargetRoots: [allowed],
      }),
    ).rejects.toThrow(/outside.*allowlist/iu);
  });

  it('binds directory inventories to regular-file content and detects changed bytes', async () => {
    const root = await fixture(),
      source = path.join(root, 'directory'),
      destination = path.join(root, 'snapshot');
    await mkdir(source);
    await writeFile(path.join(source, 'file.txt'), 'before');
    const record = await captureDirectoryCandidate({
      sourcePath: source,
      destinationPath: destination,
    });
    expect(record.entries).toEqual(await inventoryDirectory(destination));
    await writeFile(path.join(destination, 'file.txt'), 'after');
    expect(inventoriesEqual(record.entries, await inventoryDirectory(destination))).toBe(false);
  });

  it('preserves a nested symlink without copying or traversing its outside target', async () => {
    const root = await fixture(),
      source = path.join(root, 'directory'),
      destination = path.join(root, 'snapshot'),
      outside = path.join(root, 'outside.txt');
    const rawTarget = path.join('..', 'outside.txt'),
      link = path.join(source, 'outside-link.txt');
    await mkdir(source);
    await writeFile(outside, 'outside-target-bytes');
    await symlink(rawTarget, link, 'file');
    const record = await captureDirectoryCandidate({
      sourcePath: source,
      destinationPath: destination,
    });
    const destinationLink = path.join(destination, 'outside-link.txt');
    expect((await lstat(destinationLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(destinationLink)).toBe(rawTarget);
    expect(record.entries).toEqual([
      { path: 'outside-link.txt', nodeType: 'symbolic-link', rawTarget },
    ]);
    expect(record.entries).toEqual(await inventoryDirectory(destination));
    await rm(outside);
    expect((await lstat(destinationLink)).isSymbolicLink()).toBe(true);
    await expect(readFile(destinationLink)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inventoryDirectory(source)).toEqual(await inventoryDirectory(destination));
  });

  it('rejects a top-level directory symlink instead of traversing it', async () => {
    const root = await fixture(),
      target = path.join(root, 'directory'),
      source = path.join(root, 'directory-link');
    await mkdir(target);
    await writeFile(path.join(target, 'file.txt'), 'content');
    await symlink(target, source, 'dir');
    await expect(
      captureDirectoryCandidate({
        sourcePath: source,
        destinationPath: path.join(root, 'snapshot'),
      }),
    ).rejects.toThrow(/top-level directory.*link/iu);
  });
});
