#!/usr/bin/env node

import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPTIONAL_DIRECTORIES = ['.vscode', '.cursor', '.local'];

export function normalizeNativeWindowsPath(value, platform = process.platform) {
  if (platform !== 'win32' || !value) return value;
  return value.replace(/^\/([a-zA-Z])(?:\/(.*))?$/, (_match, drive, rest = '') => `${drive}:/${rest}`);
}

async function canonicalDirectory(value, name) {
  if (!value) throw new Error(`${name} is required`);

  let stats;
  try {
    stats = await lstat(normalizeNativeWindowsPath(value));
  } catch {
    throw new Error(`${name} must be an existing directory`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory`);
  }
  return realpath(normalizeNativeWindowsPath(value));
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!outside && !path.isAbsolute(relative));
}

async function copyMissingDirectory(source, destination, sourceStats = undefined) {
  sourceStats ??= await lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) return;

  try {
    await mkdir(destination);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const destinationStats = await lstat(destination);
  if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) return;

  for (const entry of await readdir(source)) {
    const sourceEntry = path.join(source, entry);
    const destinationEntry = path.join(destination, entry);
    const stats = await lstat(sourceEntry);

    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await copyMissingDirectory(sourceEntry, destinationEntry);
    } else if (stats.isFile()) {
      try {
        await copyFile(sourceEntry, destinationEntry, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }
}

export async function prepareWorktree(rootPath, worktreePath) {
  const root = await canonicalDirectory(rootPath, 'ORCA_ROOT_PATH');
  const worktree = await canonicalDirectory(worktreePath, 'ORCA_WORKTREE_PATH');

  if (contains(root, worktree) || contains(worktree, root)) {
    throw new Error('Orca root and worktree must be different, non-overlapping directories');
  }

  for (const directory of OPTIONAL_DIRECTORIES) {
    const source = path.join(root, directory);
    let sourceStats;
    try {
      sourceStats = await lstat(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await copyMissingDirectory(source, path.join(worktree, directory), sourceStats);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await prepareWorktree(process.env.ORCA_ROOT_PATH, process.env.ORCA_WORKTREE_PATH);
  } catch (error) {
    console.error(`prepare-worktree: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
